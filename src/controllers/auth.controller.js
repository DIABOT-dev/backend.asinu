const { t, getLang } = require('../i18n');
const { registerSchema, loginSchema } = require('../validation/validation.schemas');
const {
  registerByEmail: serviceRegister,
  loginByEmail: serviceLogin,
  loginByProvider: serviceLoginProvider,
  getCurrentUser,
  searchUsers: serviceSearchUsers,
  verifySocialToken,
} = require('../services/auth/auth.service');
const {
  OAuthFlowError,
  appRedirect,
  createOAuthState,
  consumeOAuthState,
  createOAuthExchange,
  exchangeOAuthCode: exchangeOAuthSessionCode,
} = require('../services/auth/oauth-flow.service');

function backendCallbackUri(provider) {
  const backendUrl = (
    process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/$/, '');
  return `${backendUrl}/api/auth/${provider}/callback`;
}

function oauthErrorCode(err) {
  if (err instanceof OAuthFlowError) {
    return ['INVALID_OAUTH_STATE', 'PKCE_REQUIRED'].includes(err.code)
      ? err.code.toLowerCase()
      : 'server_error';
  }
  return 'server_error';
}

function redirectOAuthError(res, provider, error) {
  return res.redirect(appRedirect(provider, { error }));
}

function decodeJwtJsonPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// =====================================================
// REGISTER
// =====================================================

async function registerByEmail(pool, req, res) {
  try {
    const parsed = registerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((issue) => issue.message).join(', ');
      return res.status(400).json({ ok: false, error: errorMessages });
    }

    const { email, phone_number, password, full_name, display_name } = parsed.data;
    const result = await serviceRegister(
      pool,
      email,
      password,
      phone_number,
      full_name,
      display_name
    );

    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Auth] registerByEmail error:', err.message);
    return res.status(500).json({ ok: false, error: 'Đăng ký thất bại, vui lòng thử lại.' });
  }
}

// =====================================================
// LOGIN BY EMAIL/PHONE
// =====================================================

async function loginByEmail(pool, req, res) {
  try {
    const parsed = loginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((issue) => issue.message).join(', ');
      return res.status(400).json({ ok: false, error: errorMessages });
    }

    const { identifier, password } = parsed.data;
    const result = await serviceLogin(pool, identifier, password);

    if (!result.ok) {
      return res.status(401).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Auth] loginByEmail error:', err.message);
    return res.status(500).json({ ok: false, error: 'Đăng nhập thất bại, vui lòng thử lại.' });
  }
}

// =====================================================
// LOGIN BY SOCIAL PROVIDERS
// =====================================================

async function loginByProvider(pool, req, res, provider, idColumn) {
  const { token, provider_id, email, full_name, phone_number } = req.body || {};

  // Validate token
  if (!token) {
    return res.status(400).json({ ok: false, error: t('error.missing_auth_token', getLang(req)) });
  }

  // Verify token with provider (now async, returns { valid, profile })
  const verification = await verifySocialToken(provider, token);
  if (!verification.valid) {
    return res.status(401).json({ ok: false, error: t('error.invalid_token', getLang(req)) });
  }

  // Use verified email/sub from provider if available, fallback to request body
  const verifiedEmail = verification.profile?.email || email;
  const verifiedSub = verification.profile?.sub;

  // Get or generate provider_id — prefer verified sub from provider
  let actualProviderId = verifiedSub || provider_id;
  if (!actualProviderId && verifiedEmail) {
    actualProviderId = `${provider}_${verifiedEmail}`;
  }

  if (!actualProviderId) {
    return res
      .status(400)
      .json({ ok: false, error: t('error.missing_provider_id_or_email', getLang(req)) });
  }

  // Call service
  const result = await serviceLoginProvider(
    pool,
    idColumn,
    actualProviderId,
    provider,
    verifiedEmail,
    phone_number,
    full_name
  );

  if (!result.ok) {
    // Preserve business conflicts such as an email that already belongs to
    // an email/password account. The client can then show the correct next step.
    return res.status(result.statusCode || 401).json(result);
  }

  return res.status(200).json(result);
}

async function loginByGoogle(pool, req, res) {
  return loginByProvider(pool, req, res, 'google', 'google_id');
}

async function loginByApple(pool, req, res) {
  return loginByProvider(pool, req, res, 'apple', 'apple_id');
}

async function loginByZalo(pool, req, res) {
  const { code, code_verifier } = req.body || {};
  const lang = getLang(req);

  if (!code || !code_verifier) {
    // Fallback: token-based flow (legacy)
    return loginByProvider(pool, req, res, 'zalo', 'zalo_id');
  }

  try {
    // Exchange code for access_token with Zalo
    const tokenRes = await fetch('https://oauth.zaloapp.com/v4/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: process.env.ZALO_SECRET_KEY,
      },
      body: new URLSearchParams({
        app_id: process.env.ZALO_APP_ID,
        grant_type: 'authorization_code',
        code,
        code_verifier,
      }).toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
    }

    // Get Zalo user profile (request phone if app has permission)
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture,phone', {
      headers: { access_token: tokenData.access_token },
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
    }

    const { normalizePhoneNumber } = require('../services/auth/auth.service');
    const zaloPhone = profile.phone ? normalizePhoneNumber(profile.phone) : null;
    const result = await serviceLoginProvider(
      pool,
      'zalo_id',
      String(profile.id),
      'zalo',
      null,
      zaloPhone
    );
    if (!result.ok) return res.status(401).json(result);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

/**
 * GET /api/auth/zalo/callback
 * Zalo redirects here with ?code=&state=
 * Exchange code → get profile → create user → redirect with a one-time PKCE code.
 */
async function zaloCallback(pool, req, res) {
  let oauthState;
  try {
    oauthState = await consumeOAuthState(req, res, 'zalo');
  } catch (err) {
    return redirectOAuthError(res, 'zalo', oauthErrorCode(err));
  }

  const { code } = req.query;

  if (!code) {
    return redirectOAuthError(res, 'zalo', 'no_code');
  }

  try {
    // Exchange code for access_token
    const redirectUri = backendCallbackUri('zalo');
    const tokenRes = await fetch('https://oauth.zaloapp.com/v4/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: process.env.ZALO_SECRET_KEY,
      },
      body: new URLSearchParams({
        app_id: process.env.ZALO_APP_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return redirectOAuthError(res, 'zalo', 'token_exchange_failed');
    }

    // Get user profile (request phone if app has permission)
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture,phone', {
      headers: { access_token: tokenData.access_token },
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return redirectOAuthError(res, 'zalo', 'profile_failed');
    }

    const { normalizePhoneNumber } = require('../services/auth/auth.service');
    const zaloPhone = profile.phone ? normalizePhoneNumber(profile.phone) : null;
    const result = await serviceLoginProvider(
      pool,
      'zalo_id',
      String(profile.id),
      'zalo',
      null,
      zaloPhone
    );
    if (!result.ok) {
      return redirectOAuthError(res, 'zalo', 'login_failed');
    }

    const exchangeCode = await createOAuthExchange(result, {
      provider: 'zalo',
      codeChallenge: oauthState.codeChallenge,
    });
    return res.redirect(appRedirect('zalo', { code: exchangeCode }));
  } catch (err) {
    return redirectOAuthError(res, 'zalo', 'server_error');
  }
}

/**
 * GET /api/auth/facebook/callback
 * Facebook redirects here with ?code=
 * Exchange code → get profile → create user → redirect with a one-time PKCE code.
 */
async function facebookCallback(pool, req, res) {
  let oauthState;
  try {
    oauthState = await consumeOAuthState(req, res, 'facebook');
  } catch (err) {
    return redirectOAuthError(res, 'facebook', oauthErrorCode(err));
  }

  const { code } = req.query;

  if (!code) {
    return redirectOAuthError(res, 'facebook', 'no_code');
  }

  try {
    const redirectUri = backendCallbackUri('facebook');

    // Exchange code for access_token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?${new URLSearchParams({
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      })}`
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return redirectOAuthError(res, 'facebook', 'token_exchange_failed');
    }

    // Get user profile
    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();

    if (!profile.id) {
      return redirectOAuthError(res, 'facebook', 'profile_failed');
    }

    const email = profile.email || null;
    const result = await serviceLoginProvider(
      pool,
      'facebook_id',
      String(profile.id),
      'facebook',
      email,
      null
    );
    if (!result.ok) {
      return redirectOAuthError(res, 'facebook', 'login_failed');
    }

    const exchangeCode = await createOAuthExchange(result, {
      provider: 'facebook',
      codeChallenge: oauthState.codeChallenge,
    });
    return res.redirect(appRedirect('facebook', { code: exchangeCode }));
  } catch (err) {
    console.error('[Facebook callback] error:', err.message);
    return redirectOAuthError(res, 'facebook', 'server_error');
  }
}

// =====================================================
// GET CURRENT USER
// =====================================================

async function getMe(pool, req, res) {
  const lang = getLang(req);
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.missing_auth_token', lang) });
  }

  try {
    const user = await getCurrentUser(pool, req.user.id);
    if (!user) {
      return res.status(401).json({ ok: false, error: t('error.user_not_found', lang) });
    }
    return res.status(200).json({ ok: true, user });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

// =====================================================
// SEARCH USERS
// =====================================================

async function searchUsers(pool, req, res) {
  const { q } = req.query;

  try {
    const users = await serviceSearchUsers(pool, req.user.id, q);
    return res.status(200).json({ ok: true, users });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// VERIFY TOKEN
// =====================================================

async function verifyToken(pool, req, res) {
  const lang = getLang(req);
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
  }

  try {
    const user = await getCurrentUser(pool, req.user.id);
    if (!user) {
      return res.status(401).json({ ok: false, error: t('error.user_not_found', lang) });
    }

    return res.status(200).json({
      ok: true,
      profile: user,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

/**
 * GET /api/auth/google/initiate
 * Redirect browser to Google OAuth consent screen (server-side flow for Android).
 * The app supplies a PKCE challenge; the backend binds it to this OAuth state.
 */
async function googleInitiate(pool, req, res) {
  const redirectUri = backendCallbackUri('google');
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  const codeChallenge = req.query?.code_challenge;

  if (!clientId) {
    return redirectOAuthError(res, 'google', 'google_not_configured');
  }

  try {
    const state = await createOAuthState(req, res, { provider: 'google', codeChallenge });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state,
    });

    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    return redirectOAuthError(res, 'google', oauthErrorCode(err));
  }
}

/**
 * GET /api/auth/zalo/initiate
 * Start the legacy web/backend Zalo flow with the same state + PKCE contract.
 */
async function zaloInitiate(pool, req, res) {
  const appId = process.env.ZALO_APP_ID;
  if (!appId) return redirectOAuthError(res, 'zalo', 'zalo_not_configured');

  try {
    const state = await createOAuthState(req, res, {
      provider: 'zalo',
      codeChallenge: req.query?.code_challenge,
    });
    const params = new URLSearchParams({
      app_id: appId,
      redirect_uri: backendCallbackUri('zalo'),
      state,
    });
    return res.redirect(`https://oauth.zaloapp.com/v4/permission?${params.toString()}`);
  } catch (err) {
    return redirectOAuthError(res, 'zalo', oauthErrorCode(err));
  }
}

/**
 * GET /api/auth/facebook/initiate
 * Start the legacy web/backend Facebook flow with the same state + PKCE contract.
 */
async function facebookInitiate(pool, req, res) {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) return redirectOAuthError(res, 'facebook', 'facebook_not_configured');

  try {
    const state = await createOAuthState(req, res, {
      provider: 'facebook',
      codeChallenge: req.query?.code_challenge,
    });
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: backendCallbackUri('facebook'),
      response_type: 'code',
      scope: 'email,public_profile',
      state,
    });
    return res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`);
  } catch (err) {
    return redirectOAuthError(res, 'facebook', oauthErrorCode(err));
  }
}

/**
 * GET /api/auth/google/callback
 * Google redirects here with ?code=
 * Exchange code → get profile → redirect with a one-time PKCE code.
 */
async function googleCallback(pool, req, res) {
  let oauthState;
  try {
    oauthState = await consumeOAuthState(req, res, 'google');
  } catch (err) {
    return redirectOAuthError(res, 'google', oauthErrorCode(err));
  }

  const { code } = req.query;

  if (!code) {
    return redirectOAuthError(res, 'google', 'no_code');
  }

  try {
    const redirectUri = backendCallbackUri('google');
    const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET;

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return redirectOAuthError(res, 'google', 'token_exchange_failed');
    }

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return redirectOAuthError(res, 'google', 'profile_failed');
    }

    const result = await serviceLoginProvider(
      pool,
      'google_id',
      String(profile.id),
      'google',
      profile.email || null,
      null
    );
    if (!result.ok) {
      return redirectOAuthError(res, 'google', 'login_failed');
    }

    const exchangeCode = await createOAuthExchange(result, {
      provider: 'google',
      codeChallenge: oauthState.codeChallenge,
    });
    return res.redirect(appRedirect('google', { code: exchangeCode }));
  } catch (err) {
    return redirectOAuthError(res, 'google', 'server_error');
  }
}

/**
 * POST /api/auth/oauth/exchange
 * Exchange the short-lived callback code for the API JWT after PKCE succeeds.
 */
async function exchangeOAuthCodeHandler(pool, req, res) {
  try {
    const { code, code_verifier: codeVerifier } = req.body || {};
    const result = await exchangeOAuthSessionCode(code, codeVerifier);
    return res.status(200).json({ ok: true, token: result.token, user: result.user || null });
  } catch (err) {
    const status = err instanceof OAuthFlowError && err.code === 'OAUTH_EXCHANGE_UNAVAILABLE' ? 503 : 401;
    return res.status(status).json({ ok: false, error: 'OAuth code is invalid or expired' });
  }
}

/**
 * POST /api/auth/facebook/token
 * Android native FBSDK flow — receives FB access_token, validates with Graph API, returns app JWT
 */
async function loginByFacebookToken(pool, req, res) {
  const { access_token, id_token, user_id } = req.body || {};
  if (!access_token && !id_token && !user_id) {
    return res.status(400).json({ ok: false, error: 'access_token or id_token required' });
  }
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;

    let userId = null;
    let email = null;

    if (id_token) {
      // iOS SDK v16+ Limited Login: verify JWT via Facebook JWKS
      console.log('[FB token] iOS id_token flow');
      if (!appId) {
        return res.status(503).json({ ok: false, error: 'Facebook login is not configured' });
      }

      const tokenParts = String(id_token).split('.');
      if (tokenParts.length !== 3) {
        return res.status(401).json({ ok: false, error: 'Invalid Facebook id_token' });
      }

      const [headerB64Pre, payloadB64Pre] = tokenParts;
      const headerPre = decodeJwtJsonPart(headerB64Pre);
      const unverifiedPayload = decodeJwtJsonPart(payloadB64Pre);
      const validIssuers = ['https://www.facebook.com', 'https://limited.facebook.com'];
      if (
        !headerPre ||
        !unverifiedPayload ||
        headerPre.alg !== 'RS256' ||
        unverifiedPayload.aud !== appId ||
        !validIssuers.includes(unverifiedPayload.iss)
      ) {
        return res
          .status(401)
          .json({ ok: false, error: 'Invalid Facebook id_token: aud/iss/alg mismatch' });
      }

      const jwksUrl =
        unverifiedPayload.iss === 'https://limited.facebook.com'
          ? 'https://limited.facebook.com/.well-known/oauth/openid/jwks/'
          : 'https://www.facebook.com/.well-known/oauth/openid/jwks/';

      // Fetch JWKS from Facebook
      const jwksRes = await fetch(jwksUrl);
      const jwks = await jwksRes.json();

      // The header was parsed and validated above before any network call.
      const header = headerPre;
      const jwk = jwks.keys?.find((k) => k.kid === header.kid);

      if (!jwk || jwk.kty !== 'RSA') {
        console.error('[FB token] JWKS key not found for kid:', header.kid);
        return res
          .status(401)
          .json({ ok: false, error: 'Invalid Facebook id_token: key not found' });
      }

      // Verify JWT signature using Node crypto
      const crypto = require('crypto');
      const [hB64, pB64, sigB64] = tokenParts;
      const signingInput = `${hB64}.${pB64}`;
      const signature = Buffer.from(sigB64, 'base64url');

      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const valid = crypto.verify('SHA256', Buffer.from(signingInput), pubKey, signature);

      if (!valid) {
        console.error('[FB token] JWT signature invalid');
        return res
          .status(401)
          .json({ ok: false, error: 'Invalid Facebook id_token: bad signature' });
      }

      // The payload was parsed before the signature check and is safe to use
      // only now that the signature has been verified.
      const payload = unverifiedPayload;
      console.log('[FB token] JWT payload verified');

      const now = Math.floor(Date.now() / 1000);
      const clockSkewSeconds = 60;
      if (
        payload.aud !== appId ||
        !validIssuers.includes(payload.iss) ||
        typeof payload.exp !== 'number' ||
        payload.exp <= now - clockSkewSeconds ||
        typeof payload.iat !== 'number' ||
        payload.iat > now + clockSkewSeconds ||
        payload.iat < now - 24 * 60 * 60 ||
        (payload.nbf !== undefined &&
          (typeof payload.nbf !== 'number' || payload.nbf > now + clockSkewSeconds)) ||
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0
      ) {
        return res
          .status(401)
          .json({ ok: false, error: 'Invalid Facebook id_token claims' });
      }

      userId = payload.sub;
      email = payload.email || null;
    } else {
      // Android: standard access_token via debug_token endpoint
      const debugRes = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(access_token)}&access_token=${appId}|${appSecret}`
      );
      const debugJson = await debugRes.json();
      console.log('[FB token] debug_token response:', JSON.stringify(debugJson?.data));

      if (!debugJson?.data?.is_valid || debugJson?.data?.app_id !== appId) {
        console.error('[FB token] debug_token invalid:', JSON.stringify(debugJson));
        return res.status(401).json({ ok: false, error: 'Invalid Facebook access token' });
      }

      userId = debugJson.data.user_id;

      const profileRes = await fetch(
        `https://graph.facebook.com/${userId}?fields=id,name,email&access_token=${appId}|${appSecret}`
      );
      const profile = await profileRes.json();
      email = profile.email || null;
    }

    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Could not determine Facebook user ID' });
    }

    // iOS Limited Login → lưu vào facebook_limited_id (khác facebook_id Standard).
    // Service.loginByProvider sẽ:
    //   1. Lookup theo facebook_limited_id → match nếu user iOS đã login trước
    //   2. Lookup theo email → tự link nếu user đã có account từ Android/web
    //   3. Tạo user mới nếu cả 2 không có
    const idColumn = id_token ? 'facebook_limited_id' : 'facebook_id';
    const result = await serviceLoginProvider(
      pool,
      idColumn,
      String(userId),
      'facebook',
      email,
      null
    );
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || 'Login failed' });
    }

    console.log('[FB token] login success, userId:', userId);
    return res.json({ ok: true, token: result.token });
  } catch (err) {
    console.error('[Facebook token login] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function logoutHandler(pool, req, res) {
  try {
    const { logout } = require('../services/auth/auth.service');
    await logout(pool, req.user.id).catch(() => {});
    return res.json({ ok: true, message: t('success.logged_out', getLang(req)) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  registerByEmail,
  loginByEmail,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  zaloInitiate,
  zaloCallback,
  facebookInitiate,
  facebookCallback,
  loginByFacebookToken,
  googleInitiate,
  googleCallback,
  exchangeOAuthCodeHandler,
  getMe,
  searchUsers,
  verifyToken,
  logoutHandler,
};
