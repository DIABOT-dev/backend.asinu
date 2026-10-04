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
  const input = { consent_version: 'v2', service_code: 'consult', specialty: 'general' };
  await expect(requestDoctorTask(pool, 7, input)).resolves.toMatchObject({
    kind: 'CREATED',
    result: { task_id: 'task-1' },
  });
  expect(pool.query.mock.calls[1][0]).toContain('UPDATE users');
  expect(crm.enqueueCrmEvent.mock.calls.map((call) => call[1])).toEqual([
    'consent.updated', 'service.requested',
  ]);
  expect(doctorTask.enqueueDoctorTask).toHaveBeenCalledWith(pool, { user: patient, input });
});
