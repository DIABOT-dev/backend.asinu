const {
  documentedFacts,
  reconcileMissingData,
  unsupportedDocumentedClaims,
} = require('../src/services/integrations/doctor-documented-facts');

const context = (...messages) => ({
  conversation: messages.map((message) => ({ role: 'patient', message })),
});
const missing = [
  'Chưa có danh sách thuốc đang dùng hoặc xác nhận không dùng thuốc.',
  'Chưa có thông tin dị ứng.',
  'Chưa có tiền sử dùng thuốc trước đây.',
];

test('uses an explicit patient denial, while retaining allergy and past medication gaps', () => {
  const value = context('Em chưa uống thuốc gì cả, cũng không có bệnh nền.');
  expect(reconcileMissingData(value, missing)).toEqual(missing.slice(1));
});

test.each(['Chưa uống thuốc giảm đau.', 'Em không nhớ đang dùng thuốc gì.', 'Em chưa đi khám.'])(
  'does not turn missing or narrower information into a complete medication denial: %s',
  (message) => {
    expect(reconcileMissingData(context(message), missing)).toEqual(missing);
  }
);

test('a later medication update supersedes the earlier no-medicine statement', () => {
  expect(
    documentedFacts(context('Em chưa uống thuốc gì cả.', 'Giờ em đang dùng thuốc theo đơn.'))
      .noCurrentMedicines
  ).toBe(false);
});

test('doctor questions cannot establish patient facts', () => {
  const value = {
    conversation: [
      { role: 'doctor', message: 'Em không buồn nôn và không dùng thuốc đúng không?' },
    ],
  };
  expect(documentedFacts(value)).toEqual({
    noCurrentMedicines: false,
    noNausea: false,
    painAfterMeals: false,
  });
});

test('keeps nausea unknown when only vomiting was denied and rejects fabricated post-meal pain', () => {
  const value = context(
    'Em đau âm ỉ quanh rốn. Ăn xong thì thấy đầy bụng.',
    'Em không sốt, chưa nôn.'
  );
  expect(
    unsupportedDocumentedClaims(value, {
      clinical_summary: 'Không sốt, không buồn nôn. Đau xuất hiện/tăng sau ăn.',
    })
  ).toHaveLength(2);
  expect(
    unsupportedDocumentedClaims(value, {
      clinical_summary: 'Đau quanh rốn. Đầy bụng sau ăn. Không sốt, chưa nôn.',
    })
  ).toEqual([]);
});

test('accepts explicit symptom negatives and a documented meal/pain relation', () => {
  const value = context('Em không buồn nôn. Cứ sau khi ăn thì đau bụng.');
  expect(
    unsupportedDocumentedClaims(value, { clinical_summary: 'Không buồn nôn. Đau bụng sau ăn.' })
  ).toEqual([]);
});

test('an unambiguous short answer can deny nausea but uncertainty cannot', () => {
  const value = {
    conversation: [
      { role: 'doctor', message: 'Em có buồn nôn không?' },
      { role: 'patient', message: 'Không ạ.' },
    ],
  };
  expect(documentedFacts(value).noNausea).toBe(true);
  value.conversation[1].message = 'Em không rõ có buồn nôn không.';
  expect(documentedFacts(value).noNausea).toBe(false);
});

test.each([33, 36])('does not derive or invent exact age %i from a birth year alone', (age) => {
  const value = { ...context('Em đau bụng.'), profile: { birth_year: 1990 } };
  expect(
    unsupportedDocumentedClaims(value, { clinical_summary: `Bệnh nhân nam, ${age} tuổi.` })
  ).toHaveLength(1);
  expect(
    unsupportedDocumentedClaims(value, { clinical_summary: 'Bệnh nhân sinh năm 1990.' })
  ).toEqual([]);
});

test('accepts an explicitly documented age instead of borrowing another number in the conversation', () => {
  const value = context('Em 33 tuổi, đau bụng 3 ngày.');
  expect(
    unsupportedDocumentedClaims(value, { soap_note: { subjective: 'Bệnh nhân 33 tuổi.' } })
  ).toEqual([]);
  expect(
    unsupportedDocumentedClaims(value, { clinical_summary: 'Bệnh nhân 3 tuổi.' })
  ).toHaveLength(1);
});

test.each([
  'No fever, nausea, or vomiting.',
  'No fever or nausea.',
  'Không sốt, buồn nôn hoặc nôn.',
])('rejects an unsupported nausea denial hidden in a coordinated list: %s', (summary) => {
  expect(
    unsupportedDocumentedClaims(context('Không sốt, chưa nôn.'), { clinical_summary: summary })
  ).toHaveLength(1);
});

test('rejects an invented positive nausea statement but leaves explicit uncertainty intact', () => {
  expect(
    unsupportedDocumentedClaims(context('Không sốt, chưa nôn.'), {
      clinical_summary: 'Không sốt nhưng có buồn nôn.',
    })
  ).toHaveLength(1);
  expect(
    unsupportedDocumentedClaims(context('Không sốt, chưa nôn.'), {
      clinical_summary: 'Chưa rõ có buồn nôn không.',
    })
  ).toEqual([]);
});

test.each([
  { clinical_summary: 'Bệnh nhân có buồn nôn.' },
  { clinical_summary: 'Đau bụng tăng sau ăn và đầy bụng.' },
  { soap_note: { assessment: 'Bệnh nhân không buồn nôn.' } },
  { patient_reply: 'Em 33 tuổi và không buồn nôn.' },
  { clinical_rationale: 'Bệnh nhân có buồn nôn.' },
])('all factual fields are checked, including mixed meal/fullness phrasing: %j', (output) => {
  expect(
    unsupportedDocumentedClaims(context('Em đau quanh rốn. Sau ăn đầy bụng. Em chưa nôn.'), output)
      .length
  ).toBeGreaterThan(0);
});

test('a general medication denial is not established by an ambiguous multi-topic short reply', () => {
  const value = {
    conversation: [
      { role: 'doctor', message: 'Em đang dùng thuốc gì và có dị ứng thuốc không?' },
      { role: 'patient', message: 'Không ạ.' },
    ],
  };
  expect(documentedFacts(value).noCurrentMedicines).toBe(false);
});

test('nausea and vomiting remain distinct when the specialist asks both at once', () => {
  const value = {
    conversation: [
      { role: 'doctor', message: 'Em có buồn nôn và nôn không?' },
      { role: 'patient', message: 'Không ạ.' },
    ],
  };
  expect(documentedFacts(value).noNausea).toBe(false);
});

test('explicit positives, questions and conditional safety advice remain usable', () => {
  expect(
    unsupportedDocumentedClaims(context('Em có buồn nôn.'), {
      clinical_summary: 'Bệnh nhân có buồn nôn.',
    })
  ).toEqual([]);
  expect(
    unsupportedDocumentedClaims(context('Em chưa nôn.'), {
      patient_reply: 'Em có buồn nôn không? Nếu có buồn nôn hoặc đau tăng, em cần nhắn lại.',
    })
  ).toEqual([]);
});

test('uncertainty about the cause does not erase an explicitly reported symptom', () => {
  expect(
    unsupportedDocumentedClaims(context('Em không biết tại sao lại buồn nôn.'), {
      clinical_summary: 'Bệnh nhân có buồn nôn.',
    })
  ).toEqual([]);
  expect(
    unsupportedDocumentedClaims(context('Em không chắc có buồn nôn không.'), {
      clinical_summary: 'Bệnh nhân có buồn nôn.',
    })
  ).toHaveLength(1);
});

test('uncertainty about the illness does not erase a separate explicit medication denial', () => {
  expect(
    documentedFacts(context('Em không rõ vì sao bị đau. Em chưa uống thuốc gì cả.'))
      .noCurrentMedicines
  ).toBe(true);
});

test.each([
  'Em chưa uống thuốc gì cả, cũng chưa biết mình dị ứng thuốc nào.',
  'I am not taking any medicines, I am unsure about allergies.',
])('an unknown allergy does not erase an explicit current medication denial: %s', (message) => {
  expect(reconcileMissingData(context(message), missing)).toEqual(missing.slice(1));
});

test('uncertain medication information and later positive use remain unresolved by a separate allergy clause', () => {
  expect(
    documentedFacts(context('Em không nhớ đang uống thuốc gì, chưa biết mình dị ứng thuốc nào.'))
      .noCurrentMedicines
  ).toBe(false);
  expect(
    documentedFacts(
      context(
        'Em chưa uống thuốc gì cả, chưa biết dị ứng thuốc nào.',
        'Sau đó em có uống thuốc giảm đau.'
      )
    ).noCurrentMedicines
  ).toBe(false);
});
