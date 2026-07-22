const engagementService = require('../services/profile/engagement.service');

/**
 * POST /api/mobile/engagement/screen-view
 *
 * The mobile app reports the active route after navigation changes. Keep the
 * contract intentionally small: CRM only needs a non-sensitive screen name.
 */
async function trackScreenViewHandler(pool, req, res) {
  const screenName = typeof req.body?.screen_name === 'string'
    ? req.body.screen_name
    : '';
  const featureCode = typeof req.body?.feature_code === 'string'
    ? req.body.feature_code
    : null;

  if (!screenName.trim()) {
    return res.status(400).json({ ok: false, error: 'screen_name is required' });
  }

  try {
    await engagementService.trackScreenView(pool, req.user.id, { screenName, featureCode });
    return res.status(201).json({ ok: true });
  } catch (error) {
    console.warn('[Engagement] screen view tracking failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Unable to record screen view' });
  }
}

module.exports = { trackScreenViewHandler };
