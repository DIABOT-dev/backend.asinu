const { onboardingRequestSchema } = require('../validation/validation.schemas');
const onboardingService = require('../services/onboarding.service');

async function upsertOnboardingProfile(pool, req, res) {
  const parsed = onboardingRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ', details: parsed.error.issues });
  }

  const { user_id: payloadUserId, profile } = parsed.data;
  const userId = Number(req.user?.id);
  if (!Number.isFinite(userId)) {
    return res.status(401).json({ ok: false, error: 'Chưa xác thực' });
  }
  if (payloadUserId !== undefined && payloadUserId !== userId) {
    return res.status(403).json({ ok: false, error: 'user_id_mismatch' });
  }

  try {
    const savedProfile = await onboardingService.upsertProfile(pool, userId, profile);
    return res.status(200).json({ ok: true, profile: savedProfile });
  } catch (err) {
    console.error('onboarding upsert failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

module.exports = { upsertOnboardingProfile };
