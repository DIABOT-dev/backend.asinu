'use strict';

// Public OAuth client IDs already used by Asinu mobile releases. Keep these
// exact clients during rotation so installed builds remain usable. These are
// public identifiers, never OAuth client secrets.
const SHIPPED_MOBILE_CLIENT_IDS = [
  "416338225523-4ooh8cr3hd7r2skotlkohj40ppsm6s21.apps.googleusercontent.com",
  "416338225523-vs42boe39psg5k927thrhuq8doobb29h.apps.googleusercontent.com"
];

function googleAudiences() {
  return [...new Set([
    ...SHIPPED_MOBILE_CLIENT_IDS,
    process.env.GOOGLE_WEB_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    ...(process.env.GOOGLE_LEGACY_CLIENT_IDS || '').split(','),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}
module.exports = { googleAudiences, SHIPPED_MOBILE_CLIENT_IDS };
