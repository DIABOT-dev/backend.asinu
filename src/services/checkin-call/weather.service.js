'use strict';

// Coarse, consented regions only. Never send a user id, name or health record.
// MET Norway open data: CC BY 4.0, https://api.met.no/doc/License.
const regions = Object.freeze({
  hanoi: [21, 105.8],
  hcm: [10.8, 106.7],
  danang: [16.1, 108.2],
  haiphong: [20.8, 106.7],
  cantho: [10, 105.8],
  hue: [16.5, 107.6],
});
const cache = new Map();
const pending = new Map();
let blockedUntil = 0;

function coarseLocation(input) {
  if (!input || typeof input !== 'object') return null;
  const { latitude, longitude } = input;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  return { latitude: Math.round(latitude * 10) / 10, longitude: Math.round(longitude * 10) / 10 };
}

function pointFor(preferences) {
  if (!preferences?.weather_enabled) return null;
  if (preferences.region === 'device') return coarseLocation(preferences.location);
  const point = Object.hasOwn(regions, preferences.region) ? regions[preferences.region] : null;
  return point ? { latitude: point[0], longitude: point[1] } : null;
}

function summarize(data, now) {
  const points = data?.properties?.timeseries;
  if (!Array.isArray(points)) return null;
  const point = points.find((item) => Math.abs(Date.parse(item.time) - now) <= 90 * 60_000);
  const temperature = point?.data?.instant?.details?.air_temperature;
  if (
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    temperature < -70 ||
    temperature > 65
  )
    return null;
  const symbol =
    point.data.next_1_hours?.summary?.symbol_code ||
    point.data.next_6_hours?.summary?.symbol_code ||
    '';
  return {
    temperature: Math.round(temperature),
    forecast_at: point.time,
    advice:
      temperature >= 32
        ? 'heat'
        : temperature <= 15
          ? 'cold'
          : /rain|sleet|snow/.test(symbol)
            ? 'rain'
            : 'mild',
    source: 'MET Norway',
    source_url: 'https://api.met.no/',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
  };
}

async function forecast(preferences, { fetcher = fetch, now = Date.now() } = {}) {
  const point = pointFor(preferences);
  if (!point) return null;
  const key = `${point.latitude},${point.longitude}`;
  const stored = cache.get(key);
  if (stored && stored.expires > now) return summarize(stored.data, now);
  if (now < blockedUntil) return null;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 4) return null;
  const rememberFailure = () => {
    if (cache.size >= 256 && !cache.has(key)) cache.delete(cache.keys().next().value);
    cache.set(key, { expires: now + 5 * 60_000, data: null });
    return null;
  };
  const request = (async () => {
    try {
      const headers = {
        'User-Agent':
          process.env.CHECKIN_WEATHER_USER_AGENT ||
          'AsinuCheckin/1.0 (https://github.com/DIABOT-dev/backend.asinu)',
      };
      if (stored?.lastModified) headers['If-Modified-Since'] = stored.lastModified;
      const response = await fetcher(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${point.latitude}&lon=${point.longitude}`,
        {
          headers,
          signal: AbortSignal.timeout(1800),
        }
      );
      if (response.status === 429 || response.status === 403) {
        blockedUntil = now + 60 * 60_000;
        return null;
      }
      if (!response.ok && response.status !== 304) return rememberFailure();
      if (Number(response.headers.get('content-length')) > 1_000_000) return rememberFailure();
      const data = response.status === 304 ? stored?.data : await response.json();
      const result = summarize(data, now);
      if (!result) return rememberFailure();
      const expires = Date.parse(response.headers.get('expires'));
      if (cache.size >= 256 && !cache.has(key)) cache.delete(cache.keys().next().value);
      cache.set(key, {
        data,
        expires: Number.isFinite(expires) && expires > now ? expires : now + 30 * 60_000,
        lastModified: response.headers.get('last-modified') || stored?.lastModified,
      });
      return result;
    } catch {
      return rememberFailure();
    }
  })();
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
}

module.exports = { coarseLocation, regions, pointFor, summarize, forecast };
