'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const logger = require('../../src/lib/logger');
const {
  generateStructuredConclusion,
  buildConclusionFacts,
  buildConclusionPrompt,
} = require('../../src/core/checkin/triage-conclusion');
const { conclusionLanguageFault } = require('../../src/core/checkin/triage-conclusion-contract');
const state = {
  allSymptoms: ['khó ngủ'],
  onset: 'vài ngày nay',
  progression: 'same',
  completedSteps: new Set(['red_flags']),
  redFlagsFound: [],
  actionsFound: [],
  severity: 'low',
  needsDoctor: false,
  followUpHours: 6,
};
const profile = { age: 52, gender: 'Nam', medical_conditions: [] };
const english = () => ({
  loi_nhan: 'Poor sleep has bothered you for a few days. I understand this is uncomfortable.',
  lien_quan:
    'Sleep and daily routines can affect how you feel. A simple diary can help you describe changes.',
  nen_lam: [
    'Record 2 details: when discomfort starts and when it changes.',
    'Keep a regular bedtime.',
  ],
  di_kham_khi: [
    'If poor sleep disrupts daily activities, seek an assessment.',
    'If symptoms worsen, speak with a health expert.',
  ],
});
const aiBlocks = (output) => [
  output.personalMessage,
  output.explanation,
  ...output.todo,
  ...output.seeDoctorWhen,
];
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockResolvedValue({ content: JSON.stringify(english()) });
});

test('E8: English output stays unchanged when source facts were stored in Vietnamese', async () => {
  const result = await generateStructuredConclusion(state, profile, 'en');
  expect(result.personalMessage).toBe(english().loi_nhan);
  expect(result.explanation).toBe(english().lien_quan);
  expect(result.todo).toEqual(english().nen_lam);
  expect(result.seeDoctorWhen).toEqual(english().di_kham_khi);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(callTextAi.mock.calls[0][0].prompt).toContain('OUTPUT LANGUAGE: ENGLISH');
  expect(callTextAi.mock.calls[0][0].system).toContain('Write English only');
});

test('E8: Vietnamese model prose is rejected per block even if the provider ignored English instructions', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      loi_nhan: 'Tôi hiểu bạn đang khó ngủ. Tôi mong bạn sớm dễ chịu nhé.',
      lien_quan: 'Giấc ngủ ảnh hưởng đến sinh hoạt. Theo dõi thay đổi giúp mình hiểu rõ hơn.',
      nen_lam: [
        'Record 2 details: when discomfort starts and when it changes.',
        'Hãy giữ giờ ngủ đều đặn.',
      ],
      di_kham_khi: [
        'Nếu khó ngủ ảnh hưởng sinh hoạt, bạn nên đi khám.',
        'Nếu mệt hơn, bạn nên đi khám.',
      ],
    }),
  });
  const result = await generateStructuredConclusion(state, profile, 'en');
  expect(aiBlocks(result).join(' ')).not.toMatch(/[À-ỹ]/u);
  expect(result.disclaimer).toContain('Asinu’s advice');
  expect(result.closeMessage).toContain('6 hours');
  expect(logger.warn.mock.calls.filter(([event]) => event === 'conclusion_rejected')).toHaveLength(
    4
  );
  for (const [, rejection] of logger.warn.mock.calls)
    expect(rejection.reason).toBe('wrong_output_language');
});

test('E4 / E8: one mixed-language action replaces only the action block', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...english(),
      nen_lam: [...english().nen_lam, 'Bạn nên nghỉ ngơi.'],
    }),
  });
  const result = await generateStructuredConclusion(state, profile, 'en');
  expect(result.personalMessage).toBe(english().loi_nhan);
  expect(result.explanation).toBe(english().lien_quan);
  expect(result.seeDoctorWhen).toEqual(english().di_kham_khi);
  expect(result.todo.join(' ')).not.toMatch(/[À-ỹ]/u);
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'nen_lam',
    reason: 'wrong_output_language',
  });
});

test.each([
  ['Mỡ máu cao', 'high cholesterol'],
  ['Tiểu đường', 'diabetes'],
  ['Cao huyết áp', 'hypertension'],
  ['Tiền tiểu đường', 'prediabetes'],
])(
  'English fallback translates the recorded condition %s without changing its meaning',
  async (condition, label) => {
    callTextAi.mockRejectedValue(new Error('offline'));
    const result = await generateStructuredConclusion(
      state,
      { ...profile, medical_conditions: [condition] },
      'en'
    );
    expect(result.explanation).toContain(label);
    expect(aiBlocks(result).join(' ')).not.toMatch(/[À-ỹ]/u);
  }
);

test('a custom condition label may be quoted but cannot authorize surrounding Vietnamese prose', () => {
  const facts = { language: 'en', benh_nen_da_khai: ['Bệnh hiếm (ABC)'] };
  expect(conclusionLanguageFault('You reported Bệnh hiếm (ABC).', facts)).toBeNull();
  expect(conclusionLanguageFault('Bạn đã khai Bệnh hiếm (ABC).', facts)).toBe(
    'wrong_output_language'
  );
  expect(conclusionLanguageFault('Toi hieu ban kho ngu.', facts)).toBe('wrong_output_language');
});

test('Vietnamese presentation remains valid and English generation carries an explicit language fact', () => {
  const facts = buildConclusionFacts(state, profile, {}, 'en');
  expect(facts.language).toBe('en');
  expect(buildConclusionPrompt(facts, 'en')).toContain(
    'Translate Vietnamese source facts into English'
  );
  expect(
    conclusionLanguageFault('Cháu hiểu chú đang khó ngủ.', { ...facts, language: 'vi' })
  ).toBeNull();
});

test('Vietnamese requests cannot accept fully English model prose', async () => {
  const result = await generateStructuredConclusion(state, profile, 'vi');
  expect(result.personalMessage).not.toBe(english().loi_nhan);
  expect(result.explanation).not.toBe(english().lien_quan);
  expect(result.todo).not.toEqual(english().nen_lam);
  expect(result.seeDoctorWhen).not.toEqual(english().di_kham_khi);
  expect(logger.warn.mock.calls.filter(([event]) => event === 'conclusion_rejected')).toHaveLength(
    4
  );
  expect(result.closeMessage).toContain('6 giờ');
});

test('an English action inside an otherwise Vietnamese result replaces only that block', async () => {
  const vietnamese = {
    loi_nhan: 'Chú khó ngủ vài ngày nay và vẫn như cũ. Cháu hiểu chú đang mệt nhé.',
    lien_quan:
      'Giấc ngủ ảnh hưởng đến cảm giác mệt. Nếp sinh hoạt đều đặn giúp mình theo dõi thay đổi.',
    nen_lam: ['Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.', 'Keep a regular bedtime.'],
    di_kham_khi: [
      'Nếu khó ngủ ảnh hưởng sinh hoạt, chú nên đi khám.',
      'Nếu tình trạng nặng hơn, chú nên đi khám.',
    ],
  };
  callTextAi.mockResolvedValue({ content: JSON.stringify(vietnamese) });
  const result = await generateStructuredConclusion(state, profile, 'vi');
  expect(result.personalMessage).toBe(vietnamese.loi_nhan);
  expect(result.explanation).toBe(vietnamese.lien_quan);
  expect(result.seeDoctorWhen).toEqual(vietnamese.di_kham_khi);
  expect(result.todo).not.toContain('Keep a regular bedtime.');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'nen_lam',
    reason: 'wrong_output_language',
  });
});

test('known English condition labels and ordinary Vietnamese prose are not mistaken for English advice', () => {
  const facts = { language: 'vi', benh_nen_da_khai: ['High cholesterol'] };
  expect(
    conclusionLanguageFault('Chú đã khai High cholesterol. Chú ghi lại giờ ngủ nhé.', facts)
  ).toBeNull();
  expect(conclusionLanguageFault('Ghi 2 moc gio: luc kho chiu va luc thay doi.', facts)).toBeNull();
  expect(conclusionLanguageFault('High cholesterol. Please monitor your symptoms.', facts)).toBe(
    'wrong_output_language'
  );
});
