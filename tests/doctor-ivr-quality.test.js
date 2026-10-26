const {
  questionIssues,
  asksForMoreInformation,
  applyReportQuality,
  reportFlags,
} = require('../src/services/doctor-ivr/content-quality');
const {
  validateQuestionSet,
  materializeGeneratedQuestions,
} = require('../src/services/doctor-ivr/question-set.schema');

const question = (text, labels) => ({
  text,
  options: labels.map((label) => ({ label, type: 'option' })),
});
const compact = () => ({
  title: 'Hỏi thêm về giấc ngủ',
  questions: [
    question('Bác có thường trằn trọc lúc mới lên giường không?', [
      'Thường xuyên',
      'Thỉnh thoảng',
      'Không',
    ]),
    question('Buổi sáng bác có làm việc thường ngày được không?', [
      'Vẫn làm như thường',
      'Cần nghỉ rồi làm tiếp',
      'Không làm được',
    ]),
    question('Trước giờ ngủ bác có uống trà không?', ['Có', 'Không']),
  ].map(({ text, options }) => ({ text, options: options.map(({ label }) => ({ label })) })),
});

describe('meaningful single-choice questions', () => {
  test('rejects combined context questions even if the choices are only Yes and No', () => {
    expect(
      questionIssues(
        question('Bác có thay đổi sinh hoạt hoặc dùng thuốc mới không?', ['Có', 'Không'])
      )
    ).toContain('compound_question');
  });
  test('does not hide two independent symptoms behind one yes/no answer', () => {
    expect(
      questionIssues(question('Bác có thấy mờ mắt hoặc chóng mặt kèm theo không?', ['Có', 'Không']))
    ).toContain('multiple_symptoms');
    expect(
      questionIssues(question('Bác có chóng mặt khi đau đầu không?', ['Có', 'Không']))
    ).toEqual([]);
  });
  test('rejects repeated purposes rather than turning one topic into several near-identical questions', () => {
    expect(() =>
      materializeGeneratedQuestions({
        title: 'Hỏi thêm',
        questions: [
          {
            focus: 'symptom',
            text: 'Bác có trằn trọc khi lên giường không?',
            answer_kind: 'yes_no',
          },
          { focus: 'symptom', text: 'Bác có hay thức giấc giữa đêm không?', answer_kind: 'yes_no' },
        ],
      })
    ).toThrow('focus khác nhau');
  });
  test('builds concrete choices and continuous numeric ranges from a compact AI plan', () => {
    const set = materializeGeneratedQuestions(
      {
        title: 'Thông tin cần hỏi thêm',
        questions: [
          {
            focus: 'symptom',
            text: 'Bác có buồn nôn không?',
            answer_kind: 'yes_no',
            suggested_red_flag_keys: [1],
          },
          {
            focus: 'impact',
            text: 'Cơn đau ảnh hưởng sinh hoạt của bác thế nào?',
            answer_kind: 'impact',
          },
          {
            text: 'Cơn đau kéo dài bao lâu mỗi lần?',
            focus: 'course',
            answer_kind: 'numeric',
            unit: 'giờ',
            thresholds: [1, 4],
          },
        ],
      },
      'Bác'
    );
    const validated = validateQuestionSet(set);
    expect(validated.questions[0].options.map((o) => o.label)).toEqual([
      'Có',
      'Không',
      'Khác, nói câu trả lời',
    ]);
    expect(validated.questions[0].options[0]).toMatchObject({ suggested_red_flag: true });
    expect(validated.questions[0].options[0].red_flag).toBeUndefined();
    expect(validated.questions[1].options[0].label).toBe('Vẫn sinh hoạt như thường');
    expect(validated.questions[1].text).toBe(
      'Tình trạng này ảnh hưởng đến sinh hoạt của bác thế nào?'
    );
    expect(validated.questions[2].options[0].range).toMatchObject({
      min: null,
      max: 1,
      include_max: false,
    });
    expect(validated.questions[2].options[1].range).toMatchObject({
      min: 1,
      max: 4,
      include_min: true,
      include_max: false,
    });
    expect(validated.questions[2].options[2].range).toMatchObject({
      min: 4,
      max: null,
      include_min: true,
    });
  });
  test('never silently repairs an unordered numeric plan or ambiguous custom choices', () => {
    const value = {
      title: 'Thông tin cần hỏi',
      questions: [
        {
          text: 'Mỗi lần đau kéo dài bao lâu?',
          focus: 'course',
          answer_kind: 'numeric',
          unit: 'giờ',
          thresholds: [4, 1],
        },
      ],
    };
    expect(() => materializeGeneratedQuestions(value)).toThrow('thresholds tăng dần');
    value.questions[0].thresholds = [1, 4];
    value.questions[0].suggested_red_flag_keys = [4];
    expect(() => materializeGeneratedQuestions(value)).toThrow('đáp án có thật');
  });
  test('recognizes unknown answers even when the model omits the metadata', () => {
    const value = compact();
    value.questions[2].options.push({ label: 'Không rõ' });
    const validated = validateQuestionSet(materializeGeneratedQuestions(value, 'Bác'));
    expect(
      validated.questions[2].options.find((option) => option.label === 'Không rõ').unknown
    ).toBe(true);
  });
  test('rejects an open symptom list even when only one option is in the known symptom dictionary', () => {
    expect(
      questionIssues(
        question('Ngoài đau đầu, bác có triệu chứng nào khác không?', [
          'Buồn nôn hoặc nôn',
          'Nhạy cảm với ánh sáng',
          'Không có',
        ])
      )
    ).toContain('multiple_symptoms');
  });
  test('duration questions need numeric metadata for checking overlaps and gaps too', () => {
    const value = compact();
    value.questions[0] = {
      text: 'Cơn đau kéo dài bao lâu mỗi lần?',
      options: [{ label: 'Dưới 1 giờ' }, { label: '1 đến 4 giờ' }, { label: 'Hơn 4 giờ' }],
    };
    expect(() => validateQuestionSet(materializeGeneratedQuestions(value, 'Bác'))).toThrow(
      'Câu hỏi số đo'
    );
  });
  test('also rejects vague impact labels prefixed with Có', () => {
    expect(
      questionIssues(
        question('Buổi sáng bác có làm việc được không?', [
          'Có, ảnh hưởng nhiều',
          'Có, ảnh hưởng ít',
          'Không',
        ])
      )
    ).toContain('vague_impact');
  });
  test.each([
    [
      question('Bác có gặp các triệu chứng sau không?', [
        'Đau đầu',
        'Chóng mặt',
        'Tim đập nhanh',
        'Không có',
      ]),
      'multiple_symptoms',
    ],
    [
      question('Bác thường khó ngủ theo cách nào?', [
        'Khó vào giấc',
        'Thức giấc giữa đêm',
        'Thức sớm',
        'Khó ngủ cả ba cách',
      ]),
      'combined_options',
    ],
    [
      question('Giấc ngủ ảnh hưởng sinh hoạt của bác thế nào?', [
        'Ảnh hưởng nhiều',
        'Ảnh hưởng ít',
        'Không ảnh hưởng',
      ]),
      'vague_impact',
    ],
  ])('rejects a known ambiguous intake question at approval, not just generation', (bad, issue) => {
    expect(questionIssues(bad)).toContain(issue);
    const value = compact();
    value.questions[0] = { text: bad.text, options: bad.options.map(({ label }) => ({ label })) };
    expect(() => validateQuestionSet(materializeGeneratedQuestions(value, 'Bác'))).toThrow();
  });
  test('allows one symptom with concrete choices and an explicitly dominant symptom question', () => {
    expect(questionIssues(question('Bác có chóng mặt không?', ['Có', 'Không']))).toEqual([]);
    expect(
      questionIssues(question('Biểu hiện nào làm bác khó chịu nhất?', ['Đau đầu', 'Chóng mặt']))
    ).toEqual([]);
    expect(validateQuestionSet(materializeGeneratedQuestions(compact(), 'Bác'))).toBeTruthy();
  });
  test('rejects repeated questions and capitalizes generated Vietnamese', () => {
    const value = compact();
    value.questions[0].text = 'bác có trằn trọc lúc mới lên giường không?';
    value.questions[0].options[0].label = 'thường xuyên';
    const set = materializeGeneratedQuestions(value, 'Bác');
    expect(set.questions[0].text).toMatch(/^Bác/u);
    expect(set.questions[0].options[0].label).toBe('Thường xuyên');
    set.questions[1].text = set.questions[0].text;
    expect(() => validateQuestionSet(set)).toThrow('Câu hỏi bị lặp');
  });
});

describe('final reply vs additional intake', () => {
  test('keeps patient replies readable in the native text component without Markdown markers', () => {
    const report = applyReportQuality(
      { completion: 'full' },
      {
        summary: 'Đã nhận thông tin.',
        draft_reply: '### Theo dõi\n- **Ghi lại giờ nghỉ** trong ngày.',
      }
    );
    expect(report.draft_reply).toBe('Theo dõi\n• Ghi lại giờ nghỉ trong ngày.');
  });
  test.each([
    'Bác có thể chia sẻ thêm về giờ ngủ không ạ?',
    'Vui lòng trả lời về giờ ngủ của bác.',
    'Bác cho bác sĩ biết giờ thức dậy.',
  ])('does not present an additional question as a final result: %s', (draft) => {
    const report = applyReportQuality(
      { completion: 'full', insufficient: false },
      { summary: 'Đã nhận câu trả lời.', draft_reply: draft }
    );
    expect(report.needs_follow_up).toBe(true);
    expect(report.draft_reply).toBe('');
    expect(report.follow_up_reason).toBeTruthy();
    expect(asksForMoreInformation(draft)).toBe(true);
  });
  test('keeps useful non-question drafts and respects an explicit missing-information decision', () => {
    const generated = {
      summary: 'Thông tin người bệnh cung cấp.',
      draft_reply: 'Bác hãy ghi lại giờ ngủ và giờ thức để theo dõi thay đổi trong những ngày tới.',
    };
    expect(applyReportQuality({ completion: 'full' }, generated).draft_reply).toBe(
      generated.draft_reply
    );
    expect(applyReportQuality({ completion: 'partial' }, generated).draft_reply).toBe('');
    const missing = applyReportQuality(
      { completion: 'full' },
      {
        ...generated,
        needs_follow_up: true,
        follow_up_reason: 'Chưa rõ điều bệnh nhân muốn được hỗ trợ.',
      }
    );
    expect(missing.follow_up_reason).toContain('Chưa rõ');
    expect(missing.draft_reply).toBe('');
  });
});

test('deduplicates repeated alerts and preserves revised alerts separately without losing the audit history', () => {
  const content = {
    questions: [
      {
        id: 'q1',
        text: 'Câu hỏi',
        options: [
          { id: 'a', label: 'Có' },
          { id: 'b', label: 'Không' },
        ],
      },
    ],
  };
  const events = [
    { question_id: 'q1', label: 'Có' },
    { question_id: 'q1', label: 'Có' },
  ];
  const current = reportFlags(
    events,
    [{ question_id: 'q1', option_id: 'a', is_red_flag: true }],
    content
  );
  expect(current.red_flags).toHaveLength(1);
  const revised = reportFlags(
    events,
    [{ question_id: 'q1', option_id: 'b', is_red_flag: false }],
    content
  );
  expect(revised.red_flags).toHaveLength(0);
  expect(revised.red_flag_history).toHaveLength(1);
  expect(events).toHaveLength(2);
});
