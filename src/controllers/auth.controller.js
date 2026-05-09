const { t, getLang } = require('../i18n');
const { registerSchema, loginSchema } = require('../validation/validation.schemas');
const {
  registerByEmail: serviceRegister,
  loginByEmail: serviceLogin,
  loginByProvider: serviceLoginProvider,
  getCurrentUser,
  searchUsers: serviceSearchUsers,
  verifySocialToken
} = require('../services/auth/auth.service');

const ZALO_CALLBACK_URI     = 'asinu-lite://auth/zalo/callback';
const FACEBOOK_CALLBACK_URI = 'asinu-lite://auth/facebook/callback';
const GOOGLE_CALLBACK_URI   = 'asinu-lite://auth/google/callback';
// Keep backward-compat alias
const APP_CALLBACK_URI = ZALO_CALLBACK_URI;

// =====================================================
// REGISTER
// =====================================================

async function registerByEmail(pool, req, res) {
  try {
    const parsed = registerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
      return res.status(400).json({ ok: false, error: errorMessages });
    }

    const { email, phone_number, password, full_name, display_name } = parsed.data;
    const result = await serviceRegister(pool, email, password, phone_number, full_name, display_name);

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
      const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
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
  const { token, provider_id, email, phone_number } = req.body || {};

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
    return res.status(400).json({ ok: false, error: t('error.missing_provider_id_or_email', getLang(req)) });
  }

  // Call service
  const result = await serviceLoginProvider(pool, idColumn, actualProviderId, provider, verifiedEmail, phone_number);

  if (!result.ok) {
    return res.status(401).json(result);
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
        'secret_key': process.env.ZALO_SECRET_KEY
      },
      body: new URLSearchParams({
        app_id: process.env.ZALO_APP_ID,
        grant_type: 'authorization_code',
        code,
        code_verifier
      }).toString()
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {

      return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
    }

    // Get Zalo user profile (request phone if app has permission)
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture,phone', {
      headers: { access_token: tokenData.access_token }
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
    }

    const { normalizePhoneNumber } = require('../services/auth/auth.service');
    const zaloPhone = profile.phone ? normalizePhoneNumber(profile.phone) : null;
    const result = await serviceLoginProvider(pool, 'zalo_id', String(profile.id), 'zalo', null, zaloPhone);
    if (!result.ok) return res.status(401).json(result);
    return res.status(200).json(result);
  } catch (err) {

    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

/**
 * GET /api/auth/zalo/callback
 * Zalo redirects here with ?code=&state=
 * Exchange code → get profile → create user → redirect back to app with JWT
 */
async function zaloCallback(pool, req, res) {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(`${APP_CALLBACK_URI}?error=no_code`);
  }

  try {
    // Exchange code for access_token
    const redirectUri = `${process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/api/auth/zalo/callback`;
    const tokenRes = await fetch('https://oauth.zaloapp.com/v4/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'secret_key': process.env.ZALO_SECRET_KEY
      },
      body: new URLSearchParams({
        app_id: process.env.ZALO_APP_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString()
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {

      return res.redirect(`${APP_CALLBACK_URI}?error=token_exchange_failed`);
    }

    // Get user profile (request phone if app has permission)
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture,phone', {
      headers: { access_token: tokenData.access_token }
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.redirect(`${APP_CALLBACK_URI}?error=profile_failed`);
    }

    const { normalizePhoneNumber } = require('../services/auth/auth.service');
    const zaloPhone = profile.phone ? normalizePhoneNumber(profile.phone) : null;
    const result = await serviceLoginProvider(pool, 'zalo_id', String(profile.id), 'zalo', null, zaloPhone);
    if (!result.ok) {
      return res.redirect(`${APP_CALLBACK_URI}?error=login_failed`);
    }

    return res.redirect(`${APP_CALLBACK_URI}?token=${encodeURIComponent(result.token)}`);
  } catch (err) {

    return res.redirect(`${APP_CALLBACK_URI}?error=server_error`);
  }
}

/**
 * GET /api/auth/facebook/callback
 * Facebook redirects here with ?code=
 * Exchange code → get profile → create user → redirect back to app with JWT
 */
async function facebookCallback(pool, req, res) {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${FACEBOOK_CALLBACK_URI}?error=no_code`);
  }

  try {
    const backendUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    const redirectUri = `${backendUrl}/api/auth/facebook/callback`;

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
      return res.redirect(`${FACEBOOK_CALLBACK_URI}?error=token_exchange_failed`);
    }

    // Get user profile
    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.redirect(`${FACEBOOK_CALLBACK_URI}?error=profile_failed`);
    }

    const email = profile.email || null;
    const result = await serviceLoginProvider(pool, 'facebook_id', String(profile.id), 'facebook', email, null);
    if (!result.ok) {
      return res.redirect(`${FACEBOOK_CALLBACK_URI}?error=login_failed`);
    }

    return res.redirect(`${FACEBOOK_CALLBACK_URI}?token=${encodeURIComponent(result.token)}`);
  } catch (err) {
    console.error('[Facebook callback] error:', err.message);
    return res.redirect(`${FACEBOOK_CALLBACK_URI}?error=server_error`);
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
      profile: user
    });
  } catch (err) {

    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

/**
 * GET /api/auth/google/initiate
 * Redirect browser to Google OAuth consent screen (server-side flow for Android)
 */
async function googleInitiate(pool, req, res) {
  const backendUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const redirectUri = `${backendUrl}/api/auth/google/callback`;
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;

  if (!clientId) {
    return res.redirect(`${GOOGLE_CALLBACK_URI}?error=google_not_configured`);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    state: Buffer.from(JSON.stringify({ n: Date.now() })).toString('base64'),
  });

  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

/**
 * GET /api/auth/google/callback
 * Google redirects here with ?code=
 * Exchange code → get profile → create user → redirect back to app with JWT
 */
async function googleCallback(pool, req, res) {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${GOOGLE_CALLBACK_URI}?error=no_code`);
  }

  try {
    const backendUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    const redirectUri = `${backendUrl}/api/auth/google/callback`;
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
      return res.redirect(`${GOOGLE_CALLBACK_URI}?error=token_exchange_failed`);
    }

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.redirect(`${GOOGLE_CALLBACK_URI}?error=profile_failed`);
    }

    const result = await serviceLoginProvider(pool, 'google_id', String(profile.id), 'google', profile.email || null, null);
    if (!result.ok) {
      return res.redirect(`${GOOGLE_CALLBACK_URI}?error=login_failed`);
    }

    return res.redirect(`${GOOGLE_CALLBACK_URI}?token=${encodeURIComponent(result.token)}`);
  } catch (err) {
    return res.redirect(`${GOOGLE_CALLBACK_URI}?error=server_error`);
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

      // Decode JWT header để xác định issuer → đúng JWKS endpoint
      const [headerB64Pre] = id_token.split('.');
      const headerPre = JSON.parse(Buffer.from(headerB64Pre, 'base64').toString());
      const jwksUrl = headerPre.iss === 'https://limited.facebook.com'
        ? 'https://limited.facebook.com/.well-known/oauth/openid/jwks/'
        : 'https://www.facebook.com/.well-known/oauth/openid/jwks/';

      // Fetch JWKS from Facebook
      const jwksRes = await fetch(jwksUrl);
      const jwks = await jwksRes.json();

      // Decode JWT header to get kid
      const [headerB64] = id_token.split('.');
      const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());
      const jwk = jwks.keys?.find(k => k.kid === header.kid);

      if (!jwk) {
        console.error('[FB token] JWKS key not found for kid:', header.kid);
        return res.status(401).json({ ok: false, error: 'Invalid Facebook id_token: key not found' });
      }

      // Verify JWT signature using Node crypto
      const crypto = require('crypto');
      const [hB64, pB64, sigB64] = id_token.split('.');
      const signingInput = `${hB64}.${pB64}`;
      const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const valid = crypto.verify('SHA256', Buffer.from(signingInput), pubKey, signature);

      if (!valid) {
        console.error('[FB token] JWT signature invalid');
        return res.status(401).json({ ok: false, error: 'Invalid Facebook id_token: bad signature' });
      }

      // Decode payload
      const payload = JSON.parse(Buffer.from(pB64, 'base64').toString());
      console.log('[FB token] JWT payload verified');

      const validIssuers = ['https://www.facebook.com', 'https://limited.facebook.com'];
      if (payload.aud !== appId || !validIssuers.includes(payload.iss)) {
        return res.status(401).json({ ok: false, error: 'Invalid Facebook id_token: aud/iss mismatch' });
      }

      userId = payload.sub || user_id;
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
    const result = await serviceLoginProvider(pool, idColumn, String(userId), 'facebook', email, null);
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
  zaloCallback,
  facebookCallback,
  loginByFacebookToken,
  googleInitiate,
  googleCallback,
  getMe,
  searchUsers,
  verifyToken,
  logoutHandler
};
