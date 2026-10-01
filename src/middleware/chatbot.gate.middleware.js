/**
 * Chatbot feature gate.
 *
 * V2 keeps only the operational kill switch. Chat and voice are free and
 * unlimited; usage is still recorded separately for capacity planning.
 */

const { t, getLang } = require('../i18n');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw == null) return def;
  return TRUE_VALUES.has(String(raw).toLowerCase());
}

function chatbotGate(_pool) {
  return async function chatbotGateMiddleware(req, res, next) {
    const lang = getLang(req);

    // 1) Global kill switch
    if (!envBool('CHATBOT_ENABLED', true)) {
      return res.status(403).json({
        ok: false,
        code: 'CHATBOT_DISABLED',
        error:
          t('error.chatbot_disabled', lang) || 'Tính năng chatbot sẽ được mở trong phiên bản sau.',
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res
        .status(401)
        .json({ ok: false, code: 'UNAUTHORIZED', error: t('error.unauthenticated', lang) });
    }

    return next();
  };
}

module.exports = { chatbotGate };
