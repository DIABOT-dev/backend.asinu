'use strict';

const express = require('express');
const request = require('supertest');
const service = require('../../src/services/onboarding/guidance.service');
const controller = require('../../src/controllers/guidance.controller');
const { bindController } = require('../../src/middleware/controller-handler.middleware');

function database() {
  const rows = new Map();
  const healthyUsers = new Set();
  return { rows, healthyUsers, query: jest.fn(async (sql, args) => {
    const id = args[0];
    if (sql.includes('INSERT INTO user_guidance_progress')) {
      const row = rows.get(id) || { user_id: id, role: null, welcome_seen: false, read_aloud: true,
        first_checkin: false, completed: {}, epoch: 0 };
      row.first_checkin ||= healthyUsers.has(id);
      rows.set(id, row); return { rows: [{ ...row }] };
    }
    const row = rows.get(id);
    if (sql.includes("completed = '{}'::jsonb")) {
      row.completed = {}; row.welcome_seen = false; row.epoch++;
      return { rows: [{ ...row }] };
    }
    if (!row || row.epoch !== args[6]) return { rows: [] };
    row.role = args[1] || row.role; row.welcome_seen ||= args[2];
    row.read_aloud = args[3] ?? row.read_aloud; row.first_checkin ||= args[4];
    row.completed = { ...row.completed, ...JSON.parse(args[5]) };
    return { rows: [{ ...row }] };
  }) };
}
function appFor(pool) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.get('X-Test-Account'));
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(401).json({ ok: false });
    req.user = { id }; return next();
  });
  app.get('/guidance', bindController(controller.getGuidance, pool));
  app.put('/guidance', bindController(controller.updateGuidance, pool));
  app.post('/guidance/replay', bindController(controller.replayGuidance, pool));
  return app;
}

describe('account-owned contextual guidance', () => {
  test('defaults are readable aloud, incomplete, and account-isolated', async () => {
    const pool = database();
    const a = await service.getProgress(pool, 11);
    expect(a).toEqual({ role: null, welcomeSeen: false, readAloud: true, firstCheckin: false, completed: [], epoch: 0 });
    await service.updateProgress(pool, 11, { epoch: 0, welcomeSeen: true, role: 'self', completed: ['home.fine'] });
    expect((await service.getProgress(pool, 12)).completed).toEqual([]);
    expect((await service.getProgress(pool, 11)).completed).toEqual(['home.fine']);
  });
  test('the same account on a second device sees merged acknowledgements', async () => {
    const pool = database(); await service.getProgress(pool, 1);
    await Promise.all([
      service.updateProgress(pool, 1, { epoch: 0, completed: ['home.fine'] }),
      service.updateProgress(pool, 1, { epoch: 0, completed: ['home.unwell', 'home.fine'] }),
    ]);
    expect((await service.getProgress(pool, 1)).completed).toEqual(['home.fine', 'home.unwell']);
    expect(pool.query.mock.calls.at(-1)[0]).toContain('ON CONFLICT');
  });
  test.each([
    { epoch: 0, user_id: 99 }, { epoch: 0, completed: ['invented'] },
    { epoch: -1 }, { epoch: 1.5 }, { epoch: 0, role: 'admin' },
    { epoch: 0, readAloud: 'false' }, { epoch: 0, welcomeSeen: false },
    { epoch: 0, completed: Array(service.STEP_IDS.length + 1).fill('home.fine') }, {}, null,
  ])('invalid updates cannot write to the database: %j', async body => {
    const pool = database();
    expect(await service.updateProgress(pool, 1, body)).toMatchObject({ ok: false, statusCode: 400 });
    expect(pool.query).not.toHaveBeenCalled();
  });
  test('replay preserves role, sound preference, and actual health history', async () => {
    const pool = database(); pool.healthyUsers.add(1);
    await service.getProgress(pool, 1);
    await service.updateProgress(pool, 1, { epoch: 0, role: 'caregiver', welcomeSeen: true, readAloud: false, completed: ['circle.add'] });
    expect(await service.replayProgress(pool, 1)).toEqual({ role: 'caregiver', welcomeSeen: false, readAloud: false,
      firstCheckin: true, completed: [], epoch: 1 });
    expect(await service.updateProgress(pool, 1, { epoch: 0, completed: ['circle.add'] }))
      .toMatchObject({ ok: false, statusCode: 409, code: 'GUIDANCE_STALE' });
  });
  test('check-in status and location coaches never mark the later symptom-question coaches complete', async () => {
    const pool = database(); const app = appFor(pool);
    await request(app).get('/guidance').set('X-Test-Account', '11').expect(200);
    const completed = ['checkin.status', 'checkin.location', 'checkin.location_other'];
    const saved = await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, completed }).expect(200);
    expect(saved.body.progress.completed).toEqual(completed);
    const reopened = await request(app).get('/guidance').set('X-Test-Account', '11').expect(200);
    expect(reopened.body.progress.completed).toEqual(completed);
    expect(reopened.body.progress.completed).not.toContain('checkin.choices');
    expect(reopened.body.progress.completed).not.toContain('checkin.other');
    expect((await service.getProgress(pool, 12)).completed).toEqual([]);
    await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, completed: ['checkin.choices', 'checkin.other'] }).expect(200);
    expect((await service.getProgress(pool, 11)).completed).toEqual([...completed, 'checkin.choices', 'checkin.other']);
  });
  test('unauthenticated requests cannot read or alter guidance', async () => {
    const pool = database(); const app = appFor(pool);
    await request(app).get('/guidance').expect(401);
    await request(app).put('/guidance').send({ epoch: 0 }).expect(401);
    await request(app).post('/guidance/replay').expect(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
  test('practice completion stores only guide metadata and never creates real health history', async () => {
    const pool = database(); const app = appFor(pool);
    await request(app).get('/guidance').set('X-Test-Account', '11').expect(200);
    pool.query.mockClear();
    const response = await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, completed: ['checkin.finished'] }).expect(200);
    expect(response.body.progress.completed).toEqual(['checkin.finished']);
    expect(response.body.progress.firstCheckin).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE user_guidance_progress/);
    expect(pool.query.mock.calls[0][0]).not.toMatch(/health_checkins|notifications|checkin_call/);
    expect(pool.query.mock.calls[0][1][5]).toBe('{"checkin.finished":true}');
    pool.query.mockClear();
    await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, completed: ['checkin.finished'], answers: ['private answer'], result: { severity: 'high' } }).expect(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
  test('HTTP handlers use only the authenticated account and reject spoofed payloads', async () => {
    const pool = database(); const app = appFor(pool);
    await request(app).get('/guidance').set('X-Test-Account', '11').expect(200);
    await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, user_id: 12, completed: ['home.fine'] }).expect(400);
    await request(app).put('/guidance').set('X-Test-Account', '11')
      .send({ epoch: 0, welcomeSeen: true, role: 'self', completed: ['home.fine'] }).expect(200);
    const response = await request(app).get('/guidance').set('X-Test-Account', '12').expect(200);
    expect(response.body.progress.welcomeSeen).toBe(false);
    await request(app).post('/guidance/replay').set('X-Test-Account', '11').expect(200);
    await request(app).put('/guidance').set('X-Test-Account', '11').send({ epoch: 0 }).expect(409);
  });
  test('all production guidance routes require authentication and a bound controller', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/routes/mobile.routes.js'), 'utf8');
    for (const [method, path, handler] of [['get', '/guidance', 'getGuidance'], ['put', '/guidance', 'updateGuidance'],
      ['post', '/guidance/replay', 'replayGuidance']]) {
      expect(source).toContain(`router.${method}('${path}', requireAuth, bindController(${handler}, pool))`);
    }
  });
});
