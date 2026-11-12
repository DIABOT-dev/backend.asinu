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
  let adaptivePlan = [];
  let adaptiveProviderFail = false;
  let adaptiveCalls = 0;
  let compactCalls = 0;
  let observePatientContext = null;
  let failDetailExtraction = false;

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
    jest.doMock('../src/services/ai/ai.service', () => {
      const actual = jest.requireActual('../src/services/ai/ai.service');
      return { ...actual, callTextAi: async options => {
        if (options.system?.startsWith('You generate ONE health') || options.system?.startsWith('Review one health intake') ||
          options.system?.startsWith('Extract explicitly') || options.system?.startsWith('Review patient fact')) {
          compactCalls++;
          if (failDetailExtraction && options.system.startsWith('Extract explicitly') && JSON.parse(options.prompt).CONTEXT.field === 'character')
            throw new Error('Synthetic detail extraction unavailable');
          if (observePatientContext && options.system.startsWith('You generate ONE health'))
            observePatientContext(JSON.parse(options.prompt).CONTEXT.patient_context_markdown);
          return require('./fixtures/compact-interview').providerResponse(options);
        }
        if (options.system?.startsWith('You create follow-up') || options.system?.startsWith('You review a health')) {
          adaptiveCalls++;
          if (adaptiveProviderFail) throw new Error('Synthetic provider unavailable');
          return { content: JSON.stringify(options.system.startsWith('You review') ? { valid: true } : { questions: adaptivePlan }) };
        }
        return actual.callTextAi(options);
      } };
    });
    const mobileRoutes = require('../src/routes/mobile.routes');
    const checkinCallRoutes = require('../src/routes/checkin-call.routes');
    checkinCallService = require('../src/services/checkin-call/checkin-call.service');
    sendVoipNotification =
      require('../src/services/notification/apns.voip.service').sendVoipNotification;
    const audioService = require('../src/services/checkin-call/audio.service');
    const fixtureHash = createHash('sha256')
      .update(`${audioService.audioVersion('vi')}\n${audioService.PHRASES.user_prompt.vi}`).digest('hex');
    // Keep the HTTP audio fixture inside this test process. Never replace the
    // shared local audio cache while the developer's app may be using it.
    const routePool = new Proxy(pool, { get(target, key) {
      if (key === 'query') return (text, values) => {
        if (typeof text === 'string' && text.startsWith('SELECT audio_data, mime_type FROM checkin_call_audio') &&
          values?.[0] === 'vi:user_prompt' && values[1] === fixtureHash)
          return Promise.resolve({ rows: [{ audio_data: Buffer.from('checkin-api-integration-audio'), mime_type: 'audio/mpeg' }] });
        return target.query(text, values);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });

    app = express();
    app.locals.authPool = pool;
    app.use(express.json());
    app.use('/api/mobile', mobileRoutes(pool));
    app.use('/api/mobile/checkin-call', checkinCallRoutes(routePool));

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

    const expressApp = app;
    app = await new Promise(resolve => {
      const server = expressApp.listen(0, '127.0.0.1', () => resolve(server));
    });
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (app?.close) await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    if (createdUserIds.length) {
      // Delete patient-owned episodes before their acknowledging caregivers.
      await pool.query('DELETE FROM checkin_call_episodes WHERE user_id = ANY($1::integer[])', [
        createdUserIds,
      ]);
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

    await request(app).get('/api/mobile/checkin/locations').set(auth(patientToken)).expect(404);

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

  async function conversationAccount(age = 35, conditions = []) {
    const inserted = await pool.query(
      'INSERT INTO users (phone_number, display_name) VALUES ($1,$2) RETURNING id',
      [`conv-${require('crypto').randomUUID().slice(0, 24)}`, 'Conversation test']
    );
    const userId = inserted.rows[0].id;
    createdUserIds.push(userId);
    await pool.query(
      'INSERT INTO user_onboarding_profiles (user_id,birth_year,gender,medical_conditions) VALUES ($1,$2,$3,$4::jsonb)',
      [userId, new Date().getFullYear() - age, 'Nam', JSON.stringify(conditions)]
    );
    const headers = auth(jwt.sign({ id: userId }, jwtSecret, { expiresIn: '10m' }));
    const started = await request(app)
      .post('/api/mobile/checkin/start')
      .set(headers)
      .send({ status: 'specific_concern', body_locations: ['abdomen'] })
      .expect(200);
    const checkinId = started.body.session.id;
    const entry = (step, answer) => ({ step, question: step, answer });
    const initialAnswers = [
      entry('symptoms', 'Tiêu chảy'),
      entry('onset', 'Từ hôm qua'),
      entry('progression', 'Vẫn như cũ'),
      entry('red_flags', 'Không có'),
    ];
    const triage = (answers) =>
      request(app)
        .post('/api/mobile/checkin/triage')
        .set(headers)
        .send({ checkin_id: checkinId, previous_answers: answers });
    return { userId, checkinId, headers, entry, initialAnswers, triage };
  }

  test('patient Markdown stays internal and account-scoped, and source corrections/deletions reach the next AI question', async () => {
    const account = await conversationAccount(56, ['Tăng huyết áp']);
    const foreign = await conversationAccount(35);
    const { checkinDateVN } = require('../src/services/checkin/checkin.service');
    const previous = await pool.query(`INSERT INTO health_checkins
      (user_id,session_date,initial_status,current_status,flow_state,triage_messages,triage_summary,triage_severity,triage_completed_at)
      VALUES ($1,$2,'tired','tired','follow_up',$3::jsonb,$4,'medium',NOW()) RETURNING id`,
      [account.userId, checkinDateVN(-1), JSON.stringify([{ step: 'compact_symptoms', question: 'Triệu chứng?', answer: 'history-context-marker' }]), 'Previous AI explanation']);
    const note = (await pool.query('INSERT INTO user_memories (user_id,content,category) VALUES ($1,$2,$3) RETURNING id', [account.userId, 'own-context-old', 'preference'])).rows[0];
    await pool.query('INSERT INTO user_memories (user_id,content,category) VALUES ($1,$2,$3)', [foreign.userId, 'FOREIGN-CONTEXT-PRIVATE', 'health']);
    await pool.query(`INSERT INTO agent_checkin_memory (user_id,memory_type,memory_key,content,is_active,expires_at) VALUES
      ($1,'preference','active',$2::jsonb,TRUE,NULL),
      ($1,'preference','inactive',$3::jsonb,FALSE,NULL),
      ($1,'preference','expired',$4::jsonb,TRUE,NOW()-INTERVAL '1 day')`,
      [account.userId, JSON.stringify({ note: 'active-agent-context' }), JSON.stringify({ note: 'INACTIVE-CONTEXT' }), JSON.stringify({ note: 'EXPIRED-CONTEXT' })]);
    const captures = [];
    observePatientContext = markdown => captures.push(markdown);
    const answers = [];
    const post = () => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 3, interview_layout: 'eight_groups', adaptive_questions: true }).expect(200);
    try {
      const first = (await post()).body;
      expect(captures.at(-1)).toContain(`user_id: ${account.userId}`);
      expect(captures.at(-1)).toContain('history-context-marker');
      expect(captures.at(-1)).toContain('own-context-old');
      expect(captures.at(-1)).toContain('active-agent-context');
      for (const secret of ['FOREIGN-CONTEXT-PRIVATE', 'INACTIVE-CONTEXT', 'EXPIRED-CONTEXT']) expect(captures.at(-1)).not.toContain(secret);
      expect(JSON.stringify(first)).not.toContain('own-context-old');
      expect(JSON.stringify(first)).not.toContain('patientContext');

      await pool.query('UPDATE user_onboarding_profiles SET gender=$2,updated_at=NOW() WHERE user_id=$1', [account.userId, 'Nữ']);
      await pool.query('UPDATE user_memories SET content=$2,updated_at=NOW() WHERE id=$1 AND user_id=$3', [note.id, 'own-context-updated', account.userId]);
      await pool.query('DELETE FROM health_checkins WHERE id=$1 AND user_id=$2', [previous.rows[0].id, account.userId]);
      answers.push({ step: first.step, question: first.question, answer: first.options[0] });
      const second = (await post()).body;
      expect(captures.at(-1)).toContain('own-context-updated');
      expect(captures.at(-1)).toContain('address_patient: "cô"');
      expect(captures.at(-1)).not.toContain('own-context-old');
      expect(captures.at(-1)).not.toContain('history-context-marker');

      await pool.query('DELETE FROM user_memories WHERE id=$1 AND user_id=$2', [note.id, account.userId]);
      answers.push({ step: second.step, question: second.question, answer: 'Không có' });
      await post();
      expect(captures.at(-1)).not.toContain('own-context-updated');
      const count = captures.length;
      await request(app).post('/api/mobile/checkin/triage').set(foreign.headers)
        .send({ checkin_id: account.checkinId, previous_answers: [], assessment_version: 3 }).expect(404);
      expect(captures).toHaveLength(count);
    } finally { observePatientContext = null; }
  });

  test('a technical detail-reading failure preserves the prior HTTP conversation and retries the same answer once', async () => {
    const account = await conversationAccount(35);
    const answers = [];
    const post = () => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 3, interview_layout: 'eight_groups', adaptive_questions: true });
    let next = (await post().expect(200)).body;
    for (let i = 0; i < 8 && !next.step.startsWith('compact_character'); i++) {
      const label = next.step.startsWith('compact_symptoms') ? 'Sưng khớp'
        : next.step.startsWith('compact_red_flags') ? 'Không có'
        : next.step.startsWith('compact_impact') ? next.options[0]
        : next.step.startsWith('compact_timeline') ? [next.optionsGrouped[0].items[2], next.optionsGrouped[1].items[1]].join(', ') : null;
      expect(label).toBeTruthy();
      answers.push({ step: next.step, question: next.question, answer: label });
      next = (await post().expect(200)).body;
    }
    expect(next.step).toMatch(/^compact_character/u);
    expect(next.exclusiveOptions).toContain('Tôi không biết mô tả thêm');
    const read = async () => (await pool.query('SELECT triage_messages,triage_state FROM health_checkins WHERE id=$1 AND user_id=$2', [account.checkinId, account.userId])).rows[0];
    const before = await read();
    const answer = { step: next.step, question: next.question, answer: 'Sưng khớp gối bên phải, cảm giác căng tức' };
    answers.push(answer);
    failDetailExtraction = true;
    try {
      const failed = await post().expect(503);
      expect(failed.body).toMatchObject({ code: 'CHECKIN_ANSWER_RETRY' });
      expect(failed.body.error).toContain('câu trả lời');
      expect(await read()).toEqual(before);
    } finally { failDetailExtraction = false; }
    const retried = (await post().expect(200)).body;
    expect((await read()).triage_messages).toEqual(answers);
    expect((await post().expect(200)).body).toEqual(retried);
    expect((await read()).triage_messages.filter(item => item.step === answer.step)).toHaveLength(1);
  });

  test('the screenshot’s dull-pain answer keeps its abdominal question context over the HTTP API', async () => {
    const account = await conversationAccount(35);
    const { protectAdaptiveState } = require('../src/services/checkin/adaptive-question.service');
    const question = { step: 'compact_symptoms', field: 'symptoms', question: 'Bạn đang khó chịu ở bụng trên rốn như thế nào vậy?',
      choices: [{ id: 'dull', label: 'Đau âm ỉ' }, { id: 'sharp', label: 'Đau nhói' }], origin: 'ai',
    };
    const state = { version: 1, sources: [], questions: [], compact: { version: 2, layout: 'eight_groups', lang: 'vi', hasConditions: false, questions: [question] } };
    await pool.query(`UPDATE health_checkins SET body_location_other=$3, triage_state=jsonb_build_object('assessment_version',3,'adaptive_enabled',true,'adaptive_payload',$4::text)
      WHERE id=$1 AND user_id=$2`, [account.checkinId, account.userId, 'Bụng: bụng trên rốn', protectAdaptiveState(account.userId, state)]);
    const answer = { step: question.step, question: question.question, answer: 'Đau âm ỉ' };
    const result = await request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: [answer], assessment_version: 3, interview_layout: 'eight_groups', adaptive_questions: true }).expect(200);
    expect(result.body).toMatchObject({ step: 'compact_red_flags', questionSource: 'ai' });
    expect(result.body.options).toContain('nôn ra máu hoặc chất nâu đen');
    expect(result.body.options).toContain('đi ngoài phân đen hoặc có máu');
    const saved = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(saved.triage_messages).toEqual([answer]);
    expect(saved.body_location_other).toBe('Bụng: bụng trên rốn');
  });

  test('the eight-group client negotiates a shared timeline and resumes the saved grouped question', async () => {
    const account = await conversationAccount(56, ['Tiểu đường', 'Tăng huyết áp']);
    const answers = [];
    const triage = () => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 3,
        adaptive_questions: true, interview_layout: 'eight_groups' }).expect(200);
    let next = (await triage()).body;
    expect(next).toMatchObject({ step: 'compact_symptoms', questionProgress: { current: 1, total: 8 } });
    for (let i = 0; i < 6 && !next.step.startsWith('compact_timeline'); i++) {
      const answer = next.step === 'compact_symptoms' ? 'Sưng khớp'
        : next.step.startsWith('compact_red_flags') ? 'Không có' : 'Vẫn sinh hoạt bình thường';
      answers.push({ step: next.step, question: next.question, answer });
      next = (await triage()).body;
    }
    expect(next.step).toBe('compact_timeline');
    expect(next.requiredOptionGroups.map(g => g.length)).toEqual([4, 3]);
    expect(next.optionsGrouped.map(g => g.key)).toEqual(['onset', 'progression', 'other']);
    const session = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(session.triage_messages).toEqual(answers);
    expect((await triage()).body).toEqual(next);
    expect(session.triage_state.adaptive_payload).toBeUndefined();
  });

  test('an existing compact v1 HTTP interview persists AI choices, resumes unchanged and keeps its eight-group plan', async () => {
    const account = await conversationAccount(56, ['Tiểu đường']);
    const { protectAdaptiveState } = require('../src/services/checkin/adaptive-question.service');
    const adaptive = protectAdaptiveState(account.userId, { version: 1, sources: [], questions: [], compact: { version: 1, lang: 'vi', hasConditions: true, questions: [] } });
    await pool.query("UPDATE health_checkins SET triage_state = jsonb_set(COALESCE(triage_state, '{}'::jsonb), '{adaptive_payload}', to_jsonb($2::text)) WHERE id = $1", [account.checkinId, adaptive]);
    compactCalls = 0;
    const triage = (answers, phase) => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 3,
        adaptive_questions: true, ...(phase ? { phase_id: phase } : {}) });
    const parallel = await Promise.all(Array.from({ length: 5 }, () => triage([]).expect(200)));
    const first = parallel[0].body;
    expect(parallel.every((r) => r.body.question === first.question)).toBe(true);
    expect(first).toMatchObject({ assessmentVersion: 3, step: 'compact_symptoms', questionSource: 'ai', questionProgress: { current: 1, total: 9 } });
    expect(compactCalls).toBe(2);
    const current = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(current.triage_state.assessment_version).toBe(3);
    expect(current.triage_state.adaptive_payload).toBeUndefined();
    const phase = current.triage_state.phase_id;
    await triage([], 'stale-phase').expect(409);
    await triage([{ step: first.step, question: 'forged', answer: 'Sưng khớp' }], phase).expect(409);
    const answers = [];
    const byStep = { compact_symptoms: 'Sưng khớp, Nó bị đau đớn khó đi lại', compact_red_flags: 'Không có', compact_impact: 'Vẫn sinh hoạt bình thường', compact_onset: 'Từ 3 đến dưới 7 ngày', compact_progression: 'Vẫn như cũ', compact_character: 'Đau nhói khi đi lại, ở khớp gối phải', compact_clinical_context: 'Đã dùng thuốc theo hướng dẫn, Hôm nay chưa đo chỉ số', compact_source: 'Ngã hoặc vận động mạnh', compact_associated: 'Không có' };
    let next = first;
    while (!next.isDone && answers.length <= 9) {
      answers.push({ step: next.step, question: next.question, answer: byStep[next.step] });
      next = (await triage(answers, phase).expect(200)).body;
      if (answers.length === 3) {
        const count = compactCalls;
        const resumed = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
        expect(resumed.triage_messages).toEqual(answers);
        expect((await triage(resumed.triage_messages, phase).expect(200)).body).toEqual(next);
        expect(compactCalls).toBe(count);
      }
    }
    expect(next.isDone).toBe(true);
    expect(answers).toHaveLength(9);
    expect(new Set(answers.map((a) => a.step)).size).toBe(9);
    const replay = (await triage(answers, phase).expect(200)).body;
    expect(replay.summary).toEqual(next.summary);
    const stored = (await pool.query('SELECT triage_messages,triage_completed_at FROM health_checkins WHERE id=$1', [account.checkinId])).rows[0];
    expect(stored.triage_messages).toEqual(answers);
    expect(stored.triage_completed_at).not.toBeNull();
  });

  test('new compact coverage HTTP flow preserves separate symptom timelines and resumes without repeated AI calls', async () => {
    const account = await conversationAccount(56, ['Tiểu đường']);
    const { readAdaptiveState } = require('../src/services/checkin/adaptive-question.service');
    const triage = (answers) => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 3, adaptive_questions: true });
    const saved = async () => {
      const row = (await pool.query('SELECT triage_state FROM health_checkins WHERE id=$1', [account.checkinId])).rows[0];
      return readAdaptiveState(account.userId, row.triage_state.adaptive_payload);
    };
    const answers = [];
    let next = (await triage(answers).expect(200)).body;
    expect(next.step).toBe('compact_symptoms');
    expect(next.questionProgress).toBeUndefined();
    for (let i = 0; i < 40 && !next.isDone; i++) {
      const state = await saved();
      expect(state.compact.version).toBe(2);
      const q = state.compact.questions.find((item) => item.step === next.step);
      const byCode = (code) => q.choices.find((item) => item.id === code)?.label;
      const answer = q.field === 'symptoms' ? 'Sưng khớp, Đau nhức' : q.field === 'onset' ?
        byCode(q.allowDifferent ? 'different' : q.targets[0] === 'c1' ? 'under_day' : 'under_week') :
        q.field === 'progression' ? byCode('same') : q.field === 'impact' ? byCode('normal') :
          q.field === 'character' ? q.choices[0].label : q.field === 'clinical_context' ?
            [byCode('medication_as_planned'), byCode('not_measured')].filter(Boolean).join(', ') : 'Không có';
      answers.push({ step: next.step, question: next.question, answer });
      next = (await triage(answers).expect(200)).body;
      if (!next.isDone) {
        const count = compactCalls;
        expect((await triage(answers).expect(200)).body).toEqual(next);
        expect(compactCalls).toBe(count);
      }
    }
    expect(next.isDone).toBe(true);
    const final = (await saved()).compact;
    expect(final.coverage.concerns.map((c) => c.facts.onset.value)).toEqual(['Dưới 24 giờ', 'Từ 3 đến dưới 7 ngày']);
    for (const field of ['impact', 'clinical_context', 'source', 'associated']) expect(final.questions.filter((q) => q.field === field)).toHaveLength(1);
    const own = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(own.triage_messages).toEqual(answers);
    expect(own.triage_state.adaptive_payload).toBeUndefined();
  });

  test('updating the app never converts an in-progress detailed interview to compact', async () => {
    const account = await conversationAccount();
    const post = (answers, version) => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: version });
    const old = (await post([], 2).expect(200)).body;
    const answers = [{ step: old.step, question: old.question, answer: 'Tiêu chảy' }];
    const before = (await post(answers, 2).expect(200)).body;
    const updated = (await post(answers, 3).expect(200)).body;
    expect(updated.step).toBe(before.step);
    expect(updated.question).toBe(before.question);
    expect(updated.step.startsWith('compact_')).toBe(false);
  });

  test('server rollout flag gates only new compact interviews and does not replace an offered question', async () => {
    const original = process.env.CHECKIN_COMPACT_INTERVIEW_ENABLED;
    const post = (account) => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: [], assessment_version: 3 });
    try {
      process.env.CHECKIN_COMPACT_INTERVIEW_ENABLED = 'true';
      const active = await conversationAccount();
      const question = (await post(active).expect(200)).body;
      expect(question.step).toBe('compact_symptoms');
      process.env.CHECKIN_COMPACT_INTERVIEW_ENABLED = 'false';
      expect((await post(active).expect(200)).body.question).toBe(question.question);
      const disabled = await conversationAccount();
      expect((await post(disabled).expect(200)).body.step.startsWith('compact_')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CHECKIN_COMPACT_INTERVIEW_ENABLED;
      else process.env.CHECKIN_COMPACT_INTERVIEW_ENABLED = original;
    }
  });

  test('retrying the same completed check-in returns the same conclusion and severity', async () => {
    const account = await conversationAccount();
    const first = await account.triage(account.initialAnswers).expect(200);
    const replay = await account.triage(account.initialAnswers).expect(200);
    expect(first.body).toMatchObject({ isDone: true, severity: 'low' });
    expect(replay.body).toEqual(first.body);
    expect(first.body.summary).not.toMatch(/đi kèm|chưa.*xử lý/);
  });

  test('new triage answers reset missed-response counters; replaying the same answers does not', async () => {
    const account = await conversationAccount();
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 2 });
    const first = (await triage([]).expect(200)).body;
    await pool.query("UPDATE health_checkins SET no_response_count=2,last_response_at=NOW()-INTERVAL '4 hours' WHERE id=$1",[account.checkinId]);
    const answers=[{step:first.step,question:first.question,answer:'Tiêu chảy'}];
    await triage(answers).expect(200);
    expect((await pool.query('SELECT no_response_count,last_response_at>NOW()-INTERVAL \'1 minute\' fresh FROM health_checkins WHERE id=$1',[account.checkinId])).rows[0])
      .toEqual({no_response_count:0,fresh:true});
    await pool.query('UPDATE health_checkins SET no_response_count=2 WHERE id=$1',[account.checkinId]);
    await triage(answers).expect(200);
    expect((await pool.query('SELECT no_response_count FROM health_checkins WHERE id=$1',[account.checkinId])).rows[0].no_response_count).toBe(2);
  });

  test.each([false,true])('completed HTTP replay survives a JSONB database round trip (legacy fingerprint: %s)', async legacy => {
    const account=await conversationAccount();
    const first=await account.triage(account.initialAnswers).expect(200);
    if (legacy) {
      const legacyAnswers=account.initialAnswers.map(a=>({question:a.question,answer:a.answer,step:a.step}));
      const fingerprint=createHash('sha256').update(JSON.stringify({answers:legacyAnswers,lang:'vi'})).digest('hex');
      await pool.query(`UPDATE health_checkins SET triage_state=jsonb_set(
        triage_state #- '{completed,fingerprint_version}', '{completed,fingerprint}',to_jsonb($2::text))
        WHERE id=$1`,[account.checkinId,fingerprint]);
    }
    const before=(await pool.query('SELECT triage_state,triage_messages,updated_at FROM health_checkins WHERE id=$1',[account.checkinId])).rows[0];
    const today=await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    const restored=today.body.session;
    const replay=await request(app).post('/api/mobile/checkin/triage').set(account.headers).send({
      checkin_id:account.checkinId,previous_answers:restored.triage_messages,phase_id:restored.triage_state.phase_id,
    }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect((await pool.query('SELECT triage_state,triage_messages,updated_at FROM health_checkins WHERE id=$1',[account.checkinId])).rows[0]).toEqual(before);
  });

  test('a completed conclusion records the latest response and clears old missed reminders', async () => {
    const account=await conversationAccount();
    await pool.query("UPDATE health_checkins SET no_response_count=3,last_response_at=NOW()-INTERVAL '4 hours' WHERE id=$1",[account.checkinId]);
    expect((await account.triage(account.initialAnswers).expect(200)).body.isDone).toBe(true);
    expect((await pool.query('SELECT no_response_count,last_response_at>=triage_completed_at fresh FROM health_checkins WHERE id=$1',[account.checkinId])).rows[0])
      .toEqual({no_response_count:0,fresh:true});
  });

  test('reopening a detailed check-in restores persisted answers and the identical next question', async () => {
    const account = await conversationAccount();
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 2 });
    const first = await triage([]).expect(200);
    const opened = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    const phaseId = opened.body.session.triage_state.phase_id;
    expect(phaseId).toBe(`initial:${opened.body.session.occurrence_started_at}`);
    const answers = [{ step: first.body.step, question: first.body.question, answer: 'Tiêu chảy' }];
    const next = await triage(answers).expect(200);
    const reopened = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(reopened.body.session.id).toBe(account.checkinId);
    expect(reopened.body.session.triage_messages).toEqual(answers);
    expect(reopened.body.session.triage_completed_at).toBeNull();
    expect(reopened.body.session.triage_state.phase_id).toBe(phaseId);
    expect(reopened.body.session.triage_state.revision).not.toBe(opened.body.session.triage_state.revision);
    const resumed = await triage(reopened.body.session.triage_messages).expect(200);
    expect(resumed.body).toMatchObject({ step: next.body.step, question: next.body.question, options: next.body.options });
    const afterResume = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(afterResume.body.session.triage_state.phase_id).toBe(phaseId);
  });
  test('a delayed old screen cannot shorten or rewrite an unfinished HTTP interview', async () => {
    const account = await conversationAccount();
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({checkin_id:account.checkinId,previous_answers:answers,assessment_version:2});
    const first=(await triage([]).expect(200)).body;
    const answers=[{step:first.step,question:first.question,answer:'Tiêu chảy'}];
    const safety=(await triage(answers).expect(200)).body;
    answers.push({step:safety.step,question:safety.question,answer:'Không có'});
    await triage(answers).expect(200);
    const before=(await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    await triage(answers.slice(0,1)).expect(409);
    await triage([{...answers[0],answer:'Đau đầu'},answers[1]]).expect(409);
    const after=(await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(after.triage_messages).toEqual(answers);
    expect(after.triage_state).toEqual(before.triage_state);
    await triage(answers).expect(200);
  });
  test('phase identity prevents a delayed initial request from entering a new follow-up', async () => {
    const account=await conversationAccount();
    await account.triage(account.initialAnswers).expect(200);
    const old=(await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session.triage_state.phase_id;
    await request(app).post('/api/mobile/checkin/followup').set(account.headers)
      .send({checkin_id:account.checkinId,status:'tired'}).expect(200);
    const latest=(await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    const post=phase_id=>request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({checkin_id:account.checkinId,previous_answers:[],phase_id});
    for(const invalid of [null,7,'','x'.repeat(161)]) await post(invalid).expect(400);
    await post(old).expect(409);
    expect((await post(latest.triage_state.phase_id).expect(200)).body.step).toBe('followup_status');
  });

  test('an instant check-in against a completed high alert continues through follow-up without erasing its prior answers', async () => {
    const account=await conversationAccount();
    await account.triage(account.initialAnswers).expect(200);
    await pool.query("UPDATE health_checkins SET flow_state='high_alert',triage_severity='high' WHERE id=$1",[account.checkinId]);
    const started=await request(app).post('/api/mobile/checkin/start').set(account.headers)
      .send({status:'tired',restart:true,source:'instant',body_locations:['abdomen']}).expect(200);
    expect(started.body.session.triage_messages).toEqual(account.initialAnswers);
    expect(started.body.session.triage_state.completed.finalized).toBe(true);
    const previousPhase=started.body.session.triage_state.phase_id;
    const followed=await request(app).post('/api/mobile/checkin/followup').set(account.headers)
      .send({checkin_id:account.checkinId,status:'tired'}).expect(200);
    const session=followed.body.session;
    expect(session.flow_state).toBe('high_alert');
    expect(session.triage_state.baseline_answers).toEqual(account.initialAnswers);
    expect(session.triage_state.phase_id).not.toBe(previousPhase);
    expect(session.triage_state.previous_severity).toBe('high');
    expect(session.triage_messages).toEqual([]);
    const next=await request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({checkin_id:account.checkinId,phase_id:session.triage_state.phase_id,
        previous_answers:session.triage_messages,assessment_version:2,adaptive_questions:true}).expect(200);
    expect(next.body).toMatchObject({isDone:false,step:'followup_status'});
    const resumed=await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(resumed.body.session.triage_state.baseline_answers).toEqual(account.initialAnswers);
  });

  test.each([
    ...['vi', 'en'].flatMap(lang => ['head', 'chest', 'abdomen', 'limbs', 'skin', 'whole_body', 'mental'].map(region => {
      const { getSymptomsForLocation, LOCATION_LABELS } = require('../src/services/checkin/body-location');
      return [lang, [region], getSymptomsForLocation(region, lang)[0], `${LOCATION_LABELS[lang][region].label}: ${lang === 'vi' ? 'Vị trí đã chọn' : 'Selected position'}`];
    })),
    ['vi', ['head', 'limbs'], 'Đau đầu, Đau khớp', 'Đầu: Trán; Tay chân: Vai / cánh tay phải / vai cánh tay phải'],
    ['vi', ['head'], 'Chóng mặt', 'Đầu: Không rõ'],
  ])('full detailed HTTP interview survives interruption and ends with saved answers (%s/%j/%s)', async (lang, locations, symptoms, notes) => {
    const account = await conversationAccount();
    const headers = { ...account.headers, 'Accept-Language': lang };
    await request(app).post('/api/mobile/checkin/start').set(headers)
      .send({ status: 'tired', body_locations: locations, body_location_other: notes, restart: true }).expect(200);
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 2 });
    const answers = [], steps = new Set();
    const translate = require('../src/i18n').t;
    let result;
    for (let index = 0; index <= 128; index++) {
      const response = await triage(answers).expect(200); result = response.body;
      if (result.isDone) break;
      expect(result.question).toEqual(expect.any(String));
      expect(result.question).not.toMatch(/undefined|\{\{|checkin\.detail\./);
      expect(result.question).not.toContain(notes);
      expect(result.options.length).toBeGreaterThan(1);
      expect(new Set(result.options).size).toBe(result.options.length);
      expect(steps.has(result.step)).toBe(false); steps.add(result.step);
      if (index === 7) {
        const checkpoint = await request(app).get('/api/mobile/checkin/today').set(headers).expect(200);
        expect(checkpoint.body.session.triage_messages).toEqual(answers);
        const resumed = await triage(checkpoint.body.session.triage_messages).expect(200);
        expect(resumed.body).toMatchObject({ step: result.step, question: result.question, options: result.options });
      }
      let answer = result.options[0];
      if (result.step === 'symptoms') answer = symptoms;
      else if (result.step === 'red_flags') answer = lang === 'vi' ? 'Không có' : 'None';
      else if (result.step === 'detail_history') answer = translate('checkin.detail.option.no_conditions', lang);
      else if (result.step.endsWith('_pattern')) answer = translate('checkin.detail.option.episodes', lang);
      else if (result.step.endsWith('_radiation')) answer = translate('checkin.detail.option.spreads', lang);
      else if (result.step.endsWith('_associated')) answer = translate('checkin.detail.option.none', lang);
      answers.push({ step: result.step, question: result.question, answer });
    }
    expect(result.isDone).toBe(true); expect(result.summary).toBeTruthy();
    if (result.severity !== 'emergency') expect(answers.length).toBeGreaterThan(8);
    if (symptoms === 'Chóng mặt') expect([...steps].some(step => /_character$|_radiation/.test(step))).toBe(false);
    const completed = await request(app).get('/api/mobile/checkin/today').set(headers).expect(200);
    expect(completed.body.session.triage_messages).toEqual(answers);
    expect(completed.body.session.triage_completed_at).toBeTruthy();
    expect(completed.body.session.triage_state.completed.finalized).toBe(true);
    const replay = await triage(answers).expect(200);
    expect(replay.body).toMatchObject({ isDone: true, summary: result.summary, severity: result.severity });
  }, 30000);

  test('another account cannot resume or reset a patient interview, and invalid answers preserve its progress', async () => {
    const account = await conversationAccount();
    const checkpoint = await account.triage([account.initialAnswers[0]]).expect(200);
    expect(checkpoint.body.isDone).toBe(false);
    const before = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    await request(app).post('/api/mobile/checkin/triage').set(auth(familyToken))
      .send({ checkin_id: account.checkinId, previous_answers: [], assessment_version: 2 }).expect(404);
    await request(app).post('/api/mobile/checkin/followup').set(auth(familyToken))
      .send({ checkin_id: account.checkinId, status: 'fine' }).expect(404);
    for (const invalid of [
      [{ step: 'symptoms', question: ' ', answer: 'Example' }],
      [{ step: 'not-a-step', question: 'Example?', answer: 'Example' }],
      Array.from({ length: 129 }, () => account.initialAnswers[0]),
    ]) {
      await request(app).post('/api/mobile/checkin/triage').set(account.headers)
        .send({ checkin_id: account.checkinId, previous_answers: invalid, assessment_version: 2 }).expect(400);
    }
    const after = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(after.body.session.triage_messages).toEqual(before.body.session.triage_messages);
    expect(after.body.session.triage_state).toEqual(before.body.session.triage_state);
  });

  test.each([false, true])('adaptive questions survive interruption and feed the personal conclusion (detailed=%s)', async detailed => {
    adaptiveCalls = 0; adaptiveProviderFail = false;
    adaptivePlan = [{ question: 'Âm thanh đang nghe giống loại nào?', grounding_quote: 'tiếng ù',
      options: ['Tiếng ve', 'Tiếng rít'], multi_select: false }];
    const account = await conversationAccount();
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, adaptive_questions: true,
        ...(detailed ? { assessment_version: 2 } : {}) });
    const answers = []; let response;
    for (let i = 0; i < 15; i++) {
      response = (await triage(answers).expect(200)).body;
      if (response.step?.startsWith('adaptive_')) break;
      expect(adaptiveCalls).toBe(0);
      const answer = response.step === 'symptoms' ? 'Tôi nghe tiếng ù trong tai trái'
        : response.step === 'red_flags' ? 'Không có' : response.step === 'progression' ? 'Vẫn như cũ' : response.options[0];
      answers.push({ step: response.step, question: response.question, answer });
    }
    expect(response.step).toMatch(/^adaptive_[a-f0-9]{32}$/);
    expect(answers.some(a => a.step === 'red_flags')).toBe(true);
    expect(adaptiveCalls).toBe(2);
    expect(response.options).toEqual(['Tiếng ve', 'Tiếng rít', 'Không rõ', 'Khác, nhập hoặc nói câu trả lời']);
    expect(response).not.toHaveProperty('_adaptiveState');
    const checkpoint = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(checkpoint.body.session.triage_state.adaptive_enabled).toBe(true);
    expect(checkpoint.body.session.triage_state).not.toHaveProperty('adaptive_payload');
    const resumes = await Promise.all([triage(checkpoint.body.session.triage_messages).expect(200), triage(checkpoint.body.session.triage_messages).expect(200)]);
    for (const {body: resumed} of resumes) {
      expect(resumed.step).toBe(response.step); expect(resumed.options).toEqual(response.options);
    }
    expect(adaptiveCalls).toBe(2);
    answers.push({ step: response.step, question: response.question, answer: 'Tiếng ve' });
    for (let i = 0; i < 128; i++) {
      response = (await triage(answers).expect(200)).body;
      if (response.isDone) break;
      expect(response.step).not.toMatch(/^adaptive_/);
      const answer = response.step === 'red_flags' ? 'Không có' : response.options[0];
      answers.push({ step: response.step, question: response.question, answer });
    }
    expect(response.isDone).toBe(true); expect(adaptiveCalls).toBe(2);
    const completed = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(completed.body.session.triage_messages).toEqual(answers);
    expect(completed.body.session.triage_completed_at).toBeTruthy();
    const raw = await pool.query('SELECT triage_state FROM health_checkins WHERE id=$1', [account.checkinId]);
    const { readAdaptiveState } = require('../src/services/checkin/adaptive-question.service');
    const stored = readAdaptiveState(account.userId, raw.rows[0].triage_state.adaptive_payload);
    expect(stored.questions).toHaveLength(1);
    expect(raw.rows[0].triage_state.completed.result).not.toHaveProperty('_adaptiveState');
  }, 30000);

  test('AI failure offers an open answer, resumes it unchanged and can skip without a loop', async () => {
    adaptiveCalls = 0; adaptiveProviderFail = true;
    const account = await conversationAccount();
    const triage = answers => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: answers, assessment_version: 2, adaptive_questions: true });
    const first = (await triage([]).expect(200)).body;
    const answers = [{ step: first.step, question: first.question, answer: 'Tôi nghe tiếng ù trong tai trái' }];
    const safety = (await triage(answers).expect(200)).body;
    answers.push({ step: safety.step, question: safety.question, answer: 'Không có' });
    const open = (await triage(answers).expect(200)).body;
    expect(open).toMatchObject({ options: [], allowFreeText: true, skipAnswerLabel: 'Không có gì thêm' });
    expect((await triage(answers).expect(200)).body.step).toBe(open.step); expect(adaptiveCalls).toBe(1);
    answers.push({ step: open.step, question: open.question, answer: open.skipAnswerLabel });
    const next = (await triage(answers).expect(200)).body;
    expect(next.step).not.toBe(open.step); expect(adaptiveCalls).toBe(1);
    adaptiveProviderFail = false;
  });

  test('adaptive question IDs from a completed phase cannot be reused after starting a follow-up', async () => {
    adaptiveCalls = 0; adaptiveProviderFail = false;
    adaptivePlan = [{ question: 'Âm thanh đang nghe giống loại nào?', grounding_quote: 'tiếng ù',
      options: ['Tiếng ve', 'Tiếng rít'], multi_select: false }];
    const account = await conversationAccount();
    const triage = list => request(app).post('/api/mobile/checkin/triage').set(account.headers)
      .send({ checkin_id: account.checkinId, previous_answers: list, assessment_version: 2, adaptive_questions: true });
    const answers = []; let result;
    for (let i = 0; i < 128; i++) {
      result = (await triage(answers).expect(200)).body;
      if (result.isDone) break;
      const answer = result.step === 'symptoms' ? 'Tôi nghe tiếng ù trong tai trái'
        : result.step === 'red_flags' || result.step.endsWith('_associated') ? 'Không có' : result.options[0];
      answers.push({ step: result.step, question: result.question, answer });
    }
    expect(result.isDone).toBe(true); expect(answers.some(answer => answer.step.startsWith('adaptive_'))).toBe(true);
    const before = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    await request(app).post('/api/mobile/checkin/followup').set(account.headers)
      .send({ checkin_id: account.checkinId, status: 'tired' }).expect(200);
    const phase = (await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200)).body.session;
    expect(phase.triage_state.phase_id).not.toBe(before.triage_state.phase_id);
    expect(phase.triage_messages).toEqual([]);
    expect((await triage(answers).expect(409)).body.code).toBe('TRIAGE_CHANGED');
    expect((await triage([]).expect(200)).body.step).toBe('followup_status');
  }, 30000);

  test('follow-up retains symptoms and allows a required third safety question', async () => {
    const account = await conversationAccount(70, ['cao huyết áp']);
    await account.triage(account.initialAnswers).expect(200);
    await request(app)
      .post('/api/mobile/checkin/followup')
      .set(account.headers)
      .send({ checkin_id: account.checkinId, status: 'tired' })
      .expect(200);
    const reopened = await request(app).get('/api/mobile/checkin/today').set(account.headers).expect(200);
    expect(reopened.body.session.triage_messages).toEqual([]);
    expect(reopened.body.session.triage_state.phase).toBe('followup');
    expect(reopened.body.session.triage_state.phase_id).toEqual(expect.any(String));
    expect(reopened.body.session.triage_state.baseline_answers).toEqual(account.initialAnswers);
    const answers = [
      account.entry('followup_status', 'Vẫn như cũ'),
      account.entry('followup_detail', 'Không có triệu chứng mới'),
    ];
    const question = await account.triage(answers).expect(200);
    expect(question.body).toMatchObject({ isDone: false, step: 'red_flags' });
    expect(question.body.question).toMatch(/dấu hiệu nào dưới đây/);
    // The prompt stays short; the baseline symptom must still select the
    // appropriate safety answers and remain in the resulting conclusion.
    expect(question.body.options.some(option => /tiêu chảy có máu/i.test(option))).toBe(true);
    const conclusion = await account
      .triage([...answers, account.entry('red_flags', 'Không có')])
      .expect(200);
    expect(conclusion.body).toMatchObject({ isDone: true, severity: 'medium', needsDoctor: true });
    expect(conclusion.body.summary.toLowerCase()).toContain('tiêu chảy');
    expect(conclusion.body.summary.toLowerCase()).not.toContain('không có triệu chứng mới');
  });

  test('a newly reported follow-up symptom returns to onset, progression and safety before concluding', async () => {
    const account = await conversationAccount();
    await account.triage(account.initialAnswers).expect(200);
    await request(app)
      .post('/api/mobile/checkin/followup')
      .set(account.headers)
      .send({ checkin_id: account.checkinId, status: 'tired' })
      .expect(200);
    const answers = [
      account.entry('followup_status', 'Vẫn như cũ'),
      account.entry('followup_detail', 'Có thêm triệu chứng mới'),
    ];
    const detail = await account.triage(answers).expect(200);
    expect(detail.body).toMatchObject({
      isDone: false,
      step: 'followup_detail',
      allowFreeText: true,
      options: [],
    });
    answers.push(account.entry('followup_detail', 'Đau đầu'));
    expect((await account.triage(answers).expect(200)).body.step).toBe('onset');
    answers.push(account.entry('onset', 'Từ sáng'));
    expect((await account.triage(answers).expect(200)).body.step).toBe('progression');
    answers.push(account.entry('progression', 'Vẫn như cũ'));
    expect((await account.triage(answers).expect(200)).body.step).toBe('red_flags');
    answers.push(account.entry('red_flags', 'Không có'));
    const conclusion = await account.triage(answers).expect(200);
    expect(conclusion.body.isDone).toBe(true);
    expect(conclusion.body.summary.toLowerCase()).toContain('đau đầu');
    expect(conclusion.body.summary.toLowerCase()).toContain('tiêu chảy');
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

  test('settings API enables and edits a personal reminder while the Care Circle remains empty', async () => {
    const created = await pool.query(
      'INSERT INTO users (phone_number, push_token) VALUES ($1,$2) RETURNING id',
      [`http-solo-${Date.now()}`, 'ExponentPushToken[http-solo]']
    );
    const soloId = created.rows[0].id;
    createdUserIds.push(soloId);
    await entitlementService.activateHouseholdPlan(pool, soloId, {
      planCode: 'antam_2',
      billingPeriod: 'monthly',
      platform: 'apple',
      productId: 'asinu.premium.monthly',
      originalTransactionId: `http-solo-${soloId}`,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
    const soloToken = jwt.sign({ id: soloId }, jwtSecret, { expiresIn: '10m' });
    const initial = await request(app)
      .get('/api/mobile/checkin-call/settings')
      .set(auth(soloToken))
      .expect(200);
    expect(initial.body.contacts).toEqual([]);
    const enabled = await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(soloToken))
      .send({ enabled: true })
      .expect(200);
    expect(enabled.body.settings).toMatchObject({
      user_id: soloId,
      enabled: true,
      user_timeout_seconds: 60,
    });
    await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(soloToken))
      .send({ checkin_time: '09:30', user_timeout_seconds: 180 })
      .expect(200);
    const updated = await request(app)
      .get('/api/mobile/checkin-call/settings')
      .set(auth(soloToken))
      .expect(200);
    expect(updated.body.contacts).toEqual([]);
    expect(updated.body.settings).toMatchObject({
      enabled: true,
      checkin_time: '09:30:00',
      user_timeout_seconds: 180,
    });
    await request(app)
      .put('/api/mobile/checkin-call/settings')
      .set(auth(soloToken))
      .send({ enabled: false })
      .expect(200);
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

  test('URGENT pickup keeps the alert active until the family explicitly confirms', async () => {
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
    expect(accepted.body.state).toBe('URGENT_BROADCAST');
    const connected = await pool.query(
      `SELECT a.confirm_deadline, e.acknowledged_by
       FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id
       WHERE a.id = $1`,
      [familyActive.body.active.attempt_id]
    );
    expect(connected.rows[0].acknowledged_by).toBeNull();
    expect(connected.rows[0].confirm_deadline.getTime()).toBeGreaterThan(Date.now());

    const acceptedAgain = await request(app)
      .post(`/api/mobile/checkin-call/attempts/${familyActive.body.active.attempt_id}/accept`)
      .set(auth(familyToken))
      .expect(200);
    expect(acceptedAgain.body).toMatchObject({
      ok: true,
      state: 'URGENT_BROADCAST',
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
      state: 'URGENT_BROADCAST',
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

  test('expired calls advance to family without invalid VoIP control pushes', async () => {
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
    expect(sendVoipNotification).not.toHaveBeenCalled();
    const userAttempt = await pool.query('SELECT state FROM checkin_call_attempts WHERE id = $1', [
      userAttemptId,
    ]);
    expect(userAttempt.rows[0].state).toBe('NO_ANSWER');

    const familyActive = await checkinCallService.getActive(pool, familyId);
    expect(familyActive).toMatchObject({ target_role: 'FAMILY', id: episodeId });
    await checkinCallService.dispatchDeliveries(pool);
    expect(sendVoipNotification).toHaveBeenCalledWith(
      'voip-family',
      expect.objectContaining({
        episodeId,
        attemptId: familyActive.attempt_id,
        kind: 'INCOMING_CALL',
      }),
      expect.objectContaining({ action: 'INCOMING_CALL' })
    );
    sendVoipNotification.mockClear();
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE id = $1",
      [episodeId]
    );
    await checkinCallService.tick(pool);
    expect(sendVoipNotification).not.toHaveBeenCalled();
    const expiredFamily = await pool.query(
      'SELECT state FROM checkin_call_attempts WHERE id = $1',
      [familyActive.attempt_id]
    );
    expect(expiredFamily.rows[0].state).toBe('PUSH_WAIT');
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
