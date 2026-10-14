# AGENTS.md

demo-analyzer: a private web app (demo-analyzer.mbuelow.dev) that collects CS2 matchmaking demos via a Chromium extension, parses them with demoparser2 into tick-level Parquet data, and computes match stats and cheat-detection indicators. Login is Discord OAuth with an admin-managed whitelist.

**The spec is `docs/REQUIREMENTS.md`. Read it fully before writing code.** Requirement IDs (R-AUTH-1, R-EXT-3, …) are referenced in commits and code comments where useful. If something in the spec turns out to be wrong or impossible, update the spec in the same change and say why.

## Current state

All six milestones are implemented (not yet deployed): skeleton + spike (`docs/SPIKE.md`), acquisition (extension, API keys, ingest dedupe, download queue, uploads, admin map upload, retention), parsing pipeline, match stats, cheat-detection foundation with ten indicators (wall tracking was dropped as unreliable; aim lock on hidden enemies replaces it with a stricter "same spot while moving" test; counter-strafing is shown but unweighted), and per-user scoring (own-demo baselines, with a built-in reference distribution in `server/src/analysis/reference.json` so single matches are scored). Next steps are deployment (owner decides), real-world validation of the indicators on more demos, and milestone-6 follow-ups like ray-cast visibility from map files (R-MAP-6, not started).

Layout: `server/src/` (`app.ts` + `routes/` = API, `worker/` = job queue + downloader + task child process, `parse/` = demoparser2 → Parquet, `analysis/` = rounds, stats, engagements, indicators, scoring), `web/src/` (Svelte pages), `extension/src/` (MV3; `scraper.ts` holds all Steam selectors), `shared/src/`.

Commands: `npm run dev` (API + worker on :3000, needs `.env`), `npm run dev:web` (Vite on :5173, proxies the API), `npm test` (the fixture test takes ~2 min and skips without fixtures), `npm run typecheck`, `npm run build`, `npm run spike`, `npm run reference -w server` (regenerates the reference from `data/spike/`; bump `SCORE_VERSION` in `analysis/score.ts` afterwards).

## Fixtures (gitignored, local only)

| Path | What |
|------|------|
| `fixtures/demos/*.dem.bz2` | 4 real CS2 matchmaking demos (GOTV, 110–145 MB compressed each). Use for the parser spike and integration tests. |
| `fixtures/gcpd/matchhistory.html` (+ `_files/`) | A saved Steam GCPD match-history page. Develop and test the extension scraper against it. Contains the scoreboard table `.generic_kv_table.csgo_scoreboard_root` and replay links like `http://replayNNN.valve.net/730/<matchId>_<outcomeId>.dem.bz2`. |

These files contain personal data (a Steam session id, other players' names and SteamIDs). Never commit them, copy them into the image, or paste their contents into issues, docs or commit messages. Tests that need them must skip cleanly when they are absent (CI has no fixtures).

## Fixed decisions (don't re-litigate)

- Stack: Node.js 22 + TypeScript, Fastify, Svelte 5 + Vite (plain CSS), `@laihoe/demoparser2`, SQLite (`better-sqlite3`), Parquet + DuckDB, MV3 extension. Monorepo: `server/`, `web/`, `extension/`, `shared/`.
- One Docker image, two processes (API + worker), one data volume at `DATA_DIR` (`/data` in prod). No Redis, no Postgres, no extra containers.
- Owner admin Discord ID `1012247275940085862` is hardcoded.
- No Steam bot / Game Coordinator. Demo URLs come only from the extension, the manual URL field, or file uploads.
- Visibility v1 = the demo's `spotted` mask. Demos are GOTV; don't depend on usercmd/input data.
- Raw demo retention: 3 days, cleaned up only when a new download starts, except demos a user marked "keep" (R-RET-4). No schedulers or cron anywhere in the app.
- Data is strictly private per user; every query is scoped by user. Map files (admin-uploaded `.vpk`) are the only shared data.

## Deployment

- Deploys via `deployment.json` + `.github/workflows/build-and-deploy.yml`, copied from the pattern in `~/Repositories/blog` (reusable workflow `mbuelowdev/ssh-docker-deployment`). A deploy is triggered by pushing a `version` bump in `deployment.json` to `master`. Only deploy when the owner asks.
- Container port 3000 → host `172.17.0.1:16018`. HTTPS and the domain are handled by eydu-ingress (already set up for large uploads).
- `/deployments/mbuelow_dev_demo_analyzer/` on the host is wiped on every deploy. Persistent data goes to `/var/demo-analyzer/data` (mounted at `/data`).
- Secrets `DISCORD_CLIENT_SECRET` and `SESSION_SECRET` are set in the host environment and passed with bare `-e NAME`. `DISCORD_CLIENT_ID=1422897079751147642` is public config (same Discord app as supermodel) and can be committed. Never commit secrets.
- Git remote: `git@github.com:mbuelowdev/demo-analyzer.git`, branch `master`.

## Local development

- Discord redirect URL for local dev: `http://localhost:3000/auth/discord/callback` (already registered). Local secrets go in a gitignored `.env`.
- Local data dir: `./data/` (gitignored).
- Load the extension unpacked from its build output in a Chromium browser; the app URL is configurable in the extension options.

## Conventions

- Keep the extension dumb: it scrapes and sends; the API dedupes and validates.
- Keep analysis re-runnable from stored Parquet (versioned indicators, `parser_version` / `schema_version` per match).
- Write measured findings (parse time, memory, Parquet size, available fields) to `docs/SPIKE.md` in milestone 1; later design choices should cite them.
