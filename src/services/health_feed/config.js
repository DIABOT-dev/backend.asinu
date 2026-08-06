'use strict';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const HEALTH_FEED_PUSH_COOLDOWN_HOURS = 24;
const HEALTH_FEED_TEMPLATE_COOLDOWN_HOURS = 72;
const PUSH_START_HOUR = 8;
const PUSH_END_HOUR = 21;

function isHealthFeedEnabled() {
  return process.env.ENABLE_HEALTH_FEED === 'true';
}

function resolveTimezone(timezone) {
  return typeof timezone === 'string' && timezone.trim() ? timezone.trim() : DEFAULT_TIMEZONE;
}

function getTimeParts(timezone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function isWithinPushWindow(timezone, date = new Date()) {
  const { hour } = getTimeParts(timezone, date);
  return hour >= PUSH_START_HOUR && hour < PUSH_END_HOUR;
}

module.exports = {
  DEFAULT_TIMEZONE,
  HEALTH_FEED_PUSH_COOLDOWN_HOURS,
  HEALTH_FEED_TEMPLATE_COOLDOWN_HOURS,
  PUSH_END_HOUR,
  PUSH_START_HOUR,
  getTimeParts,
  isHealthFeedEnabled,
  isWithinPushWindow,
  resolveTimezone,
};
