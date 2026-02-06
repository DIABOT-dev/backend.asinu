/**
 * Profile Controller
 * Handles user profile operations
 */

const profileService = require('../services/profile.service');

async function getProfile(pool, req, res) {
  console.log('[profile.controller] getProfile called - USER ID:', req.user?.id);
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Chưa xác thực' });
  }

  const result = await profileService.getProfile(pool, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 500;
    return res.status(statusCode).json(result);
  }

  console.log('[profile.controller] Sending profile:', result.profile);
  return res.status(200).json(result);
}

async function updateProfile(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Chưa xác thực' });
  }

  const { name, phone, dateOfBirth, gender, heightCm, weightKg, bloodType, chronicDiseases } = req.body || {};
  console.log('[profile.controller] updateProfile called with:', { 
    userId: req.user.id, 
    name, 
    phone, 
    dateOfBirth, 
    gender,
    heightCm, 
    weightKg, 
    bloodType, 
    chronicDiseases 
  });

  const result = await profileService.updateProfile(pool, req.user.id, { 
    name, 
    phone, 
    dateOfBirth, 
    gender,
    heightCm, 
    weightKg, 
    bloodType, 
    chronicDiseases 
  });

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

async function deleteAccount(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Chưa xác thực' });
  }

  const result = await profileService.deleteAccount(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

async function updatePushToken(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Chưa xác thực' });
  }

  const { push_token } = req.body || {};
  
  if (!push_token) {
    return res.status(400).json({ ok: false, error: 'Cần token thông báo đẩy' });
  }

  const result = await profileService.updatePushToken(pool, req.user.id, push_token);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  console.log('[profile] Push token updated for user', req.user.id);
  return res.status(200).json({ ok: true, message: 'Đã cập nhật token thông báo' });
}

module.exports = {
  getProfile,
  updateProfile,
  deleteAccount,
  updatePushToken
};
