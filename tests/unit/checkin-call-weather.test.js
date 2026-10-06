'use strict';

let weather;
const now = Date.parse('2026-10-06T04:00:00Z');
const settings = { weather_enabled: true, region: 'hanoi' };
function data(temperature = 34, symbol = 'clearsky_day', time = new Date(now).toISOString()) {
  return {
    properties: {
      timeseries: [
        {
          time,
          data: {
            instant: { details: { air_temperature: temperature } },
            next_1_hours: { summary: { symbol_code: symbol } },
          },
        },
      ],
    },
  };
}
function response(
  body = data(),
  {
    status = 200,
    expires = now + 30 * 60_000,
    modified = 'Tue, 06 Oct 2026 03:00:00 GMT',
    length = '1000',
  } = {}
) {
  const values = {
    expires: new Date(expires).toUTCString(),
    'last-modified': modified,
    'content-length': length,
  };
  return {
    ok: status === 200,
    status,
    headers: { get: (key) => values[key] || null },
    json: jest.fn(async () => body),
  };
}
beforeEach(() => {
  jest.resetModules();
  weather = require('../../src/services/checkin-call/weather.service');
});

test('location validation rejects malformed input and precision is restricted to an area', () => {
  for (const input of [
    null,
    {},
    { latitude: '10', longitude: 106 },
    { latitude: NaN, longitude: 106 },
    { latitude: 10, longitude: 181 },
  ]) {
    expect(weather.coarseLocation(input)).toBeNull();
  }
  expect(weather.coarseLocation({ latitude: 10.762622, longitude: 106.660172 })).toEqual({
    latitude: 10.8,
    longitude: 106.7,
  });
  expect(weather.pointFor({ weather_enabled: true, region: 'constructor' })).toBeNull();
});
test('no consent or invalid region makes no external request', async () => {
  const fetcher = jest.fn();
  for (const value of [
    { weather_enabled: false, region: 'hanoi' },
    { weather_enabled: true, region: null },
    { weather_enabled: true, region: 'device', location: null },
  ]) {
    expect(await weather.forecast(value, { fetcher, now })).toBeNull();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
test.each([
  [34, 'clearsky_day', 'heat'],
  [12, 'clearsky_day', 'cold'],
  [24, 'rain', 'rain'],
  [24, 'fair_day', 'mild'],
])(
  'general advice %i/%s is classified without medical recommendations',
  (temperature, symbol, advice) => {
    expect(weather.summarize(data(temperature, symbol), now)).toMatchObject({
      temperature,
      advice,
      source: 'MET Norway',
      forecast_at: new Date(now).toISOString(),
    });
  }
);
test('stale forecasts, absent or impossible temperatures are not advice', () => {
  for (const value of [
    null,
    {},
    data(null),
    data(80),
    data(20, 'fair', new Date(now - 2 * 3600_000).toISOString()),
  ]) {
    expect(weather.summarize(value, now)).toBeNull();
  }
});
test('backend requests contain only coarse area coordinates and an identifying User-Agent', async () => {
  const fetcher = jest.fn(async () => response());
  const result = await weather.forecast(
    {
      weather_enabled: true,
      region: 'device',
      location: { latitude: 10.762622, longitude: 106.660172 },
      name: 'Lan',
      user_id: 7,
    },
    { fetcher, now }
  );
  expect(result.advice).toBe('heat');
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=10.8&lon=106.7'
  );
  expect(fetcher.mock.calls[0][1].headers['User-Agent']).toContain('Asinu');
  expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/Lan|user_id/);
});
test('Expires cache is shared by region, and simultaneous calls coalesce into one forecast', async () => {
  const fetcher = jest.fn(async () => response());
  const [first, second] = await Promise.all([
    weather.forecast(settings, { fetcher, now }),
    weather.forecast(settings, { fetcher, now }),
  ]);
  expect(first).toEqual(second);
  await weather.forecast(settings, { fetcher, now: now + 60_000 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('after Expires a 304 uses Last-Modified without parsing an empty body', async () => {
  const notModified = response(null, { status: 304 });
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response(data(), { expires: now + 60_000 }))
    .mockResolvedValueOnce(notModified);
  await weather.forecast(settings, { fetcher, now });
  expect(await weather.forecast(settings, { fetcher, now: now + 2 * 60_000 })).toMatchObject({
    advice: 'heat',
  });
  expect(fetcher.mock.calls[1][1].headers['If-Modified-Since']).toBe(
    'Tue, 06 Oct 2026 03:00:00 GMT'
  );
  expect(notModified.json).not.toHaveBeenCalled();
});
test.each([403, 429])(
  'provider status %i disables attempts temporarily instead of retrying repeatedly',
  async (status) => {
    const fetcher = jest.fn(async () => response(null, { status }));
    expect(await weather.forecast(settings, { fetcher, now })).toBeNull();
    expect(
      await weather.forecast({ ...settings, region: 'hcm' }, { fetcher, now: now + 60_000 })
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
);
test('offline, timeout, malformed and oversized responses do not prevent check-in', async () => {
  for (const fetcher of [
    jest.fn(async () => {
      throw new Error('offline');
    }),
    jest.fn(async () => response(null)),
    jest.fn(async () => response(data(), { length: '1000001' })),
  ]) {
    jest.resetModules();
    weather = require('../../src/services/checkin-call/weather.service');
    expect(await weather.forecast(settings, { fetcher, now })).toBeNull();
    expect(await weather.forecast(settings, { fetcher, now: now + 60_000 })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
