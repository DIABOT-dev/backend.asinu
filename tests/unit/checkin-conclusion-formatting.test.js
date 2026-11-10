'use strict';
const {
  normalizeMeasurementSentences,
  normalizeConditionalWarnings,
  conditionalWarningMissingAction,
  validatePresentation,
} = require('../../src/core/checkin/triage-conclusion-contract');
const {
  validateBlock,
  buildConclusionFacts,
  buildConclusionPrompt,
  buildConclusionSystem,
} = require('../../src/core/checkin/triage-conclusion');
const state = {
  allSymptoms: ['đau đầu nhẹ'],
  completedSteps: new Set(['red_flags']),
  actionsFound: [],
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
};
const facts = buildConclusionFacts(
  state,
  { age: 52, gender: 'Nam', medical_conditions: ['Cao huyết áp'] },
  {
    recentBP: [
      { systolic: 128, diastolic: 82, occurred_at: '2026-10-29T06:00:00Z' },
      { systolic: 130, diastolic: 84, occurred_at: '2026-10-29T05:00:00Z' },
    ],
  },
  'vi',
  new Date('2026-10-29T08:00:00Z')
);
const raw =
  'Theo dõi huyết áp giúp mình hiểu rõ thay đổi. Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/26, còn lúc 12:00 ngày 29/10/26 là 130/84 mmHg.';
test.each([
  ['vi', 'Nếu cô thấy đau đầu tăng lên nhiều.', 'Hãy đi khám nếu cô thấy đau đầu tăng lên nhiều.'],
  ['vi', 'Khi chú cảm thấy chóng mặt hơn', 'Hãy đi khám khi chú cảm thấy chóng mặt hơn.'],
  [
    'vi',
    'Trong trường hợp cô không ăn uống được.',
    'Hãy đi khám trong trường hợp cô không ăn uống được.',
  ],
  ['en', 'If your symptoms worsen.', 'Seek an assessment if your symptoms worsen.'],
  [
    'en',
    'When poor sleep affects your daily life.',
    'Seek an assessment when poor sleep affects your daily life.',
  ],
])('complete %s warning fragments without changing their trigger', (lang, raw, complete) => {
  const input = Object.freeze([raw]);
  const output = normalizeConditionalWarnings(input, lang);
  expect(output).toEqual([complete]);
  expect(input).toEqual([raw]);
  expect(conditionalWarningMissingAction(raw)).toBe(true);
  expect(conditionalWarningMissingAction(complete)).toBe(false);
  expect(validatePresentation('di_kham_khi', [raw], { ...facts, language: lang })).toBe(
    'conditional_warning_missing_action'
  );
  expect(validatePresentation('di_kham_khi', output, { ...facts, language: lang })).toBeNull();
});
test.each([
  'Nếu đau ngực không hết, hãy gọi 115.',
  'Nếu khó chịu kéo dài, chú đi khám sớm hơn nhé.',
  'Nếu mệt hơn, hãy nghỉ ngơi.',
  'Nếu mệt hơn thì chú hãy nghỉ ngơi.',
  'Nếu cô lo lắng, liên hệ bác sĩ.',
  'If chest pain persists, call 115.',
  'When symptoms worsen, contact your doctor.',
  'If you feel unwell, you should rest.',
  'Please arrange an assessment today.',
])('preserve already complete actions, including 115: %s', (text) => {
  expect(normalizeConditionalWarnings([text])).toEqual([text]);
  expect(conditionalWarningMissingAction(text)).toBe(false);
});
test('warning completion leaves malformed data for the existing block validator', () => {
  for (const input of [null, 'Nếu mệt hơn.', undefined])
    expect(normalizeConditionalWarnings(input)).toBe(input);
  expect(normalizeConditionalWarnings([null, 1, ''])).toEqual([null, 1, '']);
});
test.each(['tu_theo_doi', 'dat_lich_kham', 'kham_trong_ngay'])(
  'a completed conditional warning does not replace or upgrade care level %s',
  (careLevel) => {
    const direct =
      careLevel === 'tu_theo_doi'
        ? []
        : [
            careLevel === 'kham_trong_ngay'
              ? 'Chú nên đi khám hôm nay.'
              : 'Chú nên đi khám trong vài ngày tới.',
          ];
    const warnings = normalizeConditionalWarnings([...direct, 'Nếu chú thấy khó chịu nặng hơn.']);
    expect(
      validateBlock('di_kham_khi', [...warnings, 'Nếu khó thở, hãy gọi 115.'].slice(0, 3), {
        ...facts,
        care_level: careLevel,
      })
    ).toBeNull();
    expect(warnings.at(-1)).not.toMatch(/hôm nay|ngay|115/);
  }
);
test('V3: completing a warning keeps safety checks and accepts a natural longer sentence', () => {
  const warnings = normalizeConditionalWarnings([
    'Nếu chú thấy khó chịu sau khi dùng aspirin.',
    'Nếu khó thở, hãy gọi 115.',
  ]);
  expect(validateBlock('di_kham_khi', warnings, { ...facts, care_level: 'tu_theo_doi' })).toBe(
    'drug_name_or_class'
  );
  const long = 'Nếu ' + 'mệt '.repeat(23).trim() + '.';
  const output = normalizeConditionalWarnings([long]);
  expect(output[0]).toContain('Hãy đi khám nếu');
  expect(validatePresentation('di_kham_khi', output, facts)).toBeNull();
});
test('comparison formatting preserves every word/value while giving each record its own scope', () => {
  const formatted = normalizeMeasurementSentences(raw);
  const tokens = (text) => text.toLowerCase().match(/[\p{L}\p{N}/:]+/gu);
  expect(tokens(formatted)).toEqual(tokens(raw));
  expect(validateBlock('lien_quan', formatted, facts)).toBeNull();
});
test.each([
  raw.replace('lúc 13:00', 'lúc 12:00').replace('còn lúc 12:00', 'còn lúc 13:00'),
  raw.replace('29/10/26 là', '29/10/2126 là'),
  raw.replace('lúc 12:00 ngày', 'ngày'),
  raw.replace('130/84 mmHg', '6.4 mmol/L'),
])('formatting cannot repair an incorrect number/date/unit or borrow a missing time', (text) => {
  expect(validateBlock('lien_quan', normalizeMeasurementSentences(text), facts)).toBeTruthy();
});
test('prompt retains historical comparison data only when there is a current same-type reading', () => {
  const oldOnly = {
    ...facts,
    chi_so_24h: [],
    chi_so_7_ngay: [{ ...facts.chi_so_24h[0], gia_tri: '133/87' }],
  };
  expect(buildConclusionPrompt(oldOnly)).not.toContain('133/87');
  expect(oldOnly.chi_so_7_ngay[0].gia_tri).toBe('133/87');
  expect(buildConclusionPrompt({ ...oldOnly, chi_so_24h: facts.chi_so_24h })).toContain('133/87');
});
test('patient-specific prompt requires both useful diary and the correct measured metric', () => {
  const prompt = buildConclusionPrompt(facts);
  expect(prompt).toContain('Ghi 2 mốc giờ');
  expect(prompt).toContain('Đo lại huyết áp và ghi giờ đo.');
  expect(prompt).toContain('chú nên đi khám trong vài ngày tới.');
  expect(buildConclusionSystem(facts)).toContain('người bạn đồng hành sức khỏe ấm áp');
  expect(buildConclusionSystem(facts)).not.toContain('never exceed 25');
});
test('acknowledging unknown medication records is not a medication instruction or a claim of nonadherence', () => {
  expect(
    validateBlock(
      'lien_quan',
      'Giấc ngủ có thể ảnh hưởng tới cảm giác mệt. Cháu chưa có thông tin về việc cô uống thuốc hôm nay.',
      facts
    )
  ).toBeNull();
});
test.each([
  'Cháu chưa có thông tin về việc cô uống thuốc hôm nay. Cô hãy dùng thuốc bổ.',
  'Cháu chưa có thông tin về việc cô uống thuốc hôm nay, cô hãy dùng thuốc bổ.',
  'Các triệu chứng liên quan đến việc cô chưa ghi nhận uống thuốc hôm nay.',
])('unknown-medication wording cannot hide an instruction or invented cause', (text) => {
  expect(validateBlock('lien_quan', text, facts)).toBeTruthy();
});

test('an exact acknowledgment with the recorded person after the medication phrase is not an instruction', () => {
  const text =
    'Ho và đau họng có thể liên quan đến nhiều yếu tố. Cháu không có thông tin về việc dùng thuốc hôm nay của cô.';
  expect(validateBlock('lien_quan', text, facts)).toBeNull();
  expect(validateBlock('lien_quan', text + ' Cô hãy dùng thuốc bổ.', facts)).toBeTruthy();
  expect(
    validateBlock('lien_quan', text, { ...facts, uong_thuoc_hom_nay: 'đã có bản ghi uống thuốc' })
  ).toBeTruthy();
});

test('V3 includes current and comparable historical readings as facts without prescribing an explanation sentence', () => {
  const withHistory = {
    ...facts,
    chi_so_7_ngay: [
      {
        ...facts.chi_so_24h[0],
        gia_tri: '141/91',
        measured_at: '2026-10-27T06:00:00Z',
        luc: '13:00 27/10/26',
      },
    ],
  };
  const originalFacts = JSON.stringify(withHistory);
  const prompt = buildConclusionPrompt(withHistory);
  const supplied = JSON.parse(prompt.split('FACTS=')[1].split('\n')[0]);
  expect(supplied.chi_so_24h).toEqual(withHistory.chi_so_24h);
  expect(supplied.chi_so_7_ngay).toEqual(withHistory.chi_so_7_ngay);
  expect(supplied.evaluated_at).toBeUndefined();
  expect(prompt).not.toContain('Use ONE sentence');
  expect(JSON.stringify(withHistory)).toBe(originalFacts);
});

test.each(['vi', 'en'])(
  'V3 %s is open-ended but retains the two safety boundaries and the four-field contract',
  (lang) => {
    const system = buildConclusionSystem(facts, lang);
    const prompt = buildConclusionPrompt(facts, lang);
    expect(system).toContain(
      lang === 'vi'
        ? 'đừng nêu tên thuốc, liều hay chỉnh điều trị'
        : 'never name a medicine, dose or treatment change'
    );
    expect(system).toContain(
      lang === 'vi'
        ? 'đừng nói người bệnh mắc một bệnh mà họ chưa khai'
        : 'never tell the person they have an illness they did not report'
    );
    for (const key of ['loi_nhan', 'lien_quan', 'nen_lam', 'di_kham_khi'])
      expect(prompt).toContain(key);
    expect(prompt).toContain('2-3');
    expect(prompt).not.toMatch(/FIRST item MUST|VÍ DỤ|EXACT reading sentences/);
  }
);

test('V3 accepts a three-sentence personal message while keeping unsafe medical content blocked', () => {
  const message =
    'Chú lại khó ngủ từ hôm qua. Cháu hiểu chú đang mệt. Mình cùng theo dõi hôm nay nhé.';
  expect(validatePresentation('loi_nhan', message, facts)).toBeNull();
  expect(validateBlock('loi_nhan', message, facts)).toBeNull();
  expect(validateBlock('loi_nhan', message + ' Chú hãy dùng aspirin.', facts)).toBe(
    'drug_name_or_class'
  );
});

test.each(['see', 'consult', 'contact', 'speak to', 'talk with'])(
  'V3 English referral can say %s a health expert without changing its care level',
  (verb) => {
    const warnings = [
      `Please ${verb} a health expert today.`,
      'If symptoms worsen, contact a health expert.',
    ];
    expect(
      validateBlock('di_kham_khi', warnings, {
        ...facts,
        language: 'en',
        care_level: 'kham_trong_ngay',
      })
    ).toBeNull();
    expect(
      validateBlock('di_kham_khi', warnings, {
        ...facts,
        language: 'en',
        care_level: 'tu_theo_doi',
      })
    ).toBe('upgraded_care_level');
  }
);
