'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.sanitizeEvent = sanitizeEvent;
exports.initSentry = initSentry;
exports.captureException = captureException;
exports.sentryRequestHandler = sentryRequestHandler;
exports.sentryErrorHandler = sentryErrorHandler;
exports.flushSentry = flushSentry;
const node_module_1 = require('node:module');
const DEFAULT_SERVICE = 'asinu-backend';
const SAFE_TAGS = new Set([
  'component',
  'operation',
  'job',
  'queue',
  'platform',
  'status_code',
  'method',
  'route',
  'error_code',
]);
let sdk;
const loadSdk = (0, node_module_1.createRequire)(__filename);
let service = DEFAULT_SERVICE;
let enabled = false;
const capturedRequest = Symbol('sentryCaptured');
function releaseName(value) {
  if (
    typeof value === 'string' &&
    /^(?:asinu-doctor|backend\.asinu|asinu-crm|crm(?:\.sentry)?)-[a-f0-9]{7,40}$/i.test(value)
  )
    return value;
  return technicalName(value);
}

function technicalName(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(value) ||
    /\d{7,}/.test(value)
  )
    return undefined;
  return value;
}
function errorCode(value) {
  return typeof value === 'string' && /^(?:[A-Z][A-Z_]{2,39}|[0-9A-Z]{5})$/.test(value)
    ? value
    : undefined;
}
function errorName(value) {
  return typeof value === 'string' && /^(?:[A-Za-z]{1,50}(?:Error|Exception)|Error)$/.test(value)
    ? value
    : 'Error';
}
function safeRoute(value) {
  // Only route patterns (req.route.path), never req.url/originalUrl/baseUrl.
  if (typeof value !== 'string' || value.length > 160 || !/^\/[A-Za-z_/:.*?()-]*$/.test(value))
    return undefined;
  return value;
}
function safeTags(input) {
  const tags = { service };
  for (const [key, raw] of Object.entries(input)) {
    if (!SAFE_TAGS.has(key)) continue;
    const value =
      key === 'route'
        ? safeRoute(raw)
        : key === 'status_code'
          ? Number.isInteger(Number(raw)) && Number(raw) >= 100 && Number(raw) <= 599
            ? String(raw)
            : undefined
          : key === 'error_code'
            ? errorCode(raw)
            : technicalName(raw);
    if (value) tags[key] = value;
  }
  return tags;
}
function safeFrame(frame) {
  const filename =
    typeof frame.filename === 'string' ? frame.filename.split(/[?#]/, 1)[0] : undefined;
  // Deployment-relative files + line/function are enough to locate a bug. No
  // source context, locals, absolute usernames, signed URLs or embedded secrets.
  const path =
    filename && !/[@\s]|(?:https?|s3):/i.test(filename)
      ? filename.replace(/\\/g, '/').split('/').filter(Boolean).slice(-4).join('/')
      : undefined;
  const fn =
    typeof frame.function === 'string' && /^[a-zA-Z0-9_.$<> [\]/-]{1,120}$/.test(frame.function)
      ? frame.function
      : undefined;
  return {
    ...(path ? { filename: path } : {}),
    ...(fn ? { function: fn } : {}),
    ...(Number.isInteger(frame.lineno) ? { lineno: frame.lineno } : {}),
    ...(Number.isInteger(frame.colno) ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
  };
}
/** Allowlist, rather than redact known field names: exceptions can embed health
 * text anywhere (including message, SQL detail, nested causes and breadcrumbs). */
function sanitizeEvent(event, hint) {
  if (event.type) return null; // Transactions/profiles are intentionally disabled.
  const original = hint?.originalException;
  const code = original instanceof Error ? errorCode(original.code) : undefined;
  const tags = safeTags({ ...event.tags, ...(code ? { error_code: code } : {}) });
  const values = event.exception?.values?.map((exception) => ({
    type: errorName(exception.type),
    value: code ? errorName(exception.type) + ': ' + code : errorName(exception.type),
    ...(exception.stacktrace
      ? {
          stacktrace: {
            frames: exception.stacktrace.frames?.map((frame) => safeFrame(frame)),
          },
        }
      : {}),
    ...(exception.mechanism
      ? {
          mechanism: {
            type: technicalName(exception.mechanism.type) || 'generic',
            handled: exception.mechanism.handled,
            ...(typeof exception.mechanism.synthetic === 'boolean'
              ? { synthetic: exception.mechanism.synthetic }
              : {}),
          },
        }
      : {}),
  }));
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'node',
    level: event.level,
    environment:
      technicalName(process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV) || 'development',
    release: releaseName(process.env.SENTRY_RELEASE),
    tags,
    // Route stays templated; merging scope data cannot inject a raw URL.
    ...(tags.route ? { transaction: (tags.method || 'HTTP') + ' ' + tags.route } : {}),
    ...(tags.route && values?.some((value) => value.type === 'HttpResponseError')
      ? { fingerprint: [service, 'http-response', tags.method || 'HTTP', tags.route] }
      : {}),
    ...(values?.length
      ? { exception: { values } }
      : { message: 'Application error (details withheld)' }),
  };
}
/** DSN is optional. Transport injection is for isolated SDK transport tests. */
function initSentry(name = DEFAULT_SERVICE, transport) {
  if (enabled) return true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || process.env.SENTRY_ENABLED === 'false') return false;
  // Fail disabled, without logging DSN/keys, if monitoring is misconfigured.
  try {
    const url = new URL(dsn);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !/^[a-f0-9]+$/i.test(url.username) ||
      url.password ||
      !/\/\d+$/.test(url.pathname)
    )
      return false;
    service = technicalName(name) || DEFAULT_SERVICE;
    sdk = loadSdk('@sentry/node');
    sdk.init({
      dsn,
      environment:
        technicalName(process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV) || 'development',
      release: releaseName(process.env.SENTRY_RELEASE),
      serverName: service,
      sendDefaultPii: false,
      sendClientReports: false,
      autoSessionTracking: false,
      maxBreadcrumbs: 0,
      includeLocalVariables: false,
      enableTracing: false,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      tracePropagationTargets: [],
      integrations: (defaults) => [
        ...defaults.filter((integration) =>
          ['InboundFilters', 'FunctionToString', 'OnUncaughtException', 'Dedupe'].includes(
            integration.name
          )
        ),
        // Preserve Node's fatal-rejection behavior. Sentry v7 defaults to warn.
        new sdk.Integrations.OnUnhandledRejection({ mode: 'strict' }),
      ],
      beforeBreadcrumb: () => null,
      beforeSend: sanitizeEvent,
      beforeSendTransaction: () => null,
      ...(transport ? { transport } : {}),
    });
    const client = sdk.getClient();
    if (!client?.getDsn() || typeof client.on !== 'function') return false;
    // beforeSend cannot remove attachments or the envelope's sampling context.
    // Guard those too, including attachments added by a future caller/scope.
    client.on('beforeEnvelope', (envelope) => {
      delete envelope[0].trace;
      for (let index = envelope[1].length - 1; index >= 0; index -= 1) {
        if (envelope[1][index]?.[0].type !== 'event') envelope[1].splice(index, 1);
      }
    });
    enabled = Boolean(client);
    return enabled;
  } catch {
    sdk = undefined;
    enabled = false;
    return false;
  }
}
function captureException(error, context = {}) {
  if (!enabled || !sdk) return undefined;
  try {
    // Existing Asinu IAP calls use {tags, extra}; retain only allowed tags.
    const nested = context.tags && typeof context.tags === 'object' ? context.tags : {};
    const tags = safeTags({ ...nested, ...context });
    return sdk.withScope((scope) => {
      scope.setTags(tags);
      return sdk.captureException(error instanceof Error ? error : new Error('NonErrorException'));
    });
  } catch {
    return undefined;
  }
}
function requestTags(request, status) {
  return {
    method: request.method,
    route: request.route?.path,
    status_code: status,
    component: 'http',
  };
}
/** Capture error responses even when a controller catches and returns 500 itself. */
function sentryRequestHandler() {
  return (request, response, next) => {
    response.once('finish', () => {
      if (response.statusCode < 500 || request[capturedRequest]) return;
      const error = new Error('HTTP server failure');
      error.name = 'HttpResponseError';
      captureException(error, requestTags(request, response.statusCode));
    });
    next();
  };
}
/** After routes, before application error middleware; never changes the response. */
function sentryErrorHandler() {
  return (error, request, _response, next) => {
    const rawStatus = Number(error?.statusCode || error?.status || 500);
    if (!Number.isFinite(rawStatus) || rawStatus >= 500) {
      request[capturedRequest] = true;
      captureException(error, requestTags(request, Number.isFinite(rawStatus) ? rawStatus : 500));
    }
    next(error);
  };
}
async function flushSentry(timeout = 2000) {
  try {
    return enabled && sdk ? await sdk.flush(timeout) : true;
  } catch {
    return false;
  }
}
