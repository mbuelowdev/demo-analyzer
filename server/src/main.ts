// API entrypoint. R-DEP-2: starts the worker as a child process; if either dies, the container exits
// (and docker restarts it).
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db/index.ts';
import { dataPaths, ensureDataDirs } from './lib/paths.ts';
import { log } from './log.ts';

async function main() {
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    if (config.secureCookies) throw new Error('SESSION_SECRET must be set (≥ 16 chars) in production');
    log.warn('SESSION_SECRET not set; using an insecure dev default');
    config.sessionSecret = 'dev-insecure-session-secret';
  }
  if (!config.discordClientSecret) log.warn('DISCORD_CLIENT_SECRET not set; Discord login will fail');
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const db = openDb(paths.db);
  const app = await buildApp({ config, db });
  await app.listen({ port: config.port, host: config.host });
  log.info('api listening', { port: config.port, publicUrl: config.publicUrl, dataDir: config.dataDir });

  let worker: ChildProcess | null = null;
  if (process.env.DA_NO_WORKER !== '1') {
    const isTs = import.meta.filename.endsWith('.ts');
    const entry = path.join(import.meta.dirname, isTs ? 'worker/main.ts' : 'worker.js');
    worker = fork(entry, [], { env: { ...process.env, DA_PROC: 'worker', DA_WORKER_MAIN: '1' }, execArgv: isTs ? ['--import', 'tsx'] : [] });
    worker.on('exit', (code, signal) => {
      log.error('worker exited, shutting down', { code, signal });
      process.exit(1);
    });
  }

  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    worker?.removeAllListeners('exit');
    worker?.kill('SIGTERM');
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal', { err });
  process.exit(1);
});
