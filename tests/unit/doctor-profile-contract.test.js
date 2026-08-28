const crypto = require('node:crypto');

process.env.DOCTOR_ASINU_INTEGRATION_SECRET = 'doctor-profile-test-secret';
process.env.DOCTOR_DEFAULT_TENANT_ID = 'clinic-demo';
delete require.cache[require.resolve('../../src/services/integrations/doctor-profile.service')];
const {
  assertProfileRequest,
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
        'x-doctor-signature': `${signature.slice(0, -1)}0`,
      },
      rawBody,
      body,
    })
  ).toThrow();
  expect(() =>
    assertProfileRequest({ tenant_id: 'other-clinic', app_user_id: '42', task_id: 'task-1' })
  ).toThrow();
});
