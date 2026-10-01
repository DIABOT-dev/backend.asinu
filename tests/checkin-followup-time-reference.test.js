const { formatQuestion } = require('../src/core/checkin/triage-ai-layer');

describe('check-in follow-up time references', () => {
  test('does not describe a same-day follow-up as yesterday', () => {
    const result = formatQuestion(
      {
        step: 'followup_status',
        previousSessionSummary: 'đau đầu và chóng mặt',
        options: ['đã đỡ nhiều', 'vẫn như cũ', 'mệt hơn trước'],
      },
      {
        full_name: 'Nguyễn Văn An',
        birth_year: 1960,
        gender: 'Nam',
      }
    );

    expect(result.question).toContain('lần check-in trước');
    expect(result.question).toContain('Bây giờ');
    expect(result.question.toLowerCase()).not.toContain('hôm qua');
  });
});
