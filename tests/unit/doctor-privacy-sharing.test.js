'use strict';

const oldUrl = process.env.DOCTOR_TASKS_URL;
const oldSecret = process.env.DOCTOR_ASINU_INTEGRATION_SECRET;
const originalFetch = global.fetch;
process.env.DOCTOR_TASKS_URL = 'https://doctor.example.test/tasks';
process.env.DOCTOR_ASINU_INTEGRATION_SECRET = 'privacy-test-secret';
const {
  submitPrivacyRequest,
  listPrivacyReceipts,
} = require('../../src/services/integrations/doctor-task.service');

afterAll(() => {
  global.fetch = originalFetch;
  if (oldUrl === undefined) delete process.env.DOCTOR_TASKS_URL;
  else process.env.DOCTOR_TASKS_URL = oldUrl;
  if (oldSecret === undefined) delete process.env.DOCTOR_ASINU_INTEGRATION_SECRET;
  else process.env.DOCTOR_ASINU_INTEGRATION_SECRET = oldSecret;
});

test('acceptance is sent to Doctor before recording local consent and its receipt', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { action: 'grant_consent', consent_status: 'accepted' } }),
    });
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await submitPrivacyRequest(pool, {
    userId: 42,
    input: { tenant_id: 'clinic-demo', action: 'grant_consent', consent_version: 'v2' },
  });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).payload).toMatchObject({
    app_user_id: '42',
    action: 'grant_consent',
    consent_version: 'v2',
  });
  expect(pool.query.mock.calls[0][1]).toEqual(['v2', 42]);
  expect(pool.query.mock.calls[1][1].slice(0, 3)).toEqual([42, 'clinic-demo', 'grant_consent']);
});

test('a rejected Doctor request cannot enable local sharing or record success', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
  const pool = { query: jest.fn() };
  await expect(
    submitPrivacyRequest(pool, {
      userId: 42,
      input: { tenant_id: 'clinic-demo', action: 'grant_consent', consent_version: 'v2' },
    })
  ).rejects.toThrow();
  expect(pool.query).not.toHaveBeenCalled();
});

test.each([true, false, null])(
  'returns the specialist-specific sharing decision %s',
  async (enabled) => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: enabled === null ? [] : [{ enabled }] })
        .mockResolvedValueOnce({ rows: [{ details_anonymized: false }] }),
    };
    await expect(listPrivacyReceipts(pool, 42, 'clinic-demo')).resolves.toEqual({
      items: [],
      sharing_enabled: enabled === true,
      details_anonymized: false,
    });
    expect(pool.query.mock.calls[1][1]).toEqual([42, 'clinic-demo', '42']);
  }
);

test('keeps the legacy history-only response when no tenant is supplied', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await expect(listPrivacyReceipts(pool, 42)).resolves.toEqual({ items: [] });
  expect(pool.query).toHaveBeenCalledTimes(1);
});
