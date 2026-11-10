'use strict';

const { conclusionSpeech } = require('../../src/core/checkin/triage-conclusion-speech');
const { adaptSavedConclusion } = require('../../src/core/checkin/triage-conclusion-narrative');

test.each(['vi', 'en'])(
  'narrative %s audio includes the entire result and the final advice after 1600 characters',
  (lang) => {
    const paragraphs = Array.from({ length: 100 }, (_, index) =>
      lang === 'vi'
        ? `Đây là lời giải thích và việc nên làm thứ ${index}.`
        : `This is explanation and practical action number ${index}.`
    );
    const result = {
      isDone: true,
      conclusionVersion: 2,
      conclusionFormat: 'narrative',
      severity: 'medium',
      narrative: paragraphs.join('\n\n'),
      disclaimer: 'Thông tin tham khảo.',
      closeMessage: 'Hẹn gặp lại.',
      aiNotice: 'Asinu là AI.',
      speechText: paragraphs[0],
    };
    const original = structuredClone(result);
    const refreshed = adaptSavedConclusion(result);
    expect(refreshed.narrative).toBe(result.narrative);
    expect(refreshed.speechText).toBe(
      [...paragraphs, result.disclaimer, result.closeMessage, result.aiNotice].join(' ')
    );
    expect(refreshed.speechText.length).toBeGreaterThan(1600);
    expect(refreshed.speechText).toContain(paragraphs[99]);
    expect(result).toEqual(original);
  }
);

test('structured audio reads explanations, every practical action and every warning in display order', () => {
  const result = {
    personalMessage: 'Personal message.',
    explanation: 'Complete explanation.',
    todo: ['First action.', 'Final action.'],
    seeDoctorWhen: ['First warning.', 'Final warning.'],
    disclaimer: 'Disclaimer.',
    closeMessage: 'Follow up.',
    aiNotice: 'AI notice.',
  };
  expect(conclusionSpeech(result)).toBe(
    'Personal message. Complete explanation. First action. Final action. First warning. Final warning. Disclaimer. Follow up. AI notice.'
  );
});

test('markdown markers are removed while headings, decimals and final content remain readable', () => {
  expect(
    conclusionSpeech({
      conclusionFormat: 'narrative',
      narrative:
        '## Kết quả\n\nĐường huyết **6.4 mmol/L**.\n- Việc đầu.\n2. Việc cuối.\n[Xem hướng dẫn](https://example.invalid)',
      closeMessage: 'Hẹn gặp lại.',
    })
  ).toBe('Kết quả Đường huyết 6.4 mmol/L. Việc đầu. Việc cuối. Xem hướng dẫn Hẹn gặp lại.');
});

test('a repeated fixed AI notice is not appended twice', () => {
  const result = {
    conclusionFormat: 'narrative',
    narrative: 'Kết quả đầy đủ. Asinu là AI.',
    aiNotice: 'Asinu là AI.',
  };
  expect(conclusionSpeech(result).match(/Asinu là AI\./g)).toHaveLength(1);
});
