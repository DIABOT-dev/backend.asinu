'use strict';
const assistant = require('../services/assistant/app-assistant.service');
const { hasAiConsent } = require('../services/ai/ai-consent.service');
const { getLang } = require('../i18n');

async function consent(pool, req, res, next) {
  try {
    if (!(await hasAiConsent(pool, req.user.id))) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    return next();
  } catch (error) { return next(error); }
}
async function plan(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await assistant.plan(req.body, getLang(req));
    if (!(await hasAiConsent(pool, req.user.id))) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const invalid = error.code === 'APP_ASSISTANT_INVALID_REQUEST';
    return res.status(invalid ? 400 : 503).json({ ok: false,
      code: invalid ? error.code : 'APP_ASSISTANT_UNAVAILABLE' });
  }
}
module.exports = { consent, plan };
