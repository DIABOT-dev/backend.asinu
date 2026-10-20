const {
  resolveCommunicationStyle,
  addressQuestionTemplate,
  communicationConflict,
} = require('../src/services/integrations/doctor-communication-style');
const {
  resolveClarifyingQuestions,
} = require('../src/services/integrations/doctor-question-planner');

const now = new Date('2026-10-20T08:00:00Z');
const context = (messages, profile = {}) => {
  const conversation = messages.map(([role, message]) => ({ role, message }));
  return {
    profile,
    conversation,
    latest_patient_message: conversation.findLast((turn) => turn.role === 'patient'),
  };
};
const styleOf = (value, options) => resolveCommunicationStyle(value, { now, ...options });

test.each([
  [{ birth_year: 1958, gender: 'female' }, 'bác'],
  [{ birth_year: 1986, gender: 'Nam' }, 'anh'],
  [{ birth_year: 1991, gender: 'female' }, 'chị'],
  [{ birth_year: 2014, gender: 'male' }, 'em'],
  [{ birth_year: 1991, gender: 'other' }, 'bạn'],
  [{ gender: 'female' }, 'bạn'],
  [{ birth_year: 0, gender: 'male' }, 'bạn'],
  [{ birth_year: 2030, gender: 'male' }, 'bạn'],
])(
  'uses documented demographic data only when conversation has no established address: %j',
  (profile, term) => {
    const result = styleOf(context([['patient', 'Tôi đau bụng từ sáng nay.']], profile));
    expect(result.patient_address).toBe(term);
    expect(result.clinician_self).toBe('tôi');
  }
);

test('continues the consultant and patient forms of address instead of recalculating them from profile', () => {
  const result = styleOf(
    context(
      [
        ['doctor', 'Em hỏi thêm chút. Cô đau ở vùng nào của bụng ạ?'],
        ['patient', 'Quanh rốn.'],
      ],
      { birth_year: 1958, gender: 'female' }
    )
  );
  expect(result).toMatchObject({
    patient_address: 'cô',
    clinician_self: 'em',
    source: 'conversation',
  });
});

test('retains direct address inside a sentence instead of only at its beginning', () => {
  const result = styleOf(
    context(
      [
        ['doctor', 'Cơn đau có làm chị mất ngủ không?'],
        ['patient', 'Có, tối qua khó ngủ.'],
      ],
      { birth_year: 1986, gender: 'male' }
    )
  );
  expect(result.patient_address).toBe('chị');
});

test('the latest explicit patient preference overrides earlier forms of address', () => {
  const result = styleOf(
    context(
      [
        ['doctor', 'Bác có buồn nôn không?'],
        ['patient', 'Cứ gọi tôi là chị nhé. Không buồn nôn.'],
      ],
      { birth_year: 1958, gender: 'female' }
    )
  );
  expect(result).toMatchObject({ patient_address: 'chị', source: 'patient_preference' });
});

test('retains an established address beyond twelve messages', () => {
  const result = styleOf(
    context([
      ['doctor', 'Cháu hỏi thêm. Bác đau ở đâu ạ?'],
      ...Array.from({ length: 30 }, (_, i) => [
        i % 2 ? 'doctor' : 'patient',
        i % 2 ? 'Cơn đau có liên tục không?' : 'Có ạ.',
      ]),
      ['patient', 'Vẫn như vậy.'],
    ])
  );
  expect(result).toMatchObject({ patient_address: 'bác', clinician_self: 'cháu' });
});

test.each(['Đừng gọi tôi là bác.', 'Không cần gọi tôi là bác.', 'Gọi tôi là bác sĩ.'])(
  'does not turn a rejected address or clinician title into a patient preference: %s',
  (message) => {
    const result = styleOf(
      context([
        ['doctor', 'Chị đau ở đâu?'],
        ['patient', message],
      ])
    );
    expect(result.patient_address).toBe('chị');
    expect(result.source).toBe('conversation');
  }
);

test('does not treat a patient greeting to a doctor as evidence that the patient is an elderly person', () => {
  const result = styleOf(context([['patient', 'Chào bác sĩ, tôi đau bụng từ sáng nay.']]));
  expect(result.patient_address).toBe('bạn');
});

test('does not infer the speaker age or gender from a name', () => {
  expect(
    styleOf(context([['patient', 'Tôi tên Anh, muốn hỏi về sức khỏe.']])).patient_address
  ).toBe('bạn');
});

test('uses patient self-reference when the consultant has not established a different address', () => {
  expect(styleOf(context([['patient', 'Dạ em đau bụng từ sáng nay.']])).patient_address).toBe('em');
});

test.each([
  'Em hỏi giúp mẹ, mẹ đau bụng từ sáng nay.',
  'Tôi hỏi cho bố tôi.',
  'Mẹ tôi đang đau bụng từ sáng nay.',
])('does not address a caregiver using the patient profile: %s', (message) => {
  const result = styleOf(context([['patient', message]], { birth_year: 1950, gender: 'female' }));
  expect(result.caregiver).toBe(true);
  expect(result.patient_address).not.toBe('bác');
});

test('still follows the specialist established address to the caregiver', () => {
  const result = styleOf(
    context(
      [
        ['patient', 'Tôi hỏi cho mẹ tôi.'],
        ['doctor', 'Anh đã đo nhiệt độ cho mẹ chưa?'],
        ['patient', 'Đã đo rồi.'],
      ],
      { birth_year: 1950, gender: 'female' }
    )
  );
  expect(result).toMatchObject({ patient_address: 'anh', caregiver: true });
});

test('ignores automated scheduling messages as address evidence', () => {
  const current = context([['patient', 'Tôi đau bụng.']], { birth_year: 1958 });
  current.conversation.push({
    role: 'doctor',
    sender_ref: 'doctor-sla-worker',
    message: 'Bạn đang được ưu tiên.',
  });
  expect(styleOf(current).patient_address).toBe('bác');
});

test('the fallback safety questions follow the same address as model questions', () => {
  const current = context([
    ['doctor', 'Em hỏi thêm. Bác thấy thế nào?'],
    ['patient', 'Đau đầu từ sáng nay.'],
  ]);
  const questions = resolveClarifyingQuestions({ context: current, generated: [] });
  expect(questions.join(' ')).not.toMatch(/bạn/iu);
  expect(questions.join(' ')).toContain('bác');
});

test('mandatory safety questions concern the relative rather than the caregiver', () => {
  const current = context([
    ['patient', 'Tôi hỏi cho mẹ, mẹ đau đầu tăng dần từ hôm qua.'],
    ['doctor', 'Chị ơi, mẹ có sốt hay nôn không?'],
    ['patient', 'Không có hai dấu hiệu đó ạ.'],
  ]);
  const questions = resolveClarifyingQuestions({ context: current, generated: [] }).join(' ');
  expect(questions).toContain('mẹ có');
  expect(questions).not.toContain('chị có');
  expect(questions).not.toContain('nôn');
});

test('only code-owned templates are reformatted and the original conversation stays intact', () => {
  const current = context([['patient', 'Tôi đau bụng.']], { birth_year: 1991, gender: 'female' });
  const before = JSON.stringify(current);
  expect(addressQuestionTemplate('Bạn đang cần mình hỗ trợ điều gì?', styleOf(current))).toBe(
    'Chị đang cần tôi hỗ trợ điều gì?'
  );
  expect(JSON.stringify(current)).toBe(before);
});

test('detects a changed addressee, changed specialist self-reference and reversed speaker roles', () => {
  const style = { locale: 'vi', patient_address: 'bác', clinician_self: 'em' };
  expect(communicationConflict('Bạn có buồn nôn không?', style)).toBe(true);
  expect(communicationConflict('Ngoài đau bụng, chị có buồn nôn không?', style)).toBe(true);
  expect(communicationConflict('Tôi hỏi thêm, bác có sốt không?', style)).toBe(true);
  expect(communicationConflict('Bác sĩ cho em hỏi thêm được không?', style)).toBe(true);
  expect(communicationConflict('Em có buồn nôn không?', style)).toBe(true);
  expect(communicationConflict('Có buồn nôn không chị?', style)).toBe(true);
  expect(communicationConflict('Em hỏi thêm. Bác có buồn nôn không ạ?', style)).toBe(false);
});

test('does not confuse third-party people or the word bác sĩ with direct address', () => {
  const style = { locale: 'vi', patient_address: 'anh', clinician_self: 'tôi' };
  expect(communicationConflict('Mẹ của anh có sốt không?', style)).toBe(false);
  expect(communicationConflict('Bạn của anh đã đưa mẹ đi khám chưa?', style)).toBe(false);
  expect(communicationConflict('Bác sĩ đã khám cho mẹ anh khi nào?', style)).toBe(false);
});

test('English requests retain English forms of address', () => {
  const style = styleOf(context([['patient', 'I have abdominal pain.']], { birth_year: 1958 }), {
    locale: 'en',
  });
  expect(style).toMatchObject({ patient_address: 'you', clinician_self: 'I' });
  expect(addressQuestionTemplate('Have you tried anything?', style)).toBe(
    'Have you tried anything?'
  );
});
