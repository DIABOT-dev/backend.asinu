'use strict';

jest.mock('../../src/services/media/cloudinary-upload.service', () => ({ deleteAsset: jest.fn() }));

const originalConfig = {
  url: process.env.DOCTOR_TASKS_URL,
  secret: process.env.DOCTOR_ASINU_INTEGRATION_SECRET,
  tenants: process.env.DOCTOR_ALLOWED_TENANT_IDS,
};
process.env.DOCTOR_TASKS_URL = 'https://doctor.example.test/tasks';
process.env.DOCTOR_ASINU_INTEGRATION_SECRET = 'synthetic-idempotency-test-secret';
process.env.DOCTOR_ALLOWED_TENANT_IDS = 'clinic-demo,clinic-other';

const { enqueueDoctorTask } = require('../../src/services/integrations/doctor-task.service');

const request = () => ({
  user: {
    id: 42,
    display_name: 'Synthetic patient',
    age_group: '40-49',
    gender: 'other',
    profile_version: new Date('2026-10-29T07:00:00.000Z'),
  },
  input: {
    tenant_id: 'clinic-demo',
    task_id: 'doctor-task:synthetic-retry',
    specialty: 'general',
    service_flow: 'clinical',
    priority: 'normal',
    source_channel: 'asinu-mobile',
    service_code: 'doctor-consultation',
    summary: 'Synthetic routine concern',
    clinical_intake: {
      symptom_onset: 'today',
      progression: 'stable',
      severity: 'mild',
      emergency_confirmation: true,
    },
    consent_version: 'v1.0.0',
  },
});

function outbox() {
  let stored = null;
  return {
    get stored() { return stored; },
    query: jest.fn(async (sql, params) => {
      if (sql.includes('INSERT INTO doctor_task_outbox')) {
        if (stored) return { rowCount: 0, rows: [] };
        stored = JSON.parse(params[3]);
        return { rowCount: 1, rows: [{ event_id: stored.event_id }] };
      }
      if (sql.includes('SELECT payload')) return { rows: [{ payload: stored }] };
      throw new Error('Unexpected outbox query');
    }),
  };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-29T07:10:00.000Z'));
});

afterEach(() => jest.useRealTimers());

afterAll(() => {
  for (const [key, value] of Object.entries({
    DOCTOR_TASKS_URL: originalConfig.url,
    DOCTOR_ASINU_INTEGRATION_SECRET: originalConfig.secret,
    DOCTOR_ALLOWED_TENANT_IDS: originalConfig.tenants,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('retrying unchanged consultation data later reuses the queued task and original signed envelope', async () => {
  const pool = outbox();
  const input = request();
  const first = await enqueueDoctorTask(pool, input);
  const originalEnvelope = JSON.stringify(pool.stored);
  jest.advanceTimersByTime(15_000);

  await expect(enqueueDoctorTask(pool, input)).resolves.toEqual(first);
  expect(JSON.stringify(pool.stored)).toBe(originalEnvelope);
  expect(pool.query).toHaveBeenCalledTimes(3);
});

test('a consent write changing the patient profile timestamp does not invalidate an unchanged retry', async () => {
  const pool = outbox();
  const input = request();
  const first = await enqueueDoctorTask(pool, input);
  const originalEnvelope = JSON.stringify(pool.stored);
  jest.advanceTimersByTime(15_000);
  const retry = request();
  retry.user.profile_version = new Date();

  await expect(enqueueDoctorTask(pool, retry)).resolves.toEqual(first);
  expect(JSON.stringify(pool.stored)).toBe(originalEnvelope);
});

test.each([
  ['patient owner', (value) => { value.user.id = 43; }],
  ['patient demographics', (value) => { value.user.age_group = '50-59'; }],
  ['tenant', (value) => { value.input.tenant_id = 'clinic-other'; }],
  ['summary', (value) => { value.input.summary = 'Changed synthetic concern'; }],
  ['specialty', (value) => { value.input.specialty = 'internal_medicine'; }],
  ['intake', (value) => { value.input.clinical_intake.severity = 'moderate'; }],
  ['consent', (value) => { value.input.consent_version = 'v2.0.0'; }],
  ['preferred doctor', (value) => { value.input.preferred_doctor_id = '10000000-0000-4000-8000-000000000001'; }],
])('reusing a task id with different %s still conflicts and preserves the queued envelope', async (_label, change) => {
  const pool = outbox();
  await enqueueDoctorTask(pool, request());
  const originalEnvelope = JSON.stringify(pool.stored);
  jest.advanceTimersByTime(15_000);
  const retry = request();
  change(retry);

  await expect(enqueueDoctorTask(pool, retry)).rejects.toMatchObject({
    statusCode: 409,
    code: 'DOCTOR_TASK_IDEMPOTENCY_CONFLICT',
  });
  expect(JSON.stringify(pool.stored)).toBe(originalEnvelope);
});
