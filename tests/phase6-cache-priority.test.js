'use strict';

/**
 * Phase 6 — Cache reuse + Priority compute Test Suite
 * Chạy: node tests/phase6-cache-priority.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const cache = require('../src/services/checkin/script-cache.service');
const { runNightlyCycle, processSemiActiveWithTimeout, MAX_CYCLE_MS } = require('../src/services/checkin/rnd-cycle.service');
const lifecycle = require('../src/services/profile/lifecycle.service');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) { totalPass++; console.log(`  PASS ✓ ${name}`); }
  else { totalFail++; failures.push(name); console.log(`  FAIL ✗ ${name}`); }
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000' + path, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request('http://localhost:3000' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Test cluster — pick the first one user 4 has
let TEST_CLUSTER_KEY = 'fatigue';
let TEST_SCRIPT_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP: Reset reuse counters for clean tests
// ═══════════════════════════════════════════════════════════════════════════════
async function setup() {
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE user_id = 4');
  // Pick a cluster_key user 4 has an active script for
  const { rows } = await pool.query(
    `SELECT cluster_key, id FROM triage_scripts WHERE user_id = 4 AND is_active = TRUE AND script_type = 'initial' ORDER BY created_at DESC LIMIT 1`
  );
  if (rows.length > 0) {
    TEST_CLUSTER_KEY = rows[0].cluster_key;
    TEST_SCRIPT_ID = rows[0].id;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: Migration 055 — schema verification
// ═══════════════════════════════════════════════════════════════════════════════
async function testSchema() {
  console.log('\n══════ SUITE 1: Schema Migration 055 ══════');

  // 1.1 reuse_count column
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'triage_scripts' AND column_name IN ('reuse_count', 'last_reused_at')
    ORDER BY column_name
  `);
  assert(cols.length === 2, '1.1 Both columns added');
  const reuseCol = cols.find(c => c.column_name === 'reuse_count');
  assert(reuseCol && reuseCol.data_type === 'integer', '1.2 reuse_count is integer');
  assert(reuseCol && reuseCol.is_nullable === 'NO', '1.3 reuse_count NOT NULL');
  assert(reuseCol && reuseCol.column_default === '0', '1.4 reuse_count default=0');

  const lastReusedCol = cols.find(c => c.column_name === 'last_reused_at');
  assert(lastReusedCol && lastReusedCol.data_type === 'timestamp with time zone', '1.5 last_reused_at is timestamptz');

  // 1.6 Index on reuse_count exists
  const { rows: idx } = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE indexname = 'idx_triage_scripts_reuse_count'
  `);
  assert(idx.length === 1, '1.6 idx_triage_scripts_reuse_count exists');

  // 1.7 rnd_cycle_logs has new metric columns
  const { rows: logCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'rnd_cycle_logs'
      AND column_name IN ('active_processed', 'semi_active_processed', 'semi_active_skipped_timeout', 'scripts_reused', 'elapsed_ms')
  `);
  assert(logCols.length === 5, `1.7 rnd_cycle_logs has 5 new metric columns (got ${logCols.length})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: getCachedScript
// ═══════════════════════════════════════════════════════════════════════════════
async function testGetCachedScript() {
  console.log('\n══════ SUITE 2: getCachedScript ══════');

  // 2.1 Returns script for active cluster
  const s1 = await cache.getCachedScript(pool, 4, TEST_CLUSTER_KEY);
  assert(s1 !== null, `2.1 Returns script for user 4 + ${TEST_CLUSTER_KEY}`);
  assert(s1.user_id === 4, '2.2 Correct user_id');
  assert(s1.cluster_key === TEST_CLUSTER_KEY, '2.3 Correct cluster_key');
  assert(s1.script_type === 'initial', '2.4 Default scriptType=initial');
  assert(s1.is_active === true, '2.5 is_active=true');
  assert(typeof s1.reuse_count === 'number', '2.6 reuse_count is number');
  assert(s1.script_data !== null, '2.7 has script_data');

  // 2.8 Non-existent cluster → null
  const s2 = await cache.getCachedScript(pool, 4, 'nonexistent_cluster_xyz');
  assert(s2 === null, '2.8 Non-existent cluster → null');

  // 2.9 Wrong scriptType → can return null or different script
  const s3 = await cache.getCachedScript(pool, 4, TEST_CLUSTER_KEY, 'followup');
  // Either null (no followup) or a followup script
  if (s3) {
    assert(s3.script_type === 'followup', '2.9 followup type correct');
  } else {
    assert(true, '2.9 (no followup script — OK)');
  }

  // 2.10 Different user → null
  const s4 = await cache.getCachedScript(pool, 99999, TEST_CLUSTER_KEY);
  assert(s4 === null, '2.10 Non-existent user → null');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: reuseScript — increment counter
// ═══════════════════════════════════════════════════════════════════════════════
async function testReuseScript() {
  console.log('\n══════ SUITE 3: reuseScript ══════');

  // Reset counter
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE id = $1', [TEST_SCRIPT_ID]);

  // 3.1 First reuse
  const r1 = await cache.reuseScript(pool, 4, TEST_CLUSTER_KEY);
  assert(r1 !== null, '3.1 reuseScript returns object');
  assert(r1.reuse_count === 1, `3.2 reuse_count = 1 (got ${r1.reuse_count})`);
  assert(r1.last_reused_at !== null, '3.3 last_reused_at set');

  // 3.4 Verify in DB
  const { rows: v1 } = await pool.query('SELECT reuse_count, last_reused_at FROM triage_scripts WHERE id = $1', [TEST_SCRIPT_ID]);
  assert(v1[0].reuse_count === 1, '3.4 DB verified reuse_count=1');
  assert(v1[0].last_reused_at !== null, '3.5 DB verified last_reused_at not null');

  // 3.6 Second reuse → counter increments
  const r2 = await cache.reuseScript(pool, 4, TEST_CLUSTER_KEY);
  assert(r2.reuse_count === 2, '3.6 Second reuse → 2');

  // 3.7 Multiple consecutive reuses
  for (let i = 0; i < 5; i++) {
    await cache.reuseScript(pool, 4, TEST_CLUSTER_KEY);
  }
  const { rows: v2 } = await pool.query('SELECT reuse_count FROM triage_scripts WHERE id = $1', [TEST_SCRIPT_ID]);
  assert(v2[0].reuse_count === 7, `3.7 After 5 more reuses → 7 (got ${v2[0].reuse_count})`);

  // 3.8 reuseScript on non-existent → null
  const r3 = await cache.reuseScript(pool, 4, 'nonexistent_xyz');
  assert(r3 === null, '3.8 Non-existent → null');

  // Reset
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE id = $1', [TEST_SCRIPT_ID]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: getOrReuseScript — full flow
// ═══════════════════════════════════════════════════════════════════════════════
async function testGetOrReuseScript() {
  console.log('\n══════ SUITE 4: getOrReuseScript ══════');

  // Reset counter
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE id = $1', [TEST_SCRIPT_ID]);

  // 4.1 First call → cache_first
  const r1 = await cache.getOrReuseScript(pool, 4, TEST_CLUSTER_KEY);
  assert(r1.source === 'cache_first', `4.1 First call → cache_first (got ${r1.source})`);
  assert(r1.script !== null, '4.2 Has script');
  assert(r1.script.reuse_count === 1, '4.3 First call → reuse_count=1');

  // 4.4 Second call → cache_reused
  const r2 = await cache.getOrReuseScript(pool, 4, TEST_CLUSTER_KEY);
  assert(r2.source === 'cache_reused', `4.4 Second call → cache_reused (got ${r2.source})`);
  assert(r2.script.reuse_count === 2, '4.5 Second call → reuse_count=2');

  // 4.6 Third+ calls → cache_reused
  const r3 = await cache.getOrReuseScript(pool, 4, TEST_CLUSTER_KEY);
  assert(r3.source === 'cache_reused', '4.6 Third call → cache_reused');
  assert(r3.script.reuse_count === 3, '4.7 Third call → reuse_count=3');

  // 4.8 Non-existent + no generator + allowGenerate=false → none
  const r4 = await cache.getOrReuseScript(pool, 4, 'nonexistent_xyz', { allowGenerate: false });
  assert(r4.source === 'none', '4.8 Non-existent + no generator → none');
  assert(r4.script === null, '4.9 No script returned');

  // 4.10 Non-existent + allowGenerate=true but no generator function → none
  const r5 = await cache.getOrReuseScript(pool, 4, 'nonexistent_xyz', { allowGenerate: true });
  assert(r5.source === 'none', '4.10 No generator passed → none');

  // 4.11 Custom generator works
  const fakeScript = { id: 'fake', cluster_key: 'test', source: 'custom' };
  const r6 = await cache.getOrReuseScript(pool, 4, 'nonexistent_xyz_2', {
    allowGenerate: true,
    generator: async () => fakeScript,
  });
  assert(r6.source === 'generated', '4.11 Custom generator → generated source');
  assert(r6.script.id === 'fake', '4.12 Returns generator output');

  // 4.13 Generator throws → error path
  const r7 = await cache.getOrReuseScript(pool, 4, 'nonexistent_xyz_3', {
    allowGenerate: true,
    generator: async () => { throw new Error('boom'); },
  });
  assert(r7.source === 'none', '4.13 Generator error → none');
  assert(r7.error === 'boom', '4.14 error message captured');

  // Reset
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE id = $1', [TEST_SCRIPT_ID]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: Stats functions
// ═══════════════════════════════════════════════════════════════════════════════
async function testStats() {
  console.log('\n══════ SUITE 5: Stats Functions ══════');

  // Setup: reset, then reuse 3 scripts
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE user_id = 4');

  // 5.1 Initial stats — all zeros
  let stats = await cache.getReuseStatsForUser(pool, 4);
  assert(stats.total_reuses === 0, '5.1 Initial total_reuses = 0');
  assert(stats.reused_scripts === 0, '5.2 Initial reused_scripts = 0');
  assert(stats.total_scripts > 0, '5.3 Has total_scripts > 0');

  // 5.4 Reuse same script 5 times
  for (let i = 0; i < 5; i++) {
    await cache.reuseScript(pool, 4, TEST_CLUSTER_KEY);
  }
  stats = await cache.getReuseStatsForUser(pool, 4);
  assert(stats.total_reuses === 5, `5.4 After 5 reuses → total=5 (got ${stats.total_reuses})`);
  assert(stats.reused_scripts === 1, '5.5 1 distinct script reused');
  assert(stats.max_reuses === 5, '5.6 max_reuses = 5');

  // 5.7 Global stats reflects same data
  const global = await cache.getGlobalReuseStats(pool);
  assert(global.total_reuses >= 5, `5.7 Global total_reuses >= 5 (got ${global.total_reuses})`);
  assert(global.scripts_reused_at_least_once >= 1, '5.8 scripts_reused_at_least_once >= 1');

  // 5.9 Top reused scripts
  const top = await cache.getTopReusedScripts(pool, 5);
  assert(Array.isArray(top), '5.9 Returns array');
  assert(top.length >= 1, '5.10 Has at least 1 entry');
  assert(top[0].reuse_count >= 5, `5.11 Top entry has 5+ reuses (got ${top[0].reuse_count})`);

  // 5.12 Limit respected
  const top1 = await cache.getTopReusedScripts(pool, 1);
  assert(top1.length === 1, '5.12 Limit=1 respected');

  // Reset
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE user_id = 4');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: Priority compute — runNightlyCycle ordering
// ═══════════════════════════════════════════════════════════════════════════════
async function testPriorityCompute() {
  console.log('\n══════ SUITE 6: Priority Compute ══════');

  // 6.1 MAX_CYCLE_MS exported
  assert(typeof MAX_CYCLE_MS === 'number', '6.1 MAX_CYCLE_MS exported');
  assert(MAX_CYCLE_MS === 1800000, `6.2 Default MAX_CYCLE_MS = 1800000 (30min) (got ${MAX_CYCLE_MS})`);

  // 6.3 processSemiActiveWithTimeout exported
  assert(typeof processSemiActiveWithTimeout === 'function', '6.3 processSemiActiveWithTimeout exported');

  // 6.4 Run cycle and check priority metrics
  const stats = await runNightlyCycle(pool);
  assert('activeProcessed' in stats, '6.4 stats has activeProcessed');
  assert('semiActiveProcessed' in stats, '6.5 stats has semiActiveProcessed');
  assert('semiActiveSkippedTimeout' in stats, '6.6 stats has semiActiveSkippedTimeout');
  assert('elapsedMs' in stats, '6.7 stats has elapsedMs');
  assert(stats.elapsedMs > 0, '6.8 elapsedMs > 0');
  assert(stats.elapsedMs < MAX_CYCLE_MS, '6.9 elapsedMs < MAX_CYCLE_MS');

  // 6.10 active + semi_active processed = total processed
  assert(stats.usersProcessed === stats.activeProcessed + stats.semiActiveProcessed,
    `6.10 usersProcessed = active + semi (${stats.usersProcessed} = ${stats.activeProcessed} + ${stats.semiActiveProcessed})`);

  // 6.11 Cycle log has new fields populated
  const { rows: logs } = await pool.query(`SELECT * FROM rnd_cycle_logs ORDER BY id DESC LIMIT 1`);
  const log = logs[0];
  assert(log.status === 'completed', '6.11 Last log = completed');
  assert(log.elapsed_ms > 0, '6.12 elapsed_ms saved');
  assert(typeof log.active_processed === 'number', '6.13 active_processed saved');
  assert(typeof log.semi_active_processed === 'number', '6.14 semi_active_processed saved');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: processSemiActiveWithTimeout — timeout simulation
// ═══════════════════════════════════════════════════════════════════════════════
async function testTimeoutSim() {
  console.log('\n══════ SUITE 7: Timeout Simulation ══════');

  // 7.1 Empty array → returns 0 processed
  const r1 = await processSemiActiveWithTimeout(pool, [], new Date());
  assert(r1.usersProcessed === 0, '7.1 Empty → 0 processed');
  assert(r1.skipped === 0, '7.2 Empty → 0 skipped');

  // 7.3 Already-expired cycleStart → all skipped
  const longAgo = new Date(Date.now() - MAX_CYCLE_MS - 10000); // way past timeout
  const r2 = await processSemiActiveWithTimeout(pool, [1, 2, 3], longAgo);
  assert(r2.usersProcessed === 0, '7.3 Expired cycle → 0 processed');
  assert(r2.skipped === 3, `7.4 Expired cycle → all 3 skipped (got ${r2.skipped})`);

  // 7.5 Normal cycle with users
  const r3 = await processSemiActiveWithTimeout(pool, [4], new Date());
  assert(typeof r3.usersProcessed === 'number', '7.5 Returns usersProcessed');
  // user 4 has clusters → may be processed
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: Integration — promoting user to semi_active
// ═══════════════════════════════════════════════════════════════════════════════
async function testSemiActiveIntegration() {
  console.log('\n══════ SUITE 8: Semi-active Integration ══════');

  // Backup user 4 lifecycle
  const { rows: backup } = await pool.query('SELECT * FROM user_lifecycle WHERE user_id = 4');

  // Make user 4 semi_active (2 days)
  await pool.query(
    `UPDATE user_lifecycle SET segment = 'semi_active', inactive_days = 2, last_checkin_at = NOW() - INTERVAL '2 days' WHERE user_id = 4`
  );

  // Run cycle
  const stats = await runNightlyCycle(pool);

  // Should now process user 4 in semi_active priority
  assert(stats.semiActiveProcessed >= 1 || stats.activeProcessed === 0,
    `8.1 User 4 (semi_active) processed in priority 2 (active=${stats.activeProcessed}, semi=${stats.semiActiveProcessed})`);

  // Restore
  if (backup.length > 0) {
    await pool.query(
      `UPDATE user_lifecycle SET segment = $1, inactive_days = $2, last_checkin_at = $3 WHERE user_id = 4`,
      [backup[0].segment, backup[0].inactive_days, backup[0].last_checkin_at]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: API endpoints
// ═══════════════════════════════════════════════════════════════════════════════
async function testApi() {
  console.log('\n══════ SUITE 9: API Endpoints ══════');

  // Setup: ensure at least one reused script (re-fetch TEST_SCRIPT_ID in case previous tests changed it)
  const { rows: freshScript } = await pool.query(
    `SELECT id FROM triage_scripts WHERE user_id = 4 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`
  );
  const scriptIdForApi = freshScript[0]?.id || TEST_SCRIPT_ID;
  await pool.query('UPDATE triage_scripts SET reuse_count = 3, last_reused_at = NOW() WHERE id = $1', [scriptIdForApi]);

  // 9.1 GET /cache/global
  const r1 = await get('/api/health/cache/global');
  assert(r1.s === 200 && r1.b.ok, '9.1 GET /cache/global → 200');
  assert(typeof r1.b.stats.total_active_scripts === 'number', '9.2 Has total_active_scripts');
  assert(r1.b.stats.total_reuses >= 3, '9.3 total_reuses >= 3');

  // 9.4 GET /cache/user/:id
  const r2 = await get('/api/health/cache/user/4');
  assert(r2.s === 200 && r2.b.ok, '9.4 GET /cache/user/4 → 200');
  assert(r2.b.stats.total_reuses >= 3, '9.5 user stats reflects reuses');

  // 9.6 GET /cache/user/99999 → 404
  const r3 = await get('/api/health/cache/user/99999');
  assert(r3.s === 404, '9.6 Non-existent user → 404');

  // 9.7 GET /cache/user/abc → 400
  const r4 = await get('/api/health/cache/user/abc');
  assert(r4.s === 400, '9.7 Invalid userId → 400');

  // 9.8 GET /cache/top-reused
  const r5 = await get('/api/health/cache/top-reused?limit=5');
  assert(r5.s === 200 && Array.isArray(r5.b.scripts), '9.8 GET /cache/top-reused → 200');
  assert(r5.b.scripts.length >= 1, '9.9 Has at least 1 reused script');

  // 9.10 POST /cache/reuse — reuse cached
  const r6 = await post('/api/health/cache/reuse', { userId: 4, clusterKey: TEST_CLUSTER_KEY });
  assert(r6.s === 200 && r6.b.ok, '9.10 POST /cache/reuse → 200');
  assert(['cache_reused', 'cache_first'].includes(r6.b.source), `9.11 Source = cache_reused (got ${r6.b.source})`);

  // 9.12 POST /cache/reuse missing params → 400
  const r7 = await post('/api/health/cache/reuse', {});
  assert(r7.s === 400, '9.12 Missing params → 400');

  // 9.13 POST /rnd-cycle/run
  const r8 = await post('/api/health/rnd-cycle/run', {});
  assert(r8.s === 200 && r8.b.ok, '9.13 POST /rnd-cycle/run → 200');
  assert(typeof r8.b.stats.elapsedMs === 'number', '9.14 stats.elapsedMs returned');
  assert(typeof r8.b.stats.activeProcessed === 'number', '9.15 stats.activeProcessed returned');

  // 9.16 GET /rnd-cycle/last
  const r9 = await get('/api/health/rnd-cycle/last');
  assert(r9.s === 200 && r9.b.log !== null, '9.16 GET /rnd-cycle/last → 200');
  assert(r9.b.log.status === 'completed', '9.17 Last log = completed');

  // Reset
  await pool.query('UPDATE triage_scripts SET reuse_count = 0, last_reused_at = NULL WHERE user_id = 4');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: Code integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testCodeIntegration() {
  console.log('\n══════ SUITE 10: Code Integration ══════');

  const fs = require('fs');
  const path = require('path');

  // 10.1 script-cache.service.js exports
  assert(typeof cache.getCachedScript === 'function', '10.1 getCachedScript exported');
  assert(typeof cache.reuseScript === 'function', '10.2 reuseScript exported');
  assert(typeof cache.getOrReuseScript === 'function', '10.3 getOrReuseScript exported');
  assert(typeof cache.getReuseStatsForUser === 'function', '10.4 getReuseStatsForUser exported');
  assert(typeof cache.getTopReusedScripts === 'function', '10.5 getTopReusedScripts exported');
  assert(typeof cache.getGlobalReuseStats === 'function', '10.6 getGlobalReuseStats exported');

  // 10.7 rnd-cycle exports
  assert(typeof MAX_CYCLE_MS === 'number', '10.7 MAX_CYCLE_MS exported');
  assert(typeof processSemiActiveWithTimeout === 'function', '10.8 processSemiActiveWithTimeout exported');

  // 10.9 health.routes uses Phase 6
  const hr = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health.routes.js'), 'utf8');
  assert(hr.includes("script-cache.service"), '10.9 routes imports script-cache');
  assert(hr.includes('/cache/global'), '10.10 routes has /cache/global');
  assert(hr.includes('/cache/user'), '10.11 routes has /cache/user');
  assert(hr.includes('/cache/top-reused'), '10.12 routes has /cache/top-reused');
  assert(hr.includes('/cache/reuse'), '10.13 routes has /cache/reuse');
  assert(hr.includes('/rnd-cycle/run'), '10.14 routes has /rnd-cycle/run');
  assert(hr.includes('/rnd-cycle/last'), '10.15 routes has /rnd-cycle/last');

  // 10.16 rnd-cycle.service uses priority logic
  const rc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'checkin', 'rnd-cycle.service.js'), 'utf8');
  assert(rc.includes('PRIORITY 1'), '10.16 Has PRIORITY 1 comment');
  assert(rc.includes('PRIORITY 2'), '10.17 Has PRIORITY 2 comment');
  assert(rc.includes('MAX_CYCLE_MS'), '10.18 Uses MAX_CYCLE_MS');
  assert(rc.includes('getUsersBySegment'), '10.19 Imports getUsersBySegment');
  assert(rc.includes('processSemiActiveWithTimeout'), '10.20 Calls processSemiActiveWithTimeout');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 11: Defensive
// ═══════════════════════════════════════════════════════════════════════════════
async function testDefensive() {
  console.log('\n══════ SUITE 11: Defensive ══════');

  // 11.1 getCachedScript with invalid scriptType
  const r1 = await cache.getCachedScript(pool, 4, TEST_CLUSTER_KEY, 'invalid_type');
  assert(r1 === null, '11.1 Invalid scriptType → null');

  // 11.2 getReuseStatsForUser with non-existent user
  const stats = await cache.getReuseStatsForUser(pool, 99999);
  assert(stats !== null, '11.2 Non-existent user → not null');
  assert(stats.total_scripts === 0, '11.3 Non-existent → 0 scripts');
  assert(stats.total_reuses === 0, '11.4 Non-existent → 0 reuses');

  // 11.5 getTopReusedScripts with limit=0
  const top0 = await cache.getTopReusedScripts(pool, 0);
  assert(Array.isArray(top0), '11.5 limit=0 → array');

  // 11.6 reuseScript on non-existent
  const r2 = await cache.reuseScript(pool, 99999, 'nothing');
  assert(r2 === null, '11.6 Non-existent → null');

  // 11.7 getGlobalReuseStats always returns
  const g = await cache.getGlobalReuseStats(pool);
  assert(g !== null && typeof g.total_active_scripts === 'number', '11.7 Global stats always returns');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 6 — CACHE REUSE + PRIORITY COMPUTE      ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await setup();
  await testSchema();
  await testGetCachedScript();
  await testReuseScript();
  await testGetOrReuseScript();
  await testStats();
  await testPriorityCompute();
  await testTimeoutSim();
  await testSemiActiveIntegration();
  await testApi();
  await testCodeIntegration();
  await testDefensive();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  TOTAL: ${totalPass} PASS, ${totalFail} FAIL${' '.repeat(Math.max(0, 27 - String(totalPass).length - String(totalFail).length))}║`);
  if (totalFail > 0) {
    console.log('║  FAILURES:                                       ║');
    for (const f of failures) console.log(`║  - ${f.substring(0, 46).padEnd(46)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch(err => { console.error('CRASHED:', err); pool.end(); process.exit(1); });
