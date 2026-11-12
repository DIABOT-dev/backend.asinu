'use strict';

jest.mock('../../src/security/openbao-keyring.cjs', () => ({
  keyringEnabled: () => false,
  keyringReady: () => true,
}));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { getCompactNextStep } = require('../../src/services/checkin/compact-interview.service');
const {
  initialize,
  refreshCoverage,
} = require('../../src/services/checkin/compact-coverage.service');
const { resolveComplaint } = require('../../src/services/checkin/clinical-mapping');
const { t } = require('../../src/i18n');
const { providerResponse } = require('../fixtures/compact-interview');

function scene(locations = ['abdomen'], label = 'Đau âm ỉ', region = null) {
  const compact = {
    version: 2,
    layout: 'eight_groups',
    lang: 'vi',
    hasConditions: false,
    questions: [
      {
        step: 'compact_symptoms',
        field: 'symptoms',
        question: 'Bạn đang khó chịu ở bụng trên rốn như thế nào vậy?',
        choices: [{ id: 'dull_pain', label }],
      },
    ],
  };
  const coverage = initialize(compact);
  coverage.concerns = [
    {
      id: 'c1',
      label,
      region,
      evidence: { answerIndex: 0, quote: label },
      facts: {},
      detailFields: ['character'],
    },
  ];
  coverage.global.symptoms = { value: label, status: 'reported' };
  const input = {
    phase: 'initial',
    status: 'tired',
    lang: 'vi',
    profile: { age: 35, gender: 'Nam' },
    bodyLocations: locations,
    bodyLocationOther: 'Bụng: bụng trên rốn',
    previousAnswers: [
      { step: compact.questions[0].step, question: compact.questions[0].question, answer: label },
    ],
    adaptiveState: { version: 1, sources: [], questions: [], compact },
  };
  return { input, compact, coverage };
}
beforeEach(() => {
  callTextAi.mockReset();
  callTextAi.mockImplementation(providerResponse);
});

test.each(['Đau âm ỉ', 'Đau nhói', 'Đau', 'Dull pain', 'Aching'])(
  'a selected abdominal-pain description retains its location and all owned abdominal warnings: %s',
  (label) => {
    const s = scene(['abdomen'], label);
    const next = getCompactNextStep(s.input);
    expect(next.state.primaryMapping).toBe(resolveComplaint('đau bụng').data);
    expect(next.state.allSymptoms).toEqual([label]);
    expect(next.state.bodyLocationOther).toBe('Bụng: bụng trên rốn');
    expect(next.coverageGoal.field).toBe('red_flags');
    expect(next.coverageGoal.requiredOptions.map((c) => c.label)).toEqual(
      expect.arrayContaining(resolveComplaint('đau bụng').data.redFlags)
    );
    expect(next.coverageGoal.requiredOptions.map((c) => c.label)).toContain(
      'nôn ra máu hoặc chất nâu đen'
    );
    expect(s.coverage.concerns[0].label).toBe(label);
    expect(callTextAi).not.toHaveBeenCalled();
  }
);

test.each([
  ['head', 'đau đầu'],
  ['chest', 'đau ngực'],
])(
  'other unambiguous regions bind a pain description to their existing symptom category (%s)',
  (region, key) => {
    const s = scene([region]);
    expect(getCompactNextStep(s.input).state.primaryMapping).toBe(resolveComplaint(key).data);
  }
);

test('an explicitly attributed complaint also works when multiple regions were selected', () => {
  const s = scene(['abdomen', 'head'], 'Đau âm ỉ', 'abdomen');
  expect(getCompactNextStep(s.input).state.primaryMapping).toBe(resolveComplaint('đau bụng').data);
});

test('a region is not guessed for an ambiguous multi-region selection', () => {
  const s = scene(['abdomen', 'head']);
  expect(getCompactNextStep(s.input).state.mappings).not.toContain(
    resolveComplaint('đau bụng').data
  );
});

test('bare pain in the limbs cannot acquire the headache warning menu through fuzzy matching',()=>{
 const s=scene(['limbs'],'Đau');s.input.bodyLocationOther='Tay chân: cổ chân phải';
 const next=getCompactNextStep(s.input);
 expect(next.state.mappings).not.toContain(resolveComplaint('đau đầu').data);
 expect(next.state.allSymptoms).toContain('Đau');
});

test('a new painful region explicitly spoken outside the initial selection retains its owned warnings',()=>{
 const s=scene(['skin'],'Đau âm ỉ');
 const answer='Da cổ ngứa, còn bụng dưới bên phải đau âm ỉ từ sáng nay';
 s.input.bodyLocationOther='Da: vùng cổ';
 s.input.previousAnswers[0].answer=answer;
 s.compact.questions[0].choices=[];
 s.coverage.concerns[0].facts.location={value:'bụng dưới bên phải',status:'reported',evidence:{answerIndex:0,quote:'bụng dưới bên phải'}};
 const next=getCompactNextStep(s.input);
 expect(next.state.mappings).toContain(resolveComplaint('đau bụng').data);
 expect(next.coverageGoal.requiredOptions.map(c=>c.label)).toEqual(expect.arrayContaining(resolveComplaint('đau bụng').data.redFlags));
 expect(s.coverage.concerns[0].label).toBe('Đau âm ỉ');
});

test.each(['unresolved','unquoted','ambiguous'])(
 'a %s location cannot be used to invent a new anatomical complaint',kind=>{
  const s=scene(['skin'],'Đau âm ỉ');
  s.input.bodyLocationOther='Da: vùng cổ';s.compact.questions[0].choices=[];
  s.input.previousAnswers[0].answer='Đau âm ỉ ở bụng và ngực';
  s.coverage.concerns[0].facts.location={value:kind==='ambiguous'?'bụng và ngực':'bụng',status:kind==='unresolved'?'unresolved':'reported',
   evidence:{answerIndex:kind==='unquoted'?99:0,quote:kind==='ambiguous'?'bụng và ngực':'bụng'}};
  expect(getCompactNextStep(s.input).state.mappings).not.toContain(resolveComplaint('đau bụng').data);
 });

test.each(['Ngứa', 'Không đau', 'Căng tức nhưng không đau'])(
  'non-pain or negated descriptions do not become abdominal pain: %s',
  (label) => {
    const s = scene(['abdomen'], label);
    expect(getCompactNextStep(s.input).state.mappings).not.toContain(
      resolveComplaint('đau bụng').data
    );
  }
);

test('a specifically named headache is not overwritten by the original abdominal selection', () => {
  const s = scene(['abdomen'], 'Đau đầu');
  const next = getCompactNextStep(s.input);
  expect(next.state.mappings).toContain(resolveComplaint('đau đầu').data);
  expect(next.state.mappings).not.toContain(resolveComplaint('đau bụng').data);
});

test('an unscoped later complaint does not inherit the earlier selection merely because it says pain', () => {
  const s = scene();
  s.compact.questions[0].field = 'character';
  expect(getCompactNextStep(s.input).state.mappings).not.toContain(
    resolveComplaint('đau bụng').data
  );
});

test('an already-offered generic warning is preserved and the unanswered abdominal warnings follow without repeating it', async () => {
  const s = scene();
  await refreshCoverage(s.compact, s.input);
  const labels = ['severe_shortness_of_breath', 'chest_pain_sweating', 'faint_or_drowsy'].map(
    (key) => t(`checkin.triage.option.${key}`, 'vi')
  );
  const offered = {
    step: 'compact_red_flags',
    field: 'red_flags',
    layout: 'eight_groups',
    targets: [],
    question: 'Bạn có dấu hiệu nào trong ba dấu hiệu này không?',
    choices: labels.map((label, i) => ({ id: `warning_${i}`, label })),
    warningKeys: labels,
  };
  s.compact.questions.push(offered);
  const resumed = getCompactNextStep(s.input);
  expect(resumed.step).toBe(offered.step);
  expect(resumed.coverageGoal.requiredOptions).toEqual(offered.choices);
  s.input.previousAnswers.push({
    step: offered.step,
    question: offered.question,
    answer: 'Không có',
  });
  await refreshCoverage(s.compact, s.input);
  const next = getCompactNextStep(s.input);
  expect(next.step).not.toBe(offered.step);
  expect(next.coverageGoal.requiredOptions.map((c) => c.label)).toEqual(
    expect.arrayContaining(resolveComplaint('đau bụng').data.redFlags)
  );
  expect(next.coverageGoal.requiredOptions.map((c) => c.label)).not.toEqual(
    expect.arrayContaining(labels)
  );
  expect(s.input.previousAnswers[1].answer).toBe('Không có');
});
