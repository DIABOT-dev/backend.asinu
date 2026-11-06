'use strict';

jest.mock('../../src/services/integrations/doctor-task.policy', () => ({
  screenRemoteCareSuitability: jest.fn(() => ({ suitable_for_remote_care: true })),
  normalizeSpecialty: jest.fn((value) => value),
}));
jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  enqueueDoctorTask: jest.fn(async () => ({ task_id: 'task-1' })),
}));
jest.mock('../../src/services/integrations/crm-event.service', () => ({
  enqueueCrmEvent: jest.fn(async () => {}),
}));

const policy = require('../../src/services/integrations/doctor-task.policy');
const doctorTask = require('../../src/services/integrations/doctor-task.service');
const crm = require('../../src/services/integrations/crm-event.service');
const { requestDoctorTask } = require('../../src/services/integrations/doctor-task-request.service');
const screeningAnswers = [
  ['red_flags', 'none'], ['associated', 'none'], ['onset', 'today'],
  ['progression', 'stable'], ['impact', 'mild'],
].map(([step, value]) => ({ step, values: [value], text: '' }));
const screenedInput = () => ({
  summary: 'Tôi bị đau đầu', consent_version: 'v2', service_code: 'consult', specialty: 'general',
  clinical_intake: { symptom_onset: 'today', progression: 'stable', severity: 'mild', emergency_confirmation: true, screening_answers: screeningAnswers },
});

beforeEach(() => jest.clearAllMocks());

test('stops before creating a task when the patient does not exist', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await expect(requestDoctorTask(pool, 7, {})).resolves.toEqual({ kind: 'PATIENT_NOT_FOUND' });
  expect(doctorTask.enqueueDoctorTask).not.toHaveBeenCalled();
});

test('screening blocks a remote-care task before consent or CRM writes', async () => {
  const patient = { id: 7 };
  const pool = { query: jest.fn().mockResolvedValue({ rows: [patient] }) };
  policy.screenRemoteCareSuitability.mockReturnValueOnce({ suitable_for_remote_care: false });
  await expect(requestDoctorTask(pool, 7, {})).resolves.toMatchObject({
    kind: 'REMOTE_CARE_EMERGENCY_BLOCKED',
  });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(crm.enqueueCrmEvent).not.toHaveBeenCalled();
});

test('persists versioned consent and queues both CRM events before returning the task', async () => {
  const patient = { id: 7, display_name: 'An', consent_version: 'old' };
  const pool = { query: jest.fn().mockResolvedValue({ rows: [patient] }) };
  const input = screenedInput();
  await expect(requestDoctorTask(pool, 7, input)).resolves.toMatchObject({
    kind: 'CREATED',
    result: { task_id: 'task-1' },
  });
  expect(pool.query.mock.calls[1][0]).toContain('UPDATE users');
  expect(crm.enqueueCrmEvent.mock.calls.map((call) => call[1])).toEqual([
    'consent.updated', 'service.requested',
  ]);
  expect(doctorTask.enqueueDoctorTask).toHaveBeenCalledWith(pool, {
    user: patient,
    input: expect.objectContaining({
      summary: expect.stringContaining('Bạn có dấu hiệu nào'),
      priority: 'normal', screening_result: expect.objectContaining({ screening_version: 'consultation-v2' }),
    }),
  });
});

test.each([undefined, screeningAnswers.slice(0, 3)])('missing or incomplete screening cannot create tasks or consent events: %j', answers => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 7 }] }) };
  const input = screenedInput(); input.clinical_intake.screening_answers = answers;
  return requestDoctorTask(pool, 7, input).then(outcome => {
    expect(outcome.kind).toBe('CONSULTATION_SCREENING_REQUIRED');
    expect(doctorTask.enqueueDoctorTask).not.toHaveBeenCalled();
    expect(crm.enqueueCrmEvent).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

test('rechecks warning answers at submission even if the client requests normal priority', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 7 }] }) };
  const input = screenedInput(); input.priority = 'normal';
  input.clinical_intake.screening_answers = [{ step: 'red_flags', values: ['option:0'], text: '' }];
  const outcome = await requestDoctorTask(pool, 7, input);
  expect(outcome.kind).toBe('CONSULTATION_SCREENING_REQUIRED');
  expect(outcome.screening.suitable_for_remote_care).toBe(false);
  expect(doctorTask.enqueueDoctorTask).not.toHaveBeenCalled();
});

test('client risk fields cannot downgrade the replayed answers or patient context', async () => {
  const patient = { id: 7, birth_year: 1940 };
  const pool = { query: jest.fn().mockResolvedValue({ rows: [patient] }) };
  const input = screenedInput(); input.priority = 'normal';
  input.clinical_intake.screening_answers = screeningAnswers.map(answer => answer.step === 'progression'
    ? { ...answer, values: ['worsening'] } : answer);
  await requestDoctorTask(pool, 7, input);
  const queued = doctorTask.enqueueDoctorTask.mock.calls[0][1].input;
  expect(queued.priority).toBe('high');
  expect(queued.clinical_intake.progression).toBe('worsening');
  expect(queued.summary).toContain('Nặng dần');
});
