'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));

const { callTextAi } = require('../../src/services/ai/ai.service');
const { buildState, getNextStep } = require('../../src/core/checkin/triage-engine');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { formatQuestion, generateConclusion } = require('../../src/core/checkin/triage-ai-layer');
const {
  selectEmpathyResponse,
  generateProgressFeedback,
} = require('../../src/core/checkin/illusion-layer');
const { getHonorifics, getUserAge } = require('../../src/lib/honorifics');

const answer = (step, value) => ({ step, question: step, answer: value });
const profile = { age: 35, gender: 'Nam', full_name: 'Nguyễn Văn An' };
const initial = (answers, extra = {}) => ({
  status: 'specific_concern',
  phase: 'initial',
  previousAnswers: answers,
  profile,
  ...extra,
});

beforeEach(() => {
  callTextAi.mockReset().mockImplementation(async ({ maxTokens }) => ({
    content: JSON.stringify(
      maxTokens === 200
        ? { severity: 'mild', needsDoctor: false, needsFamilyAlert: false }
        : {
            summary: 'Có triệu chứng đi kèm và chưa có biện pháp xử lý.',
            recommendation: 'Tiếp tục theo dõi và đi khám nếu tình trạng nặng lên.',
            closeMessage: 'Đã thông báo cho người thân.',
          }
    ),
  }));
});

test('keeps the initial question sequence for a normal unchanged complaint', () => {
  const answers = [];
  for (const [step, value] of [
    ['symptoms', 'Đau đầu'],
    ['onset', 'Từ sáng'],
    ['progression', 'Vẫn như cũ'],
    ['red_flags', 'Không có'],
  ]) {
    expect(getNextStep(initial(answers))).toMatchObject({ action: 'ask', step });
    answers.push(answer(step, value));
  }
  expect(getNextStep(initial(answers))).toMatchObject({
    action: 'conclude',
    conclusion: { severity: 'low' },
  });
});

test('uses the onset and progression already supplied in the first answer', () => {
  const result = getNextStep(
    initial([answer('symptoms', 'Đau đầu từ sáng, giờ đỡ nhiều rồi')], {
      profile: { age: 70 },
      healthContext: { medical_conditions: ['cao huyết áp'] },
    })
  );
  expect(result.step).toBe('red_flags');
  expect(result.state.onset).toBe('từ sáng');
  expect(result.state.progression).toBe('better');
});

test('clarifies an unknown complaint before asking when it started', () => {
  const result = getNextStep(initial([answer('symptoms', 'Tôi không rõ nữa')]));
  expect(result).toMatchObject({ step: 'symptoms', clarification: 'symptoms' });
  expect(result.state.allSymptoms).toEqual([]);
});

test('keeps an unfamiliar complaint and the onset embedded in it', () => {
  const result = getNextStep(initial([answer('symptoms', 'Ngứa da từ sáng')]));
  expect(result.step).toBe('progression');
  expect(result.state.allSymptoms).toEqual(['Ngứa da']);
  expect(result.state.onset).toBe('từ sáng');
});

test('long free-text symptoms cannot make the next question exceed the API input limit', () => {
  const answers = [answer('symptoms', `Đau đầu ${'rất khó chịu '.repeat(120)}`)];
  const result = getNextStep(initial(answers));
  const formatted = formatQuestion(result, profile, answers);
  expect(formatted.question.length).toBeLessThanOrEqual(500);
  expect(result.state.allSymptoms[0]).toContain('rất khó chịu');
});

test('a second unknown complaint ends with explicit uncertainty and care navigation', async () => {
  const result = await getNextTriageQuestion(
    initial([answer('symptoms', 'Không rõ'), answer('symptoms', 'Không biết')])
  );
  expect(result).toMatchObject({ isDone: true, assessmentIncomplete: true, needsDoctor: true });
  expect(result.summary).toContain('chưa đủ');
  expect(result.summary).not.toContain('đủ thông tin sức');
});

test('a denied symptom is not chosen as the chief complaint', () => {
  const state = buildState([answer('symptoms', 'Tôi không đau đầu, chỉ mất ngủ')]);
  expect(state.allSymptoms).toEqual(['mất ngủ']);
  expect(state.primarySymptom).not.toBe('đau đầu');
});

test('uncertain onset does not negate an already reported complaint', () => {
  const state = buildState([answer('symptoms', 'Đau đầu không nhớ từ lúc nào')]);
  expect(state.primarySymptom).toBe('đau đầu');
  expect(state.allSymptoms).toHaveLength(1);
  expect(state.onset).toBeNull();
});

test.each([['Đau bụng, Đau đầu'], [['Đau bụng', 'Đau đầu']]])(
  'screens both selected complaints: %j',
  (value) => {
    const result = getNextStep(
      initial([
        answer('symptoms', value),
        answer('onset', 'Từ sáng'),
        answer('progression', 'Vẫn như cũ'),
      ])
    );
    expect(result.options.some((option) => /bụng/.test(option))).toBe(true);
    expect(result.options.some((option) => /đầu/.test(option))).toBe(true);
    expect(result.state.allSymptoms).toHaveLength(2);
  }
);

test('an unfamiliar symptom still has usable warning choices without AI mapping', async () => {
  const result = await getNextTriageQuestion(
    initial([
      answer('symptoms', 'Ngứa tai'),
      answer('onset', 'Từ sáng'),
      answer('progression', 'Vẫn như cũ'),
    ])
  );
  expect(result.step).toBe('red_flags');
  expect(result.options.length).toBeGreaterThan(2);
  expect(result.allowFreeText).toBe(true);
  expect(callTextAi.mock.calls.every(([request]) => request.maxTokens === 200)).toBe(true);
});

test('explicitly having no condition does not make a user vulnerable', () => {
  expect(buildState([], profile, { medical_conditions: ['Không có'] }).hasConditions).toBe(false);
});

test('an unknown warning-sign answer is not recorded as a negative screen', () => {
  const result = getNextStep(
    initial([
      answer('symptoms', 'Đau đầu'),
      answer('onset', 'Từ sáng'),
      answer('progression', 'Vẫn như cũ'),
      answer('red_flags', 'Không rõ'),
    ])
  );
  expect(result).toMatchObject({ step: 'red_flags', clarification: 'red_flags' });
  expect(result.state.completedSteps.has('red_flags')).toBe(false);
});

test('follow-up keeps the old symptom, not the literal no-new-symptoms answer', () => {
  const result = getNextStep(
    initial(
      [
        answer('followup_status', 'Vẫn như cũ'),
        answer('followup_detail', 'Không có triệu chứng mới'),
      ],
      {
        phase: 'followup',
        baselineAnswers: [answer('symptoms', 'Tiêu chảy'), answer('onset', 'Từ hôm qua')],
      }
    )
  );
  expect(result.state.allSymptoms).toEqual(['Tiêu chảy']);
  expect(result.state.onset).toBe('Từ hôm qua');
  expect(result.state.primarySymptom).toBeTruthy();
});

test('an unrecognized follow-up status is not assumed to mean improvement', () => {
  const result = getNextStep(
    initial([answer('followup_status', 'Không rõ')], { phase: 'followup' })
  );
  expect(result.state.progression).toBeNull();
  expect(result.step).toBe('followup_status');
});

test('new symptoms are clarified and then assessed in the same ordered flow', () => {
  const extra = { phase: 'followup', baselineAnswers: [answer('symptoms', 'Đau đầu')] };
  const answers = [
    answer('followup_status', 'Vẫn như cũ'),
    answer('followup_detail', 'Có thêm triệu chứng mới'),
  ];
  expect(getNextStep(initial(answers, extra))).toMatchObject({
    step: 'followup_detail',
    clarification: 'new_symptom',
  });
  answers.push(answer('followup_detail', 'Đau bụng'));
  const next = getNextStep(initial(answers, extra));
  expect(next.step).toBe('onset');
  expect(next.state.allSymptoms).toEqual(['Đau đầu', 'Đau bụng']);
  answers.push(answer('onset', 'Từ sáng'), answer('progression', 'Vẫn như cũ'));
  expect(getNextStep(initial(answers, extra)).step).toBe('red_flags');
});

test('a vulnerable follow-up asks the required safety question after two answers', () => {
  const result = getNextStep(
    initial(
      [
        answer('followup_status', 'Vẫn như cũ'),
        answer('followup_detail', 'Không có triệu chứng mới'),
      ],
      {
        phase: 'followup',
        profile: { age: '60+' },
        healthContext: { medical_conditions: ['cao huyết áp'] },
        baselineAnswers: [answer('symptoms', 'Chóng mặt')],
      }
    )
  );
  expect(result.step).toBe('red_flags');
});

test('the finite answer budget preserves risk and makes missing evidence explicit', () => {
  const result = getNextStep(
    initial([answer('symptoms', 'Đau đầu'), answer('progression', 'Nặng hơn')], {
      forceConclusion: true,
      profile: { age: 70 },
    })
  );
  expect(result).toMatchObject({
    action: 'conclude',
    conclusion: { severity: 'high', needsDoctor: true },
    state: { assessmentIncomplete: true },
  });
});

test.each(['Không đỡ hơn, càng nặng hơn', 'Đỡ hơn một chút nhưng đau ngực hơn'])(
  'does not reassure a worsening answer: %s',
  (value) => {
    expect(selectEmpathyResponse({ answer: value }, { ...profile, lang: 'vi' }).templateId).toBe(
      'empathy_worsening'
    );
  }
);

test('a negated worsening phrase does not override actual improvement', () => {
  expect(
    selectEmpathyResponse({ answer: 'Không nặng hơn, đã đỡ rồi' }, { ...profile, lang: 'vi' })
      .templateId
  ).toBe('empathy_improving');
});

test('emergency severity is never described as an improvement over high', () => {
  expect(
    generateProgressFeedback({ lastSeverity: 'high' }, 'emergency', { ...profile, lang: 'vi' })
      .templateId
  ).not.toBe('progress_severity_improved');
});

test.each([
  [20, 'Nam', 'Bạn'],
  [35, 'Nam', 'Anh'],
  [50, 'Nữ', 'Cô'],
  [65, 'Nam', 'Bác'],
  [80, 'Nam', 'Ông'],
  [80, 'Nữ', 'Bà'],
  [50, null, 'Bác'],
  [80, null, 'Bác'],
])('addresses age %s, gender %s as %s', (age, gender, expected) => {
  expect(getHonorifics({ age, gender }).Honorific).toBe(expected);
});

test('uses full birth date before a stale age range and respects birthdays', () => {
  expect(
    getUserAge(
      { date_of_birth: '1966-12-01', age: '60+', birth_year: 1950 },
      new Date('2026-10-12')
    )
  ).toBe(59);
});

test.each(['symptoms', 'onset', 'progression', 'red_flags', 'followup_status', 'followup_detail'])(
  'question %s is capitalized and leaves no template tokens',
  (step) => {
    const result = formatQuestion(
      { step, symptoms: ['đau đầu'], previousSymptoms: ['đau đầu'] },
      profile
    );
    const first = result.question.match(/\p{L}/u)[0];
    expect(first).toBe(first.toUpperCase());
    expect(result.question).not.toMatch(/\{\{|💙|😊|🩺/u);
  }
);

test('capitalizes acknowledgement text for an older user', () => {
  const result = selectEmpathyResponse({ answer: 'Đau đầu từ sáng' }, { age: 80, gender: 'Nam' });
  expect(result.text[0]).toBe(result.text[0].toUpperCase());
});

test('conclusion ignores invented model history and uses the exact follow-up time', async () => {
  const state = {
    ...buildState([
      answer('symptoms', 'Tiêu chảy'),
      answer('onset', 'Từ hôm qua'),
      answer('progression', 'Vẫn như cũ'),
    ]),
    severity: 'medium',
    followUpHours: 3,
  };
  const result = await generateConclusion(state, profile);
  expect(result.summary).toContain('Tiêu chảy');
  expect(result.summary).not.toMatch(/đi kèm|chưa có biện pháp/);
  expect(result.closeMessage).toContain('3 tiếng');
  expect(result.closeMessage).not.toContain('đã thông báo');
  const request = callTextAi.mock.calls[0][0];
  expect(request.prompt).toContain('"actions_reported":null');
  expect(request).toMatchObject({ timeoutMs: 5000, maxRetries: 0 });
});

test('unavailable AI still returns a grounded conclusion with the existing severity', async () => {
  callTextAi.mockRejectedValueOnce(new Error('timeout'));
  const result = await generateConclusion(
    {
      allSymptoms: ['Đau đầu'],
      progression: 'worse',
      severity: 'high',
      needsDoctor: true,
      followUpHours: 1,
    },
    profile
  );
  expect(result.summary).toContain('nặng hơn');
  expect(result.recommendation).toContain('đi khám');
  expect(result.closeMessage).toContain('1 tiếng');
});

test('an AI emergency has personalized text without claiming a delivered family alert', async () => {
  callTextAi.mockResolvedValueOnce({
    content: JSON.stringify({ severity: 'emergency', needsDoctor: true, needsFamilyAlert: true }),
  });
  const result = await getNextTriageQuestion(
    initial([answer('symptoms', 'Mắt bỗng không nhìn rõ')], { profile: { age: 80, gender: 'Nữ' } })
  );
  expect(result).toMatchObject({ isDone: true, severity: 'emergency' });
  expect(result.closeMessage).toMatch(/^Bà /);
  expect(result.closeMessage).not.toMatch(/\{\{|đã thông báo/);
});
