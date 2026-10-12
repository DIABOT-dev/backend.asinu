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

test('a persisted completed result is replayed without another AI call or completion side effects', async () => {
  const { pool } = poolFor();
  const answers = [{ step: 'symptoms', question: 'Triệu chứng?', answer: 'Đau đầu' }];
  const first = await processTriageStep(pool, 7, 12, answers, 'vi');
  const replay = await processTriageStep(pool, 7, 12, answers, 'vi');
  expect(replay).toEqual(first);
  expect(getNextTriageQuestion).toHaveBeenCalledTimes(1);
  expect(
    pool.query.mock.calls.filter(([sql]) => sql.includes('triage_completed_at  = NOW()'))
  ).toHaveLength(1);
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
