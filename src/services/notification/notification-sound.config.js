const manifest = require('../../config/notification-sounds.json');

/** Audio classification only; check-in escalation and delivery remain unchanged. */
function notificationSoundGroup(data = {}) {
  const severity = String(data.severity || '').toUpperCase();
  if (data.type === 'checkin_call') {
    if (severity === 'URGENT' || data.kind === 'URGENT_REPEAT') {
      return 'alert';
    }
    if (['FALLBACK', 'MISSED_CALL'].includes(String(data.kind))) {
      return 'missed';
    }
    return 'incoming';
  }
  if (
    (data.type === 'early_signal' && severity === 'URGENT') ||
    data.alertType === 'emergency' ||
    data.requiresImmediate === true
  ) {
    return 'alert';
  }
  const type = String(data.type || '');
  return Object.hasOwn(manifest.types, type) ? manifest.types[type] : 'reminder';
}

function notificationSoundConfig(data = {}) {
  const group = notificationSoundGroup(data);
  const config = manifest.groups[group];
  // Expo's remote sound field is iOS-only. Android uses the matching channel.
  return { ...config, group, sound: manifest.sounds[config.sound].ios };
}

module.exports = { notificationSoundGroup, notificationSoundConfig };
