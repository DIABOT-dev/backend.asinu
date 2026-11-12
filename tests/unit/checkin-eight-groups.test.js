'use strict';
jest.mock('../../src/security/openbao-keyring.cjs', () => ({ keyringEnabled: () => false, keyringReady: () => true }));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/core/checkin/triage-ai-layer', () => ({
  ...jest.requireActual('../../src/core/checkin/triage-ai-layer'),
  classifySymptomSeverity: jest.fn().mockResolvedValue({ severity: 'mild' }),
  generateConclusion: jest.fn().mockResolvedValue({ summary: 'Recorded', recommendation: 'Monitor' }),
}));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { generateConclusion } = require('../../src/core/checkin/triage-ai-layer');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { getCompactNextStep } = require('../../src/services/checkin/compact-interview.service');
const { validateExtraction } = require('../../src/services/checkin/compact-coverage.service');
const { reportedMeasurements } = require('../../src/core/checkin/triage-reported-measurements');
const { providerResponse, options } = require('../fixtures/compact-interview');

let extractExtra;
let details;
beforeEach(() => {
  jest.clearAllMocks();
  details = ['character'];
  extractExtra = () => ({});
  callTextAi.mockImplementation(async (params) => {
    const c = JSON.parse(params.prompt).CONTEXT;
    if (params.system.startsWith('Review')) return { content: '{"valid":true,"errors":[]}' };
    if (params.system.startsWith('Extract explicitly')) {
      const facts = c.field === 'character' ? c.concerns.flatMap(concern => {
        const quote = c.answer.split('; ').find(part => part.includes(concern.label));
        return quote ? [{ concern_id: concern.id, field: 'character', value: quote, quote, answer_index: c.answer_index }] : [];
      }) : [];
      return { content: JSON.stringify({ new_concerns: [], facts,
        ...(c.field === 'symptoms' ? { requested_details: c.concerns.map(concern => ({ concern_id: concern.id, fields: details })) } : {}),
        global_answer: { relevant: true, quote: c.answer }, ...extractExtra(c) }) };
    }
    if (c.field === 'timeline') return { content: JSON.stringify({ field: c.field,
      question: `Những khó chịu này của ${c.addressing.honorific} bắt đầu từ khi nào và đến giờ thay đổi thế nào?`,
      options: c.required_options,
    }) };
    if (c.field === 'clinical_context') return { content: JSON.stringify({ field: c.field,
      question: `Hôm nay ${c.addressing.honorific} dùng thuốc và đo các chỉ số như thế nào?`,
      options: c.required_options?.length ? c.required_options : c.required_option_ids.map(id => {
        const typed = /^(huyet_ap|duong_huyet)_(reading_available|not_measured)$/u.exec(id);
        return { id, label: typed ? `${typed[2] === 'reading_available' ? 'Có đo' : 'Chưa có đo'} ${typed[1] === 'huyet_ap' ? 'huyết áp' : 'đường huyết'} hôm nay`
          : options.clinical_context.find(([code]) => code === id)[1] };
      }),
    }) };
    if (c.field === 'character') return { content: JSON.stringify({ field: c.field,
      question: 'Chỗ khó chịu có cảm giác thế nào, cụ thể ở đâu vậy?',
      options: [{ id: 'aching', label: 'Âm ỉ ở khớp gối' }, { id: 'sharp', label: 'Nhói ở khớp gối' }],
    }) };
    return providerResponse(params);
  });
});

function flow(extra = {}) {
  let adaptiveState = { version: 1, sources: [], questions: [] }, next;
  const previousAnswers = [], seen = [];
  const input = { assessmentVersion: 3, interviewLayout: 'eight_groups', adaptiveEnabled: true,
    phase: 'initial', status: 'tired', lang: 'vi', profile: { age: 56, gender: 'Nam' },
    healthContext: { medical_conditions: ['Tăng huyết áp', 'Tiểu đường'] }, bodyLocations: ['limbs'], ...extra };
  async function advance(answer) {
    if (answer !== undefined) previousAnswers.push({ step: next.step, question: next.question, answer });
    next = await getNextTriageQuestion({ ...input, previousAnswers, adaptiveState });
    adaptiveState = next._adaptiveState || adaptiveState;
    if (!next.isDone) seen.push(next);
    return next;
  }
  const offered = () => adaptiveState.compact.questions[previousAnswers.length];
  const label = id => offered().choices.find(c => c.id === id)?.label;
  const reply = () => ({
    symptoms: 'Sưng khớp', red_flags: 'Không có', impact: label('normal'),
    timeline: [label('under_week'), label('same')].filter(Boolean).join(', '),
    character: 'Sưng khớp ở gối phải, cảm giác căng tức',
    clinical_context: ['medication_as_planned', 'huyet_ap_not_measured', 'duong_huyet_not_measured'].map(label).filter(Boolean).join(', '),
    source: label('activity'), associated: 'Không có',
  })[offered().field];
  async function finish(choose = () => undefined) {
    if (!next) await advance();
    for (let i = 0; i < 20 && !next.isDone; i++) {
      const answer = choose(offered(), next) ?? reply();
      if (!answer) throw new Error(`Unexpected extra question: ${offered().field}`);
      await advance(answer);
    }
    expect(next.isDone).toBe(true);
    return generateConclusion.mock.calls.at(-1)[0].compactAssessment;
  }
  return { advance, finish, seen, previousAnswers, offered, label,
    get state() { return adaptiveState; }, get next() { return next; }, input };
}

test('eight primary groups complete a clear chronic-condition check-in without losing source screening', async () => {
  const f = flow();
  const assessment = await f.finish();
  expect(f.previousAnswers.map(a => a.step)).toEqual(['compact_symptoms', 'compact_red_flags', 'compact_impact', 'compact_timeline', 'compact_character', 'compact_clinical_context', 'compact_source', 'compact_associated']);
  expect(assessment).toMatchObject({ complete: true, causeIsUnconfirmed: true });
  expect(assessment.missing).toEqual([]);
  expect(assessment.concerns[0].facts).toMatchObject({ onset: { value: 'Từ 3 đến dưới 7 ngày' }, progression: { code: 'same' } });
  expect(f.seen.map(q => q.questionGroup.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(f.seen.every(q => q.questionProgress.total === 8)).toBe(true);
  const timeline = f.seen.find(q => q.step === 'compact_timeline');
  expect(timeline.requiredOptionGroups.map(g => g.length)).toEqual([4, 3]);
  expect(timeline.multiSelect).toBe(true);
});

test('a positive associated-context choice does not reopen every primary-question group', async () => {
  const f = flow();
  const assessment = await f.finish(q => q.field === 'associated' ? q.choices.find(c => c.id === 'sleep').label : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(assessment.concerns).toHaveLength(1);
  expect(assessment.global.associated.value).toContain('Khó ngủ');
});

test('confirmed blood pressure and glucose are captured in the same clinical question with exact evidence', async () => {
  const f = flow();
  const assessment = await f.finish(q => q.field === 'clinical_context'
    ? [f.label('medication_as_planned'), f.label('huyet_ap_reading_available'), f.label('duong_huyet_reading_available'),
      'Huyết áp hôm nay 123/78 mmHg', 'Đường huyết hôm nay 108 mg/dL'].join(', ') : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(f.seen.some(q => q.step.startsWith('compact_measurements'))).toBe(false);
  expect(reportedMeasurements(assessment)).toEqual(expect.arrayContaining([
    expect.objectContaining({ loai: 'huyet_ap', gia_tri: '123/78', don_vi: 'mmHg', source: 'user_report' }),
    expect.objectContaining({ loai: 'duong_huyet', gia_tri: '108', don_vi: 'mg/dL', source: 'user_report' }),
  ]));
  expect(assessment.measurementReplies.duong_huyet.parts[0].evidence.quote).toBe('Đường huyết hôm nay 108 mg/dL');
});

test('explicit mmol/L remains mmol/L and is never relabelled mg/dL', async () => {
  const f = flow();
  const assessment = await f.finish(q => q.field === 'clinical_context'
    ? [f.label('medication_as_planned'), f.label('huyet_ap_not_measured'), f.label('duong_huyet_reading_available'), 'Đường huyết hôm nay 6.2 mmol/L'].join(', ') : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(reportedMeasurements(assessment)).toEqual([expect.objectContaining({ loai: 'duong_huyet', gia_tri: '6.2', don_vi: 'mmol/L' })]);
  expect(assessment.measurements.huyet_ap.code).toBe('not_measured');
});

test('an older patient can report forgotten readings without guessing numbers or losing medication status', async () => {
  const f = flow();
  const assessment = await f.finish(q => q.field === 'clinical_context'
    ? ['medication_as_planned', 'huyet_ap_reading_unknown', 'duong_huyet_reading_unknown'].map(f.label).join(', ') : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(assessment.measurements.huyet_ap).toMatchObject({ status: 'unknown', code: 'reading_unknown' });
  expect(assessment.measurements.duong_huyet).toMatchObject({ status: 'unknown', code: 'reading_unknown' });
  expect(assessment.global.medication_today.code).toBe('medication_as_planned');
  expect(reportedMeasurements(assessment)).toEqual([]);
  expect(f.seen.some(q => q.step.startsWith('compact_measurements'))).toBe(false);
});

test('forgotten medication status does not discard remembered readings or become a missed dose', async () => {
  const f = flow();
  const assessment = await f.finish(q => q.field === 'clinical_context'
    ? ['medication_unknown', 'huyet_ap_reading_available', 'duong_huyet_reading_available'].map(f.label).concat([
      'Huyết áp hôm nay 123/78 mmHg', 'Đường huyết hôm nay 108 mg/dL']).join(', ') : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(assessment.global.medication_today).toMatchObject({ status: 'unknown', code: 'medication_unknown' });
  expect(reportedMeasurements(assessment)).toHaveLength(2);
});

test('today’s logged readings are reused and only the medication subsection remains', async () => {
  const f = flow({ healthContext: { medical_conditions: ['Tăng huyết áp', 'Tiểu đường'],
    recentBP: [{ systolic: 121, diastolic: 79, occurred_at: new Date().toISOString() }],
    recentGlucose: [{ value: 104, unit: 'mg/dL', occurred_at: new Date().toISOString() }],
  } });
  await f.finish();
  const clinical = f.seen.find(q => q.step === 'compact_clinical_context');
  expect(clinical.optionsGrouped.map(g => g.key)).toEqual(['medication_today', 'other']);
  expect(clinical.measurementInputs).toBeUndefined();
  expect(f.previousAnswers).toHaveLength(8);
});

test('multiple complaints share core groups while different timelines remain attributed', async () => {
  extractExtra = c => c.field === 'timeline' ? { facts: c.concerns.flatMap((concern, i) => [
    { concern_id: concern.id, field: 'onset', value: i ? 'từ hôm qua' : 'từ sáng nay', quote: i ? 'từ hôm qua' : 'từ sáng nay', answer_index: c.answer_index },
    { concern_id: concern.id, field: 'progression', value: i ? 'đỡ dần' : 'vẫn như cũ', quote: i ? 'đỡ dần' : 'vẫn như cũ', code: i ? 'better' : 'same', answer_index: c.answer_index },
  ]) } : {};
  const f = flow();
  const assessment = await f.finish(q => q.field === 'symptoms' ? 'Sưng khớp, Tê tay chân'
    : q.field === 'timeline' ? 'Sưng khớp từ sáng nay vẫn như cũ; Tê tay chân từ hôm qua đỡ dần'
      : q.field === 'character' ? 'Sưng khớp ở gối phải căng tức; Tê tay chân ở ngón tay trái châm chích' : undefined);
  expect(f.previousAnswers.length).toBeLessThanOrEqual(9);
  expect(assessment.concerns.map(c => c.facts.onset.value)).toEqual(['từ sáng nay', 'từ hôm qua']);
  expect(assessment.concerns.map(c => c.facts.progression.code)).toEqual(['same', 'better']);
  expect(assessment.concerns[0].facts.character.value).not.toContain('ngón tay trái');
  expect(assessment.concerns[1].facts.character.value).not.toContain('gối phải');
  const warning = f.seen.find(q => q.step === 'compact_red_flags');
  expect(warning.options.length).toBeGreaterThan(6);
  const warningQuestions = f.state.compact.questions.filter(q => q.field === 'red_flags');
  expect(warningQuestions.every(q => q.choices.length <= 12)).toBe(true);
  expect(new Set(warningQuestions.flatMap(q => q.warningKeys)).size).toBe(assessment.warnings.flatMap(w => w.keys).length);
  expect(f.seen.find(q => q.step === 'compact_timeline').freeTextOption).toContain('mỗi triệu chứng khác nhau');
});

test('an unclear timeline triggers a focused clarification rather than pretending eight answers are sufficient', async () => {
  const f = flow();
  await f.advance(); await f.advance('Sưng khớp'); await f.advance('Không có'); await f.advance(f.label('normal'));
  const q = await f.advance('Tôi đang cầm điện thoại');
  expect(q.step).toMatch(/^compact_timeline_q/u);
  expect(f.state.compact.coverage.concerns[0].facts.onset.status).toBe('unresolved');
  expect(generateConclusion).not.toHaveBeenCalled();
});

test('a partially completed clinical answer does not mark the other measurement as answered', async () => {
  const f = flow(); await f.advance();
  while (f.offered().field !== 'clinical_context') {
    const q = f.offered();
    await f.advance(({ symptoms: 'Sưng khớp', red_flags: 'Không có', impact: f.label('normal'),
      timeline: [f.label('under_week'), f.label('same')].filter(Boolean).join(', '), character: 'Sưng khớp ở gối phải căng tức' })[q.field]);
  }
  await f.advance([f.label('medication_as_planned'), f.label('huyet_ap_not_measured')].join(', '));
  expect(f.next.step).toMatch(/^compact_clinical_context_q/u);
  expect(f.state.compact.coverage.measurementReports.duong_huyet).toBeUndefined();
  expect(f.next.optionsGrouped.map(g => g.key)).toEqual(['duong_huyet', 'other']);
});

test('old offered questions keep their layout and exact wording when a new client resumes', async () => {
  const f = flow({ interviewLayout: undefined }); await f.advance();
  const prior = f.next;
  const next = await getNextTriageQuestion({ ...f.input, interviewLayout: 'eight_groups', adaptiveState: f.state, previousAnswers: [] });
  expect(next).toEqual(prior);
  expect(next._adaptiveState.compact.layout).toBeUndefined();
});

test('crossed missing timeline facts label the relevant symptom in each section and preserve already known facts', async () => {
  const f = flow(); await f.advance(); await f.advance('Sưng khớp, Tê tay chân');
  const concerns = f.state.compact.coverage.concerns;
  concerns[0].facts.onset = { value: 'từ sáng nay', status: 'reported', evidence: { answerIndex: 0, quote: 'Sưng khớp' } };
  concerns[1].facts.progression = { value: 'đỡ dần', status: 'reported', code: 'better', evidence: { answerIndex: 0, quote: 'Tê tay chân' } };
  await f.advance('Không có'); await f.advance(f.label('normal'));
  expect(f.next.optionsGrouped[0].label).toContain('Tê tay chân');
  expect(f.next.optionsGrouped[1].label).toContain('Sưng khớp');
  await f.advance([f.label('under_week'), f.label('same')].join(', '));
  expect(f.state.compact.coverage.concerns[0].facts.onset.value).toBe('từ sáng nay');
  expect(f.state.compact.coverage.concerns[1].facts.progression.code).toBe('better');
});

test('useful episode details are retained in the combined detail group rather than silently removed', async () => {
  details = ['pattern', 'episode_duration'];
  extractExtra = c => c.field === 'character' ? { facts: c.concerns.flatMap(concern => [
    { concern_id: concern.id, field: 'pattern', value: 'từng đợt', quote: 'từng đợt', answer_index: c.answer_index },
    { concern_id: concern.id, field: 'episode_duration', value: 'khoảng 5 phút', quote: 'khoảng 5 phút', answer_index: c.answer_index },
  ]) } : {};
  const f = flow();
  const assessment = await f.finish(q => q.field === 'character' ? 'Sưng khớp xuất hiện từng đợt, mỗi đợt khoảng 5 phút' : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(assessment.concerns[0].facts.episode_duration.value).toBe('khoảng 5 phút');
  const generation = callTextAi.mock.calls.map(([p]) => p).find(p => !p.system.startsWith('Extract') && !p.system.startsWith('Review') && JSON.parse(p.prompt).CONTEXT.field === 'character');
  expect(generation.system).not.toContain('Never ask frequency');
  expect(generation.system).not.toContain('Do not combine other dimensions');
});

test('unobserved optional aggravation cannot trap an otherwise clear interview before clinical context and source', async () => {
  details = ['character', 'pattern', 'episode_duration', 'aggravating', 'actions'];
  extractExtra = c => c.field === 'character' ? { facts: c.concerns.flatMap(concern => [
    { concern_id: concern.id, field: 'character', value: 'căng tức', quote: 'căng tức', answer_index: c.answer_index },
    { concern_id: concern.id, field: 'pattern', value: 'từng đợt', quote: 'từng đợt', answer_index: c.answer_index },
    { concern_id: concern.id, field: 'episode_duration', value: 'khoảng 10 phút', quote: 'khoảng 10 phút', answer_index: c.answer_index },
    { concern_id: concern.id, field: 'actions', value: 'Nghỉ ngơi thì đỡ', quote: 'Nghỉ ngơi thì đỡ', answer_index: c.answer_index },
  ]) } : {};
  const f = flow();
  const assessment = await f.finish(q => q.field === 'character'
    ? 'Sưng khớp ở gối phải căng tức từng đợt, mỗi đợt khoảng 10 phút. Nghỉ ngơi thì đỡ.' : undefined);
  expect(f.previousAnswers).toHaveLength(8);
  expect(f.seen.filter(q => q.step.startsWith('compact_character'))).toHaveLength(1);
  expect(f.previousAnswers.some(a => a.step === 'compact_clinical_context')).toBe(true);
  expect(f.previousAnswers.some(a => a.step === 'compact_source')).toBe(true);
  expect(assessment.concerns[0].facts.aggravating).toBeUndefined();
  expect(assessment.missing_required).toEqual([]);
  expect(assessment.missing_optional).toContainEqual(expect.objectContaining({ field: 'aggravating', required: false, status: 'not_collected' }));
  expect(assessment.concerns[0].facts.episode_duration.value).toBe('khoảng 10 phút');
});

test.each(['next_action', 'personalization'])('supplemental details block only a reviewed grounded decision, purpose=%s', async purpose => {
  details = ['character', 'aggravating'];
  extractExtra = c => c.field === 'symptoms' ? { requested_details: c.concerns.map(concern => ({ concern_id: concern.id, fields: details,
    required_details: [{ field: 'aggravating', purpose, quote: 'Sưng khớp', reason: 'Câu trả lời phân biệt nhánh cần đánh giá trực tiếp ngay với theo dõi tại nhà.' }],
  })) } : {};
  const f = flow(); await f.advance();
  await f.advance('Sưng khớp'); await f.advance('Không có'); await f.advance(f.label('normal'));
  await f.advance([f.label('under_week'), f.label('same')].join(', '));
  await f.advance('Sưng khớp ở gối phải căng tức');
  expect(f.offered().field).toBe(purpose === 'next_action' ? 'character' : 'clinical_context');
  expect(f.state.compact.coverage.concerns[0].blockingDetails.length).toBe(purpose === 'next_action' ? 1 : 0);
});

test('natural remembered dates survive unused model codes while risk-bearing course codes remain strict', () => {
  const context = { answer_index: 0, answer: 'Từ hôm qua, vẫn như cũ', concerns: [{ id: 'c1', label: 'Sưng khớp' }], locations: [], exact_location: '', lang: 'vi' };
  const validate = facts => validateExtraction(JSON.stringify({ new_concerns: [], facts }), context);
  const parsed = validate([{ concern_id: 'c1', field: 'onset', value: 'Từ hôm qua', quote: 'Từ hôm qua', answer_index: 0, code: 'under_three_days' }]);
  expect(parsed.facts[0]).toMatchObject({ field: 'onset', value: 'Từ hôm qua', quote: 'Từ hôm qua' });
  expect(parsed.facts[0].code).toBeUndefined();
  expect(validate([{ concern_id: 'c1', field: 'progression', value: 'vẫn như cũ', quote: 'vẫn như cũ', answer_index: 0, code: 'worse' }])).toBeNull();
});
