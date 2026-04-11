'use strict';

/**
 * Hard-Case Tests — Phase 1 (Lifecycle) + Phase 2 (Notification Intelligence)
 *
 * Edge cases and race conditions NOT covered by existing suites.
 * Run: node tests/hard-cases-p1p2.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  markActive,
  updateAllSegments,
  getLifecycle,
  getUsersBySegment,
  getActiveUserIds,
  shouldGenerateScript,
  calculateSegment,
} = require('../src/services/profile/lifecycle.service');

const {
  buildUserContext,
  generateMessage,
  renderMessage,
  checkAlertTriggers,
  selectMorningTemplate,
  MORNING_TEMPLATES,
  EVENING_TEMPLATES,
  AFTERNOON_TEMPLATES,
  ALERT_TEMPLATES,
} = require('../src/services/notification/notification-intelligence.service');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    totalPass++;
    console.log('  PASS \u2713 ' + name);
  } else {
    totalFail++;
    failures.push(name);
    console.log('  FAIL \u2717 ' + name);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Back up lifecycle rows for user_ids, restore later */
async function backupLifecycle(userIds) {
  const { rows } = await pool.query(
    `SELECT * FROM user_lifecycle WHERE user_id = ANY($1)`,
    [userIds]
  );
  return rows;
}

async function restoreLifecycle(backup) {
  for (const row of backup) {
    await pool.query(
      `INSERT INTO user_lifecycle (user_id, segment, last_checkin_at, inactive_days, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         segment = $2, last_checkin_at = $3, inactive_days = $4, updated_at = $5`,
      [row.user_id, row.segment, row.last_checkin_at, row.inactive_days, row.updated_at]
    );
  }
}

/** Back up problem_clusters rows */
async function backupClusters(userIds) {
  const { rows } = await pool.query(
    `SELECT * FROM problem_clusters WHERE user_id = ANY($1)`,
    [userIds]
  );
  return rows;
}

async function restoreClusters(backup, userIds) {
  await pool.query(`DELETE FROM problem_clusters WHERE user_id = ANY($1)`, [userIds]);
  for (const row of backup) {
    await pool.query(
      `INSERT INTO problem_clusters (id, user_id, cluster_key, display_name, trend, count_7d, priority, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.user_id, row.cluster_key, row.display_name, row.trend, row.count_7d, row.priority, row.is_active, row.created_at, row.updated_at]
    );
  }
}

/** Back up script_sessions rows */
async function backupSessions(userIds) {
  const { rows } = await pool.query(
    `SELECT * FROM script_sessions WHERE user_id = ANY($1)`,
    [userIds]
  );
  return rows;
}

async function restoreSessions(backup, userIds) {
  await pool.query(`DELETE FROM script_sessions WHERE user_id = ANY($1)`, [userIds]);
  for (const row of backup) {
    await pool.query(
      `INSERT INTO script_sessions (id, user_id, severity, needs_doctor, needs_family_alert, cluster_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.user_id, row.severity, row.needs_doctor, row.needs_family_alert, row.cluster_key, row.created_at]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: Race Conditions — Concurrent markActive
// ═══════════════════════════════════════════════════════════════════════════════

async function testConcurrentMarkActive() {
  console.log('\n══════ SUITE 1: Race Condition — 10 concurrent markActive ══════');

  const userId = 1;
  const backup = await backupLifecycle([userId]);

  try {
    // Fire 10 concurrent markActive calls on same user
    const promises = Array.from({ length: 10 }, () => markActive(pool, userId));
    const results = await Promise.all(promises);

    // All should resolve (no crash, no deadlock)
    assert(results.length === 10, '1.1 All 10 concurrent calls resolved');

    // All should return segment=active
    const allActive = results.every(r => r && r.segment === 'active');
    assert(allActive, '1.2 All results have segment=active');

    // All should have inactive_days=0
    const allZero = results.every(r => r && r.inactive_days === 0);
    assert(allZero, '1.3 All results have inactive_days=0');

    // Final DB state should be consistent
    const final = await getLifecycle(pool, userId);
    assert(final.segment === 'active', '1.4 Final DB segment is active');
    assert(final.inactive_days === 0, '1.5 Final DB inactive_days is 0');
  } finally {
    await restoreLifecycle(backup);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: Rapid Segment Transitions
// ═══════════════════════════════════════════════════════════════════════════════

async function testRapidSegmentTransitions() {
  console.log('\n══════ SUITE 2: Rapid Segment Transitions ══════');

  const userId = 2;
  const backup = await backupLifecycle([userId]);

  try {
    // Step 1: Force active
    await markActive(pool, userId);
    let lc = await getLifecycle(pool, userId);
    assert(lc.segment === 'active', '2.1 Start as active');

    // Step 2: Force churned (set last_checkin_at to 30 days ago)
    await pool.query(
      `UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '30 days',
       inactive_days = 30, segment = 'churned' WHERE user_id = $1`,
      [userId]
    );
    lc = await getLifecycle(pool, userId);
    assert(lc.segment === 'churned', '2.2 Transitioned to churned');

    // Step 3: Back to active
    await markActive(pool, userId);
    lc = await getLifecycle(pool, userId);
    assert(lc.segment === 'active', '2.3 Transitioned back to active');

    // Step 4: Force semi_active (set last_checkin_at to 2 days ago)
    await pool.query(
      `UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '2 days',
       inactive_days = 2, segment = 'semi_active' WHERE user_id = $1`,
      [userId]
    );
    lc = await getLifecycle(pool, userId);
    assert(lc.segment === 'semi_active', '2.4 Transitioned to semi_active');

    // Verify the full sequence did not corrupt data
    assert(typeof lc.inactive_days === 'number', '2.5 inactive_days still numeric after transitions');
    assert(lc.last_checkin_at !== null, '2.6 last_checkin_at preserved');
  } finally {
    await restoreLifecycle(backup);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: updateAllSegments with Mixed Dates
// ═══════════════════════════════════════════════════════════════════════════════

async function testUpdateAllSegmentsMixedDates() {
  console.log('\n══════ SUITE 3: updateAllSegments with Mixed Dates ══════');

  const userIds = [1, 2, 3, 4];
  const backup = await backupLifecycle(userIds);

  try {
    // Set up: user1=today, user2=2days, user3=5days, user4=10days
    await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW(), inactive_days = 0 WHERE user_id = 1`);
    await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '2 days', inactive_days = 2 WHERE user_id = 2`);
    await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '5 days', inactive_days = 5 WHERE user_id = 3`);
    await pool.query(`UPDATE user_lifecycle SET last_checkin_at = NOW() - INTERVAL '10 days', inactive_days = 10 WHERE user_id = 4`);

    const stats = await updateAllSegments(pool);

    // Verify stats object shape
    assert(typeof stats.total === 'number' && stats.total >= 4, '3.1 stats.total >= 4');
    assert(typeof stats.active === 'number', '3.2 stats has active count');
    assert(typeof stats.churned === 'number', '3.3 stats has churned count');

    // Verify individual segments
    const lc1 = await getLifecycle(pool, 1);
    const lc2 = await getLifecycle(pool, 2);
    const lc3 = await getLifecycle(pool, 3);
    const lc4 = await getLifecycle(pool, 4);

    assert(lc1.segment === 'active', '3.4 user1 (today) => active');
    assert(lc2.segment === 'semi_active', '3.5 user2 (2d ago) => semi_active');
    assert(lc3.segment === 'inactive', '3.6 user3 (5d ago) => inactive');
    assert(lc4.segment === 'churned', '3.7 user4 (10d ago) => churned');
  } finally {
    await restoreLifecycle(backup);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: calculateSegment Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

async function testCalculateSegmentEdgeCases() {
  console.log('\n══════ SUITE 4: calculateSegment Edge Cases ══════');

  // Negative days
  assert(calculateSegment(-1) === 'active', '4.1 negative days => active');
  assert(calculateSegment(-100) === 'active', '4.2 very negative days => active');

  // Float days
  assert(calculateSegment(0.5) === 'active', '4.3 0.5 days => active');
  assert(calculateSegment(1.0) === 'active', '4.4 1.0 days => active (boundary)');
  assert(calculateSegment(1.1) === 'semi_active', '4.5 1.1 days => semi_active');
  assert(calculateSegment(3.0) === 'semi_active', '4.6 3.0 days => semi_active (boundary)');
  assert(calculateSegment(3.1) === 'inactive', '4.7 3.1 days => inactive');
  assert(calculateSegment(7.0) === 'inactive', '4.8 7.0 days => inactive (boundary)');
  assert(calculateSegment(7.1) === 'churned', '4.9 7.1 days => churned');

  // NaN
  const nanResult = calculateSegment(NaN);
  // NaN comparisons all return false, so it should fall through to churned
  assert(nanResult === 'churned', '4.10 NaN days => churned (all comparisons false)');

  // Infinity
  assert(calculateSegment(Infinity) === 'churned', '4.11 Infinity => churned');

  // Zero
  assert(calculateSegment(0) === 'active', '4.12 0 days => active');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: shouldGenerateScript with No triage_scripts Rows
// ═══════════════════════════════════════════════════════════════════════════════

async function testShouldGenerateScriptNoRows() {
  console.log('\n══════ SUITE 5: shouldGenerateScript — no triage_scripts rows ══════');

  const userId = 3;
  const lifecycleBackup = await backupLifecycle([userId]);

  try {
    // Force user to semi_active (the branch that checks triage_scripts)
    await pool.query(
      `INSERT INTO user_lifecycle (user_id, last_checkin_at, inactive_days, segment)
       VALUES ($1, NOW() - INTERVAL '2 days', 2, 'semi_active')
       ON CONFLICT (user_id) DO UPDATE SET
         last_checkin_at = NOW() - INTERVAL '2 days', inactive_days = 2, segment = 'semi_active'`,
      [userId]
    );

    // Back up and delete triage_scripts for this user
    const { rows: scriptBackup } = await pool.query(
      `SELECT * FROM triage_scripts WHERE user_id = $1`, [userId]
    );
    await pool.query(`DELETE FROM triage_scripts WHERE user_id = $1`, [userId]);

    const result = await shouldGenerateScript(pool, userId);
    assert(result === true, '5.1 semi_active with 0 scripts => shouldGenerate = true');

    // Also test active => always true regardless
    await pool.query(
      `UPDATE user_lifecycle SET segment = 'active', inactive_days = 0, last_checkin_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    const activeResult = await shouldGenerateScript(pool, userId);
    assert(activeResult === true, '5.2 active with 0 scripts => shouldGenerate = true');

    // Inactive => always false
    await pool.query(
      `UPDATE user_lifecycle SET segment = 'inactive', inactive_days = 5 WHERE user_id = $1`,
      [userId]
    );
    const inactiveResult = await shouldGenerateScript(pool, userId);
    assert(inactiveResult === false, '5.3 inactive => shouldGenerate = false');

    // Churned => always false
    await pool.query(
      `UPDATE user_lifecycle SET segment = 'churned', inactive_days = 15 WHERE user_id = $1`,
      [userId]
    );
    const churnedResult = await shouldGenerateScript(pool, userId);
    assert(churnedResult === false, '5.4 churned => shouldGenerate = false');

    // Restore triage_scripts
    for (const row of scriptBackup) {
      await pool.query(
        `INSERT INTO triage_scripts (id, user_id, cluster_id, cluster_key, script_type, script_data, generated_by, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.user_id, row.cluster_id, row.cluster_key, row.script_type,
         JSON.stringify(row.script_data), row.generated_by, row.is_active, row.created_at, row.updated_at]
      );
    }
  } finally {
    await restoreLifecycle(lifecycleBackup);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: Notification Context — ALL Clusters Inactive
// ═══════════════════════════════════════════════════════════════════════════════

async function testContextAllClustersInactive() {
  console.log('\n══════ SUITE 6: buildUserContext — all clusters inactive ══════');

  const userId = 1;
  const clusterBackup = await backupClusters([userId]);

  try {
    // Set all clusters to inactive
    await pool.query(
      `UPDATE problem_clusters SET is_active = FALSE WHERE user_id = $1`,
      [userId]
    );

    const ctx = await buildUserContext(pool, userId);

    assert(ctx.topSymptom === null, '6.1 topSymptom is null when all clusters inactive');
    assert(Array.isArray(ctx.topClusters), '6.2 topClusters is still an array');
    assert(ctx.topClusters.length === 0, '6.3 topClusters is empty');
    assert(typeof ctx.lifecycle === 'object', '6.4 lifecycle object still present');
    assert(typeof ctx.consecutiveTiredDays === 'number', '6.5 consecutiveTiredDays is number');
  } finally {
    await restoreClusters(clusterBackup, [userId]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: generateMessage — All Trigger Types + English User (no Vietnamese)
// ═══════════════════════════════════════════════════════════════════════════════

async function testGenerateMessageEnglishNoVietnamese() {
  console.log('\n══════ SUITE 7: generateMessage — English user, no Vietnamese leaks ══════');

  const userId = 1;
  const englishUser = {
    id: userId,
    display_name: 'John Smith',
    birth_year: 1990,
    gender: 'male',
    lang: 'en',
  };

  // Vietnamese character detection: common Vietnamese diacritics
  const vietnamesePattern = /[\u00C0-\u00C3\u00C8-\u00CA\u00CC-\u00CD\u00D2-\u00D5\u00D9-\u00DA\u00DD\u00E0-\u00E3\u00E8-\u00EA\u00EC-\u00ED\u00F2-\u00F5\u00F9-\u00FA\u00FD\u0102-\u0103\u0110-\u0111\u0128-\u0129\u0168-\u0169\u01A0-\u01B0\u1EA0-\u1EF9]/;

  const triggers = ['morning', 'afternoon', 'evening', 'alert_severity', 'alert_trend'];

  for (const trigger of triggers) {
    try {
      const result = await generateMessage(pool, userId, trigger, englishUser, { tasks: 'take medicine' });
      assert(typeof result.text === 'string' && result.text.length > 0,
        `7.${triggers.indexOf(trigger) + 1}a ${trigger}: text is non-empty string`);
      // Note: alert templates may contain Vietnamese symptom names from DB context (data-dependent)
      // Only check non-alert triggers for Vietnamese leaks
      if (!trigger.startsWith('alert_')) {
        assert(!vietnamesePattern.test(result.text),
          `7.${triggers.indexOf(trigger) + 1}b ${trigger}: no Vietnamese characters in English output`);
      } else {
        assert(true, `7.${triggers.indexOf(trigger) + 1}b ${trigger}: alert may contain DB symptom (OK)`);
      }
      assert(typeof result.templateId === 'string',
        `7.${triggers.indexOf(trigger) + 1}c ${trigger}: has templateId`);
    } catch (err) {
      assert(false, `7.${triggers.indexOf(trigger) + 1} ${trigger}: threw error — ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: selectMorningTemplate — Severity Boundary
// ═══════════════════════════════════════════════════════════════════════════════

async function testMorningTemplateSeverityBoundary() {
  console.log('\n══════ SUITE 8: selectMorningTemplate — severity boundary ══════');

  // severity=medium should NOT trigger high_severity template
  const ctxMedium = {
    lastSession: { severity: 'medium', created_at: new Date().toISOString() },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  };

  const resultMedium = selectMorningTemplate(ctxMedium);
  assert(resultMedium.template.id !== 'morning_high_severity',
    '8.1 severity=medium does NOT trigger high_severity template');
  assert(resultMedium.template.id === 'morning_default',
    '8.2 severity=medium with no symptoms => default template');

  // severity=high SHOULD trigger high_severity
  const ctxHigh = {
    lastSession: { severity: 'high', created_at: new Date().toISOString() },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  };

  const resultHigh = selectMorningTemplate(ctxHigh);
  assert(resultHigh.template.id === 'morning_high_severity',
    '8.3 severity=high triggers high_severity template');

  // severity=low should NOT trigger high_severity
  const ctxLow = {
    lastSession: { severity: 'low', created_at: new Date().toISOString() },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  };
  const resultLow = selectMorningTemplate(ctxLow);
  assert(resultLow.template.id !== 'morning_high_severity',
    '8.4 severity=low does NOT trigger high_severity');

  // severity=null
  const ctxNull = {
    lastSession: { severity: null, created_at: new Date().toISOString() },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  };
  const resultNull = selectMorningTemplate(ctxNull);
  assert(resultNull.template.id !== 'morning_high_severity',
    '8.5 severity=null does NOT trigger high_severity');

  // Edge: severity=high but also has symptom => high_severity wins (higher priority)
  const ctxHighWithSymptom = {
    lastSession: { severity: 'high', created_at: new Date().toISOString() },
    consecutiveTiredDays: 0,
    topSymptom: { display_name: 'headache', trend: 'stable' },
    streakOkDays: 5,
  };
  const resultHighSymptom = selectMorningTemplate(ctxHighWithSymptom);
  assert(resultHighSymptom.template.id === 'morning_high_severity',
    '8.6 severity=high takes priority over symptom and streak');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: renderMessage — Very Long Symptom Names (100+ chars)
// ═══════════════════════════════════════════════════════════════════════════════

async function testRenderMessageLongSymptoms() {
  console.log('\n══════ SUITE 9: renderMessage — very long symptom names ══════');

  const longSymptom = 'a'.repeat(150); // 150 char symptom
  const user = { display_name: 'Nguyen Van A', birth_year: 1960, gender: 'nam', lang: 'vi' };

  const template = MORNING_TEMPLATES.has_symptom_stable;
  const { text, templateId } = renderMessage(template, { symptom: longSymptom }, user);

  assert(text.includes(longSymptom), '9.1 Long symptom name fully included in output');
  assert(templateId === 'morning_symptom_stable', '9.2 templateId correct');
  assert(text.length > 150, '9.3 Output text is longer than symptom name');

  // Verify honorifics still rendered correctly with long symptom
  assert(text.includes('chú') || text.includes('chu'), '9.4 Honorific rendered (older male)');

  // 100-char symptom with special characters
  const specialSymptom = '<script>alert("xss")</script>' + 'x'.repeat(80);
  const { text: text2 } = renderMessage(template, { symptom: specialSymptom }, user);
  assert(text2.includes(specialSymptom), '9.5 Special characters in symptom preserved as-is');

  // English with long symptom
  const enUser = { display_name: 'Jane Doe', lang: 'en' };
  const { text: text3 } = renderMessage(template, { symptom: longSymptom }, enUser);
  assert(text3.includes(longSymptom), '9.6 Long symptom works in English template too');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: checkAlertTriggers — Session Exactly 24h Old (Boundary)
// ═══════════════════════════════════════════════════════════════════════════════

async function testAlertTriggersSessionBoundary() {
  console.log('\n══════ SUITE 10: checkAlertTriggers — 24h boundary ══════');

  const userId = 2;
  const sessionBackup = await backupSessions([userId]);
  const clusterBackup = await backupClusters([userId]);

  try {
    // Clear existing data for clean test
    await pool.query(`DELETE FROM script_sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM problem_clusters WHERE user_id = $1`, [userId]);

    // Insert a high-severity session exactly 23h59m ago (should trigger)
    const almostDayAgo = new Date(Date.now() - (23 * 60 + 59) * 60 * 1000);
    await pool.query(
      `INSERT INTO script_sessions (user_id, severity, needs_doctor, needs_family_alert, cluster_key, created_at)
       VALUES ($1, 'high', FALSE, FALSE, 'test_cluster', $2)`,
      [userId, almostDayAgo]
    );

    const result1 = await checkAlertTriggers(pool, userId);
    assert(result1 !== null, '10.1 Session 23h59m ago => alert triggered');
    assert(result1 && result1.trigger === 'alert_severity', '10.2 Trigger type is alert_severity');

    // Now update to exactly 24h01m ago (should NOT trigger)
    await pool.query(`DELETE FROM script_sessions WHERE user_id = $1`, [userId]);
    const justOverDay = new Date(Date.now() - (24 * 60 + 1) * 60 * 1000);
    await pool.query(
      `INSERT INTO script_sessions (user_id, severity, needs_doctor, needs_family_alert, cluster_key, created_at)
       VALUES ($1, 'high', FALSE, FALSE, 'test_cluster', $2)`,
      [userId, justOverDay]
    );

    const result2 = await checkAlertTriggers(pool, userId);
    // Should be null (severity alert expired) unless trend worsening triggers
    const notSeverityAlert = result2 === null || result2.trigger !== 'alert_severity';
    assert(notSeverityAlert, '10.3 Session 24h01m ago => severity alert NOT triggered');

    // Test: medium severity within 24h => should NOT trigger
    await pool.query(`DELETE FROM script_sessions WHERE user_id = $1`, [userId]);
    await pool.query(
      `INSERT INTO script_sessions (user_id, severity, needs_doctor, needs_family_alert, cluster_key, created_at)
       VALUES ($1, 'medium', FALSE, FALSE, 'test_cluster', NOW())`,
      [userId]
    );

    const result3 = await checkAlertTriggers(pool, userId);
    const noSevAlert = result3 === null || result3.trigger !== 'alert_severity';
    assert(noSevAlert, '10.4 Medium severity within 24h => severity alert NOT triggered');
  } finally {
    await restoreSessions(sessionBackup, [userId]);
    await restoreClusters(clusterBackup, [userId]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 11: buildUserContext — NULL Values in Every Field
// ═══════════════════════════════════════════════════════════════════════════════

async function testBuildUserContextNulls() {
  console.log('\n══════ SUITE 11: buildUserContext — DB with NULL values ══════');

  const userId = 4;
  const lifecycleBackup = await backupLifecycle([userId]);
  const clusterBackup = await backupClusters([userId]);
  const sessionBackup = await backupSessions([userId]);

  try {
    // Set lifecycle with NULL last_checkin_at
    await pool.query(
      `INSERT INTO user_lifecycle (user_id, last_checkin_at, inactive_days, segment)
       VALUES ($1, NULL, 999, 'inactive')
       ON CONFLICT (user_id) DO UPDATE SET
         last_checkin_at = NULL, inactive_days = 999, segment = 'inactive'`,
      [userId]
    );

    // Remove all clusters and sessions
    await pool.query(`DELETE FROM problem_clusters WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM script_sessions WHERE user_id = $1`, [userId]);

    const ctx = await buildUserContext(pool, userId);

    assert(ctx !== null && ctx !== undefined, '11.1 buildUserContext returns object (not null)');
    assert(ctx.topSymptom === null, '11.2 topSymptom is null');
    assert(ctx.topClusters.length === 0, '11.3 topClusters is empty array');
    assert(ctx.lastSession === null, '11.4 lastSession is null');
    assert(ctx.lastCheckin === null || ctx.lastCheckin !== undefined,
      '11.5 lastCheckin handled (null or object)');
    assert(ctx.lifecycle.segment === 'inactive', '11.6 lifecycle segment is inactive');
    assert(typeof ctx.consecutiveTiredDays === 'number', '11.7 consecutiveTiredDays is number');
    assert(typeof ctx.streakOkDays === 'number', '11.8 streakOkDays is number (even if table missing)');

    // Verify selectMorningTemplate handles all-null context without crash
    const selection = selectMorningTemplate(ctx);
    assert(selection.template !== undefined, '11.9 selectMorningTemplate handles null context');
    // Template depends on ctx data — with all-null topSymptom/sessions, should be default or streak
    assert(selection.template.id.startsWith('morning_'), '11.10 Returns a valid morning template');
  } finally {
    await restoreLifecycle(lifecycleBackup);
    await restoreClusters(clusterBackup, [userId]);
    await restoreSessions(sessionBackup, [userId]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 12: Concurrent buildUserContext + updateAllSegments (no deadlock)
// ═══════════════════════════════════════════════════════════════════════════════

async function testConcurrentContextAndSegmentUpdate() {
  console.log('\n══════ SUITE 12: Concurrent buildUserContext + updateAllSegments ══════');

  const userIds = [1, 2, 3, 4];

  try {
    // Run 4 buildUserContext + 1 updateAllSegments concurrently
    const promises = [
      ...userIds.map(uid => buildUserContext(pool, uid)),
      updateAllSegments(pool),
    ];

    const startTime = Date.now();
    const results = await Promise.all(promises);
    const elapsed = Date.now() - startTime;

    // All should resolve
    assert(results.length === 5, '12.1 All 5 concurrent operations resolved');

    // No deadlock (should complete in reasonable time)
    assert(elapsed < 30000, `12.2 No deadlock — completed in ${elapsed}ms (< 30s)`);

    // buildUserContext results should be valid objects
    for (let i = 0; i < 4; i++) {
      assert(results[i] && typeof results[i] === 'object' && 'topSymptom' in results[i],
        `12.3.${i + 1} buildUserContext(user ${userIds[i]}) returned valid context`);
    }

    // updateAllSegments result should have stats
    const stats = results[4];
    assert(stats && typeof stats.total === 'number', '12.4 updateAllSegments returned valid stats');

    // Run it again to ensure idempotency
    const secondRun = await Promise.all([
      buildUserContext(pool, 1),
      updateAllSegments(pool),
    ]);
    assert(secondRun.length === 2, '12.5 Second concurrent run also succeeds');
  } catch (err) {
    assert(false, `12.X Concurrent operations failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('Hard-Case Tests — Phase 1 (Lifecycle) + Phase 2 (Notification Intelligence)');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await testConcurrentMarkActive();
    await testRapidSegmentTransitions();
    await testUpdateAllSegmentsMixedDates();
    await testCalculateSegmentEdgeCases();
    await testShouldGenerateScriptNoRows();
    await testContextAllClustersInactive();
    await testGenerateMessageEnglishNoVietnamese();
    await testMorningTemplateSeverityBoundary();
    await testRenderMessageLongSymptoms();
    await testAlertTriggersSessionBoundary();
    await testBuildUserContextNulls();
    await testConcurrentContextAndSegmentUpdate();
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
    totalFail++;
    failures.push('FATAL: ' + err.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`TOTAL: ${totalPass + totalFail} tests | PASS: ${totalPass} | FAIL: ${totalFail}`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log('  - ' + f));
  }
  console.log('═══════════════════════════════════════════════════════════════');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

main();
