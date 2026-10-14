# Milestone 1 parsing spike: findings

Measured 2026-10-14 on the 4 fixture demos (Premier, patch 14190, 3 maps) with `@laihoe/demoparser2` 0.42.0,
on a laptop (i5-1135G7, 4 cores / 8 threads, 16 GB RAM, NVMe). Reproduce with `npm run spike` (needs the gitignored
fixtures; each demo runs in its own process so the peak-RSS numbers are clean). The pipeline measured here is the
production one (`server/src/parse/parseDemo.ts`), not a throwaway script.

## Time, memory, size

| Demo | Map | Duration | .dem.bz2 | .dem | bunzip2 | Parse | Peak RSS | Parquet total | ticks | usercmd_history | events | grenades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| …862155 | de_inferno | 29:39 | 127 MB | 193 MB | 9.8 s | 89 s | 2.16 GB | 41.4 MB | 18.2 MB | 22.3 MB | 0.54 MB | 0.41 MB |
| …125128 | de_dust2 | 32:50 | 132 MB | 204 MB | 10.1 s | 104 s | 2.41 GB | 47.0 MB | 20.0 MB | 25.9 MB | 0.77 MB | 0.41 MB |
| …186015 | de_dust2 | 35:07 | 145 MB | 219 MB | 10.9 s | 113 s | 2.47 GB | 51.7 MB | 22.2 MB | 28.2 MB | 0.66 MB | 0.59 MB |
| …827140 | de_cache | 30:03 | 110 MB | 168 MB | 9.2 s | 87 s | 2.10 GB | 39.4 MB | 16.9 MB | 21.3 MB | 0.63 MB | 0.60 MB |

- **Rows:** 1.14–1.35 M tick rows (10 players × every tick at 64 tick), 2.2–3.1 M usercmd input-history rows, 100–150 k grenade trajectory rows, ~15 k event rows in ~48 event types.
- **Where the time goes:** ~90 % is `parseTicks`. Every call re-reads the whole demo (~2.3 s floor per call) and then costs
  ~0.25 ms per requested tick for ~57 props. Events take ~1.7 s, grenades ~1.5 s, Parquet writes ~2 s.
- **Storage:** ~40–50 MB of Parquet per match, so 1000 matches ≈ 50 GB. The spec planned "tens of MB": confirmed. More than half
  of it is the optional usercmd input history; `PARSE_INPUT_HISTORY=0` drops it if disk gets tight.
- **Throughput (R-NFR-2):** ~10 s decompress + ~100 s parse per match here, well within "a few minutes". A smaller VPS core will be slower; parse concurrency stays 1.

## Memory decisions (R-PARSE-4)

| Setting | Effect measured |
| --- | --- |
| `parseTicks` chunk 32 768 ticks | 1.6 GB RSS for the parser output alone |
| chunk 16 384 | 0.8 GB (1.2 GB with input history) |
| **chunk 8 192 (chosen)** | ~0.5 GB; whole parse peaks at 2.1–2.5 GB |
| chunk 4 096 | 0.25 GB, but 28 passes × 2.3 s re-read floor makes it ~30 % slower |
| `parseGrenades(path)` default | 1.1 M rows (held grenades with null positions), 7.6 s, **3 GB** RSS |
| **`parseGrenades(path, null, false)` (chosen)** | the same 145 k projectile rows, 1.3 s, 0.5 GB |
| input history as JSON string column | 37 MB of a 54 MB ticks.parquet; flattened into `usercmd_history.parquet` it is ~21 MB |

Tick rows are appended to a file-backed DuckDB table (memory_limit 512 MB) in 2048-row chunks, then written once with
`COPY … (FORMAT parquet, COMPRESSION zstd)`. The parse child process gets a 4 GB RSS cap by default (`PARSE_MEMORY_LIMIT_MB`).

## What the demos contain

### Header
`map_name`, `server_name` (e.g. "Valve Counter-Strike 2 eu_north Server (…)"), `patch_version` (build), `demo_version_name`,
`client_name` = "SourceTV Demo" (confirms GOTV). No tick count or match id in the header; duration comes from the last event tick,
the match id from the replay URL.

### Per-tick fields (all present, ≥ 99.8 % non-null for alive players)
Position X/Y/Z, pitch/yaw, velocity X/Y/Z (derived by demoparser2 from the previous *requested* tick, so chunks overlap by one tick),
health, armor, helmet, defuser, team, alive, active weapon, ammo/reserve, shots fired, recoil index, accuracy penalty, scoped,
ducking, walking, airborne, defusing, in bomb zone, flash duration / max alpha, money, equipment value, cash spent this round,
place name, inventory (list of item names).

- **Spotted mask:** present. Use the raw path `CCSPlayerPawn.m_bSpottedByMask`; demoparser2 decodes it to a list of SteamIDs.
  Requesting the friendly `approximate_spotted_by` together with the raw path silently drops one of them (same field). ~11 % of
  player-ticks have a non-empty mask.
- **Aim punch:** the friendly `aim_punch_angle` / `aim_punch_angle_vel` return **nothing** in current demos. The data moved to
  `CCSPlayerPawn.CCSPlayer_AimPunchServices.m_predictableBaseAngle` (and `m_unpredictableBaseAngle`), plus the camera's
  `CCSPlayer_CameraServices.m_vecCsViewPunchAngle`. Non-zero on ~41 % of player-ticks. Stored as `aim_punch_*` / `view_punch_*`.
- **usercmd data: present, contrary to the spec's assumption.** These GOTV demos carry per-tick `usercmd_viewangle_x/y`,
  `usercmd_mouse_dx/dy` (non-zero on ~45 % of rows), forward/left move, button states, weapon select, and the sub-tick
  `usercmd_input_history` (player/render tick + fraction + view angles; ~2 entries per tick). `usercmd_subtick_moves` is empty.
  It is all stored, but per the spec no indicator depends on it: it may disappear with a Valve update and isn't guaranteed for
  older demos. It's a strong research lead for later (mouse deltas vs view-angle changes would expose aim assistance directly).

### Events
~48 types per demo, including `player_death`, `player_hurt`, `weapon_fire`, `fire_bullets`, `bullet_damage` (with shoot angles,
aim punch, inaccuracy, sub-tick attack time, distance), `player_bullet_hit`, `player_blind`, all grenade detonations,
`inferno_*`, `smokegrenade_*`, bomb events, `round_prestart/poststart/freeze_end/officially_ended`, `rank_update`,
`cs_win_panel_match`, `item_equip/pickup`, `player_footstep`.

- **No `round_end` and no `item_purchase` events** in any of the 4 demos. Consequences:
  - Round winner, win reason and score come from game-rules props sampled 1 tick before each `round_officially_ended`
    (`round_win_status` 2 = T / 3 = CT, `round_win_reason` (CS:GO enum: 7 defused, 8 CT elimination, 9 T elimination, 1 bombed, 12 time),
    `team_rounds_total`). Stored in `round_snapshots.parquet`, together with rank, wins, crosshair code, MVPs and score per player.
  - Purchases (R-ECO) are derived from inventory and `cash_spent_this_round` changes in the tick data instead of `item_purchase`.
- `round_officially_ended` fires twice per tick (duplicate rows); dedupe on tick.
- The last round has no `round_officially_ended`; it ends at `cs_win_panel_match`.
- Events get `round` = `total_rounds_played + 1` (R-PARSE-3). Player rows in events carry `user_*` / `attacker_*` / `victim_*` SteamIDs instead of a single `steamid`.

### Player info
`parsePlayerInfo`: name, SteamID64, starting team. Rank, rank type, wins and crosshair code come from the round snapshots.

## Output layout per match (`DATA_DIR/matches/<demo id>/`)

`header.json`, `ticks.parquet`, `usercmd_history.parquet`, `events/<name>.parquet`, `grenades.parquet`, `players.parquet`,
`round_snapshots.parquet`. `parser_version` = `1+demoparser2@0.42.0`, `schema_version` = 1.
