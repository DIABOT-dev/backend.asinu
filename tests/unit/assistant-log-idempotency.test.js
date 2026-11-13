jest.mock('../../src/lib/redis', () => ({ cacheDel: jest.fn(async () => {}) }));
jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn() }));
jest.mock('../../src/services/integrations/crm-event.service', () => ({ emitCrmEventAsync: jest.fn() }));
jest.mock('../../src/security/health-field-encryption', () => ({ decryptHealthField: jest.fn() }));
jest.mock('../../src/services/missions/missions.service', () => ({ updateMissionProgress: jest.fn(async () => {}) }));
const { createLog } = require('../../src/services/profile/mobile.service');
const { updateMissionProgress } = require('../../src/services/missions/missions.service');

function database() {
  const rows = []; const queries = [];
  const client = { release: jest.fn(), query: jest.fn(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes("metadata->>'request_key'")) {
      const previous = rows.find(row => row.userId === params[0] && row.metadata.request_key === params[1]);
      return { rowCount: previous ? 1 : 0, rows: previous ? [previous] : [] };
    }
    if (sql.includes('INSERT INTO logs_common')) {
      const row = { id: `log-${rows.length + 1}`, userId: params[0], log_type: params[1], metadata: params[5] };
      rows.push(row); return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) };
  return { rows, queries, connect: async () => client, query: client.query };
}
const water = { log_type: 'water', occurred_at: '2026-11-13T10:00:00Z', data: { volume_ml: 500 } };
beforeEach(() => jest.clearAllMocks());

test('a response-lost retry returns the same log without repeating missions', async () => {
  const db = database();
  const first = await createLog(db, 1, water, { requestKey: 'assistant:request:0' });
  const second = await createLog(db, 1, water, { requestKey: 'assistant:request:0' });
  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: true, logId: first.logId, replayed: true });
  expect(db.rows).toHaveLength(1);
  expect(updateMissionProgress).toHaveBeenCalledTimes(2); // water + daily, only once
  expect(db.queries.filter(([sql]) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
});

test('idempotency is account-scoped and cannot return another account record', async () => {
  const db = database();
  const first = await createLog(db, 1, water, { requestKey: 'same-request' });
  const second = await createLog(db, 2, water, { requestKey: 'same-request' });
  expect(second.logId).not.toBe(first.logId);
  expect(db.rows.map(row => row.userId)).toEqual([1, 2]);
});

test('changing the payload under the same key is a conflict', async () => {
  const db = database();
  await createLog(db, 1, water, { requestKey: 'same-request' });
  const result = await createLog(db, 1, { ...water, data: { volume_ml: 250 } }, { requestKey: 'same-request' });
  expect(result).toMatchObject({ ok: false, statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
  expect(db.rows).toHaveLength(1);
});

test('untrusted metadata cannot forge the internal idempotency key', async () => {
  const db = database();
  await createLog(db, 1, { ...water, metadata: { request_key: 'forged', request_fingerprint: 'fake' } });
  expect(db.rows[0].metadata).toEqual({});
});
