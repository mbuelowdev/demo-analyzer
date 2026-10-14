// Worker process: polls the SQLite job queue, downloads, parses, analyses, scores (R-DL-2, R-PARSE-1).
process.env.DA_PROC ??= 'worker';
import { config as defaultConfig, type Config } from '../config.ts';
import { kvSet, openDb, type DB } from '../db/index.ts';
import { claim, complete, fail, recoverStale, pruneFinished, type Job, type JobType } from '../lib/jobs.ts';
import { dataPaths, ensureDataDirs, type DataPaths } from '../lib/paths.ts';
import { log } from '../log.ts';
import { HEARTBEAT_KEY } from '../routes/health.ts';
import { runDownload } from './download.ts';
import { runParse, runAnalyse, queueOutdatedAnalyses } from './pipeline.ts';
import { scoreUser } from '../analysis/score.ts';

export interface WorkerCtx {
  config: Config;
  db: DB;
  paths: DataPaths;
}

type Handler = (ctx: WorkerCtx, job: Job) => Promise<unknown>;

const HANDLERS: Record<JobType, Handler> = {
  download: runDownload,
  parse: runParse,
  analyse: runAnalyse,
  score: async (ctx, job) => {
    if (job.user_id) scoreUser(ctx.db, job.user_id);
    complete(ctx.db, job.id);
  },
};

export function startWorker(config: Config = defaultConfig) {
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const db = openDb(paths.db);
  const ctx: WorkerCtx = { config, db, paths };
  recoverStale(db);
  pruneFinished(db);
  queueOutdatedAnalyses(ctx);

  const beat = () => kvSet(db, HEARTBEAT_KEY, String(process.pid));
  beat();
  setInterval(beat, 5000).unref();

  const slots: Record<JobType, number> = {
    download: config.downloadConcurrency,
    parse: config.parseConcurrency,
    analyse: 1,
    score: 1,
  };
  const running: Record<JobType, number> = { download: 0, parse: 0, analyse: 0, score: 0 };

  const tick = () => {
    for (const type of Object.keys(slots) as JobType[]) {
      while (running[type] < slots[type]) {
        const job = claim(db, type);
        if (!job) break;
        running[type]++;
        log.info('job start', { id: job.id, type, demoId: job.demo_id, attempt: job.attempts });
        HANDLERS[type](ctx, job)
          .catch((err: Error) => {
            log.error('job crashed', { id: job.id, type, err });
            fail(db, job, err.message);
          })
          .finally(() => {
            running[type]--;
            log.info('job end', { id: job.id, type });
          });
      }
    }
  };
  setInterval(tick, 1000);
  tick();
  log.info('worker started', { dataDir: config.dataDir });
}

if (import.meta.filename === process.argv[1] || process.env.DA_WORKER_MAIN === '1') startWorker();
