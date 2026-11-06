'use strict';

const {
  evaluateConsultationScreening: evaluate,
  screeningRequestSchema,
} = require('../../src/services/integrations/doctor-screening.service');
const { buildDoctorTaskEnvelope } = require('../../src/services/integrations/doctor-task.policy');
const profile = { birth_year: 1992, medical_conditions: [] };
const summary = 'Tôi bị đau đầu';
const answer = (step, value, text = '') => ({
  step,
  values: Array.isArray(value) ? value : [value],
  text,
});
const answers = [
  answer('red_flags', 'none'),
  answer('associated', 'none'),
  answer('onset', 'today'),
  answer('progression', 'stable'),
  answer('impact', 'mild'),
];
const run = (values = [], extra = {}, patient = profile) =>
  evaluate({ summary, answers: values, locale: 'vi', ...extra }, patient);

test('description is required and danger checks come before timeline and impact', () => {
  expect(screeningRequestSchema.safeParse({ summary: ' ' }).success).toBe(false);
  expect(run().question.step).toBe('red_flags');
  expect(run().recorded_answers).toEqual([]);
});

test('warning options depend on the described symptoms and retain general warning signs', () => {
  const headache = run().question.options.map((item) => item.label);
  const abdominal = run([], { summary: 'Tôi bị đau bụng' }).question.options.map(
    (item) => item.label
  );
  expect(headache).not.toEqual(abdominal);
  expect(headache).toContain('Khó thở dữ dội');
  expect(headache.some((label) => label.includes('đau đầu'))).toBe(true);
});

test.each(['vi', 'en'])('%s completes all stages in order and records exact answers', (locale) => {
  const steps = ['red_flags', 'associated', 'onset', 'progression', 'impact'];
  steps.forEach((step, index) =>
    expect(run(answers.slice(0, index), { locale }).question.step).toBe(step)
  );
  const result = run(answers, { locale });
  expect(result).toMatchObject({
    status: 'ready',
    suitable_for_remote_care: true,
    risk_level: 'low',
    intake: { symptom_onset: 'today', progression: 'stable', severity: 'mild' },
  });
  expect(result.recorded_answers.map((item) => item.step)).toEqual(steps);
  expect(result.message).not.toContain('doctor.screening.');
});

test('a warning detected in the original description stops before further questions', () => {
  const result = run([], { summary: 'Tôi bị yếu nửa người và nói ngọng đột ngột' });
  expect(result).toMatchObject({ status: 'emergency', suitable_for_remote_care: false });
  expect(result.question).toBeUndefined();
});

test('reported danger signs block remote consultation even when free text detection misses the term', () => {
  const result = run([answer('red_flags', 'option:0')]);
  expect(['emergency', 'needs_in_person']).toContain(result.status);
  expect(result.suitable_for_remote_care).toBe(false);
});

test('uncertainty about danger signs is explicitly incomplete', () => {
  expect(run([answer('red_flags', 'unsure')])).toMatchObject({
    status: 'incomplete',
    risk_level: 'medium',
    suitable_for_remote_care: false,
  });
  expect(run([answer('red_flags', [], 'Không rõ')])).toMatchObject({
    status: 'incomplete',
    suitable_for_remote_care: false,
  });
});

test('an associated symptom marked dangerous by the shared mapping also stops the flow', () => {
  const result = run([answers[0], answer('associated', 'option:2')]);
  expect(['emergency', 'needs_in_person']).toContain(result.status);
  expect(result.suitable_for_remote_care).toBe(false);
});

test.each([
  [answer('onset', 'today')],
  [answer('red_flags', ['none', 'option:0'])],
  [answer('red_flags', 'none', 'another symptom')],
  [answer('red_flags', 'invalid')],
  [answer('red_flags', [])],
  [...answers, answer('impact', 'mild')],
])('cannot skip stages, contradict none, or submit unknown choices: %j', (values) => {
  expect(() => run(values)).toThrow();
});

test('impact and worsening use shared risk rules, never downgrade a vulnerable patient', () => {
  const severe = [...answers.slice(0, -1), answer('impact', 'severe')];
  expect(run(severe).risk_level).toBe('medium');
  const worse = [...answers.slice(0, 3), answer('progression', 'worsening'), answers[4]];
  expect(run(worse, {}, { birth_year: 1940 }).risk_level).toBe('high');
});

test('the signed Doctor boundary retains its existing strict intake shape', () => {
  const payload = buildDoctorTaskEnvelope({
    user: { id: 7 },
    input: {
      tenant_id: 'clinic',
      summary,
      specialty: 'general',
      service_flow: 'clinical',
      priority: 'normal',
      consent_version: 'v1',
      clinical_intake: {
        ...run(answers).intake,
        emergency_confirmation: true,
        screening_answers: answers,
        screening_locale: 'vi',
      },
    },
  }).payload;
  expect(Object.keys(payload.clinical_intake).sort()).toEqual([
    'emergency_confirmation',
    'progression',
    'severity',
    'symptom_onset',
  ]);
});
