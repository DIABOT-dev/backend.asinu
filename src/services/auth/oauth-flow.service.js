const crypto = require('crypto');
const { getRedis } = require('../../lib/redis');

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_EXCHANGE_TTL_SECONDS = 60;
const OAUTH_STATE_COOKIE = 'asinu_oauth_state';

const CALLBACK_URIS = Object.freeze({
  google: 'asinu-lite://auth/google/callback',
  zalo: 'asinu-lite://auth/zalo/callback',
  facebook: 'asinu-lite://auth/facebook/callback',
});

class OAuthFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stateKey(state) {
  return `asinu:oauth:state:${hashToken(state)}`;
}

function exchangeKey(code) {
  return `asinu:oauth:exchange:${hashToken(code)}`;
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookie values. They must not turn a public OAuth
        // callback into a 500 or bypass the state check.
      }
      return cookies;
    }, {});
}

function setStateCookie(req, res, state) {
  const secure = Boolean(req.secure) || process.env.NODE_ENV === 'production';
  const attributes = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearStateCookie(req, res) {
  const secure = Boolean(req.secure) || process.env.NODE_ENV === 'production';
  const attributes = [
    `${OAUTH_STATE_COOKIE}=`,
    'Max-Age=0',
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function assertProvider(provider) {
  if (!Object.prototype.hasOwnProperty.call(CALLBACK_URIS, provider)) {
    throw new OAuthFlowError('INVALID_PROVIDER', 'Unsupported OAuth provider');
  }
}

function assertCodeChallenge(codeChallenge) {
  if (
    typeof codeChallenge !== 'string' ||
    codeChallenge.length < 43 ||
    codeChallenge.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(codeChallenge)
  ) {
    throw new OAuthFlowError('PKCE_REQUIRED', 'A valid S256 PKCE code challenge is required');
  }
}

async function createOAuthState(req, res, { provider, codeChallenge }) {
  assertProvider(provider);
  assertCodeChallenge(codeChallenge);

  const state = randomToken(32);
  const redis = getRedis();
  try {
    await redis.set(
      stateKey(state),
      JSON.stringify({ provider, codeChallenge, createdAt: Date.now() }),
      'EX',
      OAUTH_STATE_TTL_SECONDS
    );
  } catch (err) {
    throw new OAuthFlowError('OAUTH_STATE_UNAVAILABLE', `OAuth state store unavailable: ${err.message}`);
  }

  setStateCookie(req, res, state);
  return state;
}

async function consumeOAuthState(req, res, provider) {
  assertProvider(provider);
  const queryState = typeof req.query?.state === 'string' ? req.query.state : '';
  const cookieState = parseCookies(req.headers?.cookie)[OAUTH_STATE_COOKIE] || '';

  if (!queryState || !cookieState) {
    throw new OAuthFlowError('INVALID_OAUTH_STATE', 'OAuth state is missing');
  }

  const queryHash = Buffer.from(hashToken(queryState));
  const cookieHash = Buffer.from(hashToken(cookieState));
  if (
    queryHash.length !== cookieHash.length ||
    !crypto.timingSafeEqual(queryHash, cookieHash)
  ) {
    throw new OAuthFlowError('INVALID_OAUTH_STATE', 'OAuth state does not match the browser session');
  }

  let raw;
  try {
    // GET + DEL is atomic, so a callback cannot be replayed across workers.
    raw = await getRedis().eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      stateKey(queryState)
    );
  } catch (err) {
    throw new OAuthFlowError('OAUTH_STATE_UNAVAILABLE', `OAuth state store unavailable: ${err.message}`);
  } finally {
    clearStateCookie(req, res);
  }

  if (!raw) {
    throw new OAuthFlowError('INVALID_OAUTH_STATE', 'OAuth state is invalid or expired');
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new OAuthFlowError('INVALID_OAUTH_STATE', 'OAuth state is malformed');
  }

  if (record.provider !== provider) {
    throw new OAuthFlowError('INVALID_OAUTH_STATE', 'OAuth provider does not match the state');
  }
  assertCodeChallenge(record.codeChallenge);
  return record;
}

async function createOAuthExchange(result, { provider, codeChallenge }) {
  assertProvider(provider);
  assertCodeChallenge(codeChallenge);
  if (!result?.ok || !result.token) {
    throw new OAuthFlowError('OAUTH_LOGIN_FAILED', 'Provider login did not return a session');
  }

  const code = randomToken(32);
  try {
    await getRedis().set(
      exchangeKey(code),
      JSON.stringify({
        provider,
        codeChallenge,
        token: result.token,
        user: result.user || null,
        createdAt: Date.now(),
      }),
      'EX',
      OAUTH_EXCHANGE_TTL_SECONDS
    );
  } catch (err) {
    throw new OAuthFlowError('OAUTH_EXCHANGE_UNAVAILABLE', `OAuth exchange store unavailable: ${err.message}`);
  }
  return code;
}

async function exchangeOAuthCode(code, codeVerifier) {
  if (
    typeof code !== 'string' ||
    code.length < 43 ||
    !/^[A-Za-z0-9_-]+$/.test(code) ||
    typeof codeVerifier !== 'string' ||
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(codeVerifier)
  ) {
    throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth code or PKCE verifier is invalid');
  }

  let raw;
  try {
    raw = await getRedis().get(exchangeKey(code));
  } catch (err) {
    throw new OAuthFlowError('OAUTH_EXCHANGE_UNAVAILABLE', `OAuth exchange store unavailable: ${err.message}`);
  }
  if (!raw) throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth code is invalid or expired');

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth code is malformed');
  }

  const expected = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(record.codeChallenge || ''));
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth PKCE verification failed');
  }

  let consumed;
  try {
    consumed = await getRedis().eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      exchangeKey(code)
    );
  } catch (err) {
    throw new OAuthFlowError('OAUTH_EXCHANGE_UNAVAILABLE', `OAuth exchange store unavailable: ${err.message}`);
  }
  if (!consumed) throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth code has already been used');
  try {
    const record = JSON.parse(consumed);
    if (!record || typeof record.token !== 'string' || !record.token) {
      throw new Error('invalid exchange record');
    }
    return record;
  } catch {
    throw new OAuthFlowError('INVALID_OAUTH_CODE', 'OAuth code is malformed');
  }
}

function appRedirect(provider, params = {}) {
  assertProvider(provider);
  const query = new URLSearchParams(params);
  return `${CALLBACK_URIS[provider]}${query.toString() ? `?${query.toString()}` : ''}`;
}

module.exports = {
  CALLBACK_URIS,
  OAuthFlowError,
  appRedirect,
  createOAuthState,
  consumeOAuthState,
  createOAuthExchange,
  exchangeOAuthCode,
};
