'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const {
  buildConclusionFacts,
  validateBlock,
  generateStructuredConclusion,
} = require('../../src/core/checkin/triage-conclusion');
const now = new Date('2026-10-29T08:00:00Z');
const profile = { age: 52, gender: 'Nam', medical_conditions: [] };
const state = {
  allSymptoms: ['khó ngủ'],
  redFlagsFound: [],
  actionsFound: [],
  completedSteps: new Set(['red_flags']),
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
};
const bp = (s, d, h) => ({ systolic: s, diastolic: d, occurred_at: `2026-10-29T0${h}:00:00Z` });
const glucose = (value, h) => ({ value, unit: 'mmol/L', occurred_at: `2026-10-29T0${h}:00:00Z` });
const facts = (context = {}, override = {}) =>
  buildConclusionFacts({ ...state, ...override }, profile, context, 'vi', now);
const pair = () => facts({ recentBP: [bp(128, 82, 6), bp(130, 84, 5)], tookMedicationToday: true });

test('measurement year must match the actual century', () => {
  expect(
    validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/1926.', pair())
  ).toBeTruthy();
  expect(
    validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/2126.', pair())
  ).toBeTruthy();
});
test('two measurements cannot borrow each other’s timestamps', () => {
  expect(
    validateBlock(
      'lien_quan',
      'Huyết áp 128/82 mmHg lúc 12:00 ngày 29/10/26. Huyết áp 130/84 mmHg lúc 13:00 ngày 29/10/26.',
      pair()
    )
  ).toBeTruthy();
});
test('a glucose label cannot use a BP value/unit', () => {
  expect(
    validateBlock('lien_quan', 'Đường huyết 128 mmHg lúc 13:00 ngày 29/10/26.', pair())
  ).toBeTruthy();
});
test('one BP record cannot borrow two glucose records to claim BP stability', () => {
  const f = facts({
    recentBP: [bp(128, 82, 6)],
    recentGlucose: [glucose(6.4, 5), glucose(6.5, 4)],
  });
  expect(validateBlock('lien_quan', 'Huyết áp vẫn ổn định.', f)).toBeTruthy();
});
test('negated assessment never satisfies a required referral', () => {
  expect(
    validateBlock('di_kham_khi', ['Chú không cần đi khám.', 'Nếu đau ngực thì gọi 115.'], pair())
  ).toBeTruthy();
});
test('scheduled assessment cannot be replaced with an unconditional same-day instruction', () => {
  expect(
    validateBlock('di_kham_khi', ['Chú nên đi khám hôm nay.', 'Nếu đau ngực thì gọi 115.'], pair())
  ).toBeTruthy();
});
test('a conditional clause elsewhere cannot hide an unconditional emergency call', () => {
  expect(
    validateBlock(
      'di_kham_khi',
      ['Chú nên đi khám trong vài ngày tới.', 'Nếu khó ngủ thêm, hãy đi khám. Gọi 115 ngay.'],
      pair()
    )
  ).toBeTruthy();
});
test('a mild sleep complaint is not a condition to call 115', () => {
  expect(
    validateBlock(
      'di_kham_khi',
      ['Chú nên đi khám trong vài ngày tới.', 'Nếu không ngủ được tối nay, gọi 115 ngay.'],
      pair()
    )
  ).toBeTruthy();
});
test.each([
  'Chú ngừng uống thuốc đã kê.',
  'Chú ngừng dùng thuốc theo đơn đã có.',
  'Chú tăng liều đang dùng.',
])('administration verbs cannot hide treatment change: %s', (text) => {
  expect(validateBlock('nen_lam', [text, 'Ghi giờ ngủ.'], pair())).toBeTruthy();
});
test('passive wording cannot invent successful family notification', () => {
  expect(
    validateBlock('loi_nhan', 'Người thân đã được thông báo về tình trạng của chú.', pair())
  ).toBeTruthy();
});
test('a different verb cannot create an AI follow-up schedule', () => {
  expect(validateBlock('loi_nhan', 'Cháu sẽ nhắn lại cho chú sau 2 giờ.', pair())).toBeTruthy();
});
test('missing numbers cannot become a current vital assertion', () => {
  expect(validateBlock('lien_quan', 'Huyết áp của chú cao.', facts())).toBeTruthy();
  expect(validateBlock('lien_quan', 'Blood pressure remains stable.', facts())).toBeTruthy();
});
test('literal punctuation in a custom condition never crashes the fallback', async () => {
  callTextAi.mockRejectedValueOnce(new Error('synthetic offline'));
  const output = await generateStructuredConclusion(state, {
    ...profile,
    medical_conditions: ['Bệnh hiếm ABC (ghi thêm'],
  });
  expect(output.conclusionVersion).toBe(2);
  expect(output.explanation).toContain('Bệnh hiếm ABC (ghi thêm');
});
test('prediabetes is not authorization for the model to declare diabetes', () => {
  const f = buildConclusionFacts(
    state,
    { ...profile, medical_conditions: ['Tiền tiểu đường'] },
    {},
    'vi',
    now
  );
  expect(validateBlock('lien_quan', 'Chú có tiểu đường nên cần chú ý sinh hoạt.', f)).toBeTruthy();
});
test('safe comparison keeps each exact value, unit and timestamp', () => {
  expect(
    validateBlock(
      'lien_quan',
      'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/26, so với lần trước 130/84 mmHg lúc 12:00 ngày 29/10/26.',
      pair()
    )
  ).toBeNull();
});
test('relative measurement dates agree with the server clock around Vietnam midnight', () => {
  const f = buildConclusionFacts(
    state,
    profile,
    { recentBP: [{ systolic: 128, diastolic: 82, occurred_at: '2026-10-28T16:30:00Z' }] },
    'vi',
    new Date('2026-10-28T18:00:00Z')
  );
  expect(
    validateBlock('lien_quan', 'Huyết áp hôm nay là 128/82 mmHg lúc 23:30 ngày 28/10/2026.', f)
  ).toBeTruthy();
  expect(
    validateBlock('lien_quan', 'Huyết áp hôm qua là 128/82 mmHg lúc 23:30 ngày 28/10/2026.', f)
  ).toBeNull();
});
test('a single recorded BP does not establish stability without the word still', () => {
  const f = facts({ recentBP: [bp(128, 82, 6)] });
  expect(validateBlock('lien_quan', 'Huyết áp của chú ổn định.', f)).toBeTruthy();
  expect(
    validateBlock('lien_quan', 'Việc giữ huyết áp ổn định cũng cần được quan tâm.', f)
  ).toBeNull();
});
test('two current vital categories with separate explicit timestamps remain readable', () => {
  const f = facts({ recentBP: [bp(128, 82, 6)], recentGlucose: [glucose(6.4, 5)] });
  expect(
    validateBlock(
      'lien_quan',
      'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/26 và đường huyết 6.4 mmol/L lúc 12:00 ngày 29/10/26.',
      f
    )
  ).toBeNull();
});
test('a leading timestamp before a comma still belongs to its own numerical reading', () => {
  expect(
    validateBlock(
      'lien_quan',
      'Cháu thấy lúc 13:00 ngày 29/10/26, huyết áp của chú là 128/82 mmHg.',
      pair()
    )
  ).toBeNull();
});
test('a relative date is allowed only when it unambiguously matches the server date', () => {
  expect(
    validateBlock('lien_quan', 'Hôm nay lúc 13:00, huyết áp của chú là 128/82 mmHg.', pair())
  ).toBeNull();
  expect(
    validateBlock('lien_quan', 'Hôm qua lúc 13:00, huyết áp của chú là 128/82 mmHg.', pair())
  ).toBeTruthy();
  expect(
    validateBlock(
      'lien_quan',
      'Hôm nay lúc 13:00 ngày 29/10/1926, huyết áp là 128/82 mmHg.',
      pair()
    )
  ).toBeTruthy();
});
test('conditional chest pressure with sweating is not rejected as a mild sleep complaint', () => {
  expect(
    validateBlock(
      'di_kham_khi',
      [
        'Chú nên đi khám trong vài ngày tới.',
        'Nếu tức ngực kèm vã mồ hôi, chóng mặt, chú gọi 115.',
      ],
      pair()
    )
  ).toBeNull();
});
test('formatting characters cannot hide unsafe output', () => {
  expect(validateBlock('lien_quan', 'Cháu chẩn\u200b đoán chú bị bệnh.', facts())).toBeTruthy();
});
test('a conditional referral in either sentence order remains conditional', () => {
  const f = facts({}, { needsDoctor: false, severity: 'low' });
  expect(
    validateBlock(
      'di_kham_khi',
      ['Chú đi khám nếu triệu chứng kéo dài.', 'Nếu đau ngực, gọi 115.'],
      f
    )
  ).toBeNull();
});
test('ordinary known conditions and sleep guidance are not rejected by substrings', () => {
  expect(
    validateBlock('lien_quan', 'Đau lưng thường liên quan đến tư thế sinh hoạt.', facts())
  ).toBeNull();
});

test('2160 systematic value/date/type variations never borrow a valid field from another assertion', () => {
  const f = facts({ recentBP: [bp(128, 82, 6)] });
  let checked = 0;
  for (const label of ['Huyết áp', 'Blood pressure', 'Đường huyết', 'Blood glucose'])
    for (const systolic of [127, 128, 129])
      for (const diastolic of [81, 82, 83])
        for (const clock of ['13:00', '12:00', '00:00', '25:00', '13:01'])
          for (const date of ['29/10', '28/10', '01/11', '29/11'])
            for (const year of ['26', '2026', '1926']) {
              const text = `${label} ${systolic}/${diastolic} mmHg lúc ${clock} ngày ${date}/${year}.`;
              const valid =
                ['Huyết áp', 'Blood pressure'].includes(label) &&
                systolic === 128 &&
                diastolic === 82 &&
                clock === '13:00' &&
                date === '29/10' &&
                year !== '1926';
              expect(validateBlock('lien_quan', text, f) === null).toBe(valid);
              checked++;
            }
  expect(checked).toBe(2160);
});
