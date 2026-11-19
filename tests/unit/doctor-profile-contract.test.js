const crypto = require('node:crypto');

process.env.DOCTOR_ASINU_INTEGRATION_SECRET = 'doctor-profile-test-secret';
process.env.DOCTOR_DEFAULT_TENANT_ID = 'clinic-demo';
delete require.cache[require.resolve('../../src/services/integrations/doctor-profile.service')];
const {
  assertProfileRequest,
  loadPatientProfile,
  verifyDoctorSignature,
} = require('../../src/services/integrations/doctor-profile.service');

test('doctor profile boundary accepts a valid tenant-scoped request', () => {
  expect(
    assertProfileRequest({ tenant_id: 'clinic-demo', app_user_id: '42', task_id: 'task-1' })
  ).toEqual({ tenantId: 'clinic-demo', appUserId: '42', taskId: 'task-1' });
});

test('doctor profile boundary rejects invalid signatures and tenants', () => {
  const body = { tenant_id: 'clinic-demo', app_user_id: '42', task_id: 'task-1' };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', process.env.DOCTOR_ASINU_INTEGRATION_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  expect(() =>
    verifyDoctorSignature({
      headers: { 'x-doctor-timestamp': timestamp, 'x-doctor-signature': signature },
      rawBody,
      body,
    })
  ).not.toThrow();
  expect(() =>
    verifyDoctorSignature({
      headers: {
        'x-doctor-timestamp': timestamp,
        'x-doctor-signature': `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
      },
      rawBody,
      body,
    })
  ).toThrow();
  expect(() =>
    assertProfileRequest({ tenant_id: 'other-clinic', app_user_id: '42', task_id: 'task-1' })
  ).toThrow();
});

test('doctor patient profile includes the assigned patient avatar from the profile record', async () => {
  const avatarUrl = 'https://avatar.example/patient.jpg';
  const body = { tenant_id: 'clinic-demo', app_user_id: '42', task_id: 'task-1' };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', process.env.DOCTOR_ASINU_INTEGRATION_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const req = {
    headers: { 'x-doctor-timestamp': timestamp, 'x-doctor-signature': signature },
    rawBody,
    body,
  };
  const pool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ app_user_id: '42' }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, avatar_url: avatarUrl }] })
      .mockImplementation(async () => ({ rows: [] })),
  };

  await expect(loadPatientProfile(pool, req)).resolves.toMatchObject({ avatar_url: avatarUrl });
  expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('u.avatar_url'), ['42']);
});
