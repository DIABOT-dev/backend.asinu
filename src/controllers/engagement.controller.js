const engagementService = require('../services/profile/engagement.service');
const { getLang, t } = require('../i18n');

/**
 * POST /api/mobile/engagement/screen-view
 *
 * The mobile app reports the active route after navigation changes. Keep the
 * contract intentionally small: CRM only needs a non-sensitive screen name.
 */
async function trackScreenViewHandler(pool, req, res) {
  const screenName = typeof req.body?.screen_name === 'string' ? req.body.screen_name : '';
  const featureCode = typeof req.body?.feature_code === 'string' ? req.body.feature_code : null;

  if (!screenName.trim()) {
    return res
      .status(400)
      .json({ ok: false, error: t('error.screen_name_required', getLang(req)) });
  }

  try {
    await engagementService.trackScreenView(pool, req.user.id, { screenName, featureCode });
    return res.status(201).json({ ok: true });
  } catch (error) {
    console.warn('[Engagement] screen view tracking failed:', error.message);
    return res
      .status(500)
      .json({ ok: false, error: t('error.engagement_unavailable', getLang(req)) });
  }
}

module.exports = { trackScreenViewHandler };
