// Ordered schema migrations; PRAGMA user_version tracks how many have run.
// Never edit a released migration, append a new one.
export const MIGRATIONS: string[] = [
  /* 1: auth, whitelist, sessions, api keys (R-AUTH, R-WL, R-EXT-3) */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    discord_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    avatar TEXT,
    steam_id TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE whitelist (
    discord_id TEXT PRIMARY KEY,
    note TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    added_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,            -- sha256 of the cookie token
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,  -- sha256 of the key
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX api_keys_user ON api_keys(user_id);
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 2: demos, per-user matches, jobs, maps (R-DL, R-UP, R-MAP, R-PRIV-2) */ `
  -- One row per physical demo. Shared internally between users who import the same match (R-PRIV-2);
  -- nothing in here is ever returned without going through a user's matches row.
  CREATE TABLE demos (
    id INTEGER PRIMARY KEY,
    replay_key TEXT UNIQUE,         -- <matchId>_<outcomeId> for Valve replays
    replay_url TEXT,
    sha256 TEXT UNIQUE,             -- uploaded files (R-UP-2); for downloads filled after download
    raw_path TEXT,
    raw_size INTEGER,
    raw_downloaded_at INTEGER,
    raw_deleted_at INTEGER,
    status TEXT NOT NULL,           -- queued|downloading|parsing|analysing|analysed|failed|expired
    error TEXT,
    log TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT,
    schema_version INTEGER,
    analysis_version TEXT,
    map TEXT,
    server_name TEXT,
    build TEXT,
    tick_rate REAL,
    duration_s REAL,
    max_tick INTEGER,
    header_json TEXT,
    parse_ms INTEGER,
    parse_peak_rss_mb INTEGER,
    data_size INTEGER,
    parsed_at INTEGER,
    analysed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX demos_status ON demos(status);

  CREATE TABLE matches (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    demo_id INTEGER NOT NULL REFERENCES demos(id),
    source TEXT NOT NULL,           -- gcpd|manual|upload
    mode TEXT NOT NULL DEFAULT 'unknown',
    replay_key TEXT,
    upload_name TEXT,               -- display only, never used as a path (R-SEC-4)
    scraped_json TEXT,              -- GCPD metadata, kept even if the demo expires (R-DL-3)
    played_at INTEGER,
    map_text TEXT,
    score_text TEXT,
    duration_text TEXT,
    max_suspicion REAL,
    scored_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, demo_id)
  );
  CREATE INDEX matches_user ON matches(user_id, played_at);
  CREATE INDEX matches_demo ON matches(demo_id);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,             -- download|parse|analyse|score|map_process
    demo_id INTEGER,
    user_id INTEGER,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    run_after INTEGER NOT NULL,
    locked_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_pending ON jobs(status, type, run_after);

  CREATE TABLE maps (
    name TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    pools TEXT,
    auto_added INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER,
    uploaded_at INTEGER,
    uploaded_by TEXT,
    processed_at INTEGER,
    process_error TEXT
  );
  `,
  /* 3: match analysis results (R-STAT, R-UTIL, R-ECO, R-CD, R-SCORE) */ `
  CREATE TABLE demo_players (
    demo_id INTEGER NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    steam_id TEXT NOT NULL,
    name TEXT,
    team INTEGER,                   -- 2 = T, 3 = CT (starting side)
    team_letter TEXT,               -- 'A' (started T) / 'B' (started CT)
    crosshair_code TEXT,
    rank INTEGER,
    stats_json TEXT NOT NULL,       -- scoreboard, utility, economy, weapons
    PRIMARY KEY (demo_id, steam_id)
  );
  CREATE TABLE demo_rounds (
    demo_id INTEGER NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (demo_id, round)
  );
  CREATE TABLE demo_summary (
    demo_id INTEGER PRIMARY KEY REFERENCES demos(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL
  );
  CREATE TABLE indicator_results (
    demo_id INTEGER NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    steam_id TEXT NOT NULL,
    indicator TEXT NOT NULL,
    version INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    metrics_json TEXT NOT NULL,
    flags_json TEXT,
    PRIMARY KEY (demo_id, steam_id, indicator)
  );
  -- Per-user, because the baseline is built from the user's own demos only (R-PRIV-3).
  CREATE TABLE suspicion_scores (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    steam_id TEXT NOT NULL,
    score REAL,                     -- NULL = insufficient data (R-SCORE-3)
    samples INTEGER NOT NULL,
    breakdown_json TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (match_id, steam_id)
  );
  `,
];
