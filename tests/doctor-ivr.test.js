const { randomUUID } = require('node:crypto');
const { questionSpeech } = require('../src/services/doctor-ivr/question-speech');
const {
  validateQuestionSet,
  fixedFinal,
  nextQuestion,
  materializeGeneratedQuestions,
} = require('../src/services/doctor-ivr/question-set.schema');
function content() {
  return {
    title: 'Hỏi thêm tình trạng',
    est_duration_s: 150,
    greeting: 'Chào anh/chị.',
    closing: 'Cảm ơn anh/chị.',
    questions: [1, 2, 3]
      .map((n) => ({
        id: `q${n}`,
        text:
          n === 1
            ? 'Anh/chị thấy khó chịu từ khi nào?'
            : n === 2
              ? 'Tình trạng ảnh hưởng sinh hoạt thế nào?'
              : 'Anh/chị đã nghỉ ngơi đủ chưa?',
        options: [
          { id: `q${n}_a`, key: 1, label: 'Hôm nay', type: 'option' },
          { id: `q${n}_b`, key: 2, label: 'Từ hôm trước', type: 'option' },
          {
            id: `q${n}_x`,
            key: 3,
            label: 'Khác, nói câu trả lời',
            type: 'voice',
            max_record_s: 30,
          },
        ],
      }))
      .concat(fixedFinal()),
  };
}
describe('physician-reviewed IVR question contract', () => {
  test('reads each question with its own choices in one utterance and greets only once', () => {
    const value = content();
    const first = questionSpeech(value, 'q1');
    expect(first).toContain(value.greeting);
    expect(first).toContain('Một: Hôm nay. Hai: Từ hôm trước. Ba: Khác, nói câu trả lời.');
    expect(first).not.toContain(value.questions[1].text);
    expect(questionSpeech(value, 'q2')).not.toContain(value.greeting);
    expect(questionSpeech(value, 'q_final')).toContain('Cuối cùng,');
  });
  test('a yes/no question about hypertension medicine does not require measurement intervals', () => {
    const value = content();
    value.questions[0].text = 'Bác có đang dùng thuốc điều trị tăng huyết áp không?';
    value.questions[0].options[0].label = 'Có';
    value.questions[0].options[1].label = 'Không';
    expect(validateQuestionSet(value)).toBeTruthy();
    value.questions[0].text = 'Chỉ số huyết áp gần nhất của bác là bao nhiêu?';
    expect(() => validateQuestionSet(value)).toThrow('Câu hỏi số đo');
  });
  test('adds mandatory choices to a compact AI response without trusting AI alert suggestions', () => {
    const generated = materializeGeneratedQuestions(
      {
        title: 'Hỏi thêm tình trạng',
        questions: content()
          .questions.slice(0, 3)
          .map((q) => ({
            text: q.text,
            options: q.options
              .slice(0, 2)
              .map((o) => ({ label: o.label, suggested_red_flag: true })),
          })),
      },
      'Bác'
    );
    const valid = validateQuestionSet(generated);
    expect(valid.questions.at(-1)).toEqual(fixedFinal('Bác'));
    expect(valid.questions[0].options.at(-1)).toMatchObject({ type: 'voice', max_record_s: 30 });
    expect(valid.questions[0].options[0]).toMatchObject({ key: 1, suggested_red_flag: true });
    expect(valid.questions[0].options[0].red_flag).toBeUndefined();
    expect(valid.greeting).toContain('bác');
  });
  test('validates a short set and computes duration from actual content', () => {
    const result = validateQuestionSet(content());
    expect(result.est_duration_s).toBeLessThanOrEqual(180);
    expect(nextQuestion(result, 'q3', 'q3_a')).toBe('q_final');
    expect(nextQuestion(result, 'q_final', 'qf_no')).toBeNull();
  });
  test.each([
    'remove-final',
    'duplicate-option',
    'cycle',
    'missing-target',
    'voice-missing',
    'too-many',
    'duplicate-key',
    'numeric-gap',
    'numeric-overlap',
  ])('rejects %s before sending', (kind) => {
    const value = content();
    const q = value.questions[0];
    if (kind === 'remove-final') value.questions.pop();
    if (kind === 'duplicate-option') q.options[1].label = q.options[0].label;
    if (kind === 'cycle') q.options[0].next = 'q1';
    if (kind === 'missing-target') q.options[0].next = 'q_missing';
    if (kind === 'voice-missing') q.options.pop();
    if (kind === 'too-many')
      value.questions.splice(
        0,
        0,
        ...Array.from({ length: 6 }, (_, i) => ({ ...q, id: `extra${i}` }))
      );
    if (kind === 'duplicate-key') q.options[1].key = 1;
    if (kind.startsWith('numeric')) {
      q.text = 'Đường huyết của anh/chị là bao nhiêu?';
      q.unit = 'mmol/L';
      q.options[0].range = { min: null, max: 4, include_min: false, include_max: true };
      q.options[1].range = {
        min: kind === 'numeric-gap' ? 5 : 4,
        max: null,
        include_min: true,
        include_max: false,
      };
    }
    expect(() => validateQuestionSet(value)).toThrow();
  });
  test('accepts continuous non-overlapping numeric intervals', () => {
    const value = content(),
      q = value.questions[0];
    q.unit = 'mmol/L';
    q.text = 'Đường huyết của anh/chị trong khoảng nào?';
    q.options[0].label = 'Đến 4 mmol/L';
    q.options[0].range = { min: null, max: 4, include_min: false, include_max: true };
    q.options[1].label = 'Trên 4 mmol/L';
    q.options[1].range = { min: 4, max: null, include_min: false, include_max: false };
    expect(validateQuestionSet(value)).toBeTruthy();
  });
  test('a supplement is limited to three content questions', () => {
    const value = content();
    value.questions.splice(0, 2);
    expect(() => validateQuestionSet(value)).toThrow();
    expect(validateQuestionSet(value, { supplement: true }).questions).toHaveLength(2);
  });
  test('AI suggestions never count as a physician-confirmed red flag', () => {
    const value = content();
    value.questions[0].options[0].suggested_red_flag = true;
    expect(validateQuestionSet(value).questions[0].options[0].red_flag).toBeUndefined();
  });
});

describe('IVR encryption boundary', () => {
  beforeAll(() => {
    process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  test('encrypts with randomized IVs and binds ciphertext to owner and purpose', () => {
    const { seal, reveal } = require('../src/services/doctor-ivr/ivr.service');
    const a = seal(7, 'audio', 'private'),
      b = seal(7, 'audio', 'private');
    expect(a).not.toBe(b);
    expect(reveal(7, 'audio', a)).toBe('private');
    expect(() => reveal(8, 'audio', a)).toThrow();
    expect(() => reveal(7, 'report', a)).toThrow();
  });
});

const describeDb = process.env.DOCTOR_IVR_TEST_DATABASE_URL ? describe : describe.skip;
describeDb('IVR PostgreSQL workflow in an isolated fixture schema', () => {
  let pool, admin, ivr, worker, schema;
  const input = {
    tenant_id: 'clinic-demo',
    task_id: 'ivr-fixture-task',
    app_user_id: '1',
    doctor_id: randomUUID(),
    doctor_name: 'Bác sĩ',
    operation: 'approve',
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const invoke = (operation, data) => ivr.doctorOperation(pool, { ...input, operation, data });
  const newTask = async (suffix) => {
    await pool.query(
      "UPDATE doctor_ivr_sessions SET status='cancelled' WHERE status IN ('draft','sent','in_progress','completed')"
    );
    input.task_id = `ivr-fixture-${suffix}`;
    await pool.query('INSERT INTO doctor_task_outbox(tenant_id,payload) VALUES($1,$2)', [
      input.tenant_id,
      {
        event_type: 'doctor.task.requested',
        payload: { app_user_id: '1', task_id: input.task_id, summary: 'Fixture' },
      },
    ]);
  };
  const answer = (s, question, option, extra = {}) =>
    ivr.patientAction(pool, 1, s.id, {
      action: 'answer',
      revision: s.revision,
      question_id: question,
      option_id: option,
      request_id: randomUUID(),
      ...extra,
    });
  beforeAll(async () => {
    const { Pool } = require('pg'),
      fs = require('fs'),
      url = new URL(process.env.DOCTOR_IVR_TEST_DATABASE_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Only a local fixture database is allowed');
    process.env.DOCTOR_IVR_ENABLED = 'true';
    process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.JWT_SECRET = 'ivr-fixture-jwt';
    admin = new Pool({ connectionString: url.toString() });
    schema = `ivr_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url.toString(),
      options: `-c search_path=${schema},public`,
    });
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,deleted_at TIMESTAMPTZ);INSERT INTO users VALUES(1,NULL),(2,NULL);
   CREATE TABLE doctor_task_outbox(id SERIAL,tenant_id TEXT,payload JSONB,created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE doctor_task_lifecycle_events(tenant_id TEXT,task_id TEXT,status TEXT,doctor_ref TEXT,payload JSONB,occurred_at TIMESTAMPTZ,created_at TIMESTAMPTZ);
   CREATE TABLE doctor_privacy_request_receipts(user_id INTEGER,tenant_id TEXT,action TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE user_ai_consents(user_id INTEGER,version TEXT,providers JSONB,revoked_at TIMESTAMPTZ);
   CREATE TABLE notifications(user_id INTEGER,data JSONB);
  `);
    const consent = require('../src/services/ai/ai-consent.service');
    await pool.query('INSERT INTO user_ai_consents(user_id,version,providers) VALUES(1,$1,$2)', [
      consent.AI_CONSENT_VERSION,
      JSON.stringify(consent.AI_PROVIDERS),
    ]);
    await pool.query('INSERT INTO doctor_task_outbox(tenant_id,payload) VALUES($1,$2)', [
      input.tenant_id,
      {
        event_type: 'doctor.task.requested',
        payload: { app_user_id: '1', task_id: input.task_id, summary: 'Fixture' },
      },
    ]);
    await pool.query(
      fs.readFileSync(
        require('path').join(__dirname, '../db/migrations/116_doctor_ivr_pilot.sql'),
        'utf8'
      )
    );
    await pool.query(
      fs.readFileSync(
        require('path').join(__dirname, '../db/migrations/117_doctor_ivr_template_privacy.sql'),
        'utf8'
      )
    );
    await pool.query(
      fs.readFileSync(
        require('path').join(__dirname, '../db/migrations/118_doctor_ivr_outbox_recovery.sql'),
        'utf8'
      )
    );
    jest
      .spyOn(require('../src/services/checkin-call/audio.service'), 'synthesizeText')
      .mockResolvedValue({ audio_data: Buffer.from('fixture-tts'), mime_type: 'audio/mpeg' });
    jest
      .spyOn(require('../src/services/notification/basic.notification.service'), 'sendAndSave')
      .mockResolvedValue(true);
    jest
      .spyOn(require('../src/services/integrations/doctor-task.service'), 'deliverDoctorRequest')
      .mockResolvedValue({ status: 200, data: {} });
    jest.spyOn(require('../src/services/ai/ai.service'), 'callTextAi').mockResolvedValue({
      content: JSON.stringify({
        summary: 'Đã nhận thông tin.',
        draft_reply: 'Bác sĩ đã xem các câu trả lời.',
      }),
    });
    jest
      .spyOn(require('../src/services/ai/providers/openai'), 'getWhisperTranscription')
      .mockResolvedValue('Câu trả lời bằng giọng nói.');
    ivr = require('../src/services/doctor-ivr/ivr.service');
    jest.resetModules();
    // Reload the worker after spies so every external side effect remains mocked.
    // The service itself stays connected to the same isolated Pool.
    jest.doMock('../src/services/checkin-call/audio.service', () => ({
      synthesizeText: jest.fn(async () => ({
        audio_data: Buffer.from('fixture-tts'),
        mime_type: 'audio/mpeg',
      })),
    }));
    jest.doMock('../src/services/notification/basic.notification.service', () => ({
      sendAndSave: jest.fn(async () => true),
    }));
    jest.doMock('../src/services/integrations/doctor-task.service', () => ({
      ...jest.requireActual('../src/services/integrations/doctor-task.service'),
      deliverDoctorRequest: jest.fn(async () => ({ status: 200, data: {} })),
    }));
    jest.doMock('../src/services/ai/ai.service', () => ({
      callTextAi: jest.fn(async () => ({
        content: JSON.stringify({
          summary: 'Đã nhận thông tin.',
          draft_reply: 'Bác sĩ đã xem các câu trả lời.',
        }),
      })),
    }));
    jest.doMock('../src/services/ai/providers/openai', () => ({
      getWhisperTranscription: jest.fn(async () => 'Câu trả lời bằng giọng nói.'),
    }));
    worker = require('../src/services/doctor-ivr/ivr.worker');
  });
  afterAll(async () => {
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
    jest.restoreAllMocks();
  });
  test('approve → listen/choose → report → physician reply → acknowledge, with ownership, revisions and immutable versions', async () => {
    const value = content();
    value.questions[0].options[1].red_flag = true;
    const sent = await invoke('approve', { content: value });
    await worker.runDoctorIvrWorker(pool);
    let s = await ivr.patientGet(pool, 1, sent.session_id);
    expect(s.status).toBe('sent');
    expect(s.content.questions[0].speech_text).toBe(questionSpeech(value, 'q1'));
    expect(s.content.questions[0].options[1].red_flag).toBeUndefined();
    await expect(ivr.patientGet(pool, 2, s.id)).rejects.toMatchObject({ statusCode: 404 });
    const requestId = randomUUID();
    s = await answer(s, 'q1', 'q1_b', { request_id: requestId });
    expect(s.current_question_id).toBe('q2');
    expect(
      (await pool.query("SELECT 1 FROM doctor_ivr_events WHERE event_type='red_flag.detected'"))
        .rowCount
    ).toBe(1);
    expect(
      (await ivr.patientAction(pool, 1, s.id, { action: 'answer', request_id: requestId })).revision
    ).toBe(s.revision);
    await expect(invoke('approve', { content: value })).rejects.toMatchObject({
      code: 'IVR_SESSION_ACTIVE',
    });
    await expect(invoke('cancel', { session_id: s.id })).rejects.toMatchObject({
      code: 'IVR_ALREADY_STARTED',
    });
    await expect(answer({ ...s, revision: 0 }, 'q2', 'q2_a')).rejects.toMatchObject({
      code: 'IVR_STALE_REVISION',
    });
    s = await ivr.patientAction(pool, 1, s.id, { action: 'back', revision: s.revision });
    expect(s.current_question_id).toBe('q1');
    expect(s.answers).toHaveLength(0);
    s = await answer(s, 'q1', 'q1_a');
    s = await answer(s, 'q2', 'q2_a');
    s = await answer(s, 'q3', 'q3_a');
    const finalRequest = randomUUID();
    s = await answer(s, 'q_final', 'qf_no', { request_id: finalRequest });
    expect(s.status).toBe('completed');
    expect(
      (await ivr.patientAction(pool, 1, s.id, { action: 'answer', request_id: finalRequest }))
        .status
    ).toBe('completed');
    await worker.runDoctorIvrWorker(pool);
    const listed = await invoke('list');
    s = listed.sessions[0];
    expect(s.status).toBe('reported');
    expect(s.report.red_flags).toHaveLength(0);
    expect(s.report.red_flag_history).toHaveLength(1);
    expect(s.report.summary).toBe('Đã nhận thông tin.');
    await expect(
      invoke('reply', { session_id: s.id, reply: 'Bác đang dùng thuốc gì không ạ?' })
    ).rejects.toMatchObject({ code: 'IVR_REPLY_NEEDS_FOLLOW_UP' });
    expect((await ivr.patientGet(pool, 1, s.id)).status).toBe('reported');
    await invoke('reply', { session_id: s.id, reply: 'Bác sĩ đã xem thông tin của anh/chị.' });
    s = await ivr.patientGet(pool, 1, s.id);
    expect(s.doctor_reply).toContain('đã xem');
    expect(s.report).toBeNull();
    s = await ivr.patientAction(pool, 1, s.id, { action: 'ack' });
    expect(s.status).toBe('closed');
    expect((await ivr.patientAction(pool, 1, s.id, { action: 'ack' })).status).toBe('closed');
  });
  test('private templates remain encrypted and feature flag stops new sessions', async () => {
    await invoke('template', { content: clone(content()), name: 'Mẫu riêng' });
    const row = (await pool.query('SELECT * FROM doctor_ivr_templates')).rows[0];
    expect(row.content_enc).not.toContain('Anh/chị');
    expect((await invoke('list')).templates[0].content.greeting).toBe('');
    process.env.DOCTOR_IVR_ENABLED = 'false';
    await expect(invoke('save', { content: content() })).rejects.toMatchObject({
      code: 'IVR_DISABLED',
    });
    process.env.DOCTOR_IVR_ENABLED = 'true';
  });
  test('an AI follow-up becomes a doctor review state, not a patient result or a closed case', async () => {
    await newTask('needs-follow-up');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    let s = await ivr.patientGet(pool, 1, created.session_id);
    for (const q of content().questions) s = await answer(s, q.id, q.options[0].id);
    require('../src/services/ai/ai.service').callTextAi.mockResolvedValueOnce({
      content: JSON.stringify({
        summary: 'Chưa rõ thông tin bệnh nhân muốn hỏi.',
        draft_reply: 'Bác có thể chia sẻ thêm giờ ngủ không ạ?',
        needs_follow_up: false,
      }),
    });
    await worker.runDoctorIvrWorker(pool);
    const state = (await invoke('list')).sessions[0];
    expect(state.status).toBe('reported');
    expect(state.report).toMatchObject({ needs_follow_up: true, draft_reply: '' });
    expect((await ivr.patientGet(pool, 1, state.id)).doctor_reply).toBeNull();
    await expect(ivr.patientAction(pool, 1, state.id, { action: 'ack' })).rejects.toMatchObject({
      code: 'IVR_REPLY_NOT_READY',
    });
    const extra = content();
    extra.questions.splice(0, 2);
    expect((await invoke('approve', { content: extra, supplement: true })).session_id).toBeTruthy();
  });
  test('an explicit skip is persisted as missing information, never as a negative answer', async () => {
    await newTask('explicit-skip');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    let s = await ivr.patientGet(pool, 1, created.session_id);
    s = await ivr.patientAction(pool, 1, s.id, {
      action: 'answer',
      question_id: 'q1',
      revision: s.revision,
      request_id: randomUUID(),
      skip_reason: 'user_skip',
    });
    expect(s.current_question_id).toBe('q2');
    expect(s.answers[0]).toMatchObject({
      answer_type: 'skip',
      skip_reason: 'user_skip',
      option_id: null,
    });
  });
  test('keeps one active immutable version under concurrent approvals', async () => {
    await newTask('concurrent');
    await Promise.all([
      invoke('approve', { content: content() }),
      invoke('approve', { content: content() }),
    ]);
    const sessions = (await invoke('list')).sessions;
    expect(sessions.filter((s) => s.status === 'draft')).toHaveLength(1);
    expect(sessions.filter((s) => s.status === 'cancelled')).toHaveLength(1);
    expect(new Set(sessions.map((s) => s.version)).size).toBe(2);
  });
  test('concurrent retries of one answer commit progress and its audit only once', async () => {
    await newTask('simultaneous-retry');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    const s = await ivr.patientGet(pool, 1, created.session_id);
    const requestId = randomUUID();
    const results = await Promise.all([
      answer(s, 'q1', 'q1_a', { request_id: requestId }),
      answer(s, 'q1', 'q1_a', { request_id: requestId }),
    ]);
    expect(results.map((value) => value.revision)).toEqual([1, 1]);
    const saved = await ivr.patientGet(pool, 1, s.id);
    expect(saved.current_question_id).toBe('q2');
    expect(saved.answers).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM doctor_ivr_events WHERE session_id=$1 AND event_type='answer.recorded'",
          [s.id]
        )
      ).rowCount
    ).toBe(1);
  });
  test('two devices answering the same revision cannot overwrite one another', async () => {
    await newTask('two-devices');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    const s = await ivr.patientGet(pool, 1, created.session_id);
    const results = await Promise.allSettled([answer(s, 'q1', 'q1_a'), answer(s, 'q1', 'q1_b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe(
      'IVR_STALE_REVISION'
    );
    const saved = await ivr.patientGet(pool, 1, s.id);
    expect(saved.revision).toBe(1);
    expect(saved.answers).toHaveLength(1);
    expect(saved.answers[0].option_id).toBe(
      results.find((result) => result.status === 'fulfilled').value.answers[0].option_id
    );
  });
  test('a cancelled invitation cannot be restarted or answered', async () => {
    await newTask('cancelled-invitation');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    const s = await ivr.patientGet(pool, 1, created.session_id);
    await invoke('cancel', { session_id: s.id });
    await expect(ivr.patientAction(pool, 1, s.id, { action: 'start' })).rejects.toMatchObject({
      code: 'IVR_SESSION_ENDED',
    });
    await expect(answer(s, 'q1', 'q1_a')).rejects.toMatchObject({ code: 'IVR_SESSION_ENDED' });
    expect((await ivr.patientGet(pool, 1, s.id)).answers).toHaveLength(0);
  });
  test('an expired unanswered session stays expired without fabricating a report', async () => {
    await newTask('unanswered-expiry');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    await pool.query(
      "UPDATE doctor_ivr_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [created.session_id]
    );
    await worker.runDoctorIvrWorker(pool);
    const s = await ivr.patientGet(pool, 1, created.session_id);
    expect(s.status).toBe('expired');
    expect(s.answers).toHaveLength(0);
    expect(
      (await pool.query('SELECT 1 FROM doctor_ivr_reports WHERE session_id=$1', [s.id])).rowCount
    ).toBe(0);
    await expect(ivr.patientAction(pool, 1, s.id, { action: 'start' })).rejects.toMatchObject({
      code: 'IVR_SESSION_ENDED',
    });
  });
  test('resumes the chosen branch, permits one supplement and expires partial sessions', async () => {
    await newTask('branch');
    const questions = content();
    questions.questions[0].options[0].next = 'q3';
    const created = await invoke('approve', { content: questions });
    await worker.runDoctorIvrWorker(pool);
    let s = await ivr.patientGet(pool, 1, created.session_id);
    s = await answer(s, 'q1', 'q1_a');
    expect(s.current_question_id).toBe('q3');
    expect((await ivr.patientGet(pool, 1, s.id)).current_question_id).toBe('q3');
    await pool.query(
      "UPDATE doctor_ivr_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [s.id]
    );
    await worker.runDoctorIvrWorker(pool);
    await worker.runDoctorIvrWorker(pool);
    const prior = (await invoke('list')).sessions[0];
    expect(prior.status).toBe('reported');
    expect(prior.report.completion).toBe('partial');
    const extra = content();
    extra.questions.splice(0, 2);
    const supplement = await invoke('approve', { content: extra, supplement: true });
    await worker.runDoctorIvrWorker(pool);
    s = await ivr.patientGet(pool, 1, supplement.session_id);
    expect(s.is_supplement).toBe(true);
    s = await answer(s, 'q3', 'q3_a');
    s = await answer(s, 'q_final', 'qf_no');
    await worker.runDoctorIvrWorker(pool);
    await expect(invoke('approve', { content: extra, supplement: true })).rejects.toMatchObject({
      code: 'IVR_SUPPLEMENT_LIMIT',
    });
    await expect(
      invoke('reply', { session_id: prior.id, reply: 'Nội dung trả lời.' })
    ).rejects.toMatchObject({ code: 'IVR_NEWER_SESSION' });
  });
  test('stores original voice bytes, accepts a deferred upload once, preserves unknown STT confidence and signs media for 15 minutes', async () => {
    await newTask('voice');
    const created = await invoke('approve', { content: content() });
    await worker.runDoctorIvrWorker(pool);
    let s = await ivr.patientGet(pool, 1, created.session_id);
    const requestId = randomUUID();
    s = await answer(s, 'q1', 'q1_x', {
      request_id: requestId,
      voice_pending: true,
      recording_consent: true,
    });
    expect(s.current_question_id).toBe('q2');
    expect(s.answers[0].stt_status).toBe('awaiting_upload');
    // A real two-second PCM WAV exercises ffprobe; no provider receives this fixture.
    const bytes = Buffer.alloc(44 + 16000 * 2 * 2);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let i = 44; i < bytes.length; i += 2)
      bytes.writeInt16LE(Math.round(Math.sin(i / 10) * 6000), i);
    s = await ivr.patientAction(
      pool,
      1,
      s.id,
      { action: 'answer', request_id: requestId },
      { buffer: bytes, mimetype: 'audio/wav' }
    );
    expect(s.current_question_id).toBe('q2');
    expect(s.answers[0].audio_url).toBeTruthy();
    const stored = (
      await pool.query('SELECT audio_enc FROM doctor_ivr_answers WHERE session_id=$1', [s.id])
    ).rows[0];
    expect(stored.audio_enc).not.toContain('RIFF');
    await worker.runDoctorIvrWorker(pool);
    s = await ivr.patientGet(pool, 1, s.id);
    expect(s.answers[0].transcript).toBe('Câu trả lời bằng giọng nói.');
    expect(s.answers[0].stt_confidence).toBeNull();
    expect(s.answers[0].needs_review).toBe(true);
    const url = new URL(s.answers[0].audio_url, 'http://localhost');
    const params = url.searchParams,
      answerId = url.pathname.split('/').at(-1);
    expect(
      (
        await ivr.media(
          pool,
          answerId,
          params.get('expires'),
          params.get('signature'),
          params.get('actor')
        )
      ).buffer.equals(bytes)
    ).toBe(true);
    await expect(
      ivr.media(pool, answerId, params.get('expires'), params.get('signature'), 'somebody-else')
    ).rejects.toMatchObject({ code: 'IVR_MEDIA_EXPIRED' });
    await expect(
      ivr.media(
        pool,
        answerId,
        Math.floor(Date.now() / 1000) - 1,
        params.get('signature'),
        params.get('actor')
      )
    ).rejects.toMatchObject({ code: 'IVR_MEDIA_EXPIRED' });
    // A forged client duration cannot make an invalid original pass validation.
    await expect(
      answer(s, 'q2', 'q2_x', { duration_s: 2, recording_consent: true })
    ).rejects.toMatchObject({ code: 'IVR_AUDIO_REQUIRED' });
    await expect(
      ivr.patientAction(
        pool,
        1,
        s.id,
        {
          action: 'answer',
          question_id: 'q2',
          option_id: 'q2_x',
          revision: s.revision,
          request_id: randomUUID(),
          recording_consent: true,
          duration_s: 2,
        },
        { buffer: Buffer.from('not audio'), mimetype: 'audio/wav' }
      )
    ).rejects.toMatchObject({ code: 'IVR_INVALID_AUDIO_DURATION' });
  });
  test('withdrawal blocks reads and provider calls; a later explicit grant restores access', async () => {
    await pool.query(
      "INSERT INTO doctor_privacy_request_receipts(user_id,tenant_id,action,status) VALUES(1,$1,'withdraw_consent','completed')",
      [input.tenant_id]
    );
    const id = (
      await pool.query('SELECT id FROM doctor_ivr_sessions WHERE task_id=$1', [input.task_id])
    ).rows[0].id;
    await expect(ivr.patientGet(pool, 1, id)).rejects.toMatchObject({
      code: 'IVR_CONSENT_WITHDRAWN',
    });
    await pool.query(
      "INSERT INTO doctor_privacy_request_receipts(user_id,tenant_id,action,status,created_at) VALUES(1,$1,'grant_consent','completed',NOW()+INTERVAL '1 second')",
      [input.tenant_id]
    );
    expect((await ivr.patientGet(pool, 1, id)).id).toBe(id);
  });
});
