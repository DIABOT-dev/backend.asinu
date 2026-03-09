/**
 * Profile Controller
 * Handles user profile operations
 */

const { t, getLang } = require('../i18n');
const profileService = require('../services/profile.service');

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
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }

  const { push_token } = req.body || {};
  
  if (!push_token) {
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
  await pool.query('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
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

module.exports = {
  getProfile,
  getBasicProfile,
  updateProfile,
  deleteAccount,
  updatePushToken,
  clearPushToken,
};
