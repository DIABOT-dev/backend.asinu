'use strict';
const { mayProcessAi } = require('../services/ai/ai-consent.service');
function requireAiConsent(pool) {
  return async (req, res, next) => {
    try {
      if (!(await mayProcessAi(pool, req.user?.id))) {
        return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED', error: 'AI data consent is required.' });
      }
      return next();
    } catch (error) { return next(error); }
  };
}
module.exports = { requireAiConsent };
