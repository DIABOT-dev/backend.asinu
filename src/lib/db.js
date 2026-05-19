/**
 * Postgres pool wrapper with slow-query logging.
 *
 * Drop-in replacement for `new Pool(...)`. Calls to `pool.query(...)` are
 * instrumented: anything that exceeds SLOW_QUERY_MS is logged as a warning
 * with the query text (truncated) and parameters omitted to avoid leaking
 * PII into logs.
 */

const { Pool } = require('pg');
const logger = require('./logger');

const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS || 100);
const MAX_QUERY_PREVIEW = 240;

function preview(sql) {
  if (typeof sql !== 'string') return '<non-string-query>';
  const trimmed = sql.replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_QUERY_PREVIEW
    ? trimmed.slice(0, MAX_QUERY_PREVIEW) + '…'
    : trimmed;
}

function createPool(opts) {
  const pool = new Pool(opts);
  const originalQuery = pool.query.bind(pool);

  pool.query = function instrumentedQuery(...args) {
    const started = Date.now();
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const result = originalQuery(...args);

    // Both callback-style and promise-style queries return a Promise here;
    // attach a then/catch so we always observe completion.
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          const elapsed = Date.now() - started;
          if (elapsed >= SLOW_QUERY_MS) {
            logger.warn('slow_query', { elapsed_ms: elapsed, query: preview(sql) });
          }
        },
        (err) => {
          const elapsed = Date.now() - started;
          logger.error('query_failed', {
            elapsed_ms: elapsed,
            query: preview(sql),
            err,
          });
        }
      );
    }
    return result;
  };

  return pool;
}

module.exports = { createPool };
