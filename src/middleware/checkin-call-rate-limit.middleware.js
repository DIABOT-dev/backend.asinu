'use strict';

const rateLimit = require('express-rate-limit');
const { getLang, t } = require('../i18n');

const conclusionAudioLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      error: t('error.audio_rate_limited', getLang(req)),
    }),
  keyGenerator: (req) => `checkin-conclusion:user:${req.user.id}`,
});

module.exports = { conclusionAudioLimiter };
