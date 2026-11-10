'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const logger = require('../../src/lib/logger');
const {
  generateConclusion,
  EMERGENCY_CONCLUSIONS,
} = require('../../src/core/checkin/triage-ai-layer');
const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const sentences = (text) => [...segmenter.segment(text)].map((s) => s.segment.trim());
const state = (symptoms = ['khó ngủ']) => ({
  allSymptoms: symptoms,
  currentSymptoms: symptoms,
  onset: 'vài ngày nay',
  progression: 'same',
  completedSteps: new Set(['red_flags']),
  redFlagsFound: [],
  actionsFound: [],
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
});
const profile = { age: 52, gender: 'Nam', medical_conditions: [] };
const candidate = () => ({
  loi_nhan: 'Vài ngày nay chú khó ngủ, tình trạng vẫn như cũ. Cháu hiểu chú đang mệt nhé.',
  lien_quan:
    'Ngủ kém thường ảnh hưởng tới cảm giác mệt. Theo dõi nếp sinh hoạt giúp mình hiểu rõ những thay đổi.',
  nen_lam: [
    'Giữ giờ ngủ và thức dậy đều đặn.',
    'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.',
  ],
  di_kham_khi: [
    'Chú nên đi khám trong vài ngày tới.',
    'Nếu khó ngủ ảnh hưởng nhiều tới sinh hoạt, chú đi khám sớm hơn.',
  ],
});
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockResolvedValue({ content: JSON.stringify(candidate()), model: 'medgemma-27b-it' });
});

test('E7: a bare conditional warning becomes a complete spoken action without replacing valid blocks', async () => {
  const warning = 'Nếu chú thấy mệt nhiều hơn hoặc khó ngủ kéo dài.';
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      di_kham_khi: [candidate().di_kham_khi[0], warning],
    }),
  });
  const input = state();
  const originalDecision = { ...input };
  const result = await generateConclusion(input, profile);
  expect(result.seeDoctorWhen).toEqual([
    candidate().di_kham_khi[0],
    'Hãy đi khám nếu chú thấy mệt nhiều hơn hoặc khó ngủ kéo dài.',
  ]);
  expect(result.personalMessage).toBe(candidate().loi_nhan);
  expect(result.todo).toEqual(candidate().nen_lam);
  expect(result.followUpHours).toBe(input.followUpHours);
  expect(result.recommendation).toContain(result.seeDoctorWhen[1]);
  expect(result.speechText).toBe(
    [
      result.personalMessage,
      result.explanation,
      ...result.todo,
      ...result.seeDoctorWhen,
      result.disclaimer,
      result.closeMessage,
      result.aiNotice,
    ].join(' ')
  );
  expect(input).toEqual(originalDecision);
  expect(logger.warn).not.toHaveBeenCalled();
});

test('V3: server adds the required diary without replacing useful non-medication activities', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      nen_lam: ['Nghỉ ngơi thêm.', 'Sinh hoạt điều độ nhé.'],
    }),
  });
  const result = await generateConclusion(state(), profile);
  expect(result.todo.some((item) => /\d/.test(item))).toBe(true);
  expect(result.personalMessage).toBe(candidate().loi_nhan);
  expect(result.explanation).toBe(candidate().lien_quan);
  expect(result.seeDoctorWhen).toEqual(candidate().di_kham_khi);
  expect(result.todo).toEqual([
    'Nghỉ ngơi thêm.',
    'Sinh hoạt điều độ nhé.',
    candidate().nen_lam[1],
  ]);
  expect(logger.warn).not.toHaveBeenCalled();
});

test.each([
  [['Cao huyết áp'], /huyết áp/i],
  [['Huyết áp cao'], /huyết áp/i],
  [['Tăng huyết áp'], /huyết áp/i],
  [['Tiểu đường'], /đường huyết/i],
  [['Cao huyết áp', 'Tiểu đường'], /huyết áp.*đường huyết|đường huyết.*huyết áp/i],
])(
  'E2 / FR-1: declared conditions %j require the appropriate measurement reminder',
  async (conditions, measure) => {
    const result = await generateConclusion(state(), {
      ...profile,
      medical_conditions: conditions,
    });
    expect(result.todo).toHaveLength(3);
    expect(result.todo.join(' ')).toMatch(measure);
    expect(result.explanation).not.toMatch(/\d+\s*\/\s*\d+\s*mmHg|\d+(?:[.,]\d+)?\s*mmol\/L/);
  }
);

test('V3: factual completion preserves the full explanation and adds accurate current readings', async () => {
  const raw = {
    ...candidate(),
    lien_quan:
      'Ngủ không đủ thường khiến mình mệt hơn vào ban ngày. Nếp sinh hoạt đều đặn giúp mình theo dõi thay đổi. Chú ghi lại những lúc thấy khó chịu nhé.',
  };
  callTextAi.mockResolvedValue({ content: JSON.stringify(raw) });
  const at = new Date(Date.now() - 3600000).toISOString();
  const result = await generateConclusion(
    state(),
    { ...profile, medical_conditions: ['Cao huyết áp', 'Tiểu đường'] },
    'vi',
    null,
    {
      recentBP: [{ systolic: 128, diastolic: 82, occurred_at: at }],
      recentGlucose: [{ value: 6.4, unit: 'mmol/L', occurred_at: at }],
    }
  );
  expect(result.explanation).toMatch(/Cao huyết áp/i);
  expect(result.explanation).toMatch(/Tiểu đường/i);
  expect(result.explanation).toContain('128/82');
  expect(result.explanation).toContain('6.4');
  expect(result.explanation).toContain(raw.lien_quan);
  expect(result.conclusionSource).toBe('ai');
  expect(logger.warn).not.toHaveBeenCalled();
});

test.each([
  [
    'loi_nhan',
    'Chú thấy khó ngủ. Cháu hiểu chú đang mệt. Mình cùng theo dõi nhé. Chú có thể ghi lại cảm giác.',
  ],
  ['loi_nhan', 'Cháu hiểu chú đang mệt và khó ngủ nhé ❤️.'],
  ['loi_nhan', 'Chú Asinu thấy khó ngủ. Cháu hiểu chú đang mệt nhé.'],
])('FR-1 / §5: block %s must follow its sentence and no-emoji constraints', async (block, text) => {
  callTextAi.mockResolvedValue({ content: JSON.stringify({ ...candidate(), [block]: text }) });
  const result = await generateConclusion(state(), profile);
  const output = block === 'loi_nhan' ? result.personalMessage : result.explanation;
  expect(output).not.toBe(text);
  expect(output).not.toMatch(/\p{Extended_Pictographic}/u);
});

test.each(['vi', 'en'])(
  'E3 / E7 / E8 / E9: %s timeout keeps six blocks, a single schedule and legacy projection',
  async (lang) => {
    callTextAi.mockRejectedValue(
      Object.assign(new Error('synthetic timeout'), { name: 'AbortError' })
    );
    const result = await generateConclusion(state(), profile, lang);
    for (const key of ['personalMessage', 'explanation', 'disclaimer', 'closeMessage'])
      expect(result[key]).toBeTruthy();
    expect(result.summary).toBe(`${result.personalMessage} ${result.explanation}`);
    expect(result.recommendation).toBe([...result.todo, ...result.seeDoctorWhen].join('\n'));
    expect(result.speechText).toBe(
      [
        result.personalMessage,
        result.explanation,
        ...result.todo,
        ...result.seeDoctorWhen,
        result.disclaimer,
        result.closeMessage,
        result.aiNotice,
      ].join(' ')
    );
    for (const instruction of result.todo) expect(result.speechText).toContain(instruction);
    expect(result.closeMessage).toMatch(lang === 'vi' ? /3 giờ/ : /3 hours/);
    expect(result.disclaimer).toBe(
      require(`../../src/i18n/locales/${lang}.json`)['checkin.conclusion.disclaimer']
    );
  }
);

test.each(['same', 'worse'])(
  'E8: English timeout translates stored sleep aliases and progression %s',
  async (progression) => {
    callTextAi.mockRejectedValue(new Error('offline'));
    const result = await generateConclusion({ ...state(), progression }, profile, 'en');
    expect(result.personalMessage).toContain('difficulty sleeping');
    expect(result.personalMessage).not.toMatch(/[À-ỹ]/u);
  }
);

test.each(Object.keys(EMERGENCY_CONCLUSIONS))(
  'E5: emergency %s never calls the model or shows the disclaimer',
  async (emergencyType) => {
    const result = await generateConclusion(
      { ...state(), severity: 'emergency', emergencyType },
      profile
    );
    expect(callTextAi).not.toHaveBeenCalled();
    expect(result.isEmergency).toBe(true);
    expect(result.disclaimer).toBeUndefined();
    expect(result.conclusionVersion).toBeUndefined();
    expect(result.aiNotice).toBe(
      require('../../src/i18n/locales/vi.json')['checkin.conclusion.ai_notice']
    );
  }
);

test('E10: a relative’s metadata cannot replace the patient’s form of address', async () => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const result = await generateConclusion(state(), { age: 81, gender: 'Nữ' }, 'vi', null, {
    caregiver: { age: 31, gender: 'Nam' },
    caregiverProfile: { age: 31, gender: 'Nam' },
  });
  expect(result.personalMessage).toMatch(/Bà|bà/);
  expect(result.personalMessage).not.toMatch(/\banh\b/i);
  expect(result.closeMessage).toContain('bà');
});

test.each([
  ['Ngủ ko ngon giấc'],
  ['Mệt mỏi', 'Khó ngủ', 'Ăn không ngon', 'Đau nhức người', 'Buồn bã'],
])('AC-1: the original SRS case %j retains safe six-block fallback', async (...symptoms) => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const result = await generateConclusion(state(symptoms), {
    ...profile,
    medical_conditions: ['Mỡ máu cao'],
  });
  const aiText = [
    result.personalMessage,
    result.explanation,
    ...result.todo,
    ...result.seeDoctorWhen,
  ].join(' ');
  expect(aiText).not.toMatch(/cấp cứu|chẩn đoán/i);
  expect(result.explanation).toContain('Mỡ máu cao');
  expect(result.closeMessage).toContain('3 giờ');
});
