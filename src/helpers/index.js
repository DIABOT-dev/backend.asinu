const TZ = 'Asia/Ho_Chi_Minh';

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600000).toISOString();
}

function checkinDateVN() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}

function nowVN() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePhoneNumber(phone) {
  if (!phone) return null;
  let p = String(phone).trim().replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return p;
}

module.exports = { hoursFromNow, checkinDateVN, nowVN, clamp, normalizePhoneNumber, TZ };
