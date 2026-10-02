const {
  getNextStep,
  buildState,
  INITIAL_STEPS,
  FOLLOWUP_STEPS,
} = require('../src/core/checkin/triage-engine');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');
const { getNextTriageQuestion } = require('../src/services/checkin/checkin.triage.v2');
const { EMERGENCY_CONCLUSIONS, isSafeConclusion } = require('../src/core/checkin/triage-ai-layer');
const { t } = require('../src/i18n');

const initialInput = (previousAnswers, profile = {}, healthContext = {}) => ({
  status: 'specific_concern',
  phase: 'initial',
  profile,
  healthContext,
  previousAnswers,
});

describe('check-in triage V2 flow', () => {
  test('uses an explicit adaptive 2-4 question state machine', () => {
    expect(INITIAL_STEPS).toEqual(['symptoms', 'onset', 'progression', 'red_flags', 'conclude']);
    expect(FOLLOWUP_STEPS).toEqual(['followup_status', 'followup_detail', 'conclude']);

    expect(getNextStep(initialInput([]))).toMatchObject({ action: 'ask', step: 'symptoms' });
    expect(
      getNextStep(initialInput([{ step: 'symptoms', answer: 'đau đầu', question: 'Triệu chứng?' }]))
    ).toMatchObject({ action: 'ask', step: 'onset' });

    expect(
      getNextStep(
        initialInput([{ step: 'symptoms', answer: 'đau đầu từ sáng', question: 'Triệu chứng?' }])
      )
    ).toMatchObject({ action: 'ask', step: 'progression' });

    const commonAnswers = [
      { step: 'symptoms', answer: 'đau đầu', question: 'Triệu chứng?' },
      { step: 'onset', answer: 'từ sáng', question: 'Bắt đầu khi nào?' },
    ];
    expect(getNextStep(initialInput(commonAnswers))).toMatchObject({
      action: 'ask',
      step: 'progression',
    });

    expect(
      getNextStep(
        initialInput([
          ...commonAnswers,
          { step: 'progression', answer: 'đang đỡ dần', question: 'Diễn tiến?' },
        ])
      )
    ).toMatchObject({ action: 'conclude' });

    expect(
      getNextStep(
        initialInput([
          ...commonAnswers,
          { step: 'progression', answer: 'có vẻ nặng hơn', question: 'Diễn tiến?' },
        ])
      )
    ).toMatchObject({ action: 'ask', step: 'red_flags' });
  });

  test('keeps the red-flag question for a vulnerable user even when improving', () => {
    const result = getNextStep(
      initialInput(
        [
          { step: 'symptoms', answer: 'chóng mặt', question: 'Triệu chứng?' },
          { step: 'onset', answer: 'từ sáng', question: 'Bắt đầu khi nào?' },
          { step: 'progression', answer: 'đang đỡ dần', question: 'Diễn tiến?' },
        ],
        { age: 70 },
        { medical_conditions: ['cao huyết áp'] }
      )
    );
    expect(result).toMatchObject({ action: 'ask', step: 'red_flags' });
  });

  test('does not turn broad symptoms into an emergency without a dangerous combination', () => {
    expect(detectEmergency(['hoa mắt']).isEmergency).toBe(false);
    expect(detectEmergency(['tim đập nhanh']).isEmergency).toBe(false);
    expect(detectEmergency(['không đau ngực', 'không vã mồ hôi']).isEmergency).toBe(false);
    expect(detectEmergency(['đau ngực', 'vã mồ hôi'])).toMatchObject({
      isEmergency: true,
      type: 'MI',
    });
  });

  test('does not treat negated legacy red-flag text as an affirmative sign', () => {
    const state = buildState([
      {
        step: 'red_flags',
        question: 'Dấu hiệu nghiêm trọng?',
        answer: 'Tôi không khó thở và không bị đau ngực',
      },
    ]);
    expect(state.redFlagsFound).toEqual([]);
  });

  test('normalizes deterministic emergencies to the persisted emergency severity', async () => {
    const result = await getNextTriageQuestion({
      status: 'specific_concern',
      phase: 'initial',
      profile: {},
      healthContext: {},
      previousAnswers: [{ step: 'symptoms', question: 'Triệu chứng?', answer: 'đang co giật' }],
    });
    expect(result).toMatchObject({
      isDone: true,
      severity: 'emergency',
      needsDoctor: true,
      needsFamilyAlert: true,
      autoEmergency: true,
    });
  });

  test('uses the language selected by the user for questions and options', async () => {
    const first = await getNextTriageQuestion({
      status: 'specific_concern',
      phase: 'initial',
      lang: 'en',
      profile: { full_name: 'John' },
      healthContext: {},
      previousAnswers: [],
    });
    expect(first.isDone).toBe(false);
    expect(first.question).toMatch(/John|symptom|feeling/i);
    expect(first.options).toContain('Headache');

    const next = await getNextTriageQuestion({
      status: 'specific_concern',
      phase: 'initial',
      lang: 'en',
      profile: { full_name: 'John' },
      healthContext: {},
      previousAnswers: [{ step: 'symptoms', question: first.question, answer: 'Headache' }],
    });
    expect(next.question).toMatch(/when|start/i);
    expect(next.options).toContain('Since this morning');
  });

  test('blocks diagnosis and medication instructions in generated conclusions', () => {
    expect(
      isSafeConclusion({
        summary: 'Triệu chứng này cần được bác sĩ đánh giá.',
        recommendation: 'Nên đi khám tại chuyên khoa phù hợp.',
        closeMessage: 'Asinu sẽ hỏi lại sau.',
      })
    ).toBe(true);
    expect(
      isSafeConclusion({
        summary: 'Bố bị viêm đại tràng.',
        recommendation: 'Theo dõi.',
        closeMessage: '',
      })
    ).toBe(false);
    expect(
      isSafeConclusion({
        summary: 'Cần theo dõi.',
        recommendation: 'Uống aspirin 100 mg.',
        closeMessage: '',
      })
    ).toBe(false);
    expect(
      isSafeConclusion({
        summary: 'You are likely diagnosed with a neurological disease.',
        recommendation: 'Continue monitoring.',
        closeMessage: '',
      })
    ).toBe(false);

    for (const template of Object.values(EMERGENCY_CONCLUSIONS)) {
      const honorifics = { Honorific: 'Bác', honorific: 'bác', selfRef: 'Asinu' };
      expect(
        isSafeConclusion({
          summary: t(template.summary, 'vi', honorifics),
          recommendation: t(template.recommendation, 'vi', honorifics),
          closeMessage: t(template.closeMessage, 'vi', honorifics),
        })
      ).toBe(true);
    }
  });
});
