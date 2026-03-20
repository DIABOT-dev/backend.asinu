/**
 * Voice Controller
 * HTTP handlers for voice chat endpoints
 */

const { t, getLang } = require('../i18n');
const voiceService = require('../services/voice/voice.service');
const { VOICE_MONTHLY_LIMIT, getVoiceUsageThisMonth, incrementVoiceUsage } = require('../services/payment/subscription.service');

/**
 * POST /api/voice/chat
 * Voice chat — premium only
 */
async function voiceChat(pool, req, res) {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: t('error.missing_audio', getLang(req)) });
  }

  // Check monthly voice limit
  const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
  if (voiceUsed >= VOICE_MONTHLY_LIMIT) {
    return res.status(429).json({
      ok: false,
      code: 'VOICE_LIMIT_EXCEEDED',
      error: t('error.voice_limit_exceeded', getLang(req), { limit: VOICE_MONTHLY_LIMIT }),
      voiceUsed,
      voiceLimit: VOICE_MONTHLY_LIMIT,
    });
  }

  try {
    const { transcript, reply } = await voiceService.voiceChat(
      pool,
      req.user.id,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname || 'audio.m4a'
    );

    // Increment counter after successful processing
    await incrementVoiceUsage(pool, req.user.id);

    return res.status(200).json({
      ok: true,
      transcript,
      reply,
      voiceUsed: voiceUsed + 1,
      voiceLimit: VOICE_MONTHLY_LIMIT,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || t('error.voice_processing', getLang(req)) });
  }
}

/**
 * GET /api/voice/usage
 * Get voice usage for current month
 */
async function getVoiceUsage(pool, req, res) {
  const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
  return res.status(200).json({ ok: true, voiceUsed, voiceLimit: VOICE_MONTHLY_LIMIT });
}

module.exports = {
  voiceChat,
  getVoiceUsage,
};
