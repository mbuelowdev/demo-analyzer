import path from 'node:path';

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

/** R-WL-2: hardcoded owner admin. */
export const OWNER_DISCORD_ID = '1012247275940085862';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  sessionSecret: string;
  adminDiscordIds: string[];
  secureCookies: boolean;
  uploadLimitBytes: number;
  mapUploadLimitBytes: number;
  replayDownloadLimitBytes: number;
  demoRetentionDays: number;
  downloadConcurrency: number;
  parseConcurrency: number;
  parseMemoryLimitMb: number;
  parseInputHistory: boolean;
  parseTimeoutMs: number;
  diskWarnBytes: number;
  webDistDir: string;
  extensionZip: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const root = path.resolve(import.meta.dirname, '..', '..');
  return {
    port: num('PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? path.join(root, 'data')),
    publicUrl,
    discordClientId: env.DISCORD_CLIENT_ID ?? '1422897079751147642',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    adminDiscordIds: (env.ADMIN_DISCORD_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{5,25}$/.test(s)),
    secureCookies: publicUrl.startsWith('https://'),
    uploadLimitBytes: num('UPLOAD_LIMIT_BYTES', 1024 ** 3),
    mapUploadLimitBytes: num('MAP_UPLOAD_LIMIT_BYTES', 5 * 1024 ** 3),
    replayDownloadLimitBytes: num('REPLAY_DOWNLOAD_LIMIT_BYTES', 1024 ** 3),
    demoRetentionDays: num('DEMO_RETENTION_DAYS', 3),
    downloadConcurrency: num('DOWNLOAD_CONCURRENCY', 2),
    parseConcurrency: num('PARSE_CONCURRENCY', 1),
    parseMemoryLimitMb: num('PARSE_MEMORY_LIMIT_MB', 4096),
    parseInputHistory: env.PARSE_INPUT_HISTORY !== '0',
    parseTimeoutMs: num('PARSE_TIMEOUT_MS', 20 * 60 * 1000),
    diskWarnBytes: num('DISK_WARN_BYTES', 10 * 1024 ** 3),
    webDistDir: path.resolve(env.WEB_DIST_DIR ?? path.join(root, 'web', 'dist')),
    extensionZip: path.resolve(env.EXTENSION_ZIP ?? path.join(root, 'extension', 'dist', 'demo-analyzer-extension.zip')),
  };
}

export const config = loadConfig();
