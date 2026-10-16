'use strict';
const { AI_CONSENT_VERSION, AI_PROVIDERS, hasAiConsent,
  grantAiConsent: grantReceipt, revokeAiConsent: revokeReceipt } = require('../services/ai/ai-consent.service');

async function getAiConsent(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, version: AI_CONSENT_VERSION, providers: AI_PROVIDERS,
    granted: await hasAiConsent(pool, req.user.id) });
}
async function grantAiConsent(pool, req, res) {
  if (req.body?.version !== AI_CONSENT_VERSION || req.body?.granted !== true) {
    return res.status(400).json({ ok: false, code: 'AI_CONSENT_VERSION_REQUIRED' });
  }
  await grantReceipt(pool, req.user.id);
  return getAiConsent(pool, req, res);
}
async function revokeAiConsent(pool, req, res) {
  await revokeReceipt(pool, req.user.id);
  return getAiConsent(pool, req, res);
}
module.exports = { getAiConsent, grantAiConsent, revokeAiConsent };
