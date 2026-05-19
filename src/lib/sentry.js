/**
 * Optional Sentry integration. No-ops cleanly when SENTRY_DSN is not set
 * (so dev/CI runs without the dependency installed).
 *
 * Wiring order in server.js:
 *   1. initSentry()                  -- call Sentry.init() only
 *   2. app.use(sentryRequestHandler) -- top of middleware chain
 *   3. ... routes ...
 *   4. app.use(sentryErrorHandler)   -- AFTER routes, BEFORE our error handler
 */

const logger = require('./logger');

let Sentry = null;
let isEnabled = false;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('sentry.disabled', { reason: 'no_dsn' });
    return;
  }
  try {
    // Lazy require so dev/CI without @sentry/node still boots.
    Sentry = require('@sentry/node');
  } catch (err) {
    logger.warn('sentry.disabled', { reason: 'package_missing', err });
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0),
  });

  isEnabled = true;
  logger.info('sentry.enabled', { environment: process.env.NODE_ENV });
}

const noopMiddleware = (_req, _res, next) => next();
const noopErrorMiddleware = (err, _req, _res, next) => next(err);

/**
 * Express request handler. On Sentry v7 this returns the SDK's request
 * handler. On v8+ the SDK auto-instruments Express, so we return a no-op.
 */
function sentryRequestHandler() {
  if (!isEnabled || !Sentry) return noopMiddleware;
  // v7 API
  if (Sentry.Handlers && typeof Sentry.Handlers.requestHandler === 'function') {
    return Sentry.Handlers.requestHandler();
  }
  // v8+: no-op, auto-instrumented
  return noopMiddleware;
}

/**
 * Express error handler. Must be registered AFTER all routes but BEFORE the
 * application's own error handler so it can capture and forward.
 */
function sentryErrorHandler() {
  if (!isEnabled || !Sentry) return noopErrorMiddleware;
  // v8+ provides a helper that installs onto the app directly via
  // Sentry.setupExpressErrorHandler(app). We expose a normal middleware here
  // so the caller can keep its `app.use(...)` ordering consistent.
  if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') {
    return Sentry.Handlers.errorHandler();
  }
  // v8 fallback: capture inline.
  return (err, _req, _res, next) => {
    try {
      Sentry.captureException(err);
    } catch {
      // ignore — never let logging break the response
    }
    next(err);
  };
}

function captureException(err, ctx) {
  if (!isEnabled || !Sentry) {
    logger.error('uncaptured_exception', { err, ...(ctx || {}) });
    return;
  }
  try {
    Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
  } catch (captureErr) {
    logger.error('sentry.capture_failed', { err: captureErr });
  }
}

module.exports = { initSentry, sentryRequestHandler, sentryErrorHandler, captureException };
