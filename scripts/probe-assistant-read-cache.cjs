'use strict';

// Fixed synthetic request and database fixture only. Two real model calls plan
// and review the first read; replay must fetch current rows with zero model calls.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { getClinicalConfig } = require('../src/services/ai/providers/clinical-config');
const config = getClinicalConfig();
assert.equal(config.provider, '9router', 'Configure 9Router before running the probe.');
assert.ok(config.endpoint && config.apiKey && config.model);
process.env.JWT_SECRET = 'synthetic-read-cache-probe-no-production-capabilities';
const assistant = require('../src/services/assistant/app-assistant.service');
const cache = require('../src/services/assistant/assistant-read-cache.service');
const { withPublicAiTemplate } = require('../src/services/ai/ai-consent.service');
const request = { text: 'Tôi còn thông báo nào chưa đọc?', current: { language: 'vi', fontSize: 'normal' } };
let notice = 'Synthetic notice before replay';
let requests = 0;
let tokens = 0;
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  assert.equal(String(url), config.endpoint, 'Unexpected external request');
  assert.ok(++requests <= 4, 'Unexpected number of model calls');
  const response = await realFetch(url, options);
  const data = await response.clone().json();
  tokens += data.usage?.total_tokens || 0;
  return response;
};
const queries = [];
async function query(sql) {
  const normalized = sql.trim();
  queries.push(normalized.split(/\s+/).slice(0, 4).join(' '));
  if (['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [] };
  assert.ok(/^SELECT\b/i.test(normalized), 'Writes are prohibited');
  if (sql.includes('user_ai_consents')) return { rows: [{ allowed: 1 }] };
  if (sql.includes('COUNT(*)') && sql.includes('notifications')) return { rows: [{ count: 1 }] };
  if (sql.includes('FROM notifications')) return { rows: [{
    id: 1, type: 'synthetic', title: notice, message: 'Synthetic current data only.', data: {},
    is_read: false, created_at: '2026-11-17T05:00:00Z',
  }] };
  throw new Error('Unexpected database query in synthetic probe');
}
const client = { query, release() {} };
const pool = { query, async connect() { return client; } };

(async () => {
  const planned = await withPublicAiTemplate(() => assistant.plan(request, 'vi', { pool, userId: 7 }));
  assert.equal(planned.status, 'answer');
  assert.equal(planned.actions.length, 0);
  assert.ok(planned.readCache?.token, 'The approved read must have a replay capability');
  assert.ok(planned.answer.includes(notice));
  const firstRequests = requests;
  notice = 'Synthetic notice UPDATED on server';
  const repeated = await cache.replay({ token: planned.readCache.token, request }, 'vi', { pool, userId: 7 });
  assert.ok(repeated.answer.includes(notice), 'Replay must use current server rows');
  assert.notEqual(repeated.answer, planned.answer);
  assert.deepEqual(repeated.readCache, planned.readCache, 'Replay cannot extend expiry');
  assert.deepEqual(repeated.actions, []);
  assert.equal(requests, firstRequests, 'Replay must not call AI');
  console.log(JSON.stringify({ probe: 'passed', provider: config.provider, model: config.model,
    firstPlanModelCalls: firstRequests, replayModelCalls: requests - firstRequests,
    gatewayReportedTokens: tokens, currentDataRefreshed: true, expiryUnchanged: true,
    readOnlyTransaction: queries.includes('BEGIN READ ONLY'), patientDatabaseAccessed: false }));
})().catch(error => {
  console.error(JSON.stringify({ probe: 'failed', code: error.code || error.name, message: error.message }));
  process.exitCode = 1;
});
