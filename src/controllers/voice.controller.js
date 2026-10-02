/**
 * Voice Controller
 * HTTP handlers for voice chat endpoints
 */

const { t, getLang } = require('../i18n');
const voiceService = require('../services/voice/voice.service');
const {
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
} = require('../services/payment/subscription.service');

/**
 * POST /api/voice/chat
 * Voice chat — free for every signed-in user in V2.
 */
async function voiceChat(pool, req, res) {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: t('error.missing_audio', getLang(req)) });
  }

  const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);

  try {
    const { transcript, reply } = await voiceService.voiceChat(
      pool,
      req.user.id,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname || 'audio.m4a',
      getLang(req)
    );

    // Increment counter after successful processing
    await incrementVoiceUsage(pool, req.user.id);

    return res.status(200).json({
      ok: true,
      transcript,
      reply,
      voiceUsed: voiceUsed + 1,
      voiceLimit: null,
      unlimited: true,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.voice_processing', getLang(req)) });
  }
}

/**
 * GET /api/voice/usage
 * Get voice usage for current month
 */
async function getVoiceUsage(pool, req, res) {
  const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
  return res.status(200).json({ ok: true, voiceUsed, voiceLimit: null, unlimited: true });
}

module.exports = {
  voiceChat,
  getVoiceUsage,
};
