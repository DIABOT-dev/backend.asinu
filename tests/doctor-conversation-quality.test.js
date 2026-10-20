const {
  planClarifyingQuestions,
  resolveClarifyingQuestions,
  buildGroundingFacts,
  buildAnsweredQuestionEvidence,
  conversationIntent,
  repeatedDurationQuestion,
} = require('../src/services/integrations/doctor-question-planner');
const { __test__ } = require('../src/services/integrations/doctor-ai.service');

const conversation = (...messages) =>
  messages.map((message, index) => ({
    id: String(index + 1),
    role: index % 2 ? 'doctor' : 'patient',
    message,
  }));
const followUpContext = () => ({
  conversation: conversation(
    'Tôi nặng đầu sau giờ làm 3 ngày nay.',
    'Cơn đau có đột ngột không, có yếu hoặc tê một bên, khó nói hay nhìn mờ không?',
    'Không đột ngột, chỉ âm ỉ. Không yếu, không tê, không khó nói, không nhìn mờ, không lú lẫn, không cứng gáy, không nôn, không ngất. Tôi ngủ 5 giờ mỗi đêm.'
  ),
  latest_patient_message: {
    message:
      'Không đột ngột, chỉ âm ỉ. Không yếu, không tê, không khó nói, không nhìn mờ, không lú lẫn, không cứng gáy, không nôn, không ngất. Tôi ngủ 5 giờ mỗi đêm.',
  },
  profile: {},
  medications: [],
  blood_pressure: [],
  glucose: [],
  missing_data: [],
  conflicts: [],
});

describe('Doctor conversational question planning', () => {
  test('answered-question evidence excludes a prior complaint, uncertainty and measurement timing', () => {
    const context = {
      conversation: conversation(
        'Tôi ho 3 ngày nay.',
        'Cơn ho kéo dài bao lâu?',
        'Ba ngày ạ.',
        'Bạn còn cần trao đổi điều gì?',
        'Giờ tôi đau bụng.',
        'Bạn đau ở vùng nào của bụng?',
        'Tôi chưa rõ. Tôi đã đo huyết áp sáng nay 120/80.'
      ),
      latest_patient_message: {
        message: 'Tôi chưa rõ. Tôi đã đo huyết áp sáng nay 120/80.',
      },
    };
    expect(buildAnsweredQuestionEvidence(context)).toEqual([]);
  });

  test('understands a short denial as an answer to the preceding specialist question', () => {
    const context = {
      conversation: conversation(
        'Tôi đau đầu 3 ngày nay.',
        'Cơn đau có đột ngột không? Bạn có yếu hoặc tê một bên, khó nói hay nhìn mờ không?',
        'Không có các dấu hiệu đó ạ.'
      ),
      latest_patient_message: { message: 'Không có các dấu hiệu đó ạ.' },
    };
    const questions = planClarifyingQuestions({ context }).join(' ');
    expect(questions).not.toMatch(/đột ngột|yếu hoặc tê|khó nói|nhìn mờ|từ khi nào/);
    expect(questions).toContain('lú lẫn');
  });

  test('does not infer an answer from uncertainty or an unanswered specialist question', () => {
    const context = {
      conversation: conversation(
        'Tôi đau đầu.',
        'Bạn có yếu hoặc tê một bên, khó nói hay nhìn mờ không?',
        'Tôi không biết, chưa rõ ạ.'
      ),
      latest_patient_message: { message: 'Tôi không biết, chưa rõ ạ.' },
    };
    expect(planClarifyingQuestions({ context }).join(' ')).toContain('yếu hoặc tê');
  });

  test('a yes to one sign is not asked again, while a yes to a list asks which sign', () => {
    const context = {
      conversation: conversation('Tôi đau đầu.', 'Bạn có nhìn mờ không?', 'Có ạ.'),
      latest_patient_message: { message: 'Có ạ.' },
    };
    expect(planClarifyingQuestions({ context }).join(' ')).not.toContain('nhìn mờ');
    context.conversation[1].message = 'Bạn có yếu hoặc tê một bên, khó nói hay nhìn mờ không?';
    const questions = planClarifyingQuestions({ context });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('dấu hiệu nào');
    context.conversation[1].message = 'Bạn có yếu một bên không? Bạn có nhìn mờ không?';
    expect(planClarifyingQuestions({ context })[0]).toContain('dấu hiệu nào');
  });

  test('retains an early patient answer beyond the previous twelve-message window', () => {
    const context = followUpContext();
    context.conversation.push(
      ...Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 ? 'patient' : 'doctor',
        message: i % 2 ? 'Tôi đang trao đổi tiếp về tình trạng này.' : 'Bạn nói tiếp nhé.',
      }))
    );
    context.latest_patient_message = { message: context.conversation.at(-1).message };
    expect(planClarifyingQuestions({ context }).join(' ')).not.toMatch(
      /từ khi nào|đột ngột|khó nói/
    );
  });

  test('an automated reminder is not a specialist response or a reason to stop drafting', () => {
    const context = {
      conversation: [
        { role: 'patient', message: 'Tôi đau bụng từ sáng nay.' },
        {
          role: 'doctor',
          sender_ref: 'doctor-sla-worker',
          message: 'Ca tư vấn của bạn đang được ưu tiên xử lý.',
        },
      ],
      latest_patient_message: { message: 'Tôi đau bụng từ sáng nay.' },
    };
    expect(conversationIntent(context)).toBe('clinical');
    expect(planClarifyingQuestions({ context }).length).toBeGreaterThan(0);
  });

  test('preserves safe topic-specific AI questions instead of replacing them with generic templates', () => {
    const context = {
      conversation: conversation('Tôi đau bụng từ sáng nay.'),
      latest_patient_message: { message: 'Tôi đau bụng từ sáng nay.' },
    };
    const generated = ['Bạn đau ở vùng nào của bụng?', 'Cơn đau liên tục hay từng cơn?'];
    expect(resolveClarifyingQuestions({ context, generated })).toEqual(generated);
  });

  test('does not repeat the preceding question after the patient gave a short contextual answer', () => {
    const context = {
      conversation: conversation(
        'Tôi đau bụng từ sáng nay.',
        'Bạn đau ở vùng nào của bụng?',
        'Quanh rốn ạ.'
      ),
      latest_patient_message: { message: 'Quanh rốn ạ.' },
    };
    const result = resolveClarifyingQuestions({
      context,
      generated: ['Bạn đau ở vùng nào của bụng?', 'Cơn đau liên tục hay từng cơn?'],
    });
    expect(result).not.toContain('Bạn đau ở vùng nào của bụng?');
    expect(result).toContain('Cơn đau liên tục hay từng cơn?');
  });

  test('uses earlier patient answers instead of restarting the interview on a short follow-up', () => {
    const questions = planClarifyingQuestions({ context: followUpContext(), locale: 'vi' });
    expect(questions).toHaveLength(2);
    expect(questions.join(' ')).toContain('huyết áp');
    expect(questions.join(' ')).toContain('nghỉ ngơi');
    expect(questions.join(' ')).not.toMatch(/khi nào|bao lâu|đột ngột|khó nói|màn hình/);
    expect(buildGroundingFacts(followUpContext()).join(' ')).toContain('3 ngày nay');
  });

  test('a consultant question is not evidence that the patient answered it', () => {
    const context = followUpContext();
    context.conversation = conversation(
      'Tôi nặng đầu.',
      'Bạn có yếu hoặc tê, khó nói, nhìn mờ không?',
      'Tôi chưa rõ.'
    );
    context.latest_patient_message = { message: 'Tôi chưa rõ.' };
    expect(planClarifyingQuestions({ context }).join(' ')).toMatch(/yếu hoặc tê/);
  });

  test('keeps a missing numbness check when weakness alone was answered', () => {
    const context = {
      latest_patient_message: {
        message: 'Tôi đau đầu tăng dần, không yếu, không khó nói, không nhìn mờ, không lú lẫn.',
      },
    };
    const questions = planClarifyingQuestions({ context });
    expect(questions[0]).toContain('tê một bên');
    expect(questions[0]).not.toContain('yếu');
  });

  test.each([
    'Cảm ơn chuyên gia, tôi hiểu rồi ạ.',
    'Cảm ơn bác sĩ, tôi hiểu rồi ạ.',
    'Dạ vâng ạ.',
    'Thanks doctor, I understand.',
  ])('does not restart symptom questions after a closing: %s', (message) => {
    const context = { latest_patient_message: { message } };
    expect(conversationIntent(context)).toBe('acknowledgement');
    expect(planClarifyingQuestions({ context })).toEqual([]);
  });

  test('does not treat a new concern as a simple acknowledgement', () => {
    const context = {
      latest_patient_message: { message: 'Cảm ơn bác sĩ nhưng tôi vẫn thấy mệt hơn.' },
    };
    expect(conversationIntent(context)).toBe('clinical');
    expect(planClarifyingQuestions({ context }).length).toBeGreaterThan(0);
  });

  test('a greeting gets a single open question rather than a clinical checklist', () => {
    const questions = planClarifyingQuestions({
      context: { latest_patient_message: { message: 'Chào bác sĩ' } },
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('hỗ trợ');
  });

  test('keeps safe model phrasing while preserving the unanswered safety checks', () => {
    const context = {
      latest_patient_message: { message: 'Tôi đau đầu 3 ngày nay, không nhìn mờ, không lú lẫn.' },
    };
    const generated = [
      'Cơn đau đầu xuất hiện bất ngờ và dữ dội, hay tăng dần?',
      'Bạn có thấy yếu hoặc tê một bên, hay khó nói không?',
    ];
    expect(resolveClarifyingQuestions({ context, locale: 'vi', generated })).toEqual(generated);
  });

  test('replaces irrelevant, unsafe or invented model questions with the grounded plan', () => {
    const context = { latest_patient_message: { message: 'Tôi đau đầu.' } };
    const expected = planClarifyingQuestions({ context });
    expect(
      resolveClarifyingQuestions({
        context,
        generated: [
          'Bạn 45 tuổi và uống aspirin 500 mg có đỡ đau đầu không?',
          'Vui lòng cung cấp đánh giá lâm sàng toàn diện.',
        ],
      })
    ).toEqual(expected);
  });

  test('uses an available measurement instead of asking the patient to repeat it', () => {
    const context = followUpContext();
    context.blood_pressure = [{ systolic: 120, diastolic: 80 }];
    expect(planClarifyingQuestions({ context }).join(' ')).not.toContain('huyết áp');
  });

  test('catches the observed repeated onset question in a consultation draft', () => {
    expect(
      repeatedDurationQuestion({
        context: followUpContext(),
        text: 'Cảm giác nặng đầu của bạn bắt đầu từ khi nào và diễn ra như thế nào?',
      })
    ).toBe(true);
    expect(
      repeatedDurationQuestion({
        context: followUpContext(),
        text: 'Mỗi lần đau đầu kéo dài bao lâu?',
      })
    ).toBe(false);
  });

  test('does not mistake hours of sleep for symptom duration', () => {
    const context = followUpContext();
    context.conversation[0].message = 'Tôi nặng đầu sau giờ làm.';
    expect(planClarifyingQuestions({ context }).join(' ')).toContain('từ khi nào');
    expect(repeatedDurationQuestion({ context, text: 'Bạn bắt đầu đau đầu từ khi nào?' })).toBe(
      false
    );
  });

  test('does not apply the previous complaint duration to a new concern', () => {
    const context = followUpContext();
    context.conversation = conversation(
      'Tôi ho 3 ngày nay.',
      'Bạn có muốn trao đổi thêm điều gì không?',
      'Giờ tôi đau bụng.'
    );
    context.latest_patient_message = { message: 'Giờ tôi đau bụng.' };
    expect(planClarifyingQuestions({ context }).join(' ')).toContain('từ khi nào');
    expect(repeatedDurationQuestion({ context, text: 'Bạn bắt đầu đau bụng từ khi nào?' })).toBe(
      false
    );
  });

  test('a negated symptom in a short answer does not replace the active concern', () => {
    const context = followUpContext();
    const message = `${context.latest_patient_message.message} Không mệt.`;
    context.latest_patient_message = { message };
    context.conversation.at(-1).message = message;
    expect(planClarifyingQuestions({ context }).join(' ')).toContain('huyết áp');
  });
});

test('a consultation draft cannot repeat a duration already provided', () => {
  expect(() =>
    __test__.buildOutput({
      raw: { patient_reply: 'Cảm giác nặng đầu của bạn bắt đầu từ khi nào?' },
      context: followUpContext(),
      input: {
        locale: 'vi',
        touchpoint: 'consultation_draft',
        clinical_support: { knowledge_chunks: [] },
      },
      ruleFindings: [],
    })
  ).toThrow('repeats a symptom onset or duration');
});

test('a pending patient reply does not produce another outgoing draft', () => {
  const context = followUpContext();
  context.conversation.push({
    id: '4',
    role: 'doctor',
    message: 'Bạn gửi giúp chỉ số huyết áp nhé.',
  });
  const output = __test__.buildOutput({
    raw: {
      patient_reply: 'Bạn hãy trả lời các câu sau.',
      clarifying_questions: ['Câu hỏi lặp lại?'],
    },
    context,
    input: {
      locale: 'vi',
      touchpoint: 'consultation_draft',
      clinical_support: { knowledge_chunks: [] },
    },
    ruleFindings: [],
  });
  expect(output.patient_reply).toBe('');
  expect(output.clarifying_questions).toEqual([]);
  expect(output.uncertainties.join(' ')).toContain('đang chờ phản hồi');
});

test('a consultation draft cannot ask for a location just supplied in a contextual reply', () => {
  const context = {
    ...followUpContext(),
    conversation: conversation(
      'Tôi đau bụng từ sáng nay.',
      'Bạn đau ở vùng nào của bụng?',
      'Quanh rốn ạ.'
    ),
    latest_patient_message: { message: 'Quanh rốn ạ.' },
  };
  expect(() =>
    __test__.buildOutput({
      raw: { patient_reply: 'Bạn đau ở vùng nào của bụng?' },
      context,
      input: {
        locale: 'vi',
        touchpoint: 'consultation_draft',
        clinical_support: { knowledge_chunks: [] },
      },
      ruleFindings: [],
    })
  ).toThrow('already answered');
});

test.each(['Tôi thấy mệt.', 'Chào bác sĩ', 'Cảm ơn bác sĩ, tôi hiểu rồi ạ.'])(
  'rejects an empty consultation draft instead of reporting success: %s',
  (message) => {
    expect(() =>
      __test__.buildOutput({
        raw: { patient_reply: '   ' },
        context: { ...followUpContext(), conversation: [], latest_patient_message: { message } },
        input: {
          locale: 'vi',
          touchpoint: 'consultation_draft',
          clinical_support: { knowledge_chunks: [] },
        },
        ruleFindings: [],
      })
    ).toThrow('missing the required patient_reply');
  }
);

test.each([
  ['consultation_draft', { patient_reply: 'Bạn bị tăng huyết áp, dùng metformin 500 mg.' }],
  ['follow_up_draft', { follow_up_draft: 'Không cần lo, bạn chắc chắn không sao.' }],
])('rejects an unsafe %s instead of replacing it with boilerplate', (touchpoint, raw) => {
  expect(() =>
    __test__.buildOutput({
      raw,
      context: followUpContext(),
      input: { locale: 'vi', touchpoint, clinical_support: { knowledge_chunks: [] } },
      ruleFindings: [],
    })
  ).toThrow('patient-facing safety check');
});

test('conversational style never downgrades the approved urgency floor', () => {
  const output = __test__.buildOutput({
    raw: { patient_reply: 'Bạn cần liên hệ cơ sở y tế ngay để được hỗ trợ.', urgency: 'routine' },
    context: followUpContext(),
    input: {
      locale: 'vi',
      touchpoint: 'consultation_draft',
      clinical_support: { knowledge_chunks: [] },
    },
    ruleFindings: [
      {
        metric: 'systolic',
        value: 185,
        unit: 'mmHg',
        observed_at: null,
        expert_message: 'Synthetic approved urgent finding.',
        severity: 'urgent',
      },
    ],
  });
  expect(output.urgency).toBe('urgent');
  expect(output.safety_alerts).toContain('Synthetic approved urgent finding.');
});
