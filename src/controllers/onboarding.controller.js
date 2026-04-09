const { t, getLang } = require('../i18n');
const { onboardingRequestSchema } = require('../validation/validation.schemas');
const onboardingService = require('../services/onboarding/onboarding.service');
const onboardingAiService = require('../services/onboarding/onboarding.ai.service');
const { createClustersFromOnboarding } = require('../services/checkin/script.service');

async function upsertOnboardingProfile(pool, req, res) {
  const parsed = onboardingRequestSchema.safeParse(req.body);
  if (!parsed.success) {

    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)), details: parsed.error.issues });
  }

  const { user_id: payloadUserId, profile } = parsed.data;
  const userId = Number(req.user?.id);
  if (!Number.isFinite(userId)) {
    return res.status(401).json({ ok: false, error: t('error.unauthenticated', getLang(req)) });
  }
  if (payloadUserId !== undefined && payloadUserId !== userId) {
    return res.status(403).json({ ok: false, error: t('error.user_id_mismatch', getLang(req)) });
  }

  try {
    const savedProfile = await onboardingService.upsertProfile(pool, userId, profile);
    return res.status(200).json({ ok: true, profile: savedProfile });
  } catch (err) {

    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * POST /api/mobile/onboarding/next
 * AI-driven: get next onboarding question
 */
async function onboardingNext(pool, req, res) {
  const { messages = [], language = 'vi' } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
  }
  try {
    const result = await onboardingAiService.getNextQuestion(messages, language);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * POST /api/mobile/onboarding/complete
 * AI-driven: save profile when AI reports done
 */
async function onboardingComplete(pool, req, res) {
  const { profile } = req.body;
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
  }
  try {
    const saved = await onboardingService.upsertProfileFromAI(pool, req.user.id, profile);
    return res.status(200).json({ ok: true, profile: saved });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * POST /api/mobile/onboarding/complete-v2
 * V2 fixed 5-page wizard
 */
async function onboardingCompleteV2(pool, req, res) {
  try {
    const { phone } = req.body;
    if (phone && phone.trim().length >= 9) {
      const { normalizePhoneNumber, getPhoneVariants } = require('../services/auth/auth.service');
      const variants = getPhoneVariants(normalizePhoneNumber(phone.trim()));
      const isDuplicate = await onboardingService.checkPhoneDuplicate(pool, variants, req.user.id);
      if (isDuplicate) {
        return res.status(409).json({ ok: false, error: t('auth.phone_already_used', getLang(req)) });
      }
    }
    const saved = await onboardingService.upsertProfileV2(pool, req.user.id, req.body);

    // Auto-create problem clusters + scripts from chronic symptoms
    const symptoms = [
      ...(Array.isArray(req.body.chronic_symptoms) ? req.body.chronic_symptoms : []),
      ...(Array.isArray(req.body.medical_conditions) ? req.body.medical_conditions : []),
    ].filter(Boolean);
    if (symptoms.length > 0) {
      createClustersFromOnboarding(pool, req.user.id, symptoms).catch(err =>
        console.error('[Onboarding] Failed to create clusters:', err.message)
      );
    }

    return res.json({ ok: true, profile: saved });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

module.exports = {
  upsertOnboardingProfile,
  onboardingNext,
  onboardingComplete,
  onboardingCompleteV2,
};
