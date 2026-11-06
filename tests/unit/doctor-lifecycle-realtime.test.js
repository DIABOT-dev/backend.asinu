'use strict';

jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  assertTenantAllowed: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-profile.service', () => ({
  verifyDoctorSignature: jest.fn(),
}));
jest.mock('../../src/security/health-field-encryption', () => ({
  encryptHealthField: jest.fn((_userId, _field, value) => value),
}));
jest.mock('../../src/services/health/health-timeline.service', () => ({
  rebuildPatientHealthTimeline: jest.fn(async () => {}),
}));
jest.mock('../../src/services/integrations/doctor-chat-realtime', () => ({
  broadcastChatEvent: jest.fn(),
}));

const { ingestDoctorLifecycle } = require('../../src/services/integrations/doctor-lifecycle.service');
const { broadcastChatEvent } = require('../../src/services/integrations/doctor-chat-realtime');
const { rebuildPatientHealthTimeline } = require('../../src/services/health/health-timeline.service');

function request(status = 'accepted') {
  return { body: {
    event_id: 'synthetic-lifecycle-event',
    event_type: `service.${status}`,
    source: 'asinu-doctor',
    version: 1,
    occurred_at: '2026-10-29T08:00:00.000Z',
    correlation_id: 'synthetic-task',
    payload: {
      tenant_id: 'clinic-demo',
      app_order_id: 'synthetic-task',
      app_user_id: '42',
      service_code: 'doctor-consultation',
      source_channel: 'asinu-mobile',
      specialty: 'general',
      service_flow: 'clinical',
      priority: 'normal',
      summary: 'Synthetic concern',
      status,
    },
  } };
}

function database({ insert, existing, patient = true, owner = '42' } = {}) {
  return { query: jest.fn(async (sql) => {
    if (sql.includes('SELECT 1 FROM users')) return { rows: patient ? [{ exists: 1 }] : [] };
    if (sql.includes('FROM doctor_task_outbox')) return { rows: [{ app_user_id: owner }] };
    if (sql.includes('SELECT event_id')) return { rows: existing ? [existing] : [] };
    if (sql.includes('INSERT INTO doctor_task_lifecycle_events')) {
      return insert ? insert() : { rows: [{ event_id: 'synthetic-lifecycle-event', status: 'accepted' }] };
    }
    if (sql.includes('INSERT INTO doctor_patient_medical_records')) return { rows: [] };
    throw new Error('Unexpected lifecycle query');
  }) };
}

beforeEach(() => jest.clearAllMocks());

test('emits only after the new lifecycle INSERT has committed through pool autocommit', async () => {
  let finishInsert;
  let committed = false;
  const pool = database({ insert: () => new Promise((resolve) => { finishInsert = resolve; }) });
  broadcastChatEvent.mockImplementationOnce(() => expect(committed).toBe(true));
  const result = ingestDoctorLifecycle(pool, request());
  await new Promise(setImmediate);
  expect(finishInsert).toEqual(expect.any(Function));
  expect(broadcastChatEvent).not.toHaveBeenCalled();

  committed = true;
  finishInsert({ rows: [{ event_id: 'synthetic-lifecycle-event', status: 'accepted' }] });
  await expect(result).resolves.toMatchObject({ status: 'accepted', duplicate: false });
  expect(broadcastChatEvent).toHaveBeenCalledTimes(1);
  expect(broadcastChatEvent).toHaveBeenCalledWith({
    tenantId: 'clinic-demo',
    taskId: 'synthetic-task',
    type: 'chat.task.status.changed',
    data: { task_id: 'synthetic-task', status: 'accepted' },
  });
});

test('does not emit an event already ingested', async () => {
  const pool = database({ existing: { event_id: 'synthetic-lifecycle-event', status: 'accepted' } });
  await expect(ingestDoctorLifecycle(pool, request())).resolves.toMatchObject({ duplicate: true });
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});

test('does not emit when a concurrent duplicate wins the INSERT', async () => {
  const pool = database({ insert: async () => ({ rows: [] }) });
  await ingestDoctorLifecycle(pool, request());
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});

test('does not emit when the INSERT is rejected', async () => {
  const error = new Error('Synthetic insert failure');
  const pool = database({ insert: async () => { throw error; } });
  await expect(ingestDoctorLifecycle(pool, request())).rejects.toBe(error);
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});

test('does not emit lifecycle events for another patient', async () => {
  await expect(ingestDoctorLifecycle(database({ owner: '43' }), request())).rejects.toMatchObject({
    code: 'DOCTOR_TASK_NOT_FOUND',
  });
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});

test('does not emit for an account deleted before ingestion', async () => {
  await expect(ingestDoctorLifecycle(database({ patient: false }), request())).resolves.toMatchObject({
    status: 'ignored',
    ignored_reason: 'PATIENT_ACCOUNT_DELETED',
  });
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});

test('waits for completed outcome persistence and sends only lifecycle metadata', async () => {
  let finishTimeline;
  rebuildPatientHealthTimeline.mockImplementationOnce(() => new Promise((resolve) => { finishTimeline = resolve; }));
  const req = request('completed');
  req.body.payload.consultation_summary = {
    problem_summary: 'Synthetic problem',
    assessment: 'Synthetic assessment',
    next_steps: 'Synthetic next step',
    warning_signs: 'Synthetic warning',
    follow_up_recommendation: 'Synthetic recommendation',
  };
  const result = ingestDoctorLifecycle(database(), req);
  await new Promise(setImmediate);
  expect(finishTimeline).toEqual(expect.any(Function));
  expect(broadcastChatEvent).not.toHaveBeenCalled();

  finishTimeline();
  await result;
  expect(broadcastChatEvent).toHaveBeenCalledWith({
    tenantId: 'clinic-demo',
    taskId: 'synthetic-task',
    type: 'chat.task.status.changed',
    data: { task_id: 'synthetic-task', status: 'completed' },
  });
});

test('does not emit if the request fails while persisting a completed outcome', async () => {
  rebuildPatientHealthTimeline.mockRejectedValueOnce(new Error('Synthetic timeline failure'));
  const req = request('completed');
  req.body.payload.consultation_summary = {
    problem_summary: 'Synthetic problem',
    assessment: 'Synthetic assessment',
    next_steps: 'Synthetic next step',
    warning_signs: 'Synthetic warning',
    follow_up_recommendation: 'Synthetic recommendation',
  };
  await expect(ingestDoctorLifecycle(database(), req)).rejects.toThrow('Synthetic timeline failure');
  expect(broadcastChatEvent).not.toHaveBeenCalled();
});
