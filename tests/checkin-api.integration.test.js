const express = require('express');
const { createHash } = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { Pool } = require('pg');
const entitlementService = require('../src/services/payment/entitlement.service');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('check-in HTTP API contract', () => {
  const jwtSecret = 'checkin-http-integration-secret';
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const createdUserIds = [];
  let app;
  let patientId;
  let familyId;
  let patientToken;
  let familyToken;
  let originalFetch;
  let checkinCallService;
  let sendVoipNotification;
  let audioBackup;

  const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Accept-Language': 'vi' });

  beforeAll(async () => {
    process.env.JWT_SECRET = jwtSecret;
    process.env.NODE_ENV = 'test';
    process.env.LIVEKIT_URL = 'wss://integration-test.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'integration-test-key';
    process.env.LIVEKIT_API_SECRET = 'integration-test-secret';

    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ status: 'ok', id: 'integration-ticket' }],
        model: 'medgemma-integration-test',
        choices: [
          {
            message: {
              content: JSON.stringify({
                severity: 'mild',
                reason: 'Không có dấu hiệu khẩn cấp trong dữ liệu kiểm thử.',
                needsFamilyAlert: false,
                needsDoctor: false,
                summary: 'Triệu chứng cần tiếp tục theo dõi.',
                recommendation: 'Tiếp tục theo dõi và đi khám nếu tình trạng nặng lên.',
                closeMessage: 'Asinu sẽ hỏi lại sau.',
              }),
            },
          },
        ],
      }),
    }));

    jest.resetModules();
    jest.doMock('../src/services/notification/apns.voip.service', () => ({
      sendVoipNotification: jest.fn(async () => ({ ok: true, apnsId: 'integration-apns' })),
    }));
    jest.doMock('../src/services/early-signal/early-signal.service', () => ({
      ...jest.requireActual('../src/services/early-signal/early-signal.service'),
      evaluateAfterNewHealthData: jest.fn(async () => null),
    }));
    const mobileRoutes = require('../src/routes/mobile.routes');
    const checkinCallRoutes = require('../src/routes/checkin-call.routes');
    checkinCallService = require('../src/services/checkin-call/checkin-call.service');
    sendVoipNotification =
      require('../src/services/notification/apns.voip.service').sendVoipNotification;
    const audioService = require('../src/services/checkin-call/audio.service');

    app = express();
    app.use(express.json());
    app.use('/api/mobile', mobileRoutes(pool));
    app.use('/api/mobile/checkin-call', checkinCallRoutes(pool));

    const seed = String(Date.now());
    const patient = await pool.query(
      'INSERT INTO users (phone_number, display_name, push_token) VALUES ($1,$2,$3) RETURNING id',
      [`http-patient-${seed}`, 'HTTP check-in patient', 'ExponentPushToken[http-patient]']
    );
    const family = await pool.query(
      'INSERT INTO users (phone_number, display_name, push_token) VALUES ($1,$2,$3) RETURNING id',
      [`http-family-${seed}`, 'HTTP check-in family', 'ExponentPushToken[http-family]']
    );
    patientId = patient.rows[0].id;
    familyId = family.rows[0].id;
    createdUserIds.push(patientId, familyId);
    patientToken = jwt.sign({ id: patientId }, jwtSecret, { expiresIn: '10m' });
    familyToken = jwt.sign({ id: familyId }, jwtSecret, { expiresIn: '10m' });

    await entitlementService.activateHouseholdPlan(pool, patientId, {
      planCode: 'antam_2',
      billingPeriod: 'monthly',
      platform: 'google',
      productId: 'asinu.antam2.monthly',
      originalTransactionId: `http-integration-${patientId}`,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await pool.query(
      "INSERT INTO user_connections (requester_id, addressee_id, status, permissions, accepted_at) VALUES ($1,$2,'accepted',$3::jsonb,now())",
      [patientId, familyId, JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true })]
    );

    const existingAudio = await pool.query(
      "SELECT * FROM checkin_call_audio WHERE audio_key = 'vi:user_prompt'"
    );
    audioBackup = existingAudio.rows[0] || null;
    const voice = process.env.VIENEU_VOICE || 'Ngọc Lan';
    const phrase = audioService.PHRASES.user_prompt.vi;
    const hash = createHash('sha256').update(`vi\n${voice}\n${phrase}`).digest('hex');
    await pool.query(
      "INSERT INTO checkin_call_audio (audio_key, text_hash, mime_type, audio_data) VALUES ('vi:user_prompt',$1,'audio/mpeg',$2) ON CONFLICT (audio_key) DO UPDATE SET text_hash = EXCLUDED.text_hash, mime_type = EXCLUDED.mime_type, audio_data = EXCLUDED.audio_data",
      [hash, Buffer.from('checkin-api-integration-audio')]
    );
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (audioBackup) {
      await pool.query(
        'INSERT INTO checkin_call_audio (audio_key, text_version, text_hash, mime_type, audio_data, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (audio_key) DO UPDATE SET text_version = EXCLUDED.text_version, text_hash = EXCLUDED.text_hash, mime_type = EXCLUDED.mime_type, audio_data = EXCLUDED.audio_data, created_at = EXCLUDED.created_at',
        [
          audioBackup.audio_key,
          audioBackup.text_version,
          audioBackup.text_hash,
          audioBackup.mime_type,
          audioBackup.audio_data,
          audioBackup.created_at,
        ]
      );
    } else {
      await pool.query("DELETE FROM checkin_call_audio WHERE audio_key = 'vi:user_prompt'");
    }
    if (createdUserIds.length) {
      await pool.query('DELETE FROM mission_history WHERE user_id = ANY($1::integer[])', [
        createdUserIds,
      ]);
      await pool.query('DELETE FROM user_missions WHERE user_id = ANY($1::integer[])', [
        createdUserIds,
      ]);
      await pool.query('DELETE FROM user_engagement WHERE user_id = ANY($1::integer[])', [
        createdUserIds,
      ]);
      await pool.query(
        'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
        [createdUserIds]
      );
      await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [createdUserIds]);
    }
    await pool.end();
    const redis = require('../src/lib/redis').getRedis();
    if (redis.status !== 'end') await redis.quit();
  });

  test('all check-in endpoints require authentication', async () => {
    await request(app).get('/api/mobile/checkin/today').expect(401);
    await request(app).get('/api/mobile/checkin-call/settings').expect(401);
  });

  test('health check-in frontend payloads match the HTTP API', async () => {
    const todayBefore = await request(app)
      .get('/api/mobile/checkin/today')
      .set(auth(patientToken))
      .expect(200);
    expect(todayBefore.body).toMatchObject({ ok: true, session: null });

    const locations = await request(app)
      .get('/api/mobile/checkin/locations')
      .set(auth(patientToken))
      .expect(200);
    expect(locations.body.ok).toBe(true);
    expect(locations.body.locations).toHaveLength(7);

    const started = await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(patientToken))
      .send({
        status: 'tired',
        body_locations: ['head', 'chest', 'head'],
        body_location_other: '  đau nhẹ  ',
      })
      .expect(200);
    expect(started.body).toMatchObject({
      ok: true,
      session: {
        user_id: patientId,
        initial_status: 'tired',
        body_locations: ['head', 'chest'],
        body_location_other: 'đau nhẹ',
      },
    });
    const checkinId = started.body.session.id;

    const restarted = await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(patientToken))
      .send({ status: 'specific_concern', restart: true, source: 'instant' })
      .expect(200);
    expect(restarted.body).toMatchObject({
      ok: true,
      session: {
        id: checkinId,
        initial_status: 'specific_concern',
        current_status: 'specific_concern',
        occurrence_source: 'instant',
        triage_messages: [],
        triage_summary: null,
        triage_completed_at: null,
      },
    });

    const archived = await pool.query(
      `SELECT source, initial_status, body_locations
       FROM health_checkin_occurrences
       WHERE checkin_id = $1
       ORDER BY archived_at DESC`,
      [checkinId]
    );
    expect(archived.rows).toHaveLength(1);
    expect(archived.rows[0]).toMatchObject({
      source: 'scheduled',
      initial_status: 'tired',
      body_locations: ['head', 'chest'],
    });

    const todayAfter = await request(app)
      .get('/api/mobile/checkin/today')
      .set(auth(patientToken))
      .expect(200);
    expect(todayAfter.body.session.id).toBe(checkinId);

    const followedUp = await request(app)
      .post('/api/mobile/checkin/followup')
      .set(auth(patientToken))
      .send({ checkin_id: checkinId, status: 'fine' })
      .expect(200);
    expect(followedUp.body).toMatchObject({ ok: true, session: { id: checkinId } });

    await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(patientToken))
      .send({ previous_answers: [] })
      .expect(400);

    const emergency = await request(app)
      .post('/api/mobile/checkin/emergency')
      .set(auth(patientToken))
      .send({ location: { lat: 10.7769, lng: 106.7009, accuracy: 12 } })
      .expect(200);
    expect(emergency.body).toMatchObject({ ok: true });
    expect(Number.isInteger(emergency.body.caregiversAlerted)).toBe(true);

    const pending = await request(app)
      .get('/api/mobile/checkin/pending-alerts')
      .set(auth(familyToken))
      .expect(200);
    expect(pending.body.ok).toBe(true);
    expect(Array.isArray(pending.body.alerts)).toBe(true);

    await request(app)
      .post('/api/mobile/checkin/confirm-alert')
      .set(auth(familyToken))
      .send({ alert_id: null, action: 'seen' })
      .expect(400);

    const report = await request(app)
      .get('/api/mobile/checkin/report?period=week')
      .set(auth(patientToken))
      .expect(200);
    expect(report.body).toMatchObject({ ok: true, period: 'week' });

    const healthScore = await request(app)
      .get('/api/mobile/health-score')
      .set(auth(patientToken))
      .expect(200);
    expect(healthScore.body.ok).toBe(true);
    expect(['ok', 'monitor', 'danger']).toContain(healthScore.body.level);
  });

  test('health check-in rejects malformed frontend payloads', async () => {
    await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(patientToken))
      .send({ status: 'unknown' })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(patientToken))
      .send({ status: 'tired', body_locations: 'head' })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(patientToken))
      .send({ status: 'tired', body_locations: ['invalid-location'] })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/followup')
      .set(auth(patientToken))
      .send({ checkin_id: null, status: 'fine' })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(patientToken))
      .send({ checkin_id: 1, previous_answers: {} })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(patientToken))
      .send({ checkin_id: 999999999, previous_answers: [] })
      .expect(404);
    await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(patientToken))
      .send({
        checkin_id: 1,
        previous_answers: Array.from({ length: 9 }, (_, index) => ({
          question: `Question ${index}`,
          answer: 'Answer',
        })),
      })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/emergency')
      .set(auth(patientToken))
      .send({ location: { lat: 999, lng: 106.7 } })
      .expect(400);
    await request(app)
      .post('/api/mobile/checkin/confirm-alert')
      .set(auth(familyToken))
      .send({ alert_id: 999999999, action: 'seen' })
      .expect(404);
    await request(app)
      .get('/api/mobile/checkin/report?period=year')
      .set(auth(patientToken))
      .expect(400);
  });

  test('triage accepts the frontend answer shape and applies deterministic red-flag safety', async () => {
    const started = await request(app)
      .post('/api/mobile/checkin/start')
      .set(auth(familyToken))
      .send({
        status: 'very_tired',
        body_locations: ['chest'],
        body_location_other: null,
      })
      .expect(200);

    const triage = await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(familyToken))
      .send({
        checkin_id: started.body.session.id,
        previous_answers: [
          {
            step: 'symptoms',
            question: 'Bạn đang gặp vấn đề gì?',
            answer: 'Tôi ngã cầu thang và va đập mạnh vào đầu',
          },
        ],
      })
      .expect(200);
    expect(triage.body).toMatchObject({
      ok: true,
      isDone: true,
      severity: 'emergency',
      needsDoctor: true,
      needsFamilyAlert: true,
      hasRedFlag: true,
    });

    const stored = await pool.query(
      'SELECT emergency_triggered, flow_state, triage_completed_at FROM health_checkins WHERE id = $1',
      [started.body.session.id]
    );
    expect(stored.rows[0]).toMatchObject({
      emergency_triggered: true,
      flow_state: 'high_alert',
    });
    expect(stored.rows[0].triage_completed_at).not.toBeNull();

    const report = await request(app)
      .get('/api/mobile/checkin/report?period=week')
      .set(auth(familyToken))
      .expect(200);
    expect(report.body.severityDistribution).toMatchObject({
      low: 0,
      medium: 0,
      high: 0,
      emergency: 1,
    });
  });

  test('triage hard limit persists a conclusion without false red-flag escalation', async () => {
    const inserted = await pool.query(
      "INSERT INTO health_checkins (user_id, session_date, initial_status, current_status) VALUES ($1, CURRENT_DATE - 2, 'very_tired', 'very_tired') RETURNING id",
      [familyId]
    );
    const previousAnswers = Array.from({ length: 8 }, (_, index) => ({
      question: `Câu hỏi ${index + 1}`,
      answer: 'Tôi không khó thở và không bị đau ngực',
    }));

    const triage = await request(app)
      .post('/api/mobile/checkin/triage')
      .set(auth(familyToken))
      .send({ checkin_id: inserted.rows[0].id, previous_answers: previousAnswers })
      .expect(200);
    expect(triage.body).toMatchObject({
      ok: true,
      isDone: true,
      severity: 'medium',
      needsFamilyAlert: false,
    });

    const stored = await pool.query(
      'SELECT triage_severity, triage_completed_at, flow_state FROM health_checkins WHERE id = $1',
      [inserted.rows[0].id]
    );
    expect(stored.rows[0]).toMatchObject({
      triage_severity: 'medium',
      flow_state: 'follow_up',
    });
    expect(stored.rows[0].triage_completed_at).not.toBeNull();
  });

  test('check-in call settings and validation match the frontend contract', async () => {
    const defaults = await request(app)
      .get('/api/mobile/checkin-call/settings')
      .set(auth(patientToken))
      .expect(200);
    expect(defaults.body.settings).toMatchObject({
      enabled: false,
      checkin_time: '08:00',
      timezone: 'Asia/Ho_Chi_Minh',
      grace_hours: 6,
      user_timeout_seconds: 60,
      family_ring_seconds: 60,
      family_confirm_minutes: 10,
      max_rounds: 1,
    });

    const saved = await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(patientToken))
      .send({
        enabled: true,
        checkin_time: '08:30',
        timezone: 'Asia/Ho_Chi_Minh',
        grace_hours: 2,
        user_timeout_seconds: 90,
        family_ring_seconds: 60,
        family_confirm_minutes: 5,
        max_rounds: 2,
      })
      .expect(200);
    expect(saved.body.settings).toMatchObject({
      enabled: true,
      grace_hours: 2,
      user_timeout_seconds: 90,
      family_confirm_minutes: 5,
      max_rounds: 2,
    });

    await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(patientToken))
      .send({ grace_hours: 1 })
      .expect(400);
    await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(patientToken))
      .send({ checkin_time: '25:00' })
      .expect(400);
  });

  test('test call supports the complete user OK HTTP flow', async () => {
    global.fetch.mockClear();
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    expect(started.body).toMatchObject({
      ok: true,
      episode: { user_id: patientId, state: 'CONTACT_USER' },
      attempt: { target_role: 'USER', state: 'RINGING' },
      delivery_state: 'SENT',
    });

    const expoRequest = global.fetch.mock.calls.find(([url]) =>
      String(url).includes('exp.host/--/api/v2/push/send')
    );
    expect(expoRequest).toBeDefined();
    const expoMessages = JSON.parse(expoRequest[1].body);
    expect(expoMessages[0].data).toMatchObject({
      type: 'checkin_call',
      episodeId: started.body.episode.id,
      attemptId: started.body.attempt.id,
      ringSeconds: 180,
    });

    const { episode, attempt } = started.body;
    const active = await request(app)
      .get('/api/mobile/checkin-call/active')
      .set(auth(patientToken))
      .expect(200);
    expect(active.body.active).toMatchObject({ id: episode.id, attempt_id: attempt.id });

    await request(app)
      .get(`/api/mobile/checkin-call/episodes/${episode.id}`)
      .set(auth(patientToken))
      .expect(200);
    await request(app)
      .get(`/api/mobile/checkin-call/attempts/${attempt.id}`)
      .set(auth(patientToken))
      .expect(200);

    const livekit = await request(app)
      .get(`/api/mobile/checkin-call/attempts/${attempt.id}/token`)
      .set(auth(patientToken))
      .expect(200);
    expect(livekit.body).toMatchObject({
      ok: true,
      url: 'wss://integration-test.livekit.cloud',
    });
    expect(typeof livekit.body.token).toBe('string');

    await request(app)
      .post(`/api/mobile/checkin-call/attempts/${attempt.id}/accept`)
      .set(auth(patientToken))
      .expect(200);
    const acceptedAgain = await request(app)
      .post(`/api/mobile/checkin-call/attempts/${attempt.id}/accept`)
      .set(auth(patientToken))
      .expect(200);
    expect(acceptedAgain.body).toMatchObject({ ok: true, alreadyAccepted: true });
    expect(acceptedAgain.body.confirm_deadline).toBeTruthy();
    const answered = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episode.id}/answer`)
      .set(auth(patientToken))
      .send({ choice: 1 })
      .expect(200);
    expect(answered.body.episode.state).toBe('RESOLVED');

    const falseHealthCheckin = await pool.query(
      "SELECT 1 FROM health_checkins WHERE user_id = $1 AND session_date = DATE '2099-12-31'",
      [patientId]
    );
    expect(falseHealthCheckin.rows).toHaveLength(0);
  });

  test('development CallKit simulation creates a real flow without sending a push', async () => {
    global.fetch.mockClear();
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .send({ single_device: true, local_simulation: true })
      .expect(201);

    expect(started.body).toMatchObject({
      ok: true,
      local_simulation: true,
      attempt: { target_role: 'USER', state: 'RINGING' },
      delivery_state: 'SENT',
    });
    expect(global.fetch).not.toHaveBeenCalled();

    const active = await request(app)
      .get('/api/mobile/checkin-call/active')
      .set(auth(patientToken))
      .expect(200);
    expect(active.body.active).toMatchObject({
      id: started.body.episode.id,
      attempt_id: started.body.attempt.id,
      local_callkit_simulation: true,
    });

    await request(app)
      .post(`/api/mobile/checkin-call/episodes/${started.body.episode.id}/answer`)
      .set(auth(patientToken))
      .send({ choice: 1 })
      .expect(200);
  });

  test('MILD call supports seen, accept and family confirmation over HTTP', async () => {
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const episodeId = started.body.episode.id;

    const triage = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episodeId}/triage/start`)
      .set(auth(patientToken))
      .expect(200);
    expect(triage.body.episode.state).toBe('TRIAGE_USER');
    expect(triage.body.triage.locations).toHaveLength(7);

    const escalated = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episodeId}/triage/complete`)
      .set(auth(patientToken))
      .send({ body_location: 'head', symptom: 'dizziness', intensity: 'MILD' })
      .expect(200);
    expect(escalated.body.episode.state).toBe('MILD_FAMILY_ESCALATION');
    expect(escalated.body.episode.triage_context).toEqual({
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MILD',
    });

    const active = await request(app)
      .get('/api/mobile/checkin-call/active')
      .set(auth(familyToken))
      .expect(200);
    expect(active.body.active).toMatchObject({ target_role: 'FAMILY', id: episodeId });
    const attemptId = active.body.active.attempt_id;

    const attempt = await request(app)
      .get(`/api/mobile/checkin-call/attempts/${attemptId}`)
      .set(auth(familyToken))
      .expect(200);
    expect(attempt.body.attempt.triage_display.summary).toContain('Đầu');
    expect(attempt.body.attempt.triage_display.summary).toContain('Chóng mặt');

    await request(app)
      .post(`/api/mobile/checkin-call/attempts/${attemptId}/seen`)
      .set(auth(familyToken))
      .expect(200);
    await request(app)
      .post(`/api/mobile/checkin-call/attempts/${attemptId}/accept`)
      .set(auth(familyToken))
      .expect(200);
    const acceptedAgain = await request(app)
      .post(`/api/mobile/checkin-call/attempts/${attemptId}/accept`)
      .set(auth(familyToken))
      .expect(200);
    expect(acceptedAgain.body).toMatchObject({ ok: true, alreadyAccepted: true });
    const confirmed = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episodeId}/family-confirm`)
      .set(auth(familyToken))
      .send({ action: 'ACCEPT_AND_CHECK' })
      .expect(200);
    expect(confirmed.body.episode).toMatchObject({
      state: 'RESOLVED',
      acknowledged_by: familyId,
    });
  });

  test('URGENT call stops the other calls after the first family member accepts', async () => {
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const episodeId = started.body.episode.id;

    const escalated = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episodeId}/answer`)
      .set(auth(patientToken))
      .send({ choice: 3 })
      .expect(200);
    expect(escalated.body.episode.state).toBe('URGENT_BROADCAST');

    const familyActive = await request(app)
      .get('/api/mobile/checkin-call/active')
      .set(auth(familyToken))
      .expect(200);
    expect(familyActive.body.active).toMatchObject({ target_role: 'FAMILY', id: episodeId });

    const accepted = await request(app)
      .post(`/api/mobile/checkin-call/attempts/${familyActive.body.active.attempt_id}/accept`)
      .set(auth(familyToken))
      .expect(200);
    expect(accepted.body.state).toBe('URGENT_ACKNOWLEDGED');

    const acceptedAgain = await request(app)
      .post(`/api/mobile/checkin-call/attempts/${familyActive.body.active.attempt_id}/accept`)
      .set(auth(familyToken))
      .expect(200);
    expect(acceptedAgain.body).toMatchObject({
      ok: true,
      state: 'URGENT_ACKNOWLEDGED',
      alreadyAccepted: true,
    });

    const recovered = await request(app)
      .get('/api/mobile/checkin-call/active')
      .set(auth(familyToken))
      .expect(200);
    expect(recovered.body.active).toMatchObject({
      id: episodeId,
      attempt_id: familyActive.body.active.attempt_id,
      attempt_state: 'CONNECTED',
      state: 'URGENT_ACKNOWLEDGED',
    });

    const confirmed = await request(app)
      .post(`/api/mobile/checkin-call/episodes/${episodeId}/family-confirm`)
      .set(auth(familyToken))
      .send({ action: 'ON_MY_WAY' })
      .expect(200);
    expect(confirmed.body.episode).toMatchObject({
      state: 'RESOLVED',
      acknowledged_by: familyId,
    });
  });

  test('push timeout is retried with durable state and eventually marked failed', async () => {
    global.fetch.mockRejectedValue(new Error('simulated push timeout'));
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const attemptId = started.body.attempt.id;

    for (let index = 0; index < 3; index += 1) {
      await pool.query(
        "UPDATE checkin_call_deliveries SET due_at = now() - interval '1 second' WHERE attempt_id = $1",
        [attemptId]
      );
      await checkinCallService.dispatchDeliveries(pool);
    }
    const delivery = await pool.query(
      'SELECT state, tries, last_error FROM checkin_call_deliveries WHERE attempt_id = $1',
      [attemptId]
    );
    expect(delivery.rows[0]).toMatchObject({ state: 'FAILED', tries: 4 });
    expect(delivery.rows[0].last_error).toContain('simulated push timeout');

    global.fetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'integration-ticket' }] }),
    }));
  });

  test('a delivery left in SENDING is recovered after a backend restart lease timeout', async () => {
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const attemptId = started.body.attempt.id;
    await pool.query(
      "UPDATE checkin_call_deliveries SET state = 'SENDING', updated_at = now() - interval '3 minutes' WHERE attempt_id = $1",
      [attemptId]
    );

    await checkinCallService.dispatchDeliveries(pool);

    const delivery = await pool.query(
      'SELECT state FROM checkin_call_deliveries WHERE attempt_id = $1',
      [attemptId]
    );
    expect(delivery.rows[0].state).toBe('SENT');
  });

  test('LiveKit configuration failure is explicit while response buttons remain backend-driven', async () => {
    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const previousUrl = process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_URL;
    try {
      await request(app)
        .get(`/api/mobile/checkin-call/attempts/${started.body.attempt.id}/token`)
        .set(auth(patientToken))
        .expect(503);
    } finally {
      process.env.LIVEKIT_URL = previousUrl;
    }
  });

  test('expired native calls are ended before escalation continues', async () => {
    await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(patientToken))
      .send({ enabled: false })
      .expect(200);
    await pool.query(
      "UPDATE users SET voip_push_token = CASE WHEN id = $1 THEN 'voip-patient' ELSE 'voip-family' END, voip_push_environment = 'sandbox' WHERE id = ANY($2::integer[])",
      [patientId, [patientId, familyId]]
    );

    const started = await request(app)
      .post('/api/mobile/checkin-call/test-call')
      .set(auth(patientToken))
      .expect(201);
    const episodeId = started.body.episode.id;
    const userAttemptId = started.body.attempt.id;

    sendVoipNotification.mockClear();
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE id = $1",
      [episodeId]
    );
    await checkinCallService.tick(pool);
    expect(sendVoipNotification).toHaveBeenCalledWith(
      'voip-patient',
      expect.objectContaining({ episodeId, attemptId: userAttemptId, kind: 'END_CALL' }),
      expect.objectContaining({ action: 'END_CALL' })
    );

    const familyActive = await checkinCallService.getActive(pool, familyId);
    expect(familyActive).toMatchObject({ target_role: 'FAMILY', id: episodeId });
    sendVoipNotification.mockClear();
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE id = $1",
      [episodeId]
    );
    await checkinCallService.tick(pool);
    expect(sendVoipNotification).toHaveBeenCalledWith(
      'voip-family',
      expect.objectContaining({
        episodeId,
        attemptId: familyActive.attempt_id,
        kind: 'END_CALL',
      }),
      expect.objectContaining({ action: 'END_CALL' })
    );
  });

  test('check-in call rejects invalid IDs, choices, actions and audio keys', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await request(app)
      .get(`/api/mobile/checkin-call/episodes/${missing}`)
      .set(auth(patientToken))
      .expect(404);
    await request(app)
      .get(`/api/mobile/checkin-call/attempts/${missing}`)
      .set(auth(patientToken))
      .expect(404);
    await request(app)
      .post(`/api/mobile/checkin-call/episodes/${missing}/answer`)
      .set(auth(patientToken))
      .send({ choice: 4 })
      .expect(400);
    await request(app)
      .post(`/api/mobile/checkin-call/episodes/${missing}/family-confirm`)
      .set(auth(familyToken))
      .send({ action: 'SEEN_ONLY' })
      .expect(400);
    await request(app)
      .post(`/api/mobile/checkin-call/attempts/${missing}/seen`)
      .set(auth(familyToken))
      .expect(404);
    await request(app)
      .post(`/api/mobile/checkin-call/attempts/${missing}/accept`)
      .set(auth(familyToken))
      .expect(404);
    await request(app)
      .get('/api/mobile/checkin-call/audio/unknown-key')
      .set(auth(patientToken))
      .expect(404);

    const audio = await request(app)
      .get('/api/mobile/checkin-call/audio/user_prompt')
      .set(auth(patientToken))
      .expect(200);
    expect(audio.body).toMatchObject({
      ok: true,
      mimeType: 'audio/mpeg',
      base64: Buffer.from('checkin-api-integration-audio').toString('base64'),
    });
  });
});
