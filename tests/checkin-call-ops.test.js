const express = require('express');
const request = require('supertest');
const checkinCallOpsRoutes = require('../src/routes/checkin-call.ops.routes');

describe('check-in call operational monitoring', () => {
  const previousSecret = process.env.CRON_SECRET;
  let app;
  let pool;

  beforeAll(() => {
    process.env.CRON_SECRET = 'ops-test-secret';
    pool = {
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM checkin_call_attempts'))
          return { rows: [{ state: 'CONNECTED', count: 2 }] };
        if (sql.includes('FROM checkin_call_deliveries') && sql.includes('GROUP BY state')) {
          return { rows: [{ state: 'FAILED', count: 1 }] };
        }
        if (sql.includes('due_episodes')) {
          return { rows: [{ due_episodes: 1, oldest_due_seconds: 12, stale_deliveries: 0 }] };
        }
        if (sql.includes('FROM checkin_call_audio')) {
          return { rows: [{ count: 24, newest_at: new Date('2026-09-28T00:00:00Z') }] };
        }
        if (sql.includes('FROM checkin_call_events')) {
          return { rows: [{ id: 1, event: 'EXHAUSTED', detail: {}, created_at: new Date() }] };
        }
        if (sql.includes("state IN ('EXHAUSTED'")) {
          return { rows: [{ id: 'episode-1', state: 'EXHAUSTED', severity: 'UNKNOWN' }] };
        }
        return { rows: [{ state: 'EXHAUSTED', count: 1 }] };
      }),
    };
    app = express();
    app.use('/api/internal/checkin-call', checkinCallOpsRoutes(pool));
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  test('requires the cron secret', async () => {
    await request(app).get('/api/internal/checkin-call/metrics').expect(401);
  });

  test('returns queue, delivery, episode and audio readiness metrics', async () => {
    const response = await request(app)
      .get('/api/internal/checkin-call/metrics')
      .set('x-cron-secret', 'ops-test-secret')
      .expect(200);
    expect(response.body).toMatchObject({
      ok: true,
      episodes_24h: { EXHAUSTED: 1 },
      attempts_24h: { CONNECTED: 2 },
      deliveries_24h: { FAILED: 1 },
      queue: { due_episodes: 1, oldest_due_seconds: 12, stale_deliveries: 0 },
      audio_cache: { cached: 24, expected: 24, ready: true },
    });
  });

  test('returns EXHAUSTED episodes and an episode audit timeline', async () => {
    const exhausted = await request(app)
      .get('/api/internal/checkin-call/exhausted')
      .set('x-cron-secret', 'ops-test-secret')
      .expect(200);
    expect(exhausted.body.episodes[0]).toMatchObject({ id: 'episode-1', state: 'EXHAUSTED' });

    const timeline = await request(app)
      .get('/api/internal/checkin-call/episodes/episode-1/timeline')
      .set('x-cron-secret', 'ops-test-secret')
      .expect(200);
    expect(timeline.body.events[0].event).toBe('EXHAUSTED');
  });

  test('returns a localized server error without exposing operational failures', async () => {
    pool.query.mockRejectedValueOnce(new Error('sensitive database details'));
    const response = await request(app)
      .get('/api/internal/checkin-call/metrics')
      .set('x-cron-secret', 'ops-test-secret')
      .set('accept-language', 'en')
      .expect(500);
    expect(response.body).toMatchObject({ ok: false });
    expect(response.body.error).not.toContain('sensitive database details');
  });
});
