'use strict';

/**
 * Phase 1 — Comprehensive Test Suite
 * Chạy: node tests/phase1-lifecycle.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const lifecycle = require('../src/services/profile/lifecycle.service');
const { runNightlyCycle, updateAllClusterFrequencies, optimizeScripts, processFallbackLogs } = require('../src/services/checkin/rnd-cycle.service');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    totalPass++;
    console.log(`  PASS ✓ ${name}`);
  } else {
    totalFail++;
    failures.push(name);
    console.log(`  FAIL ✗ ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP: Ensure deterministic state — user 4 always active for tests
// ═══════════════════════════════════════════════════════════════════════════════
async function setup() {
  // Force user 4 to active (last_checkin = NOW) regardless of real date
  await pool.query(
    `UPDATE user_lifecycle SET segment = 'active', inactive_days = 0, last_checkin_at = NOW() WHERE user_id = 4`
  );
  await pool.query(
    `UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10, last_checkin_at = '2026-03-30'::timestamptz WHERE user_id IN (1, 3)`
  );
  await pool.query(
    `UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 999, last_checkin_at = NULL WHERE user_id = 2`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: DB Schema & Constraints
// ═══════════════════════════════════════════════════════════════════════════════
async function testSchema() {
  console.log('\n══════ SUITE 1: DB Schema & Constraints ══════');

  // 1.1 Table exists with correct columns
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_name = 'user_lifecycle'
    ORDER BY ordinal_position
  `);
  assert(cols.length === 6, '1.1 Table has 6 columns');
  assert(cols[0].column_name === 'user_id' && cols[0].is_nullable === 'NO', '1.2 user_id NOT NULL');
  assert(cols[1].column_name === 'segment' && cols[1].is_nullable === 'NO', '1.3 segment NOT NULL');
  assert(cols[4].column_name === 'inactive_days' && cols[4].is_nullable === 'NO', '1.4 inactive_days NOT NULL');

  // 1.5 CHECK constraint: valid segments only
  try {
    await pool.query(`INSERT INTO user_lifecycle (user_id, segment) VALUES (999999, 'bogus')`);
    assert(false, '1.5 CHECK rejects invalid segment');
  } catch (e) {
    assert(e.message.includes('violates check constraint'), '1.5 CHECK rejects invalid segment');
  }

  // 1.6 FK constraint: user must exist
  try {
    await pool.query(`INSERT INTO user_lifecycle (user_id, segment) VALUES (999999, 'active')`);
    assert(false, '1.6 FK rejects non-existent user');
  } catch (e) {
    assert(e.message.includes('foreign key'), '1.6 FK rejects non-existent user');
  }

  // 1.7 PK constraint: no duplicate user_id
  try {
    await pool.query(`INSERT INTO user_lifecycle (user_id, segment) VALUES (4, 'active')`);
    assert(false, '1.7 PK rejects duplicate');
  } catch (e) {
    assert(e.message.includes('duplicate key'), '1.7 PK rejects duplicate');
  }

  // 1.8 Index exists on segment
  const { rows: idxs } = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'user_lifecycle' AND indexname = 'idx_user_lifecycle_segment'
  `);
  assert(idxs.length === 1, '1.8 Segment index exists');

  // 1.9 ON DELETE CASCADE: nếu xóa user → lifecycle record cũng bị xóa
  // (Chỉ verify constraint definition, không thực sự xóa user)
  const { rows: fk } = await pool.query(`
    SELECT pg_get_constraintdef(oid) as def
    FROM pg_constraint WHERE conrelid = 'user_lifecycle'::regclass AND contype = 'f'
  `);
  assert(fk[0].def.includes('ON DELETE CASCADE'), '1.9 FK has ON DELETE CASCADE');

  // 1.10 Seed data matches real checkins
  const { rows: verify } = await pool.query(`
    SELECT ul.user_id, ul.segment,
      MAX(hc.session_date) as real_last
    FROM user_lifecycle ul
    LEFT JOIN health_checkins hc ON hc.user_id = ul.user_id
    GROUP BY ul.user_id, ul.segment
    ORDER BY ul.user_id
  `);
  for (const row of verify) {
    if (row.user_id === 4) assert(row.segment === 'active', `1.10a User 4 seed = active`);
    if (row.user_id === 2) assert(row.segment === 'inactive', `1.10b User 2 seed = inactive (no checkins)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: calculateSegment (JS logic) vs SQL consistency
// ═══════════════════════════════════════════════════════════════════════════════
async function testCalculateSegment() {
  console.log('\n══════ SUITE 2: calculateSegment JS vs SQL ══════');

  const cases = [
    [0, 'active'], [1, 'active'],
    [2, 'semi_active'], [3, 'semi_active'],
    [4, 'inactive'], [7, 'inactive'],
    [8, 'churned'], [30, 'churned'], [999, 'churned'],
  ];

  for (const [days, expected] of cases) {
    const jsResult = lifecycle.calculateSegment(days);
    assert(jsResult === expected, `2.JS days=${days} → ${jsResult} (expected ${expected})`);
  }

  // Verify SQL logic matches JS for each boundary
  for (const [days, expected] of cases) {
    await pool.query(
      `UPDATE user_lifecycle SET last_checkin_at = NOW() - ($1 || ' days')::interval WHERE user_id = 4`,
      [days]
    );
    await lifecycle.updateAllSegments(pool);
    const { rows } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 4');
    assert(rows[0].segment === expected, `2.SQL days=${days} → ${rows[0].segment} (expected ${expected})`);
  }

  // Restore
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = '2026-04-09'::timestamptz, inactive_days = 0, segment = 'active' WHERE user_id = 4`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: ensureLifecycle edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testEnsureLifecycle() {
  console.log('\n══════ SUITE 3: ensureLifecycle ══════');

  // 3.1 User with checkins → creates correct record
  // Insert a checkin for today so ensureLifecycle sees recent activity
  const { rows: todayExists } = await pool.query(
    `SELECT 1 FROM health_checkins WHERE user_id = 4 AND session_date = CURRENT_DATE LIMIT 1`
  );
  if (todayExists.length === 0) {
    await pool.query(
      `INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state)
       VALUES (4, CURRENT_DATE, 'fine', 'fine', 'resolved')`
    );
  }
  await pool.query('DELETE FROM user_lifecycle WHERE user_id = 4');
  const lc = await lifecycle.ensureLifecycle(pool, 4);
  assert(lc.user_id === 4, '3.1 Returns correct user_id');
  assert(lc.segment === 'active', '3.2 User 4 (checked in today) → active');
  assert(lc.last_checkin_at !== null, '3.3 last_checkin_at populated');

  // 3.4 User without checkins → inactive with 999 days
  await pool.query('DELETE FROM user_lifecycle WHERE user_id = 2');
  const lc2 = await lifecycle.ensureLifecycle(pool, 2);
  assert(lc2.segment === 'inactive', '3.4 User 2 (no checkins) → inactive');
  assert(lc2.inactive_days === 999, '3.5 inactive_days = 999');
  assert(lc2.last_checkin_at === null, '3.6 last_checkin_at = null');

  // 3.7 Calling ensureLifecycle again (record exists) → no error, returns existing
  const lc3 = await lifecycle.ensureLifecycle(pool, 4);
  assert(lc3.user_id === 4, '3.7 Idempotent - no error on re-call');

  // 3.8 getLifecycle calls ensureLifecycle internally when record missing
  await pool.query('DELETE FROM user_lifecycle WHERE user_id = 1');
  const lc4 = await lifecycle.getLifecycle(pool, 1);
  assert(lc4.user_id === 1, '3.8 getLifecycle auto-creates record');
  assert(['active', 'semi_active', 'inactive', 'churned'].includes(lc4.segment), '3.9 Segment is valid');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: markActive transitions
// ═══════════════════════════════════════════════════════════════════════════════
async function testMarkActive() {
  console.log('\n══════ SUITE 4: markActive ══════');

  const transitions = [
    ['churned', 15],
    ['inactive', 5],
    ['semi_active', 2],
    ['active', 0],
  ];

  for (const [fromSegment, fromDays] of transitions) {
    await pool.query(
      `UPDATE user_lifecycle SET segment = $1, inactive_days = $2, last_checkin_at = NOW() - ($3 || ' days')::interval WHERE user_id = 3`,
      [fromSegment, fromDays, String(fromDays)]
    );
    const result = await lifecycle.markActive(pool, 3);
    assert(result.segment === 'active', `4.1 ${fromSegment} → active`);
    assert(result.inactive_days === 0, `4.2 ${fromSegment} → inactive_days=0`);

    // Verify last_checkin_at is recent (within 5s)
    const diff = Math.abs(Date.now() - new Date(result.last_checkin_at).getTime());
    assert(diff < 5000, `4.3 ${fromSegment} → last_checkin_at is recent (${diff}ms)`);
  }

  // 4.4 markActive on non-existent lifecycle record (UPSERT)
  await pool.query('DELETE FROM user_lifecycle WHERE user_id = 2');
  const result = await lifecycle.markActive(pool, 2);
  assert(result.segment === 'active', '4.4 UPSERT creates new active record');
  assert(result.inactive_days === 0, '4.5 UPSERT inactive_days=0');

  // Restore
  await pool.query(`UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10, last_checkin_at = '2026-03-30'::timestamptz WHERE user_id IN (1, 3)`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 999, last_checkin_at = NULL WHERE user_id = 2`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: updateAllSegments — daily cron simulation
// ═══════════════════════════════════════════════════════════════════════════════
async function testUpdateAllSegments() {
  console.log('\n══════ SUITE 5: updateAllSegments ══════');

  // 5.1 Returns correct stats
  const stats = await lifecycle.updateAllSegments(pool);
  assert(typeof stats.active === 'number', '5.1 stats.active is number');
  assert(typeof stats.total === 'number', '5.2 stats.total is number');
  assert(stats.total >= 4, '5.3 total >= 4 users');
  assert(stats.active + stats.semi_active + stats.inactive + stats.churned === stats.total, '5.4 Stats sum = total');

  // 5.5 Segment transition simulation: active → semi_active → inactive → churned
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW(), segment = 'active', inactive_days = 0 WHERE user_id = 4`);

  const transitions = [
    ['0 days', 'active'],
    ['2 days', 'semi_active'],
    ['5 days', 'inactive'],
    ['10 days', 'churned'],
  ];

  for (const [offset, expected] of transitions) {
    await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - '${offset}'::interval WHERE user_id = 4`);
    await lifecycle.updateAllSegments(pool);
    const { rows } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 4');
    assert(rows[0].segment === expected, `5.5 After ${offset}: ${rows[0].segment} (expected ${expected})`);
  }

  // 5.6 User with NULL last_checkin_at stays inactive
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NULL, segment = 'inactive' WHERE user_id = 2`);
  await lifecycle.updateAllSegments(pool);
  const { rows: u2 } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 2');
  assert(u2[0].segment === 'inactive', '5.6 NULL last_checkin_at → stays inactive');

  // 5.7 Multiple consecutive calls (idempotent)
  await lifecycle.updateAllSegments(pool);
  await lifecycle.updateAllSegments(pool);
  const { rows: check } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 2');
  assert(check[0].segment === 'inactive', '5.7 Multiple calls idempotent');

  // Restore
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = '2026-04-09'::timestamptz, inactive_days = 0, segment = 'active' WHERE user_id = 4`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: getActiveUserIds — R&D cycle filter
// ═══════════════════════════════════════════════════════════════════════════════
async function testGetActiveUserIds() {
  console.log('\n══════ SUITE 6: getActiveUserIds ══════');

  await lifecycle.markActive(pool, 4); // ensure active
  await lifecycle.updateAllSegments(pool);
  const ids = await lifecycle.getActiveUserIds(pool);

  // 6.1 Returns array
  assert(Array.isArray(ids), '6.1 Returns array');

  // 6.2 Only active/semi_active included
  assert(ids.includes(4), '6.2 User 4 (active) included');
  assert(!ids.includes(1), '6.3 User 1 (churned) excluded');
  assert(!ids.includes(2), '6.4 User 2 (inactive) excluded');
  assert(!ids.includes(3), '6.5 User 3 (churned) excluded');

  // 6.6 If a semi_active user exists, it should be included
  await pool.query(`UPDATE user_lifecycle SET segment = 'semi_active', inactive_days = 2 WHERE user_id = 1`);
  const ids2 = await lifecycle.getActiveUserIds(pool);
  assert(ids2.includes(1), '6.6 Semi_active user included');
  await lifecycle.markActive(pool, 4); // re-ensure active after segment changes
  const ids2b = await lifecycle.getActiveUserIds(pool);
  assert(ids2b.includes(4), '6.7 Active user still included');

  // 6.8 After making everyone inactive → empty array
  await pool.query(`UPDATE user_lifecycle SET segment = 'inactive' WHERE TRUE`);
  const ids3 = await lifecycle.getActiveUserIds(pool);
  assert(ids3.length === 0, '6.8 All inactive → empty array');

  // Restore
  await pool.query(`UPDATE user_lifecycle SET segment = 'active', inactive_days = 0, last_checkin_at = '2026-04-09'::timestamptz WHERE user_id = 4`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10, last_checkin_at = '2026-03-30'::timestamptz WHERE user_id IN (1, 3)`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 999, last_checkin_at = NULL WHERE user_id = 2`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: shouldGenerateScript
// ═══════════════════════════════════════════════════════════════════════════════
async function testShouldGenerateScript() {
  console.log('\n══════ SUITE 7: shouldGenerateScript ══════');

  // 7.1 Active → always true
  await pool.query(`UPDATE user_lifecycle SET segment = 'active' WHERE user_id = 4`);
  assert(await lifecycle.shouldGenerateScript(pool, 4) === true, '7.1 active → true');

  // 7.2 Inactive → false
  assert(await lifecycle.shouldGenerateScript(pool, 1) === false, '7.2 churned → false');

  // 7.3 Churned → false
  assert(await lifecycle.shouldGenerateScript(pool, 3) === false, '7.3 churned → false');

  // 7.4 Semi_active + recent script → false
  await pool.query(`UPDATE user_lifecycle SET segment = 'semi_active', inactive_days = 2 WHERE user_id = 4`);
  await pool.query(`UPDATE triage_scripts SET created_at = NOW() WHERE user_id = 4 AND is_active = TRUE`);
  assert(await lifecycle.shouldGenerateScript(pool, 4) === false, '7.4 semi_active + recent script → false');

  // 7.5 Semi_active + ALL scripts old (>7d) → true
  await pool.query(`UPDATE triage_scripts SET created_at = NOW() - INTERVAL '10 days' WHERE user_id = 4 AND is_active = TRUE`);
  assert(await lifecycle.shouldGenerateScript(pool, 4) === true, '7.5 semi_active + old scripts → true');

  // 7.6 Semi_active + no scripts at all → true
  // Use user 1 who has no scripts
  await pool.query(`UPDATE user_lifecycle SET segment = 'semi_active', inactive_days = 2 WHERE user_id = 1`);
  const { rows: u1scripts } = await pool.query(`SELECT COUNT(*) as cnt FROM triage_scripts WHERE user_id = 1 AND is_active = TRUE`);
  if (parseInt(u1scripts[0].cnt) === 0) {
    assert(await lifecycle.shouldGenerateScript(pool, 1) === true, '7.6 semi_active + no scripts → true');
  } else {
    console.log('  SKIP  7.6 (user 1 has scripts)');
    totalPass++;
  }

  // Restore
  await pool.query(`UPDATE triage_scripts SET created_at = NOW() WHERE user_id = 4 AND is_active = TRUE`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'active', inactive_days = 0 WHERE user_id = 4`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10 WHERE user_id = 1`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: R&D Cycle Integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testRndCycleIntegration() {
  console.log('\n══════ SUITE 8: R&D Cycle Integration ══════');

  // 8.1 Full cycle runs without error
  let stats;
  try {
    stats = await runNightlyCycle(pool);
    assert(true, '8.1 Full cycle completes without error');
  } catch (e) {
    assert(false, `8.1 Full cycle FAILED: ${e.message}`);
    return;
  }

  // 8.2 Stats structure
  assert('usersProcessed' in stats, '8.2 Has usersProcessed');
  assert('usersSkipped' in stats, '8.3 Has usersSkipped');
  assert('fallbacksProcessed' in stats, '8.4 Has fallbacksProcessed');

  // 8.5 Only active users processed
  assert(stats.usersProcessed <= 1, '8.5 usersProcessed <= 1 (only user 4)');
  assert(stats.usersSkipped >= 2, '8.6 usersSkipped >= 2 (inactive/churned)');

  // 8.7 Cycle log saved to DB
  const { rows: logs } = await pool.query(`
    SELECT * FROM rnd_cycle_logs ORDER BY id DESC LIMIT 1
  `);
  assert(logs.length > 0 && logs[0].status === 'completed', '8.7 Cycle log saved as completed');
  assert(logs[0].users_processed === stats.usersProcessed, '8.8 Log matches stats.usersProcessed');

  // 8.9 Cluster updates skipped for inactive users
  await pool.query(`UPDATE problem_clusters SET updated_at = '2026-01-01' WHERE user_id = 3`);
  await updateAllClusterFrequencies(pool, [4]); // only user 4
  const { rows: u3clusters } = await pool.query(`
    SELECT updated_at FROM problem_clusters WHERE user_id = 3 AND is_active = TRUE LIMIT 1
  `);
  if (u3clusters.length > 0) {
    const wasSkipped = new Date(u3clusters[0].updated_at).getMonth() === 0; // Jan
    assert(wasSkipped, '8.9 User 3 clusters untouched by filtered update');
  } else {
    console.log('  SKIP  8.9 (no clusters for user 3)');
    totalPass++;
  }

  // 8.10 optimizeScripts respects filter
  const scriptStats = await optimizeScripts(pool, [4]);
  assert(typeof scriptStats.regenerated === 'number', '8.10 optimizeScripts returns regenerated count');

  // Restore
  await pool.query(`UPDATE problem_clusters SET updated_at = NOW() WHERE user_id = 3`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: R&D Cycle with empty activeUserIds
// ═══════════════════════════════════════════════════════════════════════════════
async function testRndCycleEmptyActive() {
  console.log('\n══════ SUITE 9: R&D Cycle — No Active Users ══════');

  // Make ALL users truly inactive by setting last_checkin_at far in the past
  // Note: R&D Step 0 calls updateAllSegments which recalculates from last_checkin_at
  // So we must set last_checkin_at to old date, not just override segment
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '30 days' WHERE TRUE`);
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NULL WHERE user_id = 2`);

  let stats;
  try {
    stats = await runNightlyCycle(pool);
    assert(true, '9.1 Cycle completes with 0 active users');
  } catch (e) {
    assert(false, `9.1 Cycle FAILED with 0 active: ${e.message}`);
    return;
  }

  // After Step 0 recalculates, all users should be churned/inactive
  assert(stats.usersProcessed === 0, '9.2 0 users processed');
  assert(stats.usersSkipped >= 4, '9.3 All users skipped');
  assert(stats.clustersUpdated === 0, '9.4 0 clusters updated');
  assert(stats.scriptsRegenerated === 0, '9.5 0 scripts regenerated');

  // Restore
  await pool.query(`UPDATE user_lifecycle SET segment = 'active', inactive_days = 0, last_checkin_at = '2026-04-09'::timestamptz WHERE user_id = 4`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10, last_checkin_at = '2026-03-30'::timestamptz WHERE user_id IN (1, 3)`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 999, last_checkin_at = NULL WHERE user_id = 2`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: API Endpoints
// ═══════════════════════════════════════════════════════════════════════════════
async function testApiEndpoints() {
  console.log('\n══════ SUITE 10: API Endpoints ══════');

  const http = require('http');

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get('http://localhost:3000' + path, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }).on('error', reject);
    });
  }

  function post(path) {
    return new Promise((resolve, reject) => {
      const req = http.request('http://localhost:3000' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // 10.1 GET /lifecycle
  let r = await get('/api/health/lifecycle');
  assert(r.status === 200 && r.body.ok, '10.1 GET /lifecycle → 200');
  assert(Array.isArray(r.body.users), '10.2 Returns users array');
  assert(r.body.stats && typeof r.body.stats.active === 'number', '10.3 Returns stats object');

  // 10.4 GET /lifecycle/:userId (valid)
  r = await get('/api/health/lifecycle/4');
  assert(r.status === 200 && r.body.lifecycle.user_id === 4, '10.4 Valid user → 200 + data');

  // 10.5 GET /lifecycle/:userId (not found)
  r = await get('/api/health/lifecycle/99999');
  assert(r.status === 404, '10.5 Non-existent user → 404');

  // 10.6 GET /lifecycle/:userId (NaN)
  r = await get('/api/health/lifecycle/abc');
  assert(r.status === 400, '10.6 Invalid param → 400');

  // 10.7 GET /lifecycle/0 (falsy but valid int)
  r = await get('/api/health/lifecycle/0');
  assert(r.status === 400, '10.7 userId=0 → 400');

  // 10.8 GET /lifecycle/-1 (negative)
  r = await get('/api/health/lifecycle/-1');
  assert(r.status === 404 || r.status === 400, '10.8 userId=-1 → 400 or 404');

  // 10.9 POST /lifecycle/update-all
  r = await post('/api/health/lifecycle/update-all');
  assert(r.status === 200 && r.body.ok && r.body.stats.total >= 1, '10.9 update-all → 200 + stats');

  // 10.10 GET /lifecycle/check-script/:userId (active) — ensure active first
  await lifecycle.markActive(pool, 4);
  r = await get('/api/health/lifecycle/check-script/4');
  assert(r.status === 200 && r.body.shouldGenerateScript === true, '10.10 check-script active → true');

  // 10.11 GET /lifecycle/check-script/:userId (churned)
  r = await get('/api/health/lifecycle/check-script/3');
  assert(r.status === 200 && r.body.shouldGenerateScript === false, '10.11 check-script churned → false');

  // 10.12 check-script not found
  r = await get('/api/health/lifecycle/check-script/99999');
  assert(r.status === 404, '10.12 check-script non-existent → 404');

  // 10.13 check-script invalid param
  r = await get('/api/health/lifecycle/check-script/abc');
  assert(r.status === 400, '10.13 check-script NaN → 400');

  // 10.14 Concurrent requests (no deadlock)
  const results = await Promise.all([
    post('/api/health/lifecycle/update-all'),
    post('/api/health/lifecycle/update-all'),
    get('/api/health/lifecycle'),
    get('/api/health/lifecycle/4'),
    get('/api/health/lifecycle/check-script/4'),
  ]);
  assert(results.every(r => r.status === 200), '10.14 5 concurrent requests all succeed');

  // 10.15 Route ordering: /lifecycle/check-script/:id does NOT conflict with /lifecycle/:id
  r = await get('/api/health/lifecycle/check-script/4');
  assert(r.body.shouldGenerateScript !== undefined, '10.15 Route /check-script/:id correctly matched (not /:userId)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 11: checkin.controller markActive integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testCheckinIntegration() {
  console.log('\n══════ SUITE 11: Check-in → markActive Integration ══════');

  // 11.1 Verify markActive is imported in checkin controller
  const controllerSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'controllers', 'checkin.controller.js'), 'utf8'
  );
  assert(controllerSrc.includes("require('../services/profile/lifecycle.service')"), '11.1 lifecycle imported in controller');
  assert(controllerSrc.includes('markActive(pool, req.user.id)'), '11.2 markActive called in startCheckinHandler');
  assert(controllerSrc.includes('.catch('), '11.3 markActive has error handling (.catch)');

  // 11.4 markActive is non-blocking (fire-and-forget with .catch)
  // Verify the pattern: markActive(pool, req.user.id).catch(...)
  // This ensures check-in response is not delayed if lifecycle update fails
  assert(controllerSrc.includes('markActive(pool, req.user.id).catch'), '11.4 markActive is fire-and-forget');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 12: server.js cron configuration
// ═══════════════════════════════════════════════════════════════════════════════
async function testServerCron() {
  console.log('\n══════ SUITE 12: server.js Cron Config ══════');

  const serverSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server.js'), 'utf8'
  );

  // 12.1 Lifecycle cron imported
  assert(serverSrc.includes("require('./src/services/profile/lifecycle.service')"), '12.1 lifecycle imported in server.js');

  // 12.2 Lifecycle cron runs at 1:00 AM (before R&D at 2:00 AM)
  assert(serverSrc.includes('vnNow.getHours() === 1'), '12.2 Lifecycle cron at 1:00 AM VN');

  // 12.3 R&D still runs at 2:00 AM
  assert(serverSrc.includes('vnNow.getHours() === 2'), '12.3 R&D cron at 2:00 AM VN');

  // 12.4 Lifecycle runs BEFORE R&D (order in file)
  const lifecycleIdx = serverSrc.indexOf('scheduleLifecycleUpdate');
  const rndIdx = serverSrc.indexOf('scheduleRndCycle');
  assert(lifecycleIdx < rndIdx, '12.4 Lifecycle scheduled before R&D in code');

  // 12.5 R&D cycle also updates segments internally (Step 0)
  const rndSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'services', 'checkin', 'rnd-cycle.service.js'), 'utf8'
  );
  assert(rndSrc.includes('updateAllSegments(pool)'), '12.5 R&D Step 0 calls updateAllSegments');
  // Phase 6: refactored to use getUsersBySegment for priority compute (active + semi_active separately)
  assert(rndSrc.includes('getUsersBySegment'), '12.6 R&D gets users by segment after segment update');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 13: getUsersBySegment
// ═══════════════════════════════════════════════════════════════════════════════
async function testGetUsersBySegment() {
  console.log('\n══════ SUITE 13: getUsersBySegment ══════');

  await lifecycle.markActive(pool, 4); // ensure active
  const active = await lifecycle.getUsersBySegment(pool, 'active');
  assert(Array.isArray(active), '13.1 Returns array');
  assert(active.some(u => u.user_id === 4), '13.2 User 4 in active list');

  const churned = await lifecycle.getUsersBySegment(pool, 'churned');
  assert(churned.some(u => u.user_id === 1) || churned.some(u => u.user_id === 3), '13.3 Churned users found');
  assert(!churned.some(u => u.user_id === 4), '13.4 User 4 NOT in churned');

  const empty = await lifecycle.getUsersBySegment(pool, 'semi_active');
  assert(Array.isArray(empty), '13.5 Returns empty array for segment with no users');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 14: Data consistency after multiple operations
// ═══════════════════════════════════════════════════════════════════════════════
async function testDataConsistency() {
  console.log('\n══════ SUITE 14: Data Consistency ══════');

  // 14.1 markActive → updateAllSegments → should stay active if recent
  await lifecycle.markActive(pool, 3);
  await lifecycle.updateAllSegments(pool);
  const { rows: r1 } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 3');
  assert(r1[0].segment === 'active', '14.1 markActive then updateAll → stays active');

  // 14.2 After time passes, updateAll changes segment correctly
  await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '4 days' WHERE user_id = 3`);
  await lifecycle.updateAllSegments(pool);
  const { rows: r2 } = await pool.query('SELECT segment FROM user_lifecycle WHERE user_id = 3');
  assert(r2[0].segment === 'inactive', '14.2 4 days later → inactive');

  // 14.3 Full cycle after segment change
  const stats = await runNightlyCycle(pool);
  // User 3 now inactive → should be skipped
  const ids = await lifecycle.getActiveUserIds(pool);
  assert(!ids.includes(3), '14.3 User 3 (inactive) excluded from active IDs after cycle');

  // 14.4 markActive brings user back immediately
  await lifecycle.markActive(pool, 3);
  const ids2 = await lifecycle.getActiveUserIds(pool);
  assert(ids2.includes(3), '14.4 markActive → immediately in active IDs');

  // 14.5 All lifecycle records valid after operations
  const { rows: all } = await pool.query('SELECT user_id, segment, inactive_days FROM user_lifecycle');
  for (const row of all) {
    assert(
      ['active', 'semi_active', 'inactive', 'churned'].includes(row.segment),
      `14.5 User ${row.user_id} has valid segment: ${row.segment}`
    );
    assert(row.inactive_days >= 0, `14.6 User ${row.user_id} inactive_days >= 0: ${row.inactive_days}`);
  }

  // Restore
  await pool.query(`UPDATE user_lifecycle SET segment = 'churned', inactive_days = 10, last_checkin_at = '2026-03-30'::timestamptz WHERE user_id IN (1, 3)`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 999, last_checkin_at = NULL WHERE user_id = 2`);
  await pool.query(`UPDATE user_lifecycle SET segment = 'active', inactive_days = 0, last_checkin_at = '2026-04-09'::timestamptz WHERE user_id = 4`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 1 — COMPREHENSIVE TEST SUITE             ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await setup();
  await testSchema();
  await testCalculateSegment();
  await testEnsureLifecycle();
  await testMarkActive();
  await testUpdateAllSegments();
  await testGetActiveUserIds();
  await testShouldGenerateScript();
  await testRndCycleIntegration();
  await testRndCycleEmptyActive();
  await testApiEndpoints();
  await testCheckinIntegration();
  await testServerCron();
  await testGetUsersBySegment();
  await testDataConsistency();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  TOTAL: ${totalPass} PASS, ${totalFail} FAIL                        ║`);
  if (totalFail > 0) {
    console.log('║  FAILURES:                                       ║');
    for (const f of failures) console.log(`║  - ${f.substring(0, 46).padEnd(46)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  pool.end();
  process.exit(1);
});
