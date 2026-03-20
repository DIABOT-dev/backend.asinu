/**
 * Logs Controller
 * HTTP handlers for log-related endpoints (voice-parse, etc.)
 */

const { t, getLang } = require('../i18n');
const { parseLogVoice } = require('../services/voice/voice.service');
const {
  VOICE_MONTHLY_LIMIT,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
} = require('../services/payment/subscription.service');

const VALID_LOG_TYPES = ['glucose', 'blood_pressure', 'insulin'];

/**
 * POST /api/logs/voice-parse
 * Receive audio + log_type, use Whisper + GPT-4o to return parsed health data
 */
async function voiceParse(pool, req, res) {
  // Validate audio
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: t('error.missing_audio', getLang(req)),
    });
  }

  // Validate log_type
  const { log_type } = req.body;
  if (!log_type || !VALID_LOG_TYPES.includes(log_type)) {
    return res.status(400).json({
      ok: false,
      error: t('voice.invalid_log_type', getLang(req), { types: VALID_LOG_TYPES.join(', ') }),
    });
  }

  // Check monthly voice limit
  let voiceUsed;
  try {
    voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
  } catch {
    voiceUsed = 0;
  }

  if (voiceUsed >= VOICE_MONTHLY_LIMIT) {
    return res.status(429).json({
      ok: false,
      code: 'VOICE_LIMIT_EXCEEDED',
      error:
        t('error.voice_limit_exceeded', getLang(req), { limit: VOICE_MONTHLY_LIMIT }),
      voiceUsed,
      voiceLimit: VOICE_MONTHLY_LIMIT,
    });
  }

  try {
    const result = await parseLogVoice(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname || 'voice_log.m4a',
      log_type
    );

    // Count usage only when audio was actually processed (transcript exists)
    if (result.transcript) {
      try {
        await incrementVoiceUsage(pool, req.user.id);
      } catch { /* non-blocking */ }
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      transcript: '',
      parsed: null,
      error: err.message || t('error.voice_processing', getLang(req)),
    });
  }
}

module.exports = {
  voiceParse,
};
