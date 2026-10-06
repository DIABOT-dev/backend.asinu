'use strict';

jest.mock('../../src/services/payment/entitlement.service', () => ({ getEntitlement: jest.fn() }));
jest.mock('../../src/services/checkin-call/audio.service', () => ({
  synthesizeText: jest.fn(),
  audioVersion: jest.fn(() => 'voice-v1'),
}));
jest.mock('../../src/services/checkin-call/weather.service', () => ({
  ...jest.requireActual('../../src/services/checkin-call/weather.service'),
  forecast: jest.fn(),
}));

let service, entitlement, audio, weather;
const NOW = Date.parse('2026-10-06T04:00:00Z');
const recent = new Date(NOW - 60 * 60_000).toISOString();
function poolFor({
  authorized = true,
  severity = 'NONE',
  prefs = {},
  profile = {},
  logs = [],
  timezone = 'Asia/Ho_Chi_Minh',
} = {}) {
  let value = prefs;
  let revision = '2026-10-06T00:00:00Z';
  return {
    query: jest.fn(async (sql, args) => {
      if (sql.includes('FROM checkin_call_attempts')) {
        expect(sql).toContain("a.target_role = 'USER'");
        expect(sql).toContain('a.target_user_id = $2');
        expect(sql).toContain('e.user_id = $2');
        return { rows: authorized ? [{ id: args[0], episode_id: 'episode', severity }] : [] };
      }
      if (sql.startsWith('SELECT preferences'))
        return { rows: [{ preferences: value, updated_at: revision }] };
      if (sql.startsWith('INSERT INTO checkin_call_voice_preferences')) {
        value = JSON.parse(args[1]);
        revision = '2026-10-06T01:00:00Z';
        return { rows: [{ preferences: value }] };
      }
      if (sql.includes('FROM users u'))
        return { rows: [{ name: 'Nguyễn Thị Lan', gender: 'Nữ', birth_year: 1956, ...profile }] };
      if (sql.includes('FROM logs_common')) {
        expect(args).toEqual([7]);
        expect(sql).toContain('c.user_id = $1');
        expect(sql).toContain('LIMIT 5');
        expect(sql).toContain("interval '48 hours'");
        return { rows: logs };
      }
      if (sql.includes('SELECT timezone')) return { rows: [{ timezone }] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  service = require('../../src/services/checkin-call/personalization.service');
  entitlement = require('../../src/services/payment/entitlement.service');
  audio = require('../../src/services/checkin-call/audio.service');
  weather = require('../../src/services/checkin-call/weather.service');
  entitlement.getEntitlement.mockResolvedValue({ callCenterEnabled: true });
  audio.synthesizeText.mockResolvedValue({
    mime_type: 'audio/mpeg',
    audio_data: Buffer.from('test'),
    audio_version: 'voice-v1',
  });
  weather.forecast.mockResolvedValue(null);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

test('consents start off and no schedule values are accepted', () => {
  expect(service.validate({})).toEqual(service.DEFAULTS);
  expect(service.DEFAULTS).toMatchObject({
    use_name: false,
    use_health: false,
    weather_enabled: false,
  });
  for (const bad of [
    null,
    [],
    'yes',
    { use_name: 'true' },
    { use_health: 1 },
    { address: 'doctor' },
    { region: 'constructor' },
    { weather_enabled: true, region: ['hanoi'] },
    { region: {} },
    { weather_enabled: true },
    { enabled: true },
    { user_id: 8 },
    JSON.parse('{"__proto__": {"use_name": true}}'),
    { weather_enabled: true, region: 'device', location: { latitude: 91, longitude: 10 } },
  ]) {
    expect(() => service.validate(bad)).toThrow('Invalid voice preferences');
  }
});
test('device location is coarse and removed when weather is revoked or a city is selected', () => {
  const location = { latitude: 10.762622, longitude: 106.660172, user: 'not-stored' };
  expect(service.validate({ weather_enabled: true, region: 'device', location }).location).toEqual({
    latitude: 10.8,
    longitude: 106.7,
  });
  expect(service.validate({ weather_enabled: false, region: 'device', location })).toMatchObject({
    region: null,
    location: null,
  });
  expect(
    service.validate({ weather_enabled: true, region: 'hanoi', location }).location
  ).toBeNull();
});
test('expired packages cannot enable optional data use but can revoke all consents', async () => {
  entitlement.getEntitlement.mockResolvedValue({ callCenterEnabled: false });
  const pool = poolFor();
  await expect(service.savePreferences(pool, 7, { use_name: true })).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(pool.query).not.toHaveBeenCalled();
  await expect(service.savePreferences(pool, 7, {})).resolves.toEqual(service.DEFAULTS);
  expect(pool.query.mock.calls[0][1]).toEqual([7, JSON.stringify(service.DEFAULTS)]);
});
test.each([
  [{ birth_year: 1956 }, 'bac'],
  [{ date_of_birth: '1966-10-07', gender: 'Nam' }, 'anh'],
  [{ date_of_birth: '1966-10-06', gender: 'Nữ' }, 'bac'],
  [{ birth_year: 1990, gender: 'Nữ' }, 'chi'],
  [{ birth_year: 1990, gender: 'Nam' }, 'anh'],
  [{ age: '60+' }, 'bac'],
  [{ age: '40-49', gender: 'Nữ' }, 'chi'],
  [{ birth_year: 2030, gender: 'Nam' }, 'ban'],
  [{}, 'ban'],
])('automatic address respects age and does not invent gender: %j', (profile, expected) => {
  const { t } = require('../../src/i18n');
  expect(service.addressFor(service.DEFAULTS, profile, 'vi', NOW)).toBe(
    t(`checkinCall.voice.address_${expected}`, 'vi')
  );
});
test('manual honorific overrides age and English never reads Vietnamese honorifics', () => {
  expect(service.addressFor({ address: 'co' }, { birth_year: 1930 }, 'vi', NOW)).toBe('cô');
  expect(service.addressFor({ address: 'bac' }, {}, 'en', NOW)).toBe('');
});
test('birthday thresholds use the saved local date, not a shifted PostgreSQL DATE or UTC date', () => {
  const localBirthday = Date.parse('2026-10-06T18:00:00Z');
  expect(
    service.addressFor(
      service.DEFAULTS,
      { date_of_birth: '1966-10-07', gender: 'Nam' },
      'vi',
      localBirthday
    )
  ).toBe('bác');
  expect(
    service.addressFor(
      service.DEFAULTS,
      { date_of_birth: '1966-10-07', gender: 'Nam' },
      'vi',
      localBirthday,
      'UTC'
    )
  ).toBe('anh');
});
test('a name never falls back to an email, phone, id or markup', () => {
  expect(service.speechName('Nguyễn   Thị Lan')).toBe('Nguyễn Thị Lan');
  for (const value of [
    null,
    '0917325686',
    'name@example.com',
    'User 7',
    'User-test',
    '5ea78cde-36b7-4acc',
    '',
  ]) {
    expect(service.speechName(value)).toBe('');
  }
  expect(service.speechName('<Lan>')).toBe('Lan');
});
test.each(['vi', 'en'])('one real recent measurement retains timestamp and unit in %s', (lang) => {
  const bp = service.metricContext(
    [{ log_type: 'blood_pressure', occurred_at: recent, systolic: 125, diastolic: 80 }],
    lang,
    'Asia/Ho_Chi_Minh',
    NOW
  );
  expect(bp).toContain('125');
  expect(bp).toContain('80');
  expect(bp).toContain(lang === 'vi' ? 'mi-li-mét thủy ngân' : 'millimetres of mercury');
  expect(bp).toContain('10:00');
  const glucose = service.metricContext(
    [{ log_type: 'glucose', occurred_at: recent, glucose_value: 6.4, glucose_unit: 'mmol/L' }],
    lang,
    'UTC',
    NOW
  );
  expect(glucose).toContain(lang === 'vi' ? '6,4' : '6.4');
  expect(glucose).toContain('03:00');
  expect(glucose).not.toMatch(/diagnos|chẩn đoán|tăng liều|increase.*dose/i);
});
test('missing, future, stale, impossible or unitless readings use a neutral question', () => {
  const { t } = require('../../src/i18n');
  const invalid = [
    { log_type: 'blood_pressure', occurred_at: recent, systolic: 80, diastolic: 130 },
    { log_type: 'blood_pressure', occurred_at: recent, systolic: 400, diastolic: 80 },
    { log_type: 'glucose', occurred_at: recent, glucose_value: -1, glucose_unit: 'mg/dL' },
    { log_type: 'glucose', occurred_at: recent, glucose_value: 120, glucose_unit: null },
    { log_type: 'glucose', occurred_at: recent, glucose_value: 120, glucose_unit: 'mmol/L' },
    {
      log_type: 'glucose',
      occurred_at: new Date(NOW + 1000).toISOString(),
      glucose_value: 120,
      glucose_unit: 'mg/dL',
    },
    {
      log_type: 'glucose',
      occurred_at: new Date(NOW - 49 * 3600_000).toISOString(),
      glucose_value: 120,
      glucose_unit: 'mg/dL',
    },
  ];
  expect(service.metricContext(invalid, 'vi', 'UTC', NOW)).toBe(
    t('checkinCall.voice.no_recent_data', 'vi', { recipient: 'bạn' })
  );
});
test('ownership is verified before private data, weather or synthesis is accessed', async () => {
  const pool = poolFor({ authorized: false });
  await expect(
    service.userAudio(pool, 'family-or-other-user', 7, 'user_prompt')
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(weather.forecast).not.toHaveBeenCalled();
  expect(audio.synthesizeText).not.toHaveBeenCalled();
});
test('disabled health consent never queries health logs and disabled name never appears', async () => {
  const pool = poolFor();
  const notice = await service.userNotice(pool, 'attempt-7', 7);
  expect(notice.greeting).toContain('Asinu');
  expect(notice.greeting).not.toContain('Lan');
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM logs_common'))).toBe(false);
  expect(notice.weather).toBeNull();
  expect(notice.version).toMatch(/^[a-f0-9]{64}$/);
});
test('consented measurements are own-user scoped, cached as one snapshot and never included in weather requests', async () => {
  const pool = poolFor({
    prefs: { use_name: true, use_health: true },
    logs: [{ log_type: 'blood_pressure', occurred_at: recent, systolic: 125, diastolic: 80 }],
  });
  const first = await service.userNotice(pool, 'attempt-7', 7);
  expect(first.prompts.user_prompt).toContain('bác Nguyễn Thị Lan');
  expect(first.context).toContain('125');
  const second = await service.userNotice(pool, 'attempt-7', 7);
  expect(second).toBe(first);
  expect(pool.query.mock.calls.filter(([sql]) => sql.includes('FROM logs_common'))).toHaveLength(1);
  expect(weather.forecast.mock.calls[0][0]).not.toHaveProperty('name');
  expect(weather.forecast.mock.calls[0][0]).not.toHaveProperty('logs');
});
test('weather advice is only spoken after okay, never on triage or urgent acknowledgement', async () => {
  weather.forecast.mockResolvedValue({
    temperature: 34,
    advice: 'heat',
    source: 'MET Norway',
    forecast_at: recent,
  });
  const pool = poolFor({ prefs: { weather_enabled: true, region: 'hanoi' } });
  const notice = await service.userNotice(pool, 'attempt-7', 7);
  expect(notice.prompts.user_ok).toContain(notice.weather.message);
  for (const key of [
    'user_prompt',
    'user_mild',
    'user_urgent',
    'triage_location_prompt',
    'triage_symptom_prompt',
    'triage_intensity_prompt',
  ]) {
    expect(notice.prompts[key]).not.toContain(notice.weather.message);
  }
});
test('an urgent episode skips measurements and weather even if consented', async () => {
  const pool = poolFor({
    severity: 'URGENT',
    prefs: { use_health: true, weather_enabled: true, region: 'hanoi' },
  });
  const notice = await service.userNotice(pool, 'attempt-urgent', 7);
  expect(weather.forecast).not.toHaveBeenCalled();
  expect(notice.weather).toBeNull();
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM logs_common'))).toBe(false);
});
test('invalid saved timezone cannot interrupt a personalized call', async () => {
  const notice = await service.userNotice(
    poolFor({ timezone: 'not/a-zone', prefs: { use_health: true } }),
    'attempt',
    7
  );
  expect(notice.prompts.user_prompt).toContain('Asinu');
});
test('personalized synthesis matches the displayed version and coalesces concurrent replay', async () => {
  const pool = poolFor({ prefs: { use_name: true } });
  const notice = await service.userNotice(pool, 'attempt', 7);
  const [first, second] = await Promise.all([
    service.userAudio(pool, 'attempt', 7, 'user_prompt', 'vi', notice.version),
    service.userAudio(pool, 'attempt', 7, 'user_prompt', 'vi', notice.version),
  ]);
  expect(first).toBe(second);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
  expect(audio.synthesizeText).toHaveBeenCalledWith(notice.prompts.user_prompt, 'vi');
  await expect(service.userAudio(pool, 'attempt', 7, 'toString')).rejects.toMatchObject({
    statusCode: 404,
  });
});
test('revoked consent invalidates snapshots; old transcript is not synthesized or served', async () => {
  const pool = poolFor({ prefs: { use_name: true, use_health: true } });
  const before = await service.userNotice(pool, 'attempt', 7);
  await service.userAudio(pool, 'attempt', 7, 'user_prompt', 'vi', before.version);
  await service.savePreferences(pool, 7, {});
  const after = await service.userNotice(pool, 'attempt', 7);
  expect(after.version).not.toBe(before.version);
  expect(after.greeting).not.toContain('Lan');
  await expect(
    service.userAudio(pool, 'attempt', 7, 'user_prompt', 'vi', before.version)
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
});
test('personalized recordings are not reused across attempts or recipients', async () => {
  const pool = poolFor();
  await service.userAudio(pool, 'first', 7, 'user_ok');
  await service.userAudio(pool, 'second', 7, 'user_ok');
  await service.userAudio(pool, 'first', 8, 'user_ok');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(3);
});

test('changing only the backend voice revision regenerates the same personalized transcript', async () => {
  const pool = poolFor();
  await service.userAudio(pool, 'same-attempt', 7, 'user_ok');
  await service.userAudio(pool, 'same-attempt', 7, 'user_ok');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
  audio.audioVersion.mockReturnValue('voice-v2');
  audio.synthesizeText.mockResolvedValue({
    mime_type: 'audio/mpeg', audio_data: Buffer.from('new voice'), audio_version: 'voice-v2',
  });
  const changed = await service.userAudio(pool, 'same-attempt', 7, 'user_ok');
  expect(changed.audio_version).toBe('voice-v2');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
});
