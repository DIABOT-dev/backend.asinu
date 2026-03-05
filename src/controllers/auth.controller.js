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
  return loginByProvider(pool, req, res, 'zalo', 'zalo_id');
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
    console.error('[auth.controller] getMe failed:', err);
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
    console.error('[auth.controller] searchUsers failed:', err);
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
    console.error('[auth.controller] verifyToken failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', lang) });
  }
}

module.exports = {
  registerByEmail,
  loginByEmail,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  loginByPhone,
  getMe,
  searchUsers,
  verifyToken
};
