'use strict';

const {
  getDetailedNextStep,
  MAX_DETAILED_ANSWERS,
} = require('../../src/core/checkin/triage-detail-questions');
const { buildQuestion, buildState } = require('../../src/core/checkin/triage-engine');
const { formatQuestion } = require('../../src/core/checkin/triage-ai-layer');
const { normalizeAnswers } = require('../../src/core/checkin/triage-facts');
const { getHonorifics } = require('../../src/lib/honorifics');
const { t } = require('../../src/i18n');
const { buildConclusionFacts } = require('../../src/core/checkin/triage-conclusion');

const profiles = [
  { age: 23, gender: 'Nam', full_name: 'Dương Anh Đức' },
  { age: 30, gender: 'Nữ', full_name: 'Nguyễn Thị Hoa' },
  { age: 56, gender: 'Nam', full_name: 'Trần Văn Hùng' },
  { age: 56, gender: 'Nữ', full_name: 'Nguyễn Thị Hoa' },
  { age: 56, full_name: 'Nguyễn Minh An' },
  { age: 65, gender: 'Nam', full_name: 'Trần Văn Hùng' },
  { age: 80, gender: 'Nữ', full_name: 'Nguyễn Thị Hoa' },
  {},
];
const concerns = [
  ['head', 'Đau đầu'],
  ['chest', 'Hồi hộp'],
  ['abdomen', 'Đầy hơi'],
  ['limbs', 'Đau khớp'],
  ['skin', 'Ngứa'],
  ['whole_body', 'Mệt mỏi'],
  ['mental', 'Lo âu'],
];
const choice = (code, lang) => t(`checkin.detail.option.${code}`, lang);

function walk({
  regions,
  symptoms,
  profile,
  lang = 'vi',
  pattern = 'constant',
  spread = false,
  careAction = 'recorded_reading',
  relief = 'not_tried',
  previous = [],
}) {
  const questions = [],
    answers = [...previous];
  for (let i = 0; i < MAX_DETAILED_ANSWERS; i++) {
    const raw = getDetailedNextStep({
      status: 'specific_concern',
      phase: 'initial',
      bodyLocations: regions,
      profile,
      lang,
      previousAnswers: normalizeAnswers(answers),
    });
    if (raw.action === 'conclude') return { questions, answers, state: raw.state };
    const next = raw.detailedQuestion
      ? raw
      : { ...raw, ...formatQuestion(raw, profile, answers, lang) };
    questions.push(next);
    const answer =
      next.step === 'symptoms'
        ? symptoms.join(', ')
        : next.step === 'red_flags'
          ? t('checkin.triage.option.none', lang)
          : next.step === 'detail_history'
            ? choice('no_conditions', lang)
            : next.step.endsWith('_onset')
              ? t('checkin.triage.option.onset_under_three_days', lang)
              : next.step.endsWith('_progression')
                ? t('checkin.triage.option.same', lang)
                : next.step.endsWith('_pattern')
                  ? choice(pattern, lang)
                  : next.step.endsWith('_radiation')
                    ? choice(spread ? 'spreads' : 'stays_here', lang)
                    : next.step.endsWith('_associated')
                      ? choice('none', lang)
                      : next.step.endsWith('_relieving')
                        ? choice(relief, lang)
                        : next.step.endsWith('_actions')
                          ? choice(careAction, lang)
                          : next.options[0];
    answers.push({ step: next.step, question: next.question, answer });
  }
  throw new Error('The interview repeated or failed to finish');
}

const scenarios = ['vi', 'en'].flatMap((lang) =>
  profiles.flatMap((profile) =>
    concerns.map(([region, symptom]) => ({ lang, profile, region, symptom }))
  )
);
test.each(scenarios)(
  'whole conversation is readable and answerable: $lang / $region / $profile',
  ({ lang, profile, region, symptom }) => {
    const result = walk({ regions: [region], symptoms: [symptom], profile, lang });
    const h = getHonorifics({ ...profile, lang });
    expect(result.state.detailedAssessmentComplete).toBe(true);
    expect(new Set(result.questions.map((q) => q.step)).size).toBe(result.questions.length);
    expect(result.questions.filter((q) => q.step.endsWith('_actions'))).toHaveLength(1);
    for (const q of result.questions) {
      expect(q.question).not.toMatch(
        /\{\{|checkin\.(?:detail|triage)|undefined|anh\s*\/\s*chị|cô\s*\/\s*chú/iu
      );
      expect(q.question).not.toMatch(/^(?:đầu|ngực|bụng|tay chân|da|head|chest|skin)\s*:/iu);
      expect(q.question.length).toBeLessThanOrEqual(500);
      expect(
        q.options.filter((o) => !['Không rõ', 'Unsure', 'Không có', 'None'].includes(o)).length
      ).toBeGreaterThanOrEqual(2);
      if (lang === 'vi' && h.honorific !== 'bạn')
        expect(q.question).not.toMatch(/(?:^|[^\p{L}])bạn(?=$|[^\p{L}])/iu);
      if (q.multiSelect && q.options.includes(choice('unknown', lang)))
        expect(q.exclusiveOptions).toContain(choice('unknown', lang));
      if (!/đau|nhức/iu.test(symptom))
        expect(q.step).not.toMatch(/_(?:character|radiation|radiation_location)$/u);
    }
    const firstName = profile.full_name?.split(' ').at(-1);
    if (firstName)
      expect(
        result.questions.filter((q) => q.question.includes(firstName)).length
      ).toBeLessThanOrEqual(1);
  }
);

test.each(profiles.flatMap((profile) => ['vi', 'en'].map((lang) => ({ profile, lang }))))(
  'all legacy template steps resolve every addressing placeholder: $profile / $lang',
  ({ profile, lang }) => {
    const state = buildState([{ step: 'symptoms', answer: 'Đau đầu' }], profile);
    for (const step of [
      'symptoms',
      'associated',
      'onset',
      'progression',
      'red_flags',
      'cause',
      'action',
      'followup_status',
      'followup_detail',
    ]) {
      const rendered = formatQuestion(
        { ...buildQuestion(step, state, lang), step, state },
        profile,
        [],
        lang
      );
      expect(rendered.question).not.toMatch(/\{\{|undefined|anh\s*\/\s*chị/iu);
      expect(rendered.options.length).toBeGreaterThan(1);
    }
  }
);

test('self-care is asked once after all selected areas, with answers distinct from relief outcomes', () => {
  const result = walk({
    regions: ['head', 'limbs', 'skin'],
    symptoms: ['Đau đầu', 'Đau khớp', 'Ngứa'],
    profile: profiles[2],
  });
  const care = result.questions.filter((q) => q.step.endsWith('_actions'));
  expect(care).toHaveLength(1);
  expect(care[0].questionGroup).toBeNull();
  expect(result.questions.at(-1)).toBe(care[0]);
  expect(care[0].options).not.toContain(choice('rest_helps', 'vi'));
  expect(care[0].options).not.toContain(choice('rest', 'vi'));
  expect(care[0].exclusiveOptions).toContain(choice('no_extra_action', 'vi'));
  expect(result.state.actionsFound).toContain(choice('recorded_reading', 'vi'));
});

test('an older saved self-care answer is retained without asking it again', () => {
  const initial = walk({
    regions: ['head', 'limbs'],
    symptoms: ['Đau đầu', 'Đau khớp'],
    profile: profiles[2],
  });
  const previous = initial.answers.filter((a) => !a.step.endsWith('_actions'));
  previous.push({
    step: 'detail_head_actions',
    question: 'Câu hỏi đã lưu ở bản cũ',
    answer: 'Nghỉ ngơi',
  });
  const resumed = walk({
    regions: ['head', 'limbs'],
    symptoms: ['Đau đầu', 'Đau khớp'],
    profile: profiles[2],
    previous,
  });
  expect(resumed.questions).toHaveLength(0);
  expect(resumed.state.actionsFound).toContain('nghỉ ngơi');
});

test('episode and spreading questions appear only after their matching answer', () => {
  for (const pattern of ['constant', 'episodes', 'occasional']) {
    for (const spread of [false, true]) {
      const result = walk({
        regions: ['head'],
        symptoms: ['Đau đầu'],
        profile: profiles[2],
        pattern,
        spread,
      });
      const steps = result.questions.map((q) => q.step);
      expect(steps.includes('detail_head_episode_duration')).toBe(pattern !== 'constant');
      expect(steps.includes('detail_head_radiation_location')).toBe(spread);
    }
  }
});

test('questions never turn a patient sentence or an old AI summary into a symptom noun', () => {
  const sentence = 'Tôi nghe tiếng ù trong tai trái khi ngồi yên';
  const result = formatQuestion(
    { step: 'associated', primarySymptom: sentence, options: ['Buồn nôn', 'Không có'] },
    profiles[2]
  );
  expect(result.question).not.toContain(sentence.toLowerCase());
  const followup = formatQuestion(
    {
      step: 'followup_status',
      previousSessionSummary: 'Asinu đã ghi nhận chú có đau đầu. Chú nên theo dõi thêm.',
      options: ['Vẫn như cũ', 'Đỡ hơn'],
    },
    profiles[2]
  );
  expect(followup.question).not.toMatch(/chia sẻ về (?:không khỏe|khó chịu)|Asinu đã ghi nhận/u);
  expect(followup.question).toContain('So với lần hỏi thăm trước');
});

test('the old context question asks about observable events instead of possible diagnoses', () => {
  const raw = buildQuestion('cause', buildState([]), 'vi');
  const result = formatQuestion({ ...raw, step: 'cause' }, profiles[2]);
  expect(result.question).not.toMatch(/nguyên nhân|quên.*thuốc/u);
  expect(result.options).toContain(t('checkin.triage.option.no_recent_change', 'vi'));
  expect(result.options.join(' ')).not.toMatch(/thiếu máu|hạ đường huyết|trầm cảm|GERD/u);
});

test('mental and skin questions offer context-appropriate triggers and relief', () => {
  const mental = walk({ regions: ['mental'], symptoms: ['Lo âu'], profile: profiles[2] });
  const triggers = mental.questions.find((q) => q.step === 'detail_mental_aggravating');
  expect(triggers.options).not.toContain(choice('movement', 'vi'));
  expect(triggers.options).toContain(choice('short_sleep_context', 'vi'));
  expect(mental.questions.find((q) => q.step === 'detail_mental_relieving').options).toContain(
    choice('talking_helps', 'vi')
  );
  const skin = walk({ regions: ['skin'], symptoms: ['Ngứa'], profile: profiles[3] });
  expect(skin.questions.find((q) => q.step === 'detail_skin_aggravating').options).toContain(
    choice('rubbing', 'vi')
  );
  expect(skin.questions.find((q) => q.step === 'detail_skin_relieving').options).toContain(
    choice('cool_place_helps', 'vi')
  );
});

test('current severity allows the patient to say discomfort has stopped', () => {
  const pain = walk({ regions: ['head'], symptoms: ['Đau đầu'], profile: profiles[2] });
  expect(pain.questions.find((q) => q.step === 'detail_head_severity').options).toContain(
    choice('no_pain_now', 'vi')
  );
  const discomfort = walk({ regions: ['skin'], symptoms: ['Ngứa'], profile: profiles[3] });
  expect(discomfort.questions.find((q) => q.step === 'detail_skin_severity').options).toContain(
    choice('no_discomfort_now', 'vi')
  );
});

test('detailed interviews retain the selected-area context for the first symptom question', () => {
  const result = walk({
    regions: ['head', 'limbs'],
    symptoms: ['Đau đầu', 'Đau khớp'],
    profile: profiles[2],
  });
  expect(result.questions[0].question).toContain('đầu và tay chân');
  expect(result.questions[0].question).not.toContain('Hùng');
});

test('no additional self-care remains explicit in conclusion facts without erasing an earlier relief answer', () => {
  const result = walk({
    regions: ['head'],
    symptoms: ['Đau đầu'],
    profile: profiles[2],
    relief: 'rest_helps',
    careAction: 'no_extra_action',
  });
  const facts = buildConclusionFacts(result.state, profiles[2], {});
  expect(facts.cham_soc_bo_sung_da_khai).toBe(choice('no_extra_action', 'vi'));
  expect(facts.chi_tiet_tung_vung[0].answers.relieving).toBe(choice('rest_helps', 'vi'));
  expect(facts.viec_da_ke).not.toContain(choice('no_extra_action', 'vi'));
});
