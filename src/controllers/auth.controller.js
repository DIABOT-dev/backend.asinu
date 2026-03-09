const { t, getLang } = require('../i18n');
const { registerSchema, loginSchema } = require('../validation/validation.schemas');
const {
  registerByEmail: serviceRegister,
  loginByEmail: serviceLogin,
  loginByProvider: serviceLoginProvider,
  loginByPhone: serviceLoginByPhone,
  getCurrentUser,
  searchUsers: serviceSearchUsers,
  verifySocialToken
} = require('../services/auth.service');

const ZALO_CALLBACK_URI     = 'asinu-lite://auth/zalo/callback';
const FACEBOOK_CALLBACK_URI = 'asinu-lite://auth/facebook/callback';
const GOOGLE_CALLBACK_URI   = 'asinu-lite://auth/google/callback';
// Keep backward-compat alias
const APP_CALLBACK_URI = ZALO_CALLBACK_URI;

// =====================================================
// REGISTER
// =====================================================

async function registerByEmail(pool, req, res) {
  // Validate request
  const parsed = registerSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
    return res.status(400).json({ ok: false, error: errorMessages });
  }

  const { email, phone_number, password, full_name, display_name } = parsed.data;

  // Call service
  const result = await serviceRegister(pool, email, password, phone_number, full_name, display_name);
  
  if (!result.ok) {
    return res.status(400).json(result);
  }
  
  return res.status(200).json(result);
}

// =====================================================
// LOGIN BY EMAIL/PHONE
// =====================================================

async function loginByEmail(pool, req, res) {
  // Validate request
  const parsed = loginSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
    return res.status(400).json({ ok: false, error: errorMessages });
  }

  const { identifier, password } = parsed.data;

  // Call service
  const result = await serviceLogin(pool, identifier, password);
  
  if (!result.ok) {
    return res.status(401).json(result);
  }
  
  return res.status(200).json(result);
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

    // Get Zalo user profile
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture', {
      headers: { access_token: tokenData.access_token }
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.status(401).json({ ok: false, error: t('error.invalid_token', lang) });
    }

    const result = await serviceLoginProvider(pool, 'zalo_id', String(profile.id), 'zalo', null, null);
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

    // Get user profile
    const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture', {
      headers: { access_token: tokenData.access_token }
    });
    const profile = await profileRes.json();

    if (!profile.id) {
      return res.redirect(`${APP_CALLBACK_URI}?error=profile_failed`);
    }

    const result = await serviceLoginProvider(pool, 'zalo_id', String(profile.id), 'zalo', null, null);
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

async function loginByPhone(pool, req, res) {
  const { phone_number } = req.body || {};

  if (!phone_number) {
    return res.status(400).json({ ok: false, error: t('error.missing_phone', getLang(req)) });
  }

  // Call service
  const result = await serviceLoginByPhone(pool, phone_number);
  
  if (!result.ok) {
    return res.status(401).json(result);
  }
  
  return res.status(200).json(result);
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
      token: req.headers.authorization?.replace('Bearer ', ''),
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

module.exports = {
  registerByEmail,
  loginByEmail,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  zaloCallback,
  facebookCallback,
  googleInitiate,
  googleCallback,
  loginByPhone,
  getMe,
  searchUsers,
  verifyToken
};
