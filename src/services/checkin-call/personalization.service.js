'use strict';

const { t } = require('../../i18n');
const entitlement = require('../payment/entitlement.service');
const audio = require('./audio.service');
const weather = require('./weather.service');
const { createHash } = require('crypto');

const DEFAULTS = Object.freeze({
  use_name: false,
  use_health: false,
  address: 'auto',
  weather_enabled: false,
  region: null,
  location: null,
});
const addresses = new Set(['auto', 'bac', 'co', 'chu', 'anh', 'chi', 'ban']);
const notices = new Map();
const recordings = new Map();
const inFlight = new Map();
const langFor = (lang) => (String(lang).startsWith('en') ? 'en' : 'vi');
function fail() {
  throw Object.assign(new Error('Invalid voice preferences'), {
    statusCode: 400,
    i18nKey: 'checkinCall.error.invalid_voice_preferences',
  });
}

function validate(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(DEFAULTS, key))
  )
    fail();
  const value = { ...DEFAULTS, ...input };
  for (const field of ['use_name', 'use_health', 'weather_enabled'])
    if (typeof value[field] !== 'boolean') fail();
  if (!addresses.has(value.address)) fail();
  if (value.region !== null && typeof value.region !== 'string') fail();
  if (
    value.region !== null &&
    value.region !== 'device' &&
    !Object.hasOwn(weather.regions, value.region)
  )
    fail();
  if (value.region === 'device' && value.weather_enabled) {
    value.location = weather.coarseLocation(value.location);
    if (!value.location) fail();
  } else value.location = null;
  if (value.weather_enabled && !value.region) fail();
  if (!value.weather_enabled) {
    value.region = null;
    value.location = null;
  }
  return value;
}

async function preferences(pool, userId) {
  const result = await pool.query(
    'SELECT preferences, updated_at FROM checkin_call_voice_preferences WHERE user_id = $1',
    [userId]
  );
  const row = result.rows[0];
  return {
    preferences: { ...DEFAULTS, ...row?.preferences },
    revision: row?.updated_at ? new Date(row.updated_at).toISOString() : 'default',
  };
}

async function savePreferences(pool, userId, input) {
  const value = validate(input);
  // Revoking consent remains possible after a subscription expires.
  if (value.use_name || value.use_health || value.weather_enabled) {
    if (!(await entitlement.getEntitlement(pool, userId)).callCenterEnabled) {
      throw Object.assign(new Error('An Tam required'), {
        statusCode: 403,
        i18nKey: 'error.an_tam_required',
      });
    }
  }
  const result = await pool.query(
    'INSERT INTO checkin_call_voice_preferences (user_id, preferences) VALUES ($1,$2::jsonb) ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = now() RETURNING preferences',
    [userId, JSON.stringify(value)]
  );
  for (const [key, notice] of notices) if (notice.userId === userId) notices.delete(key);
  for (const [key, recording] of recordings)
    if (recording.userId === userId) recordings.delete(key);
  return result.rows[0].preferences;
}

function speechName(value) {
  const cleaned =
    typeof value === 'string'
      ? value
          .normalize('NFC')
          .replace(/[^\p{L}\p{M}\s'-]/gu, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  // Never substitute an email, phone number, UUID or internal id for a name.
  if (!cleaned || /@|\d/.test(value) || /^user\b/i.test(cleaned)) return '';
  return cleaned.slice(0, 40);
}

function addressFor(preferences, profile, lang, now, timezone = 'Asia/Ho_Chi_Minh') {
  if (lang === 'en') return '';
  let address = preferences.address;
  if (address === 'auto') {
    let age = null;
    const date = profile?.date_of_birth && new Date(profile.date_of_birth);
    if (date && Number.isFinite(date.getTime()) && date.getTime() <= now) {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).formatToParts(new Date(now));
      const today = Object.fromEntries(
        parts
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, Number(part.value)])
      );
      age =
        today.year -
        date.getUTCFullYear() -
        (today.month < date.getUTCMonth() + 1 ||
        (today.month === date.getUTCMonth() + 1 && today.day < date.getUTCDate())
          ? 1
          : 0);
    } else if (Number(profile?.birth_year) >= 1900)
      age = new Date(now).getUTCFullYear() - Number(profile.birth_year);
    else if (profile?.age === '60+') age = 60;
    else if (/^\d{2}-\d{2}$/.test(profile?.age || '')) age = Number(profile.age.split('-')[0]);
    const gender = String(profile?.gender || '').toLowerCase();
    address =
      age >= 60 && age <= 120
        ? 'bac'
        : age >= 18 && age < 60
          ? /^(male|nam)$/.test(gender)
            ? 'anh'
            : /^(female|nữ|nu)$/.test(gender)
              ? 'chi'
              : 'ban'
          : 'ban';
  }
  return t(`checkinCall.voice.address_${address}`, lang);
}

function metricContext(logs, lang, timezone, now, recipient = lang === 'vi' ? 'bạn' : '') {
  for (const row of logs) {
    const at = Date.parse(row.occurred_at);
    if (!Number.isFinite(at) || at > now || now - at > 48 * 60 * 60_000) continue;
    const format = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'vi-VN', {
      timeZone: timezone,
      day: 'numeric',
      month: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const when = format.format(new Date(at));
    const number = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'vi-VN', {
      maximumFractionDigits: 1,
    });
    if (
      row.log_type === 'blood_pressure' &&
      Number(row.systolic) >= 50 &&
      Number(row.systolic) <= 300 &&
      Number(row.diastolic) >= 30 &&
      Number(row.diastolic) <= 200 &&
      Number(row.systolic) > Number(row.diastolic)
    ) {
      return t('checkinCall.voice.recent_bp', lang, {
        recipient,
        when,
        systolic: number.format(row.systolic),
        diastolic: number.format(row.diastolic),
      });
    }
    if (
      row.log_type === 'glucose' &&
      Number(row.glucose_value) > 0 &&
      ['mmol/L', 'mg/dL'].includes(row.glucose_unit)
    ) {
      const max = row.glucose_unit === 'mmol/L' ? 55 : 1000;
      if (Number(row.glucose_value) > max) continue;
      return t('checkinCall.voice.recent_glucose', lang, {
        recipient,
        when,
        value: number.format(row.glucose_value),
        unit: t(
          row.glucose_unit === 'mmol/L'
            ? 'checkinCall.voice.unit_mmol'
            : 'checkinCall.voice.unit_mg',
          lang
        ),
      });
    }
  }
  return t('checkinCall.voice.no_recent_data', lang, { recipient });
}

async function authorizedAttempt(pool, attemptId, userId) {
  const result = await pool.query(
    "SELECT a.id, a.episode_id, e.severity FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.id = $1 AND a.target_user_id = $2 AND a.target_role = 'USER' AND e.user_id = $2",
    [attemptId, userId]
  );
  if (!result.rows.length)
    throw Object.assign(new Error('Attempt not found'), {
      statusCode: 404,
      i18nKey: 'checkinCall.error.attempt_not_found',
    });
  return result.rows[0];
}

async function userNotice(pool, attemptId, userId, requestedLanguage = 'vi') {
  const attempt = await authorizedAttempt(pool, attemptId, userId);
  const lang = langFor(requestedLanguage);
  const { preferences: prefs, revision } = await preferences(pool, userId);
  const preferencesHash = createHash('sha256').update(JSON.stringify(prefs)).digest('hex');
  const key = `${attemptId}:${userId}:${lang}:${revision}:${preferencesHash}`;
  const stored = notices.get(key);
  const now = Date.now();
  if (stored?.expires > now) return stored.notice;
  const [profileResult, logsResult, settingsResult, forecast] = await Promise.all([
    pool.query(
      "SELECT COALESCE(NULLIF(trim(u.full_name), ''), NULLIF(trim(u.display_name), ''), p.display_name) AS name, p.gender, p.date_of_birth::text AS date_of_birth, p.birth_year, p.age FROM users u LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.deleted_at IS NULL",
      [userId]
    ),
    prefs.use_health && attempt.severity !== 'URGENT'
      ? pool.query(
          "SELECT c.log_type, c.occurred_at, bp.systolic, bp.diastolic, g.value AS glucose_value, g.unit AS glucose_unit FROM logs_common c LEFT JOIN blood_pressure_logs bp ON bp.log_id = c.id LEFT JOIN glucose_logs g ON g.log_id = c.id WHERE c.user_id = $1 AND c.log_type IN ('blood_pressure','glucose') AND c.occurred_at BETWEEN now() - interval '48 hours' AND now() ORDER BY c.occurred_at DESC, c.id DESC LIMIT 5",
          [userId]
        )
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT timezone FROM checkin_call_settings WHERE user_id = $1', [userId]),
    attempt.severity !== 'URGENT' ? weather.forecast(prefs) : Promise.resolve(null),
  ]);
  const profile = profileResult.rows[0];
  let timezone = settingsResult.rows[0]?.timezone || 'Asia/Ho_Chi_Minh';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    timezone = 'Asia/Ho_Chi_Minh';
  }
  const address = addressFor(prefs, profile, lang, now, timezone);
  const name = prefs.use_name ? speechName(profile?.name) : '';
  const recipient = [address, name].filter(Boolean).join(' ');
  const greeting = t(
    recipient ? 'checkinCall.voice.greeting_named' : 'checkinCall.voice.greeting',
    lang,
    { recipient }
  );
  const shortAddress = lang === 'vi' ? address || t('checkinCall.voice.address_ban', lang) : '';
  const context =
    prefs.use_health && attempt.severity !== 'URGENT'
      ? metricContext(logsResult.rows, lang, timezone, now, shortAddress)
      : t('checkinCall.voice.general_question', lang, { recipient: shortAddress });
  const weatherText = forecast
    ? t(`checkinCall.voice.weather_${forecast.advice}`, lang, { temperature: forecast.temperature })
    : '';
  const params = {
    recipient:
      lang === 'en'
        ? name
          ? `${name},`
          : ''
        : recipient || t('checkinCall.voice.address_ban', lang),
  };
  const prompts = Object.fromEntries(
    [
      'user_retry',
      'triage_location_prompt',
      'triage_symptom_prompt',
      'triage_intensity_prompt',
      'user_mild',
      'user_urgent',
    ].map((audioKey) => [audioKey, t(`checkinCall.voice.${audioKey}`, lang, params)])
  );
  prompts.user_prompt = [greeting, context, t('checkinCall.voice.choices', lang, params)].join(' ');
  prompts.user_ok = [t('checkinCall.voice.user_ok', lang, params), weatherText]
    .filter(Boolean)
    .join(' ');
  for (const audioKey of Object.keys(prompts))
    prompts[audioKey] = prompts[audioKey].replace(/\s+/g, ' ').trim();
  const version = createHash('sha256').update(JSON.stringify({ revision, prompts })).digest('hex');
  const notice = {
    version,
    greeting,
    context,
    prompts,
    weather: forecast ? { ...forecast, message: weatherText } : null,
    consent: {
      use_name: prefs.use_name,
      use_health: prefs.use_health,
      weather: prefs.weather_enabled,
    },
  };
  if (notices.size >= 256) notices.delete(notices.keys().next().value);
  notices.set(key, { userId, notice, expires: now + 5 * 60_000 });
  return notice;
}

async function userAudio(pool, attemptId, userId, key, lang = 'vi', expectedVersion) {
  const notice = await userNotice(pool, attemptId, userId, lang);
  if (expectedVersion && expectedVersion !== notice.version) {
    throw Object.assign(new Error('Notice changed'), {
      statusCode: 409,
      i18nKey: 'checkinCall.error.audio_unavailable',
    });
  }
  const text = Object.hasOwn(notice.prompts, key) ? notice.prompts[key] : null;
  if (!text)
    throw Object.assign(new Error('Unknown audio key'), {
      statusCode: 404,
      i18nKey: 'checkinCall.error.unknown_audio',
    });
  const version = audio.audioVersion(lang);
  const hash = createHash('sha256')
    .update(`${userId}:${attemptId}:${lang}:${version}:${text}`)
    .digest('hex');
  const stored = recordings.get(hash);
  if (stored?.expires > Date.now()) return stored.data;
  if (inFlight.has(hash)) return inFlight.get(hash);
  const task = audio.synthesizeText(text, lang).then((data) => {
    // A config change during synthesis must not populate the old cache key.
    if (data.audio_version !== version) return data;
    if (recordings.size >= 64) recordings.delete(recordings.keys().next().value);
    recordings.set(hash, { userId, data, expires: Date.now() + 5 * 60_000 });
    return data;
  });
  inFlight.set(hash, task);
  try {
    return await task;
  } finally {
    inFlight.delete(hash);
  }
}

module.exports = {
  DEFAULTS,
  validate,
  preferences,
  savePreferences,
  speechName,
  addressFor,
  metricContext,
  authorizedAttempt,
  userNotice,
  userAudio,
};
