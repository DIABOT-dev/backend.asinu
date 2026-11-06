'use strict';
const { resolveNotificationTimezone } = require('../notification/notification-quiet-hours.policy');
const { z, error } = require('./common');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const hhmm = (minutes) =>
  `${String(Math.floor((((minutes % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((minutes % 60) + 60) % 60).padStart(2, '0')}`;
const anchors = ['before_breakfast', 'after_breakfast', 'after_lunch', 'after_dinner', 'bedtime'];
function anchorTime(anchor, meals) {
  const map = {
    before_breakfast: ['breakfast', -30],
    after_breakfast: ['breakfast', 30],
    after_lunch: ['lunch', 30],
    after_dinner: ['dinner', 30],
    bedtime: ['bedtime', 0],
  };
  const entry = map[anchor];
  if (!entry) throw error('MED_INVALID_MEAL_ANCHOR');
  return hhmm(minute(meals[entry[0]]) + entry[1]);
}
const formatters = new Map();
function parts(date, tz) {
  tz = resolveNotificationTimezone(tz);
  if (!formatters.has(tz)) {
    if (formatters.size > 100) formatters.clear();
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return Object.fromEntries(
    formatters
      .get(tz)
      .formatToParts(new Date(date))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
}
function inCallWindow(date, tz) {
  const p = parts(date, tz);
  return p.hour >= 7 && p.hour < 21;
}
function atLocal(date, timeLocal, tz) {
  const target = minute(time.parse(timeLocal));
  const desired = Date.parse(date + 'T' + timeLocal + ':00Z');
  let candidate = desired;
  for (let i = 0; i < 4; i++) {
    const v = parts(candidate, tz),
      shown = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute);
    if (shown === desired) return new Date(candidate);
    candidate += desired - shown;
  }
  // A DST gap has no valid time. Search only around the candidate instead of
  // doing thousands of Intl formatter allocations for every Vietnam schedule.
  for (let step = -180; step <= 180; step++) {
    const value = new Date(candidate + step * 60000),
      v = parts(value, tz);
    if (
      `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}` === date &&
      v.hour * 60 + v.minute === target
    )
      return value;
  }
  return null;
}
function nextWindow(now, tz) {
  for (let i = 0; i <= 26 * 60; i++) {
    const d = new Date(new Date(now).getTime() + i * 60000);
    if (inCallWindow(d, tz)) return d;
  }
  throw error('MED_INVALID_TIMEZONE');
}
function slotName(timeLocal, lang = 'vi') {
  const m = minute(timeLocal);
  return lang === 'en'
    ? m < 660
      ? 'morning'
      : m < 840
        ? 'midday'
        : m < 1200
          ? 'evening'
          : 'bedtime'
    : m < 660
      ? 'sáng'
      : m < 840
        ? 'trưa'
        : m < 1200
          ? 'tối'
          : 'trước khi ngủ';
}
function nextState(button) {
  return { 1: 'TAKEN', 2: 'SKIPPED', 3: 'OUT_OF_MEDS' }[button] || null;
}
const terminal = ['TAKEN', 'SKIPPED', 'OUT_OF_MEDS', 'CANCELLED', 'SKIPPED_NO_DEVICE'];
module.exports = {
  time,
  minute,
  hhmm,
  anchors,
  anchorTime,
  parts,
  inCallWindow,
  atLocal,
  nextWindow,
  slotName,
  nextState,
  terminal,
  resolveNotificationTimezone,
};
