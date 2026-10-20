const { gradeDialogueResult } = require('../src/services/integrations/doctor-dialogue-evaluation');

test('allows a first greeting and detects a repeated greeting after the consultant already replied', () => {
  const result = { text: 'Chào chị, chị khó ngủ bao lâu rồi?', grounded: true };
  expect(
    gradeDialogueResult({ expected: {}, turns: [['patient', 'Tôi khó ngủ.']] }, result)
  ).toEqual([]);
  expect(
    gradeDialogueResult(
      {
        expected: {},
        turns: [
          ['patient', 'Tôi khó ngủ.'],
          ['doctor', 'Chị khó ngủ từ khi nào?'],
          ['patient', 'Hôm qua.'],
        ],
      },
      result
    )
  ).toContain('repeated_greeting');
});

test('checks source grounding and subject independently of style', () => {
  const failures = gradeDialogueResult(
    { expected: { subject: 'relative', speaker: 'caregiver' }, turns: [] },
    {
      text: 'Mẹ có sốt không chị?',
      understanding: { subject: 'self', speaker: 'patient' },
      grounded: false,
    }
  );
  expect(failures).toEqual([
    'subject_not_grounded',
    'speaker_not_grounded',
    'missing_grounded_understanding',
  ]);
});

test('does not count reopening a declined conversation as a successful evaluation', () => {
  expect(
    gradeDialogueResult(
      { expected: { closing: true }, turns: [] },
      { text: 'Chị đau từ khi nào?', understanding: { next_action: 'ask' }, grounded: true }
    )
  ).toContain('reopened_closed_conversation');
});
