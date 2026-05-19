/**
 * Application error helper.
 *
 * Goals:
 *  - Every error response has a stable machine-readable `code`.
 *  - Sensitive internals never leak: we keep cause/details server-side
 *    and only surface the public `message` + `code` to API clients.
 */

const ERROR_CODES = {
  // Auth / authorization
  UNAUTHORIZED:           { http: 401, code: 'UNAUTHORIZED' },
  FORBIDDEN:              { http: 403, code: 'FORBIDDEN' },
  TOKEN_EXPIRED:          { http: 401, code: 'TOKEN_EXPIRED' },

  // Validation
  VALIDATION_FAILED:      { http: 400, code: 'VALIDATION_FAILED' },
  INVALID_INPUT:          { http: 400, code: 'INVALID_INPUT' },
  MISSING_FIELD:          { http: 400, code: 'MISSING_FIELD' },

  // Resources
  NOT_FOUND:              { http: 404, code: 'NOT_FOUND' },
  CONFLICT:               { http: 409, code: 'CONFLICT' },
  ALREADY_EXISTS:         { http: 409, code: 'ALREADY_EXISTS' },

  // Rate / quota
  RATE_LIMITED:           { http: 429, code: 'RATE_LIMITED' },
  QUOTA_EXCEEDED:         { http: 429, code: 'QUOTA_EXCEEDED' },

  // Payment / subscription
  PAYMENT_FAILED:         { http: 400, code: 'PAYMENT_FAILED' },
  PAYMENT_NOT_FOUND:      { http: 404, code: 'PAYMENT_NOT_FOUND' },
  AMOUNT_MISMATCH:        { http: 400, code: 'AMOUNT_MISMATCH' },
  SUBSCRIPTION_REQUIRED:  { http: 402, code: 'SUBSCRIPTION_REQUIRED' },

  // Upload
  INVALID_FILE:           { http: 400, code: 'INVALID_FILE' },
  FILE_TOO_LARGE:         { http: 413, code: 'FILE_TOO_LARGE' },

  // External services
  UPSTREAM_FAILED:        { http: 502, code: 'UPSTREAM_FAILED' },
  SERVICE_UNAVAILABLE:    { http: 503, code: 'SERVICE_UNAVAILABLE' },

  // Generic fallback
  INTERNAL_ERROR:         { http: 500, code: 'INTERNAL_ERROR' },
};

class AppError extends Error {
  constructor(codeKey, { message, cause, details } = {}) {
    const def = ERROR_CODES[codeKey] || ERROR_CODES.INTERNAL_ERROR;
    super(message || def.code);
    this.name = 'AppError';
    this.code = def.code;
    this.statusCode = def.http;
    if (cause) this.cause = cause;
    if (details) this.details = details;
  }

  /** Shape sent to clients. Never includes `cause` or internal details. */
  toJSON() {
    return { ok: false, error: this.message, code: this.code };
  }
}

function asAppError(err) {
  if (err instanceof AppError) return err;
  return new AppError('INTERNAL_ERROR', { message: 'Internal server error', cause: err });
}

module.exports = { AppError, ERROR_CODES, asAppError };
