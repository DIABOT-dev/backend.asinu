/**
 * Kill switch + capability gates for the Care Circle feature.
 *
 *   CARE_CIRCLE_ENABLED=false           -> 403 CARE_CIRCLE_DISABLED
 *   CAREGIVER_ALERT_ENABLED=false       -> drop alert send (handled in services)
 *   CAREGIVER_VIEW_LOGS_ENABLED=false   -> 403 on /caregiver/logs/*
 *   CAREGIVER_ACK_ENABLED=false         -> 403 on /caregiver/ack endpoints
 *
 * Defaults are all `true` so existing deployments keep working until
 * someone flips a flag.
 */

const { t, getLang } = require('../i18n');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envBool(name, def = true) {
  const raw = process.env[name];
  if (raw == null) return def;
  return TRUE_VALUES.has(String(raw).toLowerCase());
}

function gateOnFlag(envName, code, defaultEnabled = true) {
  return function gateMiddleware(req, res, next) {
    if (!envBool(envName, defaultEnabled)) {
      return res.status(403).json({
        ok: false,
        code,
        error: t(`error.${code.toLowerCase()}`, getLang(req)) || 'Tính năng tạm khoá.',
      });
    }
    return next();
  };
}

const careCircleEnabled    = gateOnFlag('CARE_CIRCLE_ENABLED',         'CARE_CIRCLE_DISABLED');
const caregiverViewLogs    = gateOnFlag('CAREGIVER_VIEW_LOGS_ENABLED', 'CAREGIVER_VIEW_DISABLED');
const caregiverAckEnabled  = gateOnFlag('CAREGIVER_ACK_ENABLED',       'CAREGIVER_ACK_DISABLED');

function isCaregiverAlertEnabled() {
  return envBool('CAREGIVER_ALERT_ENABLED', true);
}

module.exports = {
  careCircleEnabled,
  caregiverViewLogs,
  caregiverAckEnabled,
  isCaregiverAlertEnabled,
  envBool,
};
