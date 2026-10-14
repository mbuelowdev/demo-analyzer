# demo-analyzer — Requirements

Exported 2026-10-14 from the living doc: https://claude.ai/code/artifact/734f0e67-4c9a-4573-8fab-0a971d4086a7
This file is the spec the implementation follows. Change it here (and in the doc) when decisions change.

## Overview and goals

demo-analyzer (demo-analyzer.mbuelow.dev) is a private, self-hosted web app that collects a user's CS2 match demos, parses them and extracts as much data as possible. The data drives match stats and, above all, cheat-detection research.

- **Collect** Valve matchmaking demos (Premier, Competitive, Wingman, Rush) through a Chromium extension that reads the user's Steam GCPD match history. Manual upload is the second source.
- **Parse** every demo into a rich, tick-level dataset that can be re-analysed when new indicators are invented.
- **Analyse** scoreboard stats, utility and economy, and cheat indicators such as pre-aim, aim accuracy and time to damage, with a per-player suspicion score.
- **Restrict** access to whitelisted Discord users who log in via Discord OAuth. Each user sees only their own data.

Out of scope for v1: FACEIT, HLTV or URL imports, 2D round replays, heatmaps, cross-user player profiles, and a Steam bot or Game Coordinator integration.

## Users, authentication and whitelist

Login is Discord OAuth2 only, and access needs a Discord ID on the whitelist. Data is strictly private per user.

**Requirements**

- R-AUTH-1: Log in via Discord OAuth2 (authorization code flow, scope `identify`). No passwords are stored.
- R-AUTH-2: After the callback, the backend checks the Discord user ID against the whitelist. A user who isn't listed gets a "not authorised" page and no session.
- R-AUTH-3: Sessions are server-side and live in the database, behind an HttpOnly, Secure, SameSite=Lax cookie with a 30-day sliding expiry. Logout destroys the session.
- R-AUTH-4: Removing a user from the whitelist revokes their sessions and extension API keys immediately.
- R-WL-1: There is an admin page to add or remove Discord IDs, with an optional note such as "Max – friend". The whitelist lives in the database.
- R-WL-2: Discord ID `1012247275940085862` is hardcoded as the owner admin. Additional admins can optionally be seeded from the env var `ADMIN_DISCORD_IDS` (comma-separated). They are always whitelisted and can't lock themselves out. Admins can promote other users to admin.
- R-PRIV-1: Every demo, match and analysis belongs to the user who imported it, and no other user can see it. This includes admins, who manage the whitelist only.
- R-PRIV-2: If two users import the same match, each gets their own copy of the user-to-match link. The raw file and parsed data may be deduplicated internally, but analysis never mixes data across users.
- R-PRIV-3: Baselines for cheat detection come from the requesting user's own demos, never from other users' data. Until a user's demos hold enough values for a metric, a built-in reference distribution is used instead (see R-SCORE-1).
- R-USER-1: Each user links their SteamID64, so the app knows which player in a demo is "me" for personal stats and baselines. It's set manually or detected from the extension's GCPD page.

**Solution notes**

- Use the Discord endpoints `https://discord.com/oauth2/authorize`, `/api/oauth2/token` and `/api/users/@me`. A small hand-written flow is enough; Passport isn't needed.
- Redirect URLs registered in the Discord app: `https://demo-analyzer.mbuelow.dev/auth/discord/callback` and `http://localhost:3000/auth/discord/callback`. The callback route must be exactly `/auth/discord/callback`.
- Configuration via env vars: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL` (redirect URI = `PUBLIC_URL` + `/auth/discord/callback`), `SESSION_SECRET`.
- Show the Discord avatar and username in the UI.

## Demo acquisition

A Chromium extension scrapes download links from the user's logged-in Steam GCPD pages and sends them to the API. The server never holds Steam credentials and needs no Steam bot. Manual upload is the second source.

### Chromium extension

The user clicks the toolbar icon. A flyout offers four match types, each mapped to a GCPD tab on `https://steamcommunity.com/my/gcpd/730/`:

| Flyout option | GCPD tab |
| --- | --- |
| Premier | `?tab=matchhistorypremier` |
| Competitive | `?tab=matchhistorycompetitivepermap` |
| Wingman | `?tab=matchhistorywingman` |
| Rush | `?tab=matchhistoryrush` |

Flow:

1. The user picks a type, and the extension opens or navigates to that GCPD tab.
2. A content script waits for the page to load. If the table `.generic_kv_table.csgo_scoreboard_root` has no match entries, it clicks `#load_more_clickable` **once** and waits for rows to appear. It never clicks more than once.
3. As soon as rows are in the table, the script **automatically** collects every "Download Replay" link, plus the metadata visible in each row: map, date and time, duration, score, and the players' Steam profile links and scoreboard values.
4. It POSTs the batch to `POST /api/ext/matches` with the user's extension API key.
5. The flyout shows the result returned by the API: N new, N already known, N failed.

The flyout also has two manual controls:

- **"Scan this page for demo urls"** button: runs steps 3–5 on the current tab. Use it when you've already opened a GCPD page yourself, or after loading more history by hand.
- **"Manual demo url input"** field: paste one or more replay URLs (one per line) and send them to the same endpoint.

Requirements:

- R-EXT-1: Manifest V3, for Chromium-based browsers (Chrome, Edge, Brave, Vivaldi). Host permission only for `steamcommunity.com` and the app's own domain.
- R-EXT-2: The extension does no deduplication or filtering. It sends everything it finds, and the API dedupes.
- R-EXT-3: It authenticates with a per-user API key generated on the app's settings page and pasted into the extension's options. Keys can be revoked.
- R-EXT-4: The app URL is configurable in the options, so local dev and production both work.
- R-EXT-5: Distribution is unpacked or a `.zip` built by CI and downloadable from the app. Publishing to the Chrome Web Store is optional, later.
- R-EXT-6: Selectors live in one place. Steam markup changes will break scraping, so a failure must show a clear error rather than sending nothing silently.
- R-EXT-7: A real saved GCPD page is in `fixtures/gcpd/matchhistory.html` (gitignored). The scraper is developed and tested against it. Replay links on that page use `http://` (for example `http://replay181.valve.net/730/003847940962324054227_0152827140.dem.bz2`).

### Ingest API and download pipeline

- R-DL-1: The match identity is taken from the replay URL (`…/730/<matchId>_<outcomeId>.dem.bz2`) and stored per user. A link the user already has is ignored. A known match whose download failed is retried.
- R-DL-2: A background job queue downloads `.dem.bz2` files with limited concurrency (default 2), retries with backoff, and records status per match: `queued` → `downloading` → `parsing` → `analysed`, or `failed` / `expired`.
- R-DL-3: Valve keeps replays for 2 weeks. The user runs the extension manually now and then; nothing is scheduled. Links that return 404 are marked `expired` and keep the scraped scoreboard metadata.
- R-DL-4: Downloads are streamed to disk, never buffered in memory. The worker decompresses bz2 to `.dem` before parsing.

### Manual upload

- R-UP-1: Upload `.dem`, `.dem.bz2` or `.dem.zst` files via drag and drop, with a progress bar. The size limit is configurable (default 1 GB).
- R-UP-2: The server validates the CS2 demo header (`PBDEMS2`) before queuing. Duplicates are detected by file hash.

### Raw file retention

- R-RET-1: Raw demos older than `DEMO_RETENTION_DAYS` (default 3) are deleted only when a new demo download starts. There is no scheduler or cron. If no new demos come in, existing raw demos stay indefinitely, which is intended. Extracted data is kept forever.
- R-RET-2: While the raw file exists, a user can trigger "re-parse" or "re-analyse", for example after a new indicator is added. Afterwards only re-analysis from stored tick data is possible (see Parsing).
- R-RET-3: Raw demos are stored compressed (bz2 as downloaded, or zstd) to save disk.
- R-RET-4: A user can mark a match "keep demo" (Matches page overflow menu). Retention cleanup skips a raw demo while any user linked to it keeps it; un-keeping hands it back to normal retention. While the raw file exists, it can be downloaded unpacked from the Matches page (named `demo_<YYYYMMDD>_<HHMMSS>_<map>_<own>_<opp>.dem`).

## Parsing and data model

Each demo is parsed once with `@laihoe/demoparser2` into per-match Parquet files at full tick resolution. Analysis runs on those files, so new indicators can be computed later without the raw demo.

**Requirements**

- R-PARSE-1: Parsing runs in a separate worker process, not in the web server's event loop. Concurrency is limited (default 1) because parsing is CPU- and memory-heavy.
- R-PARSE-2: Extract as much as possible and store it all:
  - Header: map, server, build, tick rate, match ID, duration.
  - Player info: SteamID64, name, team, rank if present, crosshair code.
  - All game events (`listGameEvents`, then parse each): `player_death`, `player_hurt`, `weapon_fire`, `bullet_impact`, `player_blind`, all grenade events, bomb events, `round_*`, `item_purchase` and so on.
  - Grenade trajectories (`parseGrenades`).
  - Per-tick player state for all players: position X/Y/Z, pitch/yaw (view angles), velocity, health, armor, active weapon, ammo, scoped, ducking, walking, flash duration, money, equipment value, `spotted` / spotted-by mask, in-air flag, and aim punch / recoil angles if exposed.
  - Per-tick input data (usercmd: buttons, view angles, subtick moves) **if** present. Parse it if found, but no indicator may depend on it. (Spike finding: current MM GOTV demos *do* carry usercmd view angles, mouse deltas, buttons and the sub-tick input history; it is stored in `ticks.parquet` / `usercmd_history.parquet`, see `docs/SPIKE.md`.)
- R-PARSE-3: Every row carries `tick`, `round`, `steamid`. Store `parser_version` and `schema_version` per match so outdated matches can be re-processed.
- R-PARSE-4: Parse in tick-range chunks or column groups to keep memory bounded. A full match is about 150k ticks × 10 players ≈ 1.5M rows at 64 tick.
- R-PARSE-5: Parse errors are stored on the match with the log, and the user can retry.

**Storage layout** (all under the mounted data volume, `DATA_DIR`, `/data` in production)

| Store | Contents | Technology |
| --- | --- | --- |
| App database | users, whitelist, sessions, API keys, matches, jobs, maps, per-player match stats, indicator results | SQLite (`better-sqlite3`), WAL mode |
| Match data | `ticks.parquet`, `usercmd_history.parquet`, `events/<name>.parquet`, `grenades.parquet`, `players.parquet`, `round_snapshots.parquet`, `header.json`, plus analysis output `engagements.parquet`, `engagement_ticks.parquet`, `indicators.parquet` per match | Parquet (zstd), one folder per match |
| Raw demos | `.dem.bz2` / `.dem.zst` until retention ends | files |
| Map files | `maps/<map>.vpk` | files |
| Ad-hoc analytics | SQL over Parquet for indicators and research | DuckDB (`@duckdb/node-api`) |

Why this split: SQLite fits a single `docker run` with one volume, so there's no extra DB container. Parquet plus DuckDB handles millions of tick rows fast and allows research queries in Python or the DuckDB CLI on the same files.

Measured in milestone 1 (`docs/SPIKE.md`): 39–52 MB of Parquet per match, ~100 s parse and 2.1–2.5 GB peak RSS on a laptop core (1.5 GB after the small-host fixes in SPIKE.md). More than half of the size is the optional usercmd input history (`PARSE_INPUT_HISTORY=0` drops it).

Assumption: all matchmaking demos are GOTV recordings. GOTV is the server-side spectator recording at 64 tick. It holds positions, view angles, health, weapons, shots, damage and events. Every indicator is designed to work on that data alone. The spike showed that current demos also include usercmd data (mouse deltas, buttons, sub-tick view angles); it is stored for research but no indicator depends on it, because Valve can drop it at any time.

Spike findings that changed the design (details in `docs/SPIKE.md`):

- MM demos have **no `round_end` and no `item_purchase` events**. Round winner, win reason and score come from game-rules props sampled just before each `round_officially_ended` (and at the win panel for the last round), stored in `round_snapshots.parquet`. Purchases are derived from inventory changes during buy time.
- The friendly `aim_punch_angle` field is empty; aim punch comes from `CCSPlayer_AimPunchServices` and only changes on each shot (a step function), so recoil analysis works shot to shot.
- The spotted mask must be read from the raw `CCSPlayerPawn.m_bSpottedByMask` path.

## Map files

Admins upload CS2 map `.vpk` files from their local game install. The maps are shared by all users and are the basis for geometry-based analysis later on (ray-cast visibility). There is no map versioning: a new upload replaces the old file.

- R-MAP-1: The app keeps a pre-created list of known maps, seeded with the table below. Any map name seen in a parsed demo header is added automatically, so pool changes correct themselves.
- R-MAP-2: The admin page lists all maps with their status: no file, uploaded (size, date, uploader), processed.
- R-MAP-3: To upload, the admin first selects which map the file belongs to. If the file name (for example `de_dust2.vpk`) or the VPK's internal paths (`maps/<name>/…`) match a known map exactly, that map is selected automatically. Otherwise the admin must pick one.
- R-MAP-4: The server validates the VPK header (magic `0x55AA1234`). The file is stored at `/data/maps/<map>.vpk`, overwriting any previous file. Upload size is up to 5 GB, streamed to disk with a progress bar.
- R-MAP-5: Admins can only upload and delete map files. Every logged-in user's analysis may use them; map files are not private data.
- R-MAP-6 (later milestone): A worker job extracts the collision mesh from the VPK into a triangle file for ray casting, for example via the Source2Viewer / ValveResourceFormat CLI. Geometry-based indicators are skipped for maps without a processed mesh.
- Where the files live: the local install path is `…/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/<map>.vpk`.

The seed list comes from the map files in a real CS2 install, checked on 2026-10-14, plus the Premier Season 5 pool. `*_vanity.vpk` files (main-menu scenes) are never offered for upload or auto-detection.

| Map name (= file name) | Display name | Pools |
| --- | --- | --- |
| `de_ancient` | Ancient | Premier, Competitive |
| `de_anubis` | Anubis | Premier, Competitive |
| `de_cache` | Cache | Premier, Competitive |
| `de_dust2` | Dust II | Premier, Competitive |
| `de_inferno` | Inferno | Premier, Competitive |
| `de_mirage` | Mirage | Premier, Competitive |
| `de_nuke` | Nuke | Premier, Competitive |
| `de_overpass` | Overpass | Competitive |
| `de_train` | Train | Competitive |
| `de_vertigo` | Vertigo | Competitive |
| `cs_office` | Office | Competitive (hostage) |
| `cs_italy` | Italy | Competitive (hostage) |
| `de_boulder` | Boulder | Competitive (community) |
| `de_fachwerk` | Fachwerk | Competitive (community) |
| `cs_shelter` | Shelter | Competitive (community) |
| `rush_001` | Rush arenas | Rush |
| `de_ancient_night` | Ancient (night) | other / casual |
| `de_debris` | Debris | other / casual |
| `de_eldorado` | Eldorado | other / casual |
| `de_poseidon` | Poseidon | other / casual |
| `ar_baggage` | Baggage | Arms Race |
| `ar_pool_day` | Pool Day | Arms Race |
| `ar_shoots` | Shoots | Arms Race |
| `ar_shoots_night` | Shoots (night) | Arms Race |

Rush ships as a single map file, `rush_001.vpk`, which holds the whole chain of arenas: T Assault and CT Assault, plus 5 drawn from Spire, Wallbang, Big Box, Sewer, Dogleg, Drop, Crane, Playhouse, Madhouse, Tunnel, King of the Hill, Marksman and Horseshoe, with Convoy as the 7:7 decider.

## Match analysis: stats, utility, economy

Every parsed match gets a full scoreboard, a per-round breakdown, and utility and economy stats for all players. Results are stored in SQLite for fast listing and filtering.

**Scoreboard and stats (R-STAT)**

- Kills, deaths, assists, K/D, ADR, HS%, KAST, multi-kills (2K to 5K), opening kills and deaths, clutches (1vX won/lost), trade kills and traded deaths, MVPs, and an HLTV-2.0-style rating approximation.
- Per-round timeline: winner, win reason, score, each player's kills and damage, and who died first.
- Weapon breakdown per player: kills, HS%, damage, shots fired, hits and accuracy.

**Utility (R-UTIL)**

- Flashes thrown, enemies and teammates flashed, average blind duration, flash assists.
- HE and molotov/incendiary damage, smokes thrown, utility damage per round.
- Unused utility at death, i.e. value lost.

**Economy (R-ECO)**

- Per-round team buy type: pistol, eco, force, half buy, full buy, using equipment-value thresholds that can be configured.
- Money spent, equipment value, and round win rate per buy type.
- Purchases per player per round, from `item_purchase` events.

**Personal trends (R-TREND)**

- For the user's own SteamID: stats over time across their matches, filterable by map, mode and date range.

Rush matches have a different structure (3v3, arenas instead of bomb rounds). Stats that don't apply are omitted for Rush rather than shown wrong.

## Cheat-detection analysis

The foundation is an **engagement dataset** derived from tick data. Indicators are pluggable, versioned modules on top of it. Each indicator yields per-player metrics, and a suspicion score combines them against a baseline built from the user's own demos.

### Foundation (build first)

- R-CD-1 **Engagement extraction.** For each attacker–victim pair, an engagement is a window from the tick the victim becomes visible to the attacker until a kill, a loss of visibility, or a timeout. Stored per engagement:
  - Start, first-shot, first-damage and end ticks.
  - Angular distance from the crosshair to the victim's head at each tick.
  - Weapon, distance, attacker speed, flashed or smoked state, and the outcome.
- R-CD-2 **Visibility model.** Pluggable interface. Decision: v1 uses the game's own `spotted` / spotted-by mask only (cheap, approximate). Ray casting against map geometry (from uploaded map files, see Map files) is a later upgrade behind the same interface.
- R-CD-3 **View-angle helpers.** Angle to target, angular velocity and acceleration per tick, recoil/aim-punch-compensated aim, and on-target / in-hitbox estimates.
- R-CD-4 **Indicator plugin API.** Each module has `id`, `version`, `description`, the inputs it needs, and `compute(match) → per-player metrics (+ optional flagged moments)`. A version bump queues re-analysis of all matches whose Parquet data exists.
- R-CD-5 All engagements and indicator outputs are written to Parquet, so new indicators can be researched with DuckDB, Python or notebooks before turning them into modules.

### Initial indicators

| Indicator | Definition | Suspicious when |
| --- | --- | --- |
| Time to damage (TTD) | ms from victim visible → first damage | Consistently very low, with low variance |
| Reaction time | ms from visible → first movement of the attacker's own view toward the target (measured against the target direction of the previous tick, so the victim or attacker walking doesn't count) or first shot | Below human range (~150 ms) repeatedly |
| Pre-aim | Angle between the crosshair and the center of the victim's body at the moment of visibility | Near 0° far more often than the baseline, especially at non-standard angles |
| Flick precision | Large, fast view-angle changes that end exactly on the head | High snap-to-head rate with little overshoot or correction |
| Aim accuracy | First-bullet accuracy, HS% by weapon and distance, spray accuracy | Outlier vs baseline at a comparable distance and weapon |
| Recoil compensation | Residual of view-angle movement against aim punch during sprays | Near-perfect compensation (no-recoil) |
| Triggerbot pattern | Delay from crosshair entering the hitbox to shot fired | Very short with tiny variance |
| Through-obstacle kills | Kill share through smoke, through walls, or while flashed | Outlier vs baseline |
| Counter-strafing | Per shot attempt (first shot after 0.5 s without firing): share fired on the ground below 34% of the weapon's max speed (scoped speed while scoped), i.e. at full accuracy, and of those the share preceded by a counter-strafe (deceleration > 1.6× friction alone on 2+ ticks within 250 ms, or a velocity reversal). Shown as `83%/10%`; the player view shows the median over matches. Timing: ms from the speed dropping under the threshold to the shot, and the share fired within 1 tick of it (fixture demos: humans 0–25%, median 50–350 ms). Weight 0 until validated (owner request 2026-10-14) | Auto-stop: shots fire on the tick the player becomes accurate, almost every time |
| Aim lock (hidden) | Moments the crosshair stays on one spot of an enemy who is not visible (not in the spotted mask for 250 ms+): on the body, the spot on the victim (lateral/vertical offset from the body centre in world units, 5-tick smoothed for GOTV angle plateaus) drifting less than 5 u while the line of sight sweeps over 32 u across the victim because either player moves, for 1 s or longer. Metrics: lock count, longest lock (scored), total lock time; each lock is a flagged moment with the spot (head, chest, …). Fixture demos: no lock ≥ 1 s up to a 6 u tolerance (at 8 u three legit locks of 1.2–3.2 s appear, all with a slow sweep of 34–104 u). Owner request 2026-10-14 | Any lock over 1 s; longer is more suspicious. Unlike the dropped wall tracking, holding an angle or pre-aiming a hidden enemy doesn't count, because the spot drifts as soon as anyone moves |

Wall tracking (crosshair on occluded enemies) was removed (owner decision 2026-10-14): legit players holding a common angle, aiming into smokes or looking at enemies stacked behind one wall scored as high as wall-trackers, so it produced false positives rather than signal.

Later ideas: information-based behaviour (ESP), such as rotations, utility thrown at hidden enemies, and checking fewer angles. Also aim smoothness or humanizer signatures, and target-switch speed in multi-kills.

### Baseline and suspicion score

- R-SCORE-1: The baseline is the distribution of each metric over all players in the user's own demos, stratified where it matters (weapon class, distance band, map). There is no data from other users (R-PRIV-3). Every match must get a score, including a user's first and only match (owner decision 2026-10-14). So while a metric has fewer than `baselineMin` (default 20) player-match values in the user's demos, it is compared with a built-in reference distribution instead: aggregate quantiles shipped in `server/src/analysis/reference.json`, generated by `npm run reference` from the owner's fixture demos (no SteamIDs, names or per-player rows). Regenerate it as more demos become available and bump `SCORE_VERSION`. The breakdown shows which baseline each indicator used.
- R-SCORE-2: Each metric becomes a percentile or z-score vs the baseline. The suspicion score is a weighted combination (0–100), with configurable weights and thresholds per indicator.
- R-SCORE-3: A minimum sample size per player and indicator is required (for example ≥ N engagements), and at least 3 indicators must qualify. Below that the score shows "insufficient data" rather than a number. A small baseline is not a reason for "insufficient data" (see R-SCORE-1).
- R-SCORE-4: Scores are computed for all players of both teams. Each score lists which indicators contributed and how much. It's an aid for investigation, not a verdict, and the UI says so.
- R-SCORE-5: A per-player view aggregates across all of the user's matches with that SteamID, for recurring opponents or teammates. The aggregated score is the sample-weighted mean of the per-match scores.

## Frontend

The frontend is a Svelte single-page app (Vite build, plain CSS, no UI framework), served as static files by the Node backend. Charts use a small library such as uPlot or Chart.js.

| Page | Contents |
| --- | --- |
| Login | "Login with Discord" button; a "not whitelisted" message for rejected IDs |
| Matches | List of the user's matches: date, mode, map, score, own K/D, processing status, highest suspicion score in the match. Filters by mode, map and date. Clicking a row expands a simplified scoreboard (Team A left, Team B right: K, A, D, K/D, ADR, suspicion) under a full-width "Show match details" button. |
| Import | Upload by drag and drop, plus extension setup: download link, API key, instructions. Live job status. |
| Match detail | Scoreboard tab, rounds tab, utility and economy tab, cheat-analysis tab (per-player indicator table + suspicion score with breakdown) |
| Player | One SteamID across the user's matches: stats, indicator trends, aggregated suspicion score |
| My stats | Personal trends (R-TREND) |
| Settings | Linked SteamID64, extension API keys (create/revoke), delete my data |
| Admin | Whitelist management (add/remove Discord ID, note, admin flag), map files (select map, upload .vpk, status), job queue overview, disk usage |

- R-UI-1: Responsive down to laptop width; mobile only needs to be readable.
- R-UI-2: Dark theme by default.
- R-UI-3: Job status updates live via polling or Server-Sent Events.

## Architecture, stack and deployment

The app ships as one Docker image running two Node processes, web/API and worker, that share one mounted data volume. It deploys with the same `deployment.json` + reusable GitHub workflow as the blog.

```
 Chromium extension ──HTTPS + API key──┐
                                       ▼
 Svelte SPA ─────────session cookie──► Web / API (Node, Fastify) ──► Discord OAuth2
                                       │   login, whitelist, ingest, upload,
                                       │   serves SPA + JSON API, reads SQLite/DuckDB
                                       │ jobs (SQLite queue)
                                       ▼
                                     Worker (Node) ──► Valve replay servers (.dem.bz2)
                                       │   download, decompress, demoparser2 → Parquet,
                                       │   stats, indicators, scores
                                       ▼
                         Data volume /data: SQLite · Parquet per match · raw demos · maps
```

The extension and the SPA only talk to the API. The worker alone downloads from Valve and writes Parquet, and jobs pass between the two processes through a SQLite-backed queue.

### Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript | One language for API, worker and extension |
| Web framework | Fastify | Static file serving, streamed raw-body uploads (`PUT` with `application/octet-stream`, so XHR can show progress and 5 GB files never touch memory), cookies |
| Frontend | Svelte 5 + Vite, plain CSS | Built into `dist/` and served by Fastify |
| Demo parser | `@laihoe/demoparser2` | Rust core with Node bindings; CS2 support |
| App DB | SQLite via `better-sqlite3` | Migrations in the repo; WAL mode |
| Analytics | Parquet + DuckDB (`@duckdb/node-api`) | Tick-level queries |
| Job queue | Table in SQLite, polled by the worker | No Redis needed |
| Extension | Manifest V3, TypeScript, built by Vite | Lives in the same repo under `extension/` |

Repo layout (monorepo): `server/` (API + worker), `web/` (Svelte), `extension/`, `shared/` (types for API payloads), `fixtures/` (gitignored real data), `docs/`, `Dockerfile`, `deployment.json`, `.github/workflows/build-and-deploy.yml`.

### Deployment

- R-DEP-1: A multi-stage `Dockerfile`: build web, server and extension zip, then a slim `node:22` runtime image. demoparser2 ships prebuilt native binaries, so the runtime image must match their libc (Debian-slim is the safer bet than Alpine).
- R-DEP-2: A single entrypoint starts both processes, either as a supervisor script or with the API spawning the worker as a child process. If either dies, the container exits and gets restarted.
- R-DEP-3: `deployment.json`:

```json
{
  "version": "0.1.0",
  "name": "mbuelow.dev/demo-analyzer",
  "tag": "latest",
  "url": "https://demo-analyzer.mbuelow.dev",
  "informDiscord": true,
  "deployImages": [
    {
      "name": "mbuelow.dev/demo-analyzer",
      "tag": "latest",
      "argPorts": "-p 172.17.0.1:16018:3000",
      "argVolumes": "-v /var/demo-analyzer/data:/data",
      "argExtra": "--init -e TZ=Europe/Berlin -e DATA_DIR=/data -e PUBLIC_URL=https://demo-analyzer.mbuelow.dev -e DISCORD_CLIENT_ID=1422897079751147642 -e DISCORD_CLIENT_SECRET -e SESSION_SECRET"
    }
  ]
}
```

`DISCORD_CLIENT_ID` is the Discord application's public client ID, not a secret.

`/deployments/mbuelow_dev_demo_analyzer` is wiped on every deploy (`deploy-repository.sh` runs `rm -rf` on it), so nothing persistent may live there. Data lives at `/var/demo-analyzer/data` (already created on the host, 30+ GB free). Secrets use bare `-e NAME`, which passes the value through from the host environment (`DISCORD_CLIENT_SECRET` and `SESSION_SECRET` are already set there). Non-secret config is inline. The deploy scripts already add `--restart=unless-stopped` and `--add-host host.docker.internal:host-gateway`.

- R-DEP-4: `.github/workflows/build-and-deploy.yml` reuses `mbuelowdev/ssh-docker-deployment/.github/workflows/build-and-deploy.yml@master` with the same inputs and secrets as `~/Repositories/blog/.github/workflows/build-and-deploy.yml` (`DEPLOYMENT_SSH_KEY`, `DISCORD_BOT_TOKEN` are set on the GitHub repo). It triggers on pushes to `master` that change `deployment.json`, and via `workflow_dispatch`. Deploying = bumping `version` in `deployment.json`.
- R-DEP-5: Secrets (Discord client secret, session secret) are set in the host environment and passed through with bare `-e` flags; they are never baked into the image or committed.
- R-DEP-6: eydu-ingress (nginx) terminates HTTPS and proxies demo-analyzer.mbuelow.dev to host port 16018 with 5 GB request bodies, request buffering off and 2 h timeouts for demo and .vpk uploads. This is already configured and deployed (`~/Repositories/eydu-ingress/nginx/sites/mbuelow.dev/demo-analyzer.mbuelow.dev.conf`). The app listens on port 3000 inside the container.
- R-DEP-7: `GET /healthz` reports DB access and worker heartbeat.

## Security and non-functional requirements

The main risks are untrusted uploaded files, the extension API key, and server-side fetches of URLs that users supply. Each one gets an explicit control.

**Security**

- R-SEC-1: Every endpoint except login, the OAuth callback and `/healthz` requires a valid session or an extension API key. Every data query is scoped by `user_id`.
- R-SEC-2: Extension API keys are random (≥ 32 bytes) and stored hashed. They're scoped to the ingest endpoints only and can be revoked.
- R-SEC-3: SSRF protection: the worker only downloads URLs matching `^https?://replay\d+\.valve\.net/730/\d+_\d+\.dem\.bz2$`, and only up to a size limit.
- R-SEC-4: Uploads are size-limited, header-validated, and stored under generated names. User file names are never used as paths.
- R-SEC-5: The parser runs in a separate process with memory and time limits, so a malformed demo can't take down the API.
- R-SEC-6: OAuth `state` parameter, CSRF protection on cookie-authenticated state-changing requests, a strict CORS policy (extension origin allowed for ingest only), and rate limiting on login and ingest.
- R-SEC-7: "Delete my data" removes the user's matches, Parquet folders, raw demos and API keys.

**Non-functional**

- R-NFR-1: Scale: about 5–30 users and a few hundred to a few thousand matches in total, on a single host.
- R-NFR-2: Throughput: parsing plus analysis of one match should finish within a few minutes on the VPS. Measure in milestone 1.
- R-NFR-3: Disk usage is shown in the admin view, with a warning threshold. Retention keeps raw demo usage bounded.
- R-NFR-4: Backups mean the SQLite file (online backup API) plus the Parquet folders. A documented host cron is enough.
- R-NFR-5: Structured JSON logs to stdout for `docker logs`.
- R-NFR-6: Tests cover parser runs on the fixture demos, indicator unit tests on synthetic engagements, extension scraping against the saved GCPD page, and API auth and privacy tests. Tests that need gitignored fixtures skip cleanly when the files are absent (e.g. in CI).

## Decisions log

- Host port 16018 (next free in eydu-ingress). Name demo-analyzer, domain demo-analyzer.mbuelow.dev.
- Extension: click "LOAD MORE HISTORY" once, only when the table is empty; send automatically when rows appear; plus a scan button and a manual URL field.
- Valve keeps replays for 2 weeks; the extension is run manually, no scheduling.
- Demos are GOTV recordings without raw input data; indicators must not depend on usercmd data.
- Visibility: start with the spotted mask; ray casting later, using uploaded map files.
- Retention: 3 days, cleaned up when a new download starts; no scheduler.
- The suspicion score covers all players of both teams.
- Every match gets a score: a built-in reference distribution stands in until the user's own demos form a large enough baseline (2026-10-14).
- Map seed list confirmed from a real install.
- 2026-10-14 (milestone 1 spike): usercmd data exists in MM demos but stays research-only; rounds and purchases are derived from tick props because the events are missing; parse in 8192-tick chunks (memory), `parseGrenades` without held grenades.
- Owner admin Discord ID 1012247275940085862 is hardcoded.

## Milestones

1. **Skeleton and spike:** repo structure, Dockerfile, deployment.json, workflow, Discord login, whitelist admin page. Spike: parse the 4 fixture demos, measure time, memory and Parquet size, and record which per-tick fields (including spotted mask, aim punch, any usercmd data) actually exist. Write the findings to `docs/SPIKE.md`.
2. **Acquisition:** extension (flyout, GCPD scraping, ingest), API keys, dedupe, download queue, manual upload, admin map (.vpk) upload, retention cleanup on download.
3. **Parsing pipeline:** full extraction to Parquet, match list, job status, re-parse.
4. **Match stats:** scoreboard, rounds, utility, economy, personal trends.
5. **Cheat-detection foundation:** visibility model, engagement extraction, indicator plugin API, the first indicators (TTD, reaction time, pre-aim, accuracy).
6. **Scoring:** baselines, suspicion score with breakdown, player view, then the remaining indicators.
