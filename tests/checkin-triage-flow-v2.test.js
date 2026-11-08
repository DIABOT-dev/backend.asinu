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
const {
  getDetailedNextStep,
  detailedQuestionsEnabled,
  MAX_DETAILED_ANSWERS,
} = require('../src/core/checkin/triage-detail-questions');
const { normalizeAnswers } = require('../src/core/checkin/triage-facts');
const { buildConclusionFacts } = require('../src/core/checkin/triage-conclusion');

const initialInput = (previousAnswers, profile = {}, healthContext = {}) => ({
  status: 'specific_concern',
  phase: 'initial',
  profile,
  healthContext,
  previousAnswers,
});

describe('per-area check-in interview', () => {
  test('long location notes stay in facts while the next question fits the API limit', () => {
    const result = getDetailedNextStep({
      status: 'tired',
      phase: 'initial',
      lang: 'vi',
      profile: { age: 35, medical_conditions: ['Tiểu đường'] },
      bodyLocations: ['head'],
      bodyLocationOther: 'Đầu: ' + 'vị trí đã khai '.repeat(90),
      previousAnswers: [
        { step: 'symptoms', answer: 'đau đầu' },
        { step: 'red_flags', answer: 'Không có' },
      ],
    });
    expect(result.step).toBe('detail_head_onset');
    expect(result.question.length).toBeLessThanOrEqual(500);
    expect(result.state.regionDetails[0].position.length).toBeGreaterThan(1000);
  });
  const input = {
    status: 'tired',
    phase: 'initial',
    lang: 'vi',
    profile: { age: 35, gender: 'Nam', medical_conditions: [] },
    bodyLocations: ['head', 'limbs'],
    bodyLocationOther: 'Đầu: Trán; Tay chân: Cổ tay phải',
  };
  const select = (r) => {
    if (r.step === 'symptoms') return 'Đau đầu, Đau khớp';
    if (r.step === 'red_flags') return 'Không có';
    if (r.step === 'detail_history') return t('checkin.detail.option.no_conditions', 'vi');
    const field = r.step.replace(/^detail_(?:head|limbs)_/, '');
    return (
      {
        onset: 'Từ hôm qua',
        progression: 'Vẫn như cũ',
        severity: 'Vừa',
        impact: t('checkin.detail.option.impact_some', 'vi'),
        character: t('checkin.detail.option.dull', 'vi'),
        pattern: t('checkin.detail.option.constant', 'vi'),
        radiation: t('checkin.detail.option.stays_here', 'vi'),
        associated: 'Không có',
      }[field] || r.options[0]
    );
  };
  const walk = (choose = select, overrides = {}) => {
    const answers = [],
      questions = [];
    for (let index = 0; index <= MAX_DETAILED_ANSWERS; index++) {
      const response = getDetailedNextStep({
        ...input,
        ...overrides,
        previousAnswers: normalizeAnswers(answers),
      });
      if (response.action === 'conclude') return { result: response, questions, answers };
      expect(response.question).toBeTruthy();
      expect(response.question.length).toBeLessThanOrEqual(500);
      expect(response.question).not.toMatch(/\{\{|checkin\.detail\./);
      questions.push(response);
      answers.push({ step: response.step, question: response.question, answer: choose(response) });
    }
    throw new Error('Interview exceeded its bounded answer limit');
  };
  test('screens danger first, uses known history, finishes each area and never stops at eight answers', () => {
    const run = walk();
    const steps = run.questions.map((r) => r.step);
    expect(steps.slice(0, 3)).toEqual(['symptoms', 'red_flags', 'detail_history']);
    expect(run.answers).toHaveLength(25);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps.indexOf('detail_head_actions')).toBeLessThan(steps.indexOf('detail_limbs_onset'));
    expect(steps).not.toContain('detail_head_episode_duration');
    expect(steps).not.toContain('detail_head_radiation_location');
    expect(run.result.state.detailedAssessmentComplete).toBe(true);
    expect(run.result.state.regionDetails[0].position).toBe('Trán');
    expect(run.result.state.regionDetails[1].position).toBe('Cổ tay phải');
    expect(run.questions.every((r) => r.questionProgress.current <= r.questionProgress.total)).toBe(
      true
    );
  });
  test('keeps separate onset, severity and impact instead of overwriting the other area', () => {
    const run = walk((r) =>
      r.step === 'detail_limbs_onset'
        ? 'Từ sáng'
        : r.step === 'detail_limbs_severity'
          ? 'Nhẹ'
          : r.step === 'detail_limbs_impact'
            ? t('checkin.detail.option.impact_none', 'vi')
            : select(r)
    );
    const facts = buildConclusionFacts(run.result.state, input.profile);
    expect(facts.chi_tiet_tung_vung.map((area) => area.answers.onset)).toEqual([
      'từ hôm qua',
      'từ sáng',
    ]);
    expect(facts.chi_tiet_tung_vung.map((area) => area.answers.severity)).toEqual(['Vừa', 'Nhẹ']);
    expect(facts.chi_tiet_tung_vung[1].answers.impact).toBe(
      t('checkin.detail.option.impact_none', 'vi')
    );
    expect(facts.tinh_trang_khai_bao_benh_nen).toBe('none_reported');
    expect(facts.benh_nen_da_khai).toEqual([]);
  });
  test('asks duration only for episodes and asks the destination only when pain spreads', () => {
    const run = walk((r) =>
      r.step === 'detail_head_pattern'
        ? t('checkin.detail.option.episodes', 'vi')
        : r.step === 'detail_limbs_radiation'
          ? t('checkin.detail.option.spreads', 'vi')
          : r.step === 'detail_limbs_radiation_location'
            ? 'Lan đến bàn tay phải'
            : select(r)
    );
    const steps = run.questions.map((r) => r.step);
    expect(steps).toContain('detail_head_episode_duration');
    expect(steps).not.toContain('detail_limbs_episode_duration');
    expect(steps).toContain('detail_limbs_radiation_location');
    expect(steps).not.toContain('detail_head_radiation_location');
  });
  test.each(['vi', 'en'])('every detailed question offers real choices, including where pain spreads (%s)', lang => {
    const run = walk(r => {
      if (r.step.endsWith('_radiation')) return t('checkin.detail.option.spreads', lang);
      if (r.step.endsWith('_pattern')) return t('checkin.detail.option.episodes', lang);
      if (r.step.endsWith('_radiation_location')) {
        const hand = t('checkin.detail.option.radiates_hand', lang);
        return r.options.includes(hand) ? hand : r.options[0];
      }
      return select(r);
    }, { lang });
    for (const question of run.questions) {
      expect(question.options.length).toBeGreaterThan(1);
      expect(new Set(question.options).size).toBe(question.options.length);
      expect(question.options.every(option => typeof option === 'string' && option.trim())).toBe(true);
      expect(question.question.trim().split(/\s+/).length).toBeLessThanOrEqual(25);
    }
    const where = run.questions.find(r => r.step === 'detail_limbs_radiation_location');
    expect(where.options).toContain(t('checkin.detail.option.radiates_hand', lang));
    expect(where.allowFreeText).toBe(true);
    expect(run.result.state.regionDetails.find(r => r.region === 'limbs').answers.radiation_location)
      .toBe(t('checkin.detail.option.radiates_hand', 'vi'));
  });
  test.each(['vi', 'en'].flatMap(lang => ['head', 'chest', 'abdomen', 'limbs', 'skin', 'whole_body', 'mental'].map(region => [lang, region])))(
    'all available questions have readable text and usable choices (%s/%s)', (lang, region) => {
      const symptoms = require('../src/services/checkin/body-location').getSymptomsForLocation(region, lang);
      const run = walk(r => {
        if (r.step === 'symptoms') return symptoms[0];
        if (r.step === 'red_flags') return 'Không có';
        if (r.step.endsWith('_pattern')) return t('checkin.detail.option.episodes', lang);
        if (r.step.endsWith('_radiation')) return t('checkin.detail.option.spreads', lang);
        return r.options[0];
      }, { lang, bodyLocations: [region], bodyLocationOther: '' });
      expect(run.answers.length).toBeLessThanOrEqual(MAX_DETAILED_ANSWERS);
      expect(new Set(run.answers.map(a => a.step)).size).toBe(run.answers.length);
      for (const q of run.questions) {
        expect(q.options.length).toBeGreaterThan(1);
        expect(new Set(q.options).size).toBe(q.options.length);
        expect(q.options.every(option => typeof option === 'string' && option.trim().length)).toBe(true);
        expect(q.question).not.toMatch(/undefined|\{\{|checkin\.detail\./);
        if (q.step.startsWith('detail_')) expect(q.question.split(/\s+/).length).toBeLessThanOrEqual(25);
      }
    });
  test('the question stays readable when the recorded position is long or repeated', () => {
    const rawPosition = 'Vai / cánh tay phải / vai cánh tay phải';
    const run = walk(select, { bodyLocationOther: `Tay chân: ${rawPosition}` });
    const associated = run.questions.find(r => r.step === 'detail_limbs_associated');
    expect(associated.question).toBe('Bạn có thêm dấu hiệu nào dưới đây không?');
    expect(associated.question).not.toContain('(');
    expect(associated.question).not.toContain('ngoài điều đã kể');
    expect(associated.questionGroup.label).toBe('Tay chân');
    expect(run.result.state.regionDetails.find(r => r.region === 'limbs').position).toBe(rawPosition);
  });
  test('accepts optional uncertainty once and concludes explicitly incomplete if timing is unknown', () => {
    const run = walk((r) =>
      r.step.startsWith('detail_') && r.step !== 'detail_history' ? 'Không rõ' : select(r)
    );
    expect(new Set(run.answers.map((a) => a.step)).size).toBe(run.answers.length);
    expect(run.result.state.assessmentIncomplete).toBe(true);
    expect(run.result.state.regionDetails[0].answers.severity).toBe('không rõ');
  });
  test('does not call a non-pain complaint pain or ask pain character and radiation', () => {
    const run = walk((r) => (r.step === 'symptoms' ? 'Chóng mặt' : select(r)), {
      bodyLocations: ['head'],
    });
    expect(run.questions.find((r) => r.step === 'detail_head_severity').question).toBe(t('checkin.detail.question.discomfort', 'vi'));
    expect(run.questions.map((r) => r.step)).not.toContain('detail_head_character');
    expect(run.questions.map((r) => r.step)).not.toContain('detail_head_radiation');
  });
  test('does not re-ask a single-area onset already supplied with its symptom', () => {
    const run = walk((r) => (r.step === 'symptoms' ? 'đau đầu từ hôm qua' : select(r)), {
      bodyLocations: ['head'],
    });
    expect(run.questions.map((r) => r.step)).not.toContain('detail_head_onset');
    expect(run.result.state.regionDetails[0].answers.onset).toBeTruthy();
  });
  test('reuses existing profile conditions without asking again and retains newly declared conditions', () => {
    const known = walk(select, {
      profile: { ...input.profile, medical_conditions: ['Tiểu đường'] },
    });
    expect(known.questions.map((r) => r.step)).not.toContain('detail_history');
    const fresh = walk((r) => (r.step === 'detail_history' ? 'Tiểu đường' : select(r)));
    expect(buildConclusionFacts(fresh.result.state, input.profile).benh_nen_da_khai).toEqual([
      'Tiểu đường',
    ]);
  });
  test('one uncertain area stays incomplete without overwriting the other area or restarting questions', () => {
    const run = walk((r) =>
      r.step === 'detail_head_onset' || r.step === 'detail_history' ? 'Không rõ' : select(r)
    );
    expect(run.result.state.assessmentIncomplete).toBe(true);
    expect(run.result.state.regionDetails[0].answers.onset).toBe('không rõ');
    expect(run.result.state.regionDetails[1].answers.onset).toBe('từ hôm qua');
    expect(run.result.state.historyAssessment).toBe('unknown');
    expect(new Set(run.answers.map((a) => a.step)).size).toBe(run.answers.length);
  });
  test('positive danger signals conclude before the detailed interview', () => {
    const result = getDetailedNextStep({
      ...input,
      previousAnswers: [
        { step: 'symptoms', answer: 'đau đầu' },
        { step: 'red_flags', answer: 'yếu hoặc tê nửa người' },
      ],
    });
    expect(result.action).toBe('conclude');
    expect(result.conclusion.hasRedFlag).toBe(true);
    expect(result.state.detailedAssessmentComplete).toBe(false);
  });
  test('leaves routine follow-up and legacy callers on their original sequence', () => {
    expect(detailedQuestionsEnabled({}, { NODE_ENV: 'test' })).toBeFalsy();
    expect(
      detailedQuestionsEnabled({ assessmentVersion: 2 }, { NODE_ENV: 'production' })
    ).toBeFalsy();
    const followup = { ...input, phase: 'followup', previousAnswers: [] };
    expect(getDetailedNextStep(followup).step).toBe(getNextStep(followup).step);
  });
  test('English choices are localized while stable field IDs preserve independent facts', () => {
    const run = walk(
      (r) =>
        r.step === 'symptoms'
          ? 'Headache, Joint pain'
          : r.step === 'red_flags'
            ? 'None'
            : r.step === 'detail_history'
              ? 'No diagnosed conditions'
              : r.options[0],
      { lang: 'en' }
    );
    expect(run.questions.find((r) => r.step === 'detail_head_severity').question).toContain('pain');
    expect(run.result.state.regionDetails[0].answers.severity).toBe('Nhẹ');
    expect(
      buildConclusionFacts(run.result.state, input.profile, {}, 'en').benh_nen_da_khai
    ).toEqual([]);
  });
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
