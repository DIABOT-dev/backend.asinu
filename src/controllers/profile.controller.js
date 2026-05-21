/**
 * Profile Controller
 * Handles user profile operations
 */

const { t, getLang } = require('../i18n');
const profileService = require('../services/profile/profile.service');
const { hashPassword, comparePassword } = require('../services/auth/auth.service');

async function changePassword(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ ok: false, error: t('error.password_invalid', getLang(req)) });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: t('error.password_too_short', getLang(req)) });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ ok: false, error: t('error.password_same_as_old', getLang(req)) });
  }

  const { rows } = await pool.query(
    `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [req.user.id]
  );
  if (!rows.length || !rows[0].password_hash) {
    return res.status(400).json({ ok: false, error: t('error.password_not_set', getLang(req)) });
  }

  const valid = await comparePassword(currentPassword, rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ ok: false, error: t('error.password_current_wrong', getLang(req)) });
  }

  const newHash = await hashPassword(newPassword);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [newHash, req.user.id]);

  return res.status(200).json({ ok: true, message: t('success.password_changed', getLang(req)) });
}

async function getProfile(pool, req, res) {

  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }

  const result = await profileService.getProfile(pool, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 500;
    return res.status(statusCode).json(result);
  }

  return res.status(200).json(result);
}

async function updateProfile(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }

  const { name, phone, dateOfBirth, gender, heightCm, weightKg, bloodType, chronicDiseases, language } = req.body || {};
  const result = await profileService.updateProfile(pool, req.user.id, {
    name,
    phone,
    dateOfBirth,
    gender,
    heightCm,
    weightKg,
    bloodType,
    chronicDiseases,
    language
  });

  if (!result.ok) {
    return res.status(result.statusCode || 500).json(result);
  }

  return res.status(200).json(result);
}

async function deleteAccount(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }

  const result = await profileService.deleteAccount(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

async function updatePushToken(pool, req, res) {
  console.log('[updatePushToken] req.body:', JSON.stringify(req.body));
  console.log('[updatePushToken] req.user:', req.user?.id);
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }

  const { push_token } = req.body || {};

  if (!push_token) {
    console.log('[updatePushToken] No push_token in body');
    return res.status(400).json({ ok: false, error: t('error.push_token_required', getLang(req)) });
  }

  const result = await profileService.updatePushToken(pool, req.user.id, push_token);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json({ ok: true, message: t('success.push_token_updated', getLang(req)) });
}

async function clearPushToken(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }
  await profileService.clearPushToken(pool, req.user.id);
  return res.status(200).json({ ok: true });
}

async function getBasicProfile(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }
  const result = await profileService.getBasicProfile(pool, req.user.id);
  if (!result.ok) {
    return res.status(result.statusCode || 500).json(result);
  }
  return res.status(200).json(result);
}

async function featureFlagsHandler(pool, req, res) {
  // Resolve premium status server-side so FE doesn't need a second call
  // to decide which tier-specific limits to surface.
  let premium = false;
  try {
    premium = await require('../services/payment/subscription.service').isPremium(pool, req.user?.id);
  } catch {
    premium = false;
  }

  const envBool = (name, def) => {
    const raw = process.env[name];
    if (raw == null) return def;
    return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
  };
  const envInt = (name, def) => {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) ? n : def;
  };

  const chatbotEnabled = envBool('CHATBOT_ENABLED', true);
  const chatbotPremiumOnly = envBool('CHATBOT_PREMIUM_ONLY', false);
  const dailyLimit = premium
    ? envInt('CHATBOT_DAILY_LIMIT_PREMIUM', 20)
    : envInt('CHATBOT_DAILY_LIMIT_FREE', 0);

  // The chatbot is *effectively* available to this user only if all
  // three gates are satisfied. FE uses this single boolean to decide
  // whether to render the chat entry point at all.
  const chatbotAvailable =
    chatbotEnabled &&
    (!chatbotPremiumOnly || premium) &&
    dailyLimit > 0;

  return res.json({
    // Legacy keys — keep so older FE builds don't break.
    FEATURE_MOOD_TRACKER: false,
    FEATURE_JOURNAL: false,
    FEATURE_AUDIO: false,
    FEATURE_DAILY_CHECKIN: true,
    FEATURE_AI_FEED: false,
    FEATURE_AI_CHAT: chatbotAvailable,

    // New structured payload (MVP audit FIX #1 + #6).
    chatbot: {
      enabled: chatbotEnabled,
      premium_only: chatbotPremiumOnly,
      available: chatbotAvailable,
      daily_limit: dailyLimit,
    },
    care_circle: {
      enabled: envBool('CARE_CIRCLE_ENABLED', true),
      free_limit: envInt('CARE_CIRCLE_FREE_LIMIT', 1),
      premium_limit: envInt('CARE_CIRCLE_PREMIUM_LIMIT', 3),
      caregiver_alert_enabled: envBool('CAREGIVER_ALERT_ENABLED', true),
      caregiver_view_logs_enabled: envBool('CAREGIVER_VIEW_LOGS_ENABLED', true),
      caregiver_ack_enabled: envBool('CAREGIVER_ACK_ENABLED', true),
    },
    // Check-in flow selector (MVP audit lỗi 7). FE currently calls
    // /checkin/start + /checkin/triage (the AI-driven flow). The
    // backend also exposes /checkin/script/* which is 0 AI calls per
    // check-in — much cheaper. The full FE migration is tracked
    // separately; this flag lets us A/B test once the FE picker lands.
    checkin: {
      mode: (process.env.CHECKIN_MODE || 'ai').toLowerCase() === 'script' ? 'script' : 'ai',
    },
    tier: premium ? 'premium' : 'free',
  });
}

module.exports = {
  getProfile,
  getBasicProfile,
  updateProfile,
  deleteAccount,
  updatePushToken,
  clearPushToken,
  featureFlagsHandler,
  changePassword,
};
