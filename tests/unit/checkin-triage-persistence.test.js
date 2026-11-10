'use strict';

jest.mock('../../src/services/checkin/checkin.ai.service', () => ({
  getNextTriageQuestion: jest.fn(),
  calcFollowUpHours: () => 6,
}));
jest.mock('../../src/core/checkin/illusion-layer', () => ({
  buildCheckinContext: jest.fn().mockResolvedValue({}),
  applyIllusion: jest.fn(() => ({})),
}));
jest.mock('../../src/lib/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}));
jest.mock('../../src/services/health/health-timeline.service', () => ({
  rebuildPatientHealthTimeline: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/checkin/symptom-tracker.service', () => ({
  saveSymptomLogs: jest.fn().mockResolvedValue(null),
  getSymptomFrequencyContext: jest.fn().mockResolvedValue(null),
  getMedicationAdherenceContext: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({}));
jest.mock('../../src/core/notification/notification.orchestrator', () => ({
  dispatch: jest.fn(),
}));
jest.mock('../../src/services/notification/notification-dispatch.service', () => ({
  deliverNotification: jest.fn(),
}));

const { processTriageStep } = require('../../src/services/checkin/checkin.service');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.ai.service');
const { buildCheckinContext } = require('../../src/core/checkin/illusion-layer');

function poolFor() {
  const session = {
    id: 12,
    user_id: 7,
    initial_status: 'tired',
    current_status: 'tired',
    flow_state: 'follow_up',
    triage_messages: [],
    triage_state: {},
  };
  const pool = {
    query: jest.fn(async (sql, args = []) => {
      if (sql.includes('SELECT * FROM health_checkins WHERE id')) return { rows: [{ ...session }] };
      if (sql.includes('SELECT uop.*'))
        return { rows: [{ birth_year: 1991, gender: 'Nam', medical_conditions: [], lang: 'vi' }] };
      if (sql.includes('RETURNING id') && sql.includes('triage_state = $3')) {
        if (JSON.stringify(session.triage_state) !== args[3]) return { rows: [] };
        session.triage_messages = JSON.parse(args[0]);
        session.triage_state = JSON.parse(args[2]);
        return { rows: [{ id: session.id }] };
      }
      if (sql.includes('triage_summary       = $1')) {
        if (session.triage_state.revision !== args[6]) return { rows: [] };
        session.triage_summary = args[0];
        session.triage_severity = args[1];
        session.triage_completed_at = new Date();
        return { rows: [{ id: session.id }] };
      }
      if (sql.includes('SET triage_state = $1')) session.triage_state = JSON.parse(args[0]);
      if (sql.startsWith('SELECT triage_state'))
        return { rows: [{ triage_state: session.triage_state }] };
      return { rows: [] };
    }),
  };
  return { pool, session };
}

const completed = {
  isDone: true,
  summary: 'Đã ghi nhận đau đầu.',
  severity: 'low',
  recommendation: 'Theo dõi thêm.',
  needsDoctor: false,
  needsFamilyAlert: false,
  followUpHours: 6,
};
beforeEach(() => {
  jest.clearAllMocks();
  getNextTriageQuestion.mockResolvedValue({ ...completed });
  buildCheckinContext.mockResolvedValue({});
});

test.each(['requested', 'persisted', 'inferred'])('detailed assessment never forces a conclusion from answer count (%s)', async source => {
  const { pool, session } = poolFor();
  const answers = Array.from({ length: 128 }, () => ({ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }));
  if (source === 'persisted') session.triage_state = { assessment_version: 2 };
  if (source === 'inferred') answers[127] = { step: 'detail_head_onset', question: 'Từ khi nào?', answer: 'Từ sáng' };
  await processTriageStep(pool, 7, 12, answers, 'vi', source === 'requested' ? { assessmentVersion: 2 } : {});
  expect(getNextTriageQuestion).toHaveBeenCalledWith(expect.objectContaining({ forceConclusion: false }));
});

test('legacy installed clients keep their existing completion behavior', async () => {
  const { pool } = poolFor();
  const answers = Array.from({ length: 8 }, () => ({ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }));
  await processTriageStep(pool, 7, 12, answers, 'vi');
  expect(getNextTriageQuestion).toHaveBeenCalledWith(expect.objectContaining({ forceConclusion: true }));
});

test('a persisted completed result is replayed without another AI call or completion side effects', async () => {
  const earlySignal = require('../../src/services/early-signal/early-signal.service');
  earlySignal.evaluateAfterNewHealthData.mockClear();
  const { pool } = poolFor();
  const answers = [{ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }];
  const first = await processTriageStep(pool, 7, 12, answers, 'vi');
  const replay = await processTriageStep(pool, 7, 12, answers, 'vi');
  expect(replay).toEqual(first);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
  expect(earlySignal.evaluateAfterNewHealthData).toHaveBeenCalledTimes(1);
  expect(earlySignal.evaluateAfterNewHealthData).toHaveBeenCalledWith(
    pool, 7, expect.stringMatching(/^checkin:12:/), { patientPresent: true }
  );
  expect(
    pool.query.mock.calls.filter(([sql]) => sql.includes('triage_completed_at  = NOW()'))
  ).toHaveLength(1);
});

test('replaying JSONB answers with reordered object keys returns the saved conclusion', async () => {
  const { pool, session } = poolFor();
  const answers = [{ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }];
  const first = await processTriageStep(pool, 7, 12, answers, 'vi');
  const fromDatabase = answers.map(a => ({ step: a.step, answer: a.answer, question: a.question }));
  session.triage_messages = fromDatabase;
  pool.query.mockClear();
  await expect(processTriageStep(pool, 7, 12, fromDatabase, 'vi')).resolves.toEqual(first);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});

test('a conclusion created before canonical fingerprints can be replayed after a database round trip', async () => {
  const { createHash } = require('node:crypto');
  const { pool, session } = poolFor();
  const answers = [{ question: 'Triệu chứng?', answer: 'Đau đầu', step: 'symptoms' }];
  session.triage_messages = answers.map(a => ({ step: a.step, answer: a.answer, question: a.question }));
  session.triage_completed_at = new Date();
  session.triage_state = { phase: 'initial', lang: 'vi', completed: {
    fingerprint: createHash('sha256').update(JSON.stringify({ answers, lang: 'vi' })).digest('hex'),
    result: { ...completed }, finalized: true,
  } };
  await expect(processTriageStep(pool, 7, 12, session.triage_messages, 'vi')).resolves.toEqual(completed);
  expect(getNextTriageQuestion).not.toHaveBeenCalled();
  expect(pool.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  for (const changed of [[], [...answers, { step: 'onset', question: 'Từ khi nào?', answer: 'Hôm nay' }],
    [{ ...answers[0], answer: 'Đau bụng' }]]) {
    await expect(processTriageStep(pool, 7, 12, changed, 'vi')).rejects.toMatchObject({code:'TRIAGE_CHANGED'});
  }
  await expect(processTriageStep(pool, 7, 12, answers, 'en')).rejects.toMatchObject({code:'TRIAGE_CHANGED'});
});

test('simultaneous semantically identical answers share one conclusion despite different object key orders', async () => {
  const { pool } = poolFor();
  let release;
  getNextTriageQuestion.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = processTriageStep(pool, 7, 12, [{ step:'symptoms', question:'Triệu chứng?', answer:'Đau đầu' }], 'vi');
  const second = processTriageStep(pool, 7, 12, [{ answer:'Đau đầu', question:'Triệu chứng?', step:'symptoms' }], 'vi');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ ...completed });
  await expect(Promise.all([first, second])).resolves.toEqual([completed, completed]);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
});

test('an active patient receives doctor guidance in the result without a duplicate self-push', async () => {
  const { pool } = poolFor();
  const notifications = require('../../src/core/notification/notification.orchestrator');
  notifications.dispatch.mockClear();
  getNextTriageQuestion.mockResolvedValueOnce({ ...completed, severity: 'medium', needsDoctor: true });
  const result = await processTriageStep(pool, 7, 12, [
    { step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' },
  ], 'vi');
  expect(result).toMatchObject({ isDone: true, needsDoctor: true });
  expect(notifications.dispatch).not.toHaveBeenCalled();
});

test('two simultaneous identical submissions share the pending response', async () => {
  const { pool } = poolFor();
  let release;
  getNextTriageQuestion.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const first = processTriageStep(pool, 7, 12, [], 'vi');
  const second = processTriageStep(pool, 7, 12, [], 'vi');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release({ ...completed });
  expect(await first).toEqual(await second);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
});

test('an optional context-store failure does not fail the question API', async () => {
  const { pool } = poolFor();
  getNextTriageQuestion.mockResolvedValueOnce({
    isDone: false,
    step: 'symptoms',
    question: 'Anh thấy khó chịu ở đâu?',
    options: ['Đau đầu'],
  });
  buildCheckinContext.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(processTriageStep(pool, 7, 12, [], 'vi')).resolves.toMatchObject({
    isDone: false,
    step: 'symptoms',
  });
});

test('a late answer cannot overwrite a newer conversation state', async () => {
  const { pool, session } = poolFor();
  getNextTriageQuestion.mockImplementationOnce(async () => {
    session.triage_state = { phase: 'initial', revision: 'newer' };
    return { isDone: false, step: 'onset', question: 'Bắt đầu khi nào?', options: [] };
  });
  await expect(processTriageStep(pool, 7, 12, [], 'vi')).rejects.toMatchObject({
    code: 'TRIAGE_CHANGED',
    statusCode: 409,
  });
  expect(session.triage_state.revision).toBe('newer');
});

test('a stale earlier submission cannot reopen a completed conversation', async () => {
  const { pool, session } = poolFor();
  await processTriageStep(
    pool,
    7,
    12,
    [{ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }],
    'vi'
  );
  await expect(processTriageStep(pool, 7, 12, [], 'vi')).rejects.toMatchObject({
    code: 'TRIAGE_CHANGED',
  });
  expect(session.triage_severity).toBe('low');
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
});
test('an old tab cannot roll an unfinished interview back after newer answers are saved', async () => {
  const { pool, session } = poolFor();
  getNextTriageQuestion.mockResolvedValue({ isDone: false, step: 'progression', question: 'Diễn biến?', options: ['Vẫn vậy'] });
  const first = { step: 'symptoms', question: 'Biểu hiện?', answer: 'Đau đầu' };
  const second = { step: 'onset', question: 'Bắt đầu?', answer: 'Từ hôm qua' };
  await processTriageStep(pool, 7, 12, [first, second], 'vi');
  await expect(processTriageStep(pool, 7, 12, [first], 'vi')).rejects.toMatchObject({ code: 'TRIAGE_CHANGED', statusCode: 409 });
  expect(session.triage_messages).toEqual([first, second]);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
});
test('a stale edited prefix cannot silently replace facts already saved by another device', async () => {
  const { pool, session } = poolFor();
  getNextTriageQuestion.mockResolvedValue({ isDone: false, step: 'onset', question: 'Bắt đầu?', options: ['Hôm nay'] });
  const answer = { step: 'symptoms', question: 'Biểu hiện?', answer: 'Đau đầu' };
  await processTriageStep(pool, 7, 12, [answer], 'vi');
  await expect(processTriageStep(pool, 7, 12, [{ ...answer, answer: 'Đau bụng' }], 'vi')).rejects.toMatchObject({ code: 'TRIAGE_CHANGED' });
  expect(session.triage_messages).toEqual([answer]);
});
test('a delayed request from an earlier phase cannot start answering the new phase', async () => {
  const { pool, session } = poolFor();
  session.triage_state = { phase: 'followup', phase_id: 'new-followup-phase', revision: 'new-revision' };
  await expect(processTriageStep(pool, 7, 12, [], 'vi', { phaseId: 'old-initial-phase' })).rejects.toMatchObject({ code: 'TRIAGE_CHANGED' });
  expect(session.triage_messages).toEqual([]);
  expect(getNextTriageQuestion).not.toHaveBeenCalled();
});
test('simultaneous requests for different phases cannot share an in-flight result', async () => {
  const { pool, session } = poolFor();
  session.triage_state = { phase: 'followup', phase_id: 'new-phase', revision: 'new-revision' };
  getNextTriageQuestion.mockResolvedValue({ isDone:false,step:'followup_status',question:'Hiện giờ?',options:['Vẫn vậy'] });
  const valid = processTriageStep(pool,7,12,[],'vi',{phaseId:'new-phase'});
  const stale = processTriageStep(pool,7,12,[],'vi',{phaseId:'old-phase'});
  await expect(stale).rejects.toMatchObject({code:'TRIAGE_CHANGED'});
  await expect(valid).resolves.toMatchObject({step:'followup_status'});
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
});

test('a follow-up started during completion cannot receive the older summary', async () => {
  const { pool, session } = poolFor();
  const query = pool.query.getMockImplementation();
  pool.query.mockImplementation(async (sql, args) => {
    if (sql.includes('triage_summary       = $1'))
      session.triage_state = { phase: 'followup', revision: 'followup-started' };
    return query(sql, args);
  });
  await expect(processTriageStep(pool, 7, 12, [], 'vi')).rejects.toMatchObject({
    code: 'TRIAGE_CHANGED',
  });
  expect(session.triage_summary).toBeUndefined();
  expect(session.triage_state.revision).toBe('followup-started');
});

test.each(['initial', 'followup'])('phase identity remains stable while CAS revisions advance (%s)', async phase => {
  const { pool, session } = poolFor();
  session.occurrence_started_at = new Date('2026-11-08T01:00:00Z');
  session.triage_state = { phase, revision: 'opening-write' };
  getNextTriageQuestion.mockResolvedValue({ isDone: false, question: 'Example question', step: 'onset', options: ['Today', 'Yesterday'] });
  const ids = [], revisions = [];
  for (let i = 0; i < 3; i++) {
    await processTriageStep(pool, 7, 12, Array.from({ length: i }, () => ({ step: 'symptoms', question: 'Symptoms?', answer: 'Example symptom' })), 'vi');
    ids.push(session.triage_state.phase_id); revisions.push(session.triage_state.revision);
  }
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toBe(phase === 'initial' ? 'initial:2026-11-08T01:00:00.000Z' : 'opening-write');
  expect(new Set(revisions).size).toBe(3);
});
