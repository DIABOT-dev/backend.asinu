'use strict';

// Exercise the real HTTP handler, triage engine, conclusion and persistence.
// Only storage, provider and external side effects are replaced; no live users,
// notification transports or database credentials are used by this harness.
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}));
jest.mock('../../src/core/checkin/illusion-layer', () => ({
  buildCheckinContext: jest.fn().mockResolvedValue({}),
  applyIllusion: jest.fn(() => ({})),
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
jest.mock('../../src/lib/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const express = require('express');
const request = require('supertest');
const { triageHandler } = require('../../src/controllers/checkin.controller');
const { callTextAi } = require('../../src/services/ai/ai.service');
const candidate = {
  loi_nhan: 'Chú khó ngủ từ hôm qua và đang đỡ hơn. Cháu mong chú sớm dễ chịu nhé.',
  lien_quan: 'Giấc ngủ và sinh hoạt đều đặn cũng cần được quan tâm.',
  nen_lam: ['Giữ giờ thức dậy đều đặn.', 'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.'],
  di_kham_khi: [
    'Nếu khó ngủ ảnh hưởng nhiều tới sinh hoạt, chú nên đi khám.',
    'Nếu mất ngủ kéo dài, chú nên đi khám sớm hơn.',
  ],
};
const answers = [
  { step: 'symptoms', question: 'Triệu chứng?', answer: 'Khó ngủ' },
  { step: 'onset', question: 'Bắt đầu khi nào?', answer: 'Từ hôm qua' },
  { step: 'progression', question: 'Diễn biến?', answer: 'Đang đỡ dần' },
  { step: 'red_flags', question: 'Dấu hiệu?', answer: 'Không có' },
];
function harness({ condition } = {}) {
  const session = {
    id: 912,
    user_id: 7007,
    session_date: '2026-10-29',
    initial_status: 'tired',
    current_status: 'tired',
    flow_state: 'monitoring',
    triage_messages: [],
    triage_state: {},
  };
  let failCompletion = false;
  const pool = {
    query: jest.fn(async (sql, args = []) => {
      if (sql.includes('SELECT * FROM health_checkins WHERE id'))
        return {
          rows:
            Number(args[0]) === session.id && Number(args[1]) === session.user_id
              ? [{ ...session }]
              : [],
        };
      if (sql.includes('SELECT uop.*'))
        return {
          rows: [
            {
              age: 52,
              gender: 'Nam',
              medical_conditions: condition ? [condition] : [],
              lang: 'vi',
            },
          ],
        };
      if (sql.includes('RETURNING id') && sql.includes('triage_state = $3')) {
        if (JSON.stringify(session.triage_state) !== args[3]) return { rows: [] };
        session.triage_messages = JSON.parse(args[0]);
        session.triage_state = JSON.parse(args[2]);
        return { rows: [{ id: session.id }] };
      }
      if (sql.includes('triage_summary       = $1')) {
        if (failCompletion) {
          failCompletion = false;
          throw new Error('synthetic database failure');
        }
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
  const app = express();
  app.use(express.json());
  app.post('/api/mobile/checkin/triage', (req, res) => {
    req.user = { id: Number(req.headers['x-test-user'] || 7007) };
    return triageHandler(pool, req, res);
  });
  const submit = (body = { checkin_id: 912, previous_answers: answers }) =>
    request(app).post('/api/mobile/checkin/triage').send(body);
  return {
    session,
    pool,
    submit,
    failNextCompletion() {
      failCompletion = true;
    },
  };
}
const generations = () => callTextAi.mock.calls.filter(([options]) => options.maxTokens === 700);

test('HTTP detailed interview persists beyond eight answers and replays without another generation', async () => {
  const h = harness();
  h.session.body_locations = ['head', 'limbs'];
  h.session.body_location_other = 'Đầu: Trán; Tay chân: Cổ tay phải';
  const submitted = [];
  let final;
  for (let index = 0; index < 40; index++) {
    const response = await h.submit({
      checkin_id: 912,
      previous_answers: submitted,
      assessment_version: 2,
    });
    expect(response.status).toBe(200);
    const r = response.body;
    if (r.isDone) {
      final = r;
      break;
    }
    expect(r.questionProgress.total).toBeGreaterThanOrEqual(r.questionProgress.current);
    const answer =
      r.step === 'symptoms'
        ? 'Đau đầu, Đau khớp'
        : r.step === 'red_flags' || r.step.endsWith('_associated')
          ? 'Không có'
          : r.options[0];
    submitted.push({ step: r.step, question: r.question, answer });
    if (submitted.length === 9) expect(r.isDone).toBe(false);
  }
  expect(final?.isDone).toBe(true);
  expect(submitted.length).toBeGreaterThan(20);
  expect(h.session.triage_state.assessment_version).toBe(2);
  const count = generations().length;
  const replay = await h.submit({
    checkin_id: 912,
    previous_answers: submitted,
    assessment_version: 2,
  });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(final);
  expect(generations()).toHaveLength(count);
});

test('detailed API still rejects unknown field IDs and requests over its bounded limit', async () => {
  const h = harness();
  const invalid = await h.submit({
    checkin_id: 912,
    assessment_version: 2,
    previous_answers: [{ step: 'detail_head_hacked', question: 'Vị trí?', answer: 'abc' }],
  });
  expect(invalid.status).toBe(400);
  const oversized = await h.submit({
    checkin_id: 912,
    assessment_version: 2,
    previous_answers: Array.from({ length: 129 }, () => ({
      step: 'detail_head_severity',
      question: 'Mức đau?',
      answer: 'Nhẹ',
    })),
  });
  expect(oversized.status).toBe(400);
  expect(callTextAi).not.toHaveBeenCalled();
});
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockImplementation(async (options) => ({
    content: JSON.stringify(
      options.maxTokens === 200
        ? { severity: 'mild', needsDoctor: false, needsFamilyAlert: false }
        : candidate
    ),
    model: 'medgemma-27b-it',
  }));
});

test('HTTP response and stored replay preserve six blocks and legacy fields', async () => {
  const h = harness();
  const response = await h.submit();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    ok: true,
    isDone: true,
    conclusionVersion: 2,
    severity: 'low',
    needsDoctor: false,
    followUpHours: 6,
  });
  for (const key of [
    'personalMessage',
    'explanation',
    'summary',
    'recommendation',
    'closeMessage',
    'disclaimer',
  ])
    expect(response.body[key]).toBeTruthy();
  expect(response.body.todo).toHaveLength(2);
  expect(response.body.seeDoctorWhen).toHaveLength(2);
  expect(response.body.disclaimer).toContain('điều trị của bác sĩ.');
  expect(h.session.triage_completed_at).toBeTruthy();
  const replay = await h.submit();
  expect(replay.body).toEqual(response.body);
  expect(generations()).toHaveLength(1);
  expect(
    h.pool.query.mock.calls.filter(([sql]) => sql.includes('triage_completed_at  = NOW()'))
  ).toHaveLength(1);
});

test('narrative format travels through the real HTTP handler, generation, storage and replay', async () => {
  const h = harness();
  callTextAi.mockImplementation(async (options) => ({
    content:
      options.maxTokens === 200
        ? JSON.stringify({ severity: 'mild', needsDoctor: false, needsFamilyAlert: false })
        : 'Chú đang khó ngủ từ hôm qua, cháu hiểu chú đang mệt nhé.\n\nNếp sinh hoạt đều đặn giúp mình theo dõi những thay đổi.\n\n- Chú thử giữ giờ đi ngủ đều đặn.\n- Nếu khó ngủ kéo dài, chú hãy đi khám.',
    model: 'medgemma-27b-it',
  }));
  const body = { checkin_id: 912, previous_answers: answers, conclusion_format: 'narrative' };
  const response = await h.submit(body);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    conclusionFormat: 'narrative',
    conclusionSource: 'ai',
    severity: 'low',
    needsDoctor: false,
    followUpHours: 6,
  });
  expect(response.body.narrative).toContain('Chú đang khó ngủ từ hôm qua');
  const calls = callTextAi.mock.calls.length;
  const replay = await h.submit(body);
  expect(replay.body).toEqual(response.body);
  expect(callTextAi.mock.calls.length).toBe(calls);
});

test('a completed old result opens as a narrative without generating again or changing saved clinical data', async () => {
  const h = harness();
  await h.submit();
  const before = JSON.stringify(h.session);
  const calls = callTextAi.mock.calls.length;
  const response = await h.submit({
    checkin_id: 912,
    previous_answers: answers,
    conclusion_format: 'narrative',
  });
  expect(response.status).toBe(200);
  expect(response.body.conclusionFormat).toBe('narrative');
  expect(response.body.narrative).toContain(candidate.loi_nhan);
  expect(callTextAi.mock.calls.length).toBe(calls);
  expect(JSON.stringify(h.session)).toBe(before);
  expect(
    (await h.submit({ checkin_id: 912, previous_answers: answers, conclusion_format: 'anything' }))
      .status
  ).toBe(400);
});
test('concurrent HTTP submissions share one conclusion and one completion', async () => {
  const h = harness();
  const responses = await Promise.all([h.submit(), h.submit(), h.submit()]);
  expect(responses.map((r) => ({ status: r.status, code: r.body.code }))).toEqual(
    Array.from({ length: 3 }, () => ({ status: 200, code: undefined }))
  );
  expect(responses[1].body).toEqual(responses[0].body);
  expect(generations()).toHaveLength(1);
  expect(
    h.pool.query.mock.calls.filter(([sql]) => sql.includes('triage_completed_at  = NOW()'))
  ).toHaveLength(1);
});
test('foreign session, changed history and malformed answers never overwrite a saved result', async () => {
  const h = harness();
  await h.submit();
  const snapshot = JSON.stringify(h.session);
  const foreign = await h.submit().set('x-test-user', '7008');
  expect(foreign.status).toBe(404);
  expect((await h.submit({ checkin_id: 912, previous_answers: [] })).status).toBe(409);
  expect((await h.submit({ checkin_id: 912, previous_answers: null })).status).toBe(400);
  expect(JSON.stringify(h.session)).toBe(snapshot);
  expect(generations()).toHaveLength(1);
});
test('malformed model output and custom condition punctuation remain HTTP 200 with fallback', async () => {
  callTextAi.mockImplementation(async (options) => ({
    content: options.maxTokens === 200 ? '{}' : 'not JSON',
  }));
  const h = harness({ condition: 'Bệnh hiếm ABC (ghi thêm' });
  const response = await h.submit();
  expect(response.status).toBe(200);
  expect(response.body.conclusionVersion).toBe(2);
  expect(response.body.explanation).toContain('Bệnh hiếm ABC (ghi thêm');
});
test('retry after a failed metadata write finishes persistence before claiming completion', async () => {
  const h = harness();
  h.failNextCompletion();
  expect((await h.submit()).status).toBe(500);
  expect(h.session.triage_completed_at).toBeFalsy();
  const retry = await h.submit();
  expect(retry.status).toBe(200);
  expect(h.session.triage_completed_at).toBeTruthy();
  expect(h.session.triage_summary).toBe(retry.body.summary);
  expect(generations()).toHaveLength(1);
});

test('failed follow-up completion cannot use the earlier completion timestamp as success', async () => {
  const h = harness();
  const initial = await h.submit();
  h.session.triage_state = {
    phase: 'followup',
    baseline_answers: answers,
    previous_severity: 'low',
  };
  const previous = h.session.triage_summary;
  callTextAi.mockImplementation(async (options) => ({
    content: JSON.stringify(
      options.maxTokens === 200
        ? { severity: 'mild', needsDoctor: false, needsFamilyAlert: false }
        : { ...candidate, loi_nhan: 'Chú vẫn khó ngủ. Cháu hiểu chú đang khó chịu.' }
    ),
    model: 'medgemma-27b-it',
  }));
  const body = {
    checkin_id: 912,
    previous_answers: [
      { step: 'followup_status', question: 'So với lần trước?', answer: 'Vẫn như cũ' },
      { step: 'followup_detail', question: 'Triệu chứng mới?', answer: 'Không có triệu chứng mới' },
    ],
  };
  h.failNextCompletion();
  expect((await h.submit(body)).status).toBe(500);
  expect(h.session.triage_completed_at).toBeTruthy();
  expect(h.session.triage_summary).toBe(previous);
  expect(h.session.triage_state.completed.finalized).toBe(false);
  const count = generations().length;
  const retry = await h.submit(body);
  expect(retry.status).toBe(200);
  expect(h.session.triage_state.completed.finalized).toBe(true);
  expect(h.session.triage_summary).toBe(retry.body.summary);
  expect(h.session.triage_summary).not.toBe(initial.body.summary);
  expect(generations()).toHaveLength(count);
});
