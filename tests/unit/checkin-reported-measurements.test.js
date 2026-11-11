'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { buildConclusionFacts } = require('../../src/core/checkin/triage-conclusion');
const { measurementFault } = require('../../src/core/checkin/triage-conclusion-guards');
const {
  generateNarrativeConclusion,
} = require('../../src/core/checkin/triage-conclusion-narrative');

function state() {
  return {
    allSymptoms: ['Tê bàn chân phải'],
    currentSymptoms: ['Tê bàn chân phải'],
    completedSteps: new Set(['red_flags']),
    redFlagsFound: [],
    actionsFound: [],
    severity: 'medium',
    needsDoctor: true,
    compactAssessment: {
      answers: [
        { question: 'Hôm nay chú đã đo đường huyết chưa?', answer: 'Đã đo' },
        { question: 'Chú đo được bao nhiêu?', answer: '6.4' },
        { question: 'Đơn vị và giờ đo?', answer: 'mmol/L, đo lúc 7:00 hôm nay' },
      ],
      measurements: {
        duong_huyet: {
          status: 'reported',
          code: 'reading_available',
          value: 'Đã đo',
          evidence: { answerIndex: 0, quote: 'Đã đo' },
        },
      },
      measurementReplies: {
        duong_huyet: {
          status: 'reported',
          value: '6.4 mmol/L, đo lúc 7:00 hôm nay',
          parts: [
            { value: '6.4', evidence: { answerIndex: 1, quote: '6.4' } },
            {
              value: 'mmol/L, đo lúc 7:00 hôm nay',
              evidence: { answerIndex: 2, quote: 'mmol/L, đo lúc 7:00 hôm nay' },
            },
          ],
        },
      },
    },
  };
}
const profile = { age: 56, gender: 'Nam', medical_conditions: ['Tiểu đường'] };
const facts = () => buildConclusionFacts(state(), profile);

test('a reading supplied in answer parts stays separate from stored vital logs with its actual evidence', () => {
  const result = facts();
  expect(result.chi_so_24h).toEqual([]);
  expect(result.chi_so_tu_khai).toMatchObject([
    {
      loai: 'duong_huyet',
      gia_tri: '6.4',
      don_vi: 'mmol/L',
      is_today: true,
      source: 'user_report',
    },
  ]);
  expect(result.chi_so_tu_khai[0]).not.toHaveProperty('measured_at');
  expect(result.chi_so_tu_khai[0].evidence.map((e) => e.quote)).toEqual([
    '6.4',
    'mmol/L, đo lúc 7:00 hôm nay',
  ]);
});

test.each([
  'Chú cho biết đường huyết 6.4 mmol/L lúc 7:00 hôm nay.',
  'Chú vừa cung cấp đường huyết 6,4 mmol/L lúc 7 giờ hôm nay.',
  'Chú cho biết đường huyết 6.4 mmol/L.',
])(
  'the actual reported value can be acknowledged without pretending it is a diary record: %s',
  (text) => {
    expect(measurementFault(text, facts())).toBeNull();
  }
);

test.each([
  ['Chú cho biết đường huyết 8.4 mmol/L lúc 7:00 hôm nay.', 'ungrounded_measurement'],
  ['Chú cho biết đường huyết 6.4 mg/dL lúc 7:00 hôm nay.', 'ungrounded_measurement'],
  ['Chú cho biết đường huyết 6.4 mmol/L lúc 8:00 hôm nay.', 'measurement_time_not_exact'],
  ['Chú cho biết đường huyết 6.4 mmol/L lúc 8 giờ hôm nay.', 'measurement_time_not_exact'],
  ['Chú cho biết đường huyết 6.4 mmol/L ngày 12/11/2026.', 'measurement_time_not_exact'],
  ['Đường huyết của chú đang bình thường.', 'unmeasured_vital_claim'],
  ['Đường huyết của chú vẫn ổn định.', 'insufficient_comparison_data'],
])(
  'reporting does not authorise a different number, time, unit or clinical interpretation: %s',
  (text, fault) => {
    expect(measurementFault(text, facts())).toBe(fault);
  }
);

test('a tampered composed value cannot replace the actual quoted answer parts', () => {
  const value = state();
  value.compactAssessment.measurementReplies.duong_huyet.value = '8.4 mmol/L';
  expect(buildConclusionFacts(value, profile).chi_so_tu_khai).toBeUndefined();
});

test('a complete result retains the supplied reading even if the model omitted it', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú có kể bàn chân phải bị tê. Chú nên theo dõi các thay đổi và đi khám trong vài ngày tới.',
    finishReason: 'stop',
  });
  const result = await generateNarrativeConclusion(state(), profile);
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).toContain(
    'vừa cho biết đường huyết đo được 6.4 mmol/L lúc 7:00 hôm nay'
  );
});
