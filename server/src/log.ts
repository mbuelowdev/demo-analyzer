// R-NFR-5: structured JSON logs to stdout.
type Level = 'debug' | 'info' | 'warn' | 'error';

const proc = process.env.DA_PROC ?? 'api';

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (process.env.LOG_SILENT === '1') return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, proc, msg, ...fields };
  if (fields?.err instanceof Error) line.err = { message: fields.err.message, stack: fields.err.stack };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => process.env.LOG_DEBUG && write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};
