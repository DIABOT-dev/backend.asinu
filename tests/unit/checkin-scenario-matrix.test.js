'use strict';

// State/answer-contract simulations. The provider is deterministic test data;
// this suite never calls Dr7, a database, TTS, push or a real patient account.
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { callTextAi } = require('../../src/services/ai/ai.service');
const {
  BODY_LOCATIONS,
  getSymptomsForLocation,
} = require('../../src/services/checkin/body-location');
const {
  prepareCompactInterview,
  resolveCompactQuestion,
  validateCompactAnswers,
} = require('../../src/services/checkin/compact-interview.service');
const { providerResponse } = require('../fixtures/compact-interview');

const masks = [
  1, 2, 4, 8, 16, 32, 64, 3, 5, 9, 17, 33, 65, 6, 10, 18, 34, 66, 12, 20, 36, 68, 24, 40, 72, 48,
  80, 96, 7, 15, 31, 127,
];
const profiles = [
  { age: 23, gender: 'Nam' },
  { age: 35, gender: 'Nam' },
  { age: 35, gender: 'Nữ' },
  { age: 56, gender: 'Nam' },
  { age: 56, gender: 'Nữ' },
  { age: 65, gender: 'Nam' },
  { age: 78, gender: 'Nữ' },
  {},
];
const conditions = [
  [],
  ['Tăng huyết áp'],
  ['Tiểu đường'],
  ['Tăng huyết áp', 'Tiểu đường'],
  ['Tăng huyết áp', 'Tiểu đường'],
];
const onsetCodes = ['under_day', 'under_three_days', 'under_week', 'week_or_more'];
const earlyTimes = ['từ sáng nay', 'từ hôm qua', 'được 4 ngày', 'được 10 ngày'];
const cases = [];
for (let set = 0; set < masks.length; set++)
  for (let profile = 0; profile < profiles.length; profile++)
    for (let timeline = 0; timeline < 4; timeline++)
      for (let clinical = 0; clinical < conditions.length; clinical++)
        for (const fault of [false, true])
          cases.push({
            id: `S${set}-P${profile}-T${timeline}-C${clinical}-F${Number(fault)}`,
            set,
            profile,
            timeline,
            clinical,
            fault,
          });
assert.equal(cases.length, 10240);
const shuffled = [...cases];
let seed = 20261111;
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const at = seed % (i + 1);
  [shuffled[i], shuffled[at]] = [shuffled[at], shuffled[i]];
}
const selectedCases = process.env.CHECKIN_MATRIX_SAMPLE
  ? shuffled.slice(0, Number(process.env.CHECKIN_MATRIX_SAMPLE))
  : cases;
const stats = {
  planned: selectedCases.length,
  passed: 0,
  failed: [],
  questions: 0,
  resumeChecks: 0,
  clarificationChecks: 0,
  fallbackChecks: 0,
  readingPartsChecks: 0,
};
let active;

function provider(params) {
  const ctx = JSON.parse(params.prompt).CONTEXT;
  if (params.system.startsWith('Review patient fact')) return { content: 'APPROVE' };
  if (params.system.startsWith('Review one')) return { content: '{"valid":true,"errors":[]}' };
  if (params.system.startsWith('Extract explicitly')) {
    if (ctx.field === 'symptoms') {
      const existing = new Map(ctx.concerns.map((c) => [c.label, c.id]));
      const new_concerns = active.symptoms
        .filter((s) => !existing.has(s.label))
        .map((s, i) => ({
          id: `new_${i + 1}`,
          label: s.label,
          quote: s.label,
          answer_index: ctx.answer_index,
          region: s.region,
          detail_fields: [],
        }));
      const ids = new Map([...existing, ...new_concerns.map((c) => [c.label, c.id])]);
      return {
        content: JSON.stringify({
          new_concerns,
          facts:
            active.timeline === 2
              ? active.symptoms.map((s, i) => ({
                  concern_id: ids.get(s.label),
                  field: 'onset',
                  value: earlyTimes[i % 4],
                  quote: earlyTimes[i % 4],
                  answer_index: ctx.answer_index,
                }))
              : [],
          requested_details: active.symptoms.map((s) => ({
            concern_id: ids.get(s.label),
            fields: [],
          })),
        }),
      };
    }
    return {
      content: JSON.stringify({
        new_concerns: [],
        facts: [],
        global_answer: {
          relevant: ctx.answer !== 'Vừa đi chợ về',
          ...(ctx.answer !== 'Vừa đi chợ về' ? { quote: ctx.answer } : {}),
        },
      }),
    };
  }
  if (ctx.field === 'symptoms') {
    const labels = [
      ...new Set([
        ...active.symptoms.map((s) => s.label),
        ...active.regions.flatMap((r) => getSymptomsForLocation(r, 'vi')),
      ]),
    ].slice(0, 8);
    return {
      content: JSON.stringify({
        field: 'symptoms',
        question: `Hiện giờ ${ctx.addressing.honorific} đang thấy khó chịu như thế nào?`,
        options: labels.map((label, i) => ({ id: `symptom_${i}`, label })),
      }),
    };
  }
  if (active.fault && active.set % 3 === 0 && ctx.field === 'clinical_context')
    return {
      content: JSON.stringify({
        field: ctx.field,
        question: `Hôm nay ${ctx.addressing.honorific} đã đo chưa?`,
        options: [],
      }),
    };
  const result = JSON.parse(providerResponse(params).content);
  if (ctx.field === 'clinical_context') {
    const type = ctx.measurement_types?.[0] === 'huyet_ap' ? 'huyết áp' : 'đường huyết';
    result.question =
      ctx.clinical_parts?.length === 1
        ? ctx.clinical_parts[0] === 'medication_today'
          ? `Hôm nay ${ctx.addressing.honorific} dùng thuốc như thế nào?`
          : `Hôm nay ${ctx.addressing.honorific} đã đo ${type} chưa?`
        : `Hôm nay ${ctx.addressing.honorific} dùng thuốc và đo ${type} như thế nào?`;
  }
  if (ctx.clarification)
    result.question = `Để hiểu rõ hơn, ${result.question.charAt(0).toLocaleLowerCase() + result.question.slice(1)}`;
  return { content: JSON.stringify(result) };
}

beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockImplementation(provider);
});

test.each(selectedCases)('complete state/answer scenario $id', async (scenario) => {
  active = {
    ...scenario,
    regions: BODY_LOCATIONS.filter((_, i) => masks[scenario.set] & (1 << i)),
  };
  active.symptoms = active.regions.map((region, i) => ({
    region,
    label: getSymptomsForLocation(region, 'vi')[(scenario.set + i) % 4],
  }));
  const input = {
    assessmentVersion: 3,
    phase: 'initial',
    status: 'tired',
    lang: 'vi',
    profile: profiles[scenario.profile],
    bodyLocations: active.regions,
    healthContext: {
      medical_conditions: conditions[scenario.clinical],
      ...(scenario.clinical === 4
        ? { recentBP: [{ systolic: 121, diastolic: 79, occurred_at: new Date().toISOString() }] }
        : {}),
    },
  };
  let adaptiveState = { version: 1, sources: [], questions: [] },
    done = false,
    impactFaultSent = false;
  const answers = [],
    seen = [],
    partial = new Map(),
    steps = new Set();
  try {
    for (let round = 0; round < 70; round++) {
      const args = { ...input, previousAnswers: answers, adaptiveState };
      const base = await prepareCompactInterview(args);
      adaptiveState = base.compactAdaptive;
      if (base.action === 'conclude') {
        done = true;
        break;
      }
      const result = await resolveCompactQuestion(base, args);
      adaptiveState = result._adaptiveState;
      const q = adaptiveState.compact.questions.at(-1);
      assert.ok(!steps.has(q.step), 'A completed question step must never be offered again');
      steps.add(q.step);
      assert.ok(q.question.length <= 500);
      if (q.clarificationIndex !== undefined) {
        assert.notEqual(
          q.question,
          answers[q.clarificationIndex].question,
          'Clarification must rephrase the unclear question'
        );
        stats.clarificationChecks++;
      }
      if (scenario.fault && round === 3) {
        const before = callTextAi.mock.calls.length;
        const resumedArgs = {
          ...input,
          previousAnswers: answers,
          adaptiveState: JSON.parse(JSON.stringify(adaptiveState)),
        };
        const resumedBase = await prepareCompactInterview(resumedArgs);
        const resumed = await resolveCompactQuestion(resumedBase, resumedArgs);
        assert.equal(resumed.step, result.step);
        assert.equal(resumed.question, result.question);
        expect(resumed.options).toEqual(result.options);
        assert.equal(
          callTextAi.mock.calls.length,
          before,
          'Resuming a stored question must not call AI again'
        );
        stats.resumeChecks++;
      }
      const choice = (id) => q.choices.find((c) => c.id === id)?.label;
      let answer;
      if (q.field === 'symptoms')
        answer = active.symptoms
          .map((s, i) =>
            scenario.timeline === 2 ? `${s.label} bắt đầu ${earlyTimes[i % 4]}` : s.label
          )
          .join(', ');
      else if (q.field === 'impact') {
        if (scenario.fault && !impactFaultSent) {
          answer = 'Vừa đi chợ về';
          impactFaultSent = true;
        } else answer = choice('normal');
      } else if (['red_flags', 'source', 'associated'].includes(q.field)) answer = 'Không có';
      else if (q.field === 'onset') {
        if (scenario.timeline === 3) answer = 'Không rõ';
        else if (scenario.timeline === 1 && q.allowDifferent) answer = choice('different');
        else {
          const target = adaptiveState.compact.coverage.concerns.find((c) => c.id === q.targets[0]);
          const index = active.symptoms.findIndex((s) => s.label === target.label);
          answer = choice(scenario.timeline === 1 ? onsetCodes[index % 4] : 'under_three_days');
        }
      } else if (q.field === 'progression') answer = choice('same');
      else if (q.field === 'clinical_context') {
        const numeric = scenario.fault && scenario.set % 3 === 1;
        answer = [
          choice('medication_as_planned'),
          choice(numeric ? 'reading_available' : 'not_measured'),
        ]
          .filter(Boolean)
          .join(', ');
        assert.ok(
          q.choices.some((c) => c.id === 'reading_available') ||
            q.clinicalParts?.every((p) => p === 'medication_today')
        );
        assert.ok(
          q.choices.some((c) => c.id === 'not_measured') ||
            q.clinicalParts?.every((p) => p === 'medication_today')
        );
        if (q.origin === 'fallback') {
          assert.ok(q.choices.length >= 2);
          stats.fallbackChecks++;
        }
      } else if (q.field === 'measurements') {
        const type = q.measurementTypes[0],
          nth = (partial.get(type) || 0) + 1;
        partial.set(type, nth);
        assert.equal(
          q.choices.length,
          0,
          'Numeric values must never be fabricated as offered choices'
        );
        answer =
          type === 'huyet_ap' ? (nth === 1 ? '121/79' : 'mmHg') : nth === 1 ? '6.2' : 'mmol/L';
        if (nth === 2) stats.readingPartsChecks++;
      } else assert.fail(`Unexpected field ${q.field}`);
      assert.ok(answer, `Missing usable answer for ${q.field}`);
      answers.push({ step: q.step, question: q.question, answer });
      seen.push(q);
      validateCompactAnswers(adaptiveState, answers);
      stats.questions++;
    }
    assert.ok(
      done,
      'The complete understood interview must finish without an arbitrary question cap'
    );
    const c = adaptiveState.compact.coverage;
    expect([...c.concerns.map((c) => c.label)].sort()).toEqual(
      [...active.symptoms.map((s) => s.label)].sort()
    );
    for (const [i, symptom] of active.symptoms.entries()) {
      const concern = c.concerns.find((c) => c.label === symptom.label);
      assert.equal(concern.facts.onset.status, scenario.timeline === 3 ? 'unknown' : 'reported');
      if (scenario.timeline === 1) assert.equal(concern.facts.onset.code, onsetCodes[i % 4]);
      if (scenario.timeline === 2) assert.equal(concern.facts.onset.value, earlyTimes[i % 4]);
      assert.equal(concern.facts.progression.code, 'same');
    }
    assert.equal(seen.filter((q) => q.field === 'impact').length, scenario.fault ? 2 : 1);
    for (const field of ['source', 'associated'])
      assert.equal(seen.filter((q) => q.field === field).length, 1);
    if (scenario.timeline === 2) assert.equal(seen.filter((q) => q.field === 'onset').length, 0);
    if (scenario.timeline === 3) assert.equal(seen.filter((q) => q.field === 'onset').length, 1);
    if (scenario.clinical === 0)
      assert.equal(seen.filter((q) => q.field === 'clinical_context').length, 0);
    else {
      assert.equal(c.global.medication_today.code, 'medication_as_planned');
      const expected =
        scenario.clinical === 1
          ? ['huyet_ap']
          : scenario.clinical === 2
            ? ['duong_huyet']
            : ['huyet_ap', 'duong_huyet'];
      for (const type of expected) assert.equal(c.measurementReports[type].status, 'reported');
      if (scenario.clinical === 4)
        assert.ok(
          !seen.some(
            (q) => q.field === 'clinical_context' && q.measurementTypes?.includes('huyet_ap')
          )
        );
    }
    expect(c.unresolvedReports).toEqual([]);
    assert.throws(
      () => validateCompactAnswers(adaptiveState, [{ ...answers[0], question: 'Forged question' }]),
      /Question is not part/
    );
    assert.ok(
      seen[0].question.includes(
        ['bạn', 'anh', 'chị', 'chú', 'cô', 'bác', 'bà', 'bạn'][scenario.profile]
      ),
      'The question must use the expected age/gender address'
    );
    stats.passed++;
  } catch (error) {
    stats.failed.push({ id: scenario.id, reason: error.message });
    throw error;
  }
});

afterAll(() => {
  if (process.env.CHECKIN_MATRIX_REPORT)
    writeFileSync(
      process.env.CHECKIN_MATRIX_REPORT,
      JSON.stringify(
        {
          type: 'deterministic_state_and_answer_contract_simulations',
          real_provider_calls: 0,
          real_patient_rows: 0,
          dimensions: {
            symptom_sets: 32,
            profiles: 8,
            timeline_modes: 4,
            condition_contexts: 5,
            fault_modes: 2,
          },
          ...stats,
        },
        null,
        2
      )
    );
});
