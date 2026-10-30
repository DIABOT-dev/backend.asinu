'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const logger = require('../../src/lib/logger');
const { generateConclusion } = require('../../src/core/checkin/triage-ai-layer');
const {
  buildConclusionFacts,
  validateBlock,
  composeConclusion,
  BLOCKS,
} = require('../../src/core/checkin/triage-conclusion');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { calculateConclusion } = require('../../src/core/checkin/triage-engine');
const { cases } = require('../../tools/checkin-conclusion-lab/cases.cjs');
const { t } = require('../../src/i18n');

const profile = { age: 52, gender: 'Nam', medical_conditions: ['Mỡ máu cao'] };
const state = () => ({
  allSymptoms: ['mệt mỏi', 'khó ngủ'],
  currentSymptoms: ['mệt mỏi', 'khó ngủ'],
  onset: 'vài ngày nay',
  progression: 'same',
  redFlagsFound: [],
  actionsFound: [],
  completedSteps: new Set(['red_flags']),
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
});
const candidate = () => ({
  loi_nhan: 'Chú mệt và khó ngủ vài ngày nay, tình trạng vẫn như cũ. Cháu hiểu chú đang uể oải ạ.',
  lien_quan:
    'Ngủ kém thường ảnh hưởng tới cảm giác mệt. Với mỡ máu cao đã khai, sinh hoạt đều đặn cũng cần được quan tâm.',
  nen_lam: ['Giữ giờ thức dậy đều đặn.', 'Ghi 2 điều: lúc mệt và giấc ngủ gần đây.'],
  di_kham_khi: [
    'Chú nên đến phòng khám trong vài ngày tới.',
    'Nếu khó chịu ảnh hưởng nhiều tới sinh hoạt, chú đi khám sớm hơn nhé.',
  ],
});
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockResolvedValue({
    content: JSON.stringify(candidate()),
    model: 'medgemma-27b-it',
    usage: { total: 700 },
  });
});

test('returns four AI blocks, fixed disclaimer, one server follow-up and legacy fields', async () => {
  const result = await generateConclusion(state(), profile);
  expect(result).toMatchObject({
    conclusionVersion: 2,
    todo: candidate().nen_lam,
    seeDoctorWhen: candidate().di_kham_khi,
    followUpHours: 3,
  });
  expect(result.summary).toBe(`${candidate().loi_nhan} ${candidate().lien_quan}`);
  expect(result.recommendation).toBe(
    [...candidate().nen_lam, ...candidate().di_kham_khi].join('\n')
  );
  expect(result.disclaimer).toBe(
    require('../../src/i18n/locales/vi.json')['checkin.conclusion.disclaimer']
  );
  expect(result.disclaimer).toContain('điều trị của bác sĩ.');
  expect(result.disclaimer).toContain('chẩn đoán');
  expect(result.closeMessage).toContain('3 giờ');
  expect(result.speechText).toBe(
    [candidate().loi_nhan, ...candidate().di_kham_khi, result.closeMessage].join(' ')
  );
  expect(result.speechText).not.toContain(result.explanation);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(callTextAi).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'medgemma',
      strictProvider: true,
      model: 'medgemma-27b-it',
      maxTokens: 700,
      timeoutMs: 10000,
      maxRetries: 0,
    })
  );
});
test('rejects only an unsafe block and logs reason without clinical text', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ ...candidate(), lien_quan: 'Chú có thể là mắc trầm cảm.' }),
  });
  const result = await generateConclusion(state(), profile);
  expect(result.personalMessage).toBe(candidate().loi_nhan);
  expect(result.todo).toEqual(candidate().nen_lam);
  expect(result.explanation).not.toContain('trầm cảm');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'lien_quan',
    reason: 'speculative_diagnosis',
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Chú');
});
test.each(['invalid JSON', '{"loi_nhan":""}', 'null', '[]'])(
  'malformed output %s retains six readable blocks',
  async (content) => {
    callTextAi.mockResolvedValue({ content });
    const result = await generateConclusion(state(), profile);
    expect(result.personalMessage).toBeTruthy();
    expect(result.explanation).toBeTruthy();
    expect(result.todo.length).toBeGreaterThanOrEqual(2);
    expect(result.seeDoctorWhen.length).toBeGreaterThanOrEqual(2);
    expect(result.disclaimer).toBeTruthy();
    expect(result.closeMessage).toContain('3 giờ');
    expect(result.recommendation).not.toContain('cấp cứu');
  }
);
test('provider timeout retains the symptom-specific sleep guidance', async () => {
  callTextAi.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));
  const result = await generateConclusion(state(), profile);
  expect(result.todo.join(' ')).toMatch(/ngủ|giấc ngủ/);
  expect(result.seeDoctorWhen.join(' ')).not.toContain('115');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'response',
    reason: 'provider_unavailable',
  });
});
test('emergency templates bypass the AI and omit disclaimer/structured blocks', async () => {
  const result = await generateConclusion(
    { ...state(), emergencyType: 'stroke', severity: 'emergency' },
    profile
  );
  expect(callTextAi).not.toHaveBeenCalled();
  expect(result.isEmergency).toBe(true);
  expect(result.disclaimer).toBeUndefined();
  expect(result.conclusionVersion).toBeUndefined();
  expect(result.recommendation).toContain('115');
});
test('health context contains only bounded patient facts and preserves unknown medication', () => {
  const now = new Date('2026-10-29T08:00:00Z');
  const facts = buildConclusionFacts(
    state(),
    { ...profile, full_name: 'Private Name', email: 'private@example.com', phone: '000' },
    {
      recentBP: [
        { systolic: 128, diastolic: 82, occurred_at: '2026-10-29T06:00:00Z' },
        { systolic: 130, diastolic: 84, occurred_at: '2026-10-27T06:00:00Z' },
        { systolic: 140, diastolic: 90, occurred_at: '2026-10-30T06:00:00Z' },
      ],
      recentGlucose: [{ value: '6.4', unit: 'mmol/L', occurred_at: '2026-10-29T05:00:00Z' }],
      tookMedicationToday: false,
      previousCheckins: [
        { session_date: '2026-10-27', initial_status: 'tired', triage_summary: 'khó ngủ' },
      ],
      symptomFrequencyContext: 'Khó ngủ: 2 lần',
      medicationAdherenceContext: null,
    },
    'vi',
    now
  );
  expect(facts.chi_so_24h).toHaveLength(2);
  expect(facts.chi_so_7_ngay).toHaveLength(1);
  expect(facts.chi_so_24h[0].luc).toContain('13:00');
  expect(facts.uong_thuoc_hom_nay).toBe('chưa ghi');
  expect(facts.check_in_truoc[0].tom_tat).toBe('khó ngủ');
  expect(facts.trieu_chung_lap_lai).toBe('Khó ngủ: 2 lần');
  expect(JSON.stringify(facts)).not.toMatch(/Private Name|private@example/);
});
test('no 24h value means no old numbers; comparison requires same-type pairs', () => {
  const facts = buildConclusionFacts(state(), profile);
  facts.chi_so_7_ngay = [
    { loai: 'huyet_ap', gia_tri: '128/82', don_vi: 'mmHg', luc: '13:00 27/10/26' },
  ];
  expect(validateBlock('lien_quan', 'Huyết áp hôm trước là 128/82 mmHg.', facts)).toBe(
    'ungrounded_measurement'
  );
  facts.chi_so_24h = [
    { loai: 'huyet_ap', gia_tri: '130/84', don_vi: 'mmHg', luc: '13:00 29/10/26' },
  ];
  expect(
    validateBlock(
      'lien_quan',
      'Huyết áp 130/84 mmHg lúc 13:00 29/10/26, so với lần trước 128/82 mmHg lúc 13:00 27/10/26.',
      facts
    )
  ).toBeNull();
  expect(validateBlock('lien_quan', 'Đường huyết 130 mmol/L.', facts)).toBe(
    'ungrounded_measurement'
  );
});

test('block 2 always includes latest real 24h readings and declared conditions omitted by AI', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: 'Sinh hoạt đều đặn giúp theo dõi sức khỏe.',
    }),
  });
  const result = await generateConclusion(state(), profile, 'vi', null, {
    recentBP: [
      { systolic: 128, diastolic: 82, occurred_at: new Date(Date.now() - 3600000).toISOString() },
    ],
  });
  expect(result.explanation).toContain('Mỡ máu cao');
  expect(result.explanation).toContain('128/82 mmHg');
  expect(result.explanation).toMatch(/\d{2}:\d{2}/);
  expect(result.todo).toEqual(candidate().nen_lam);
});

test('server factual completion never promotes a historical measurement to a current reading', async () => {
  const result = await generateConclusion(state(), profile, 'vi', null, {
    recentBP: [
      {
        systolic: 128,
        diastolic: 82,
        occurred_at: new Date(Date.now() - 48 * 3600000).toISOString(),
      },
    ],
  });
  expect(result.explanation).not.toContain('128/82');
});
test('allows vì, bởi, declared conditions and adherence; forbids changing treatment', () => {
  const facts = buildConclusionFacts(state(), profile, { tookMedicationToday: true });
  expect(
    validateBlock('lien_quan', 'Vì chú khó ngủ nên cháu hiểu chú đang mệt.', facts)
  ).toBeNull();
  expect(
    validateBlock('nen_lam', ['Uống thuốc đúng như bác sĩ đã kê.', 'Ghi giờ đi ngủ.'], facts)
  ).toBeNull();
  expect(validateBlock('nen_lam', ['Giảm liều thuốc.', 'Ghi giờ đi ngủ.'], facts)).toBe(
    'treatment_change'
  );
  expect(validateBlock('lien_quan', 'Chú đã khai mắc mỡ máu cao.', facts)).toBeNull();
  expect(validateBlock('lien_quan', 'Chú bị suy giáp.', facts)).toBe('undeclared_disease');
});

test('a permitted adherence reminder cannot hide an unrelated medication instruction', () => {
  const facts = buildConclusionFacts(state(), profile, { tookMedicationToday: true });
  expect(
    validateBlock('nen_lam', ['Chú dùng thuốc bổ.', 'Uống thuốc đúng như bác sĩ đã kê.'], facts)
  ).toBe('medication_instruction');
});

test.each([
  'Mỡ máu của chú vẫn cao.',
  'Mỡ máu của chú cao.',
  'Mỡ máu hiện tại cao.',
  'Mỡ máu của chú ổn định.',
])('declared high cholesterol is not a new measured result: %s', (claim) => {
  expect(validateBlock('lien_quan', claim, buildConclusionFacts(state(), profile))).toBe(
    'unmeasured_lipid_claim'
  );
});
test('does not accept changing required assessment into conditional-only advice', () => {
  const facts = buildConclusionFacts(state(), profile);
  expect(
    validateBlock(
      'di_kham_khi',
      ['Nếu khó ngủ nhiều hơn thì đi khám.', 'Nếu khó thở thì gọi 115.'],
      facts
    )
  ).toBe('required_referral_missing');
  expect(validateBlock('di_kham_khi', candidate().di_kham_khi, facts)).toBeNull();
});
test('self-monitoring cannot become an immediate assessment instruction', () => {
  const facts = buildConclusionFacts({ ...state(), needsDoctor: false }, profile);
  expect(
    validateBlock('di_kham_khi', ['Chú nên đi khám hôm nay.', 'Nếu đau ngực thì gọi 115.'], facts)
  ).toBe('upgraded_care_level');
});

test('word boundaries do not confuse lưng thường or khó ngủ with cancer or cough', async () => {
  const facts = buildConclusionFacts(state(), profile);
  expect(
    validateBlock('lien_quan', 'Đau lưng thường liên quan đến tư thế sinh hoạt.', facts)
  ).toBeNull();
  callTextAi.mockRejectedValueOnce(new Error('offline'));
  const result = await generateConclusion(state(), profile);
  expect(result.todo.join(' ')).toMatch(/ngủ/);
  expect(result.todo.join(' ')).not.toMatch(/nhiệt độ|khói thuốc/);
});

test('measurement grounding accepts an optional ngày separator but rejects wrong date or time', () => {
  const facts = buildConclusionFacts(state(), profile);
  facts.chi_so_24h = [
    { loai: 'huyet_ap', gia_tri: '128/82', don_vi: 'mmHg', luc: '13:00 29/10/26' },
  ];
  expect(
    validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/2026.', facts)
  ).toBeNull();
  expect(validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 14:00 ngày 29/10/2026.', facts)).toBe(
    'measurement_time_not_exact'
  );
  expect(validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 28/10/2026.', facts)).toBe(
    'measurement_time_not_exact'
  );
});
test('incomplete assessment is acknowledged while no absence of red flags is invented', async () => {
  const result = await generateConclusion({ ...state(), assessmentIncomplete: true }, profile);
  expect(result.personalMessage).toMatch(/chưa hỏi|chưa đủ/);
  const facts = buildConclusionFacts({ ...state(), assessmentIncomplete: true }, profile);
  expect(validateBlock('loi_nhan', 'Không có dấu hiệu nguy hiểm.', facts)).toBe(
    'unconfirmed_absence_of_red_flags'
  );
});
test('English fallback, disclaimer and schedule use the selected language', async () => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const result = await generateConclusion(state(), profile, 'en');
  expect(result.disclaimer).toContain('Connect with an Asinu health expert');
  expect(result.closeMessage).toContain('3 hours');
  expect(result.todo.join(' ')).toMatch(/sleep|bedtime/);
});
test('integration passes context and keeps all new fields in the public result', async () => {
  // Empty symptom avoids the unrelated safety-classifier request in this test.
  const result = await getNextTriageQuestion({
    status: 'tired',
    forceConclusion: true,
    profile,
    healthContext: { tookMedicationToday: true, symptomFrequencyContext: 'Test frequency' },
    previousAnswers: [],
  });
  expect(result).toMatchObject({ isDone: true, conclusionVersion: 2 });
  expect(result.disclaimer).toBeTruthy();
  expect(result.todo).toHaveLength(2);
  const sent = callTextAi.mock.calls[0][0].prompt;
  expect(sent).toContain('Test frequency');
  expect(sent).toContain('đã có bản ghi uống thuốc');
});
test.each(cases().map((item) => [item.id, item]))(
  '30-case rule contract stays unchanged: %s',
  (_id, item) => {
    const expected = calculateConclusion(item.state, 'tired');
    const before = JSON.stringify({
      severity: item.state.severity,
      needsDoctor: item.state.needsDoctor,
      needsFamilyAlert: item.state.needsFamilyAlert,
      followUpHours: item.state.followUpHours,
    });
    const facts = buildConclusionFacts(item.state, item.profile, item.context, item.lang);
    const result = composeConclusion(candidate(), item.state, item.profile, item.lang);
    expect(result.followUpHours).toBe(expected.followUpHours);
    expect(
      JSON.stringify({
        severity: item.state.severity,
        needsDoctor: item.state.needsDoctor,
        needsFamilyAlert: item.state.needsFamilyAlert,
        followUpHours: item.state.followUpHours,
      })
    ).toBe(before);
    expect(facts.care_level).toBe(
      item.state.needsDoctor
        ? item.state.severity === 'high'
          ? 'kham_trong_ngay'
          : 'dat_lich_kham'
        : 'tu_theo_doi'
    );
  }
);
