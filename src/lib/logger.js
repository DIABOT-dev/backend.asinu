/**
 * Minimal structured logger. Emits JSON lines so log aggregators (Datadog,
 * Loki, ELK, CloudWatch) can parse them without extra config.
 *
 * Backward-compatible: still writes to stdout/stderr like console.log. Tests
 * can flip LOG_FORMAT=pretty to get human-readable output during development.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const ACTIVE_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const PRETTY = (process.env.LOG_FORMAT || '').toLowerCase() === 'pretty' || process.env.NODE_ENV === 'development';

function serializeError(err) {
  if (!err || typeof err !== 'object') return err;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.code && { code: err.code }),
  };
}

function write(level, msg, ctx) {
  if (LEVELS[level] < ACTIVE_LEVEL) return;
  const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;

  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    ...(ctx && typeof ctx === 'object' ? ctx : {}),
  };
  if (ctx && ctx.err) payload.err = serializeError(ctx.err);

  if (PRETTY) {
    const tag = `[${payload.ts}] ${level.toUpperCase()}`;
    const extra = Object.keys(ctx || {}).length ? ' ' + JSON.stringify({ ...ctx, err: payload.err }) : '';
    out.write(`${tag} ${payload.msg}${extra}\n`);
  } else {
    out.write(JSON.stringify(payload) + '\n');
  }
}

const logger = {
  trace: (msg, ctx) => write('trace', msg, ctx),
  debug: (msg, ctx) => write('debug', msg, ctx),
  info:  (msg, ctx) => write('info',  msg, ctx),
  warn:  (msg, ctx) => write('warn',  msg, ctx),
  error: (msg, ctx) => write('error', msg, ctx),
  fatal: (msg, ctx) => write('fatal', msg, ctx),
  child(bindings) {
    return {
      trace: (msg, ctx) => write('trace', msg, { ...bindings, ...ctx }),
      debug: (msg, ctx) => write('debug', msg, { ...bindings, ...ctx }),
      info:  (msg, ctx) => write('info',  msg, { ...bindings, ...ctx }),
      warn:  (msg, ctx) => write('warn',  msg, { ...bindings, ...ctx }),
      error: (msg, ctx) => write('error', msg, { ...bindings, ...ctx }),
      fatal: (msg, ctx) => write('fatal', msg, { ...bindings, ...ctx }),
    };
  },
};

module.exports = logger;
