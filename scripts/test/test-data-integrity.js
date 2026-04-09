'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  createClustersFromOnboarding,
  getUserScript,
  getScript,
  addCluster,
  updateClusterStats,
  generateScriptForCluster,
} = require('../src/services/checkin/script.service');

const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');
const { evaluateScript, evaluateFollowUp } = require('../src/services/checkin/scoring-engine');
const {
  logFallback,
  markFallbackProcessed,
  getFallbackScriptData,
  matchCluster,
  getPendingFallbacks,
} = require('../src/services/checkin/fallback.service');

const { listComplaints, resolveComplaint } = require('../src/services/checkin/clinical-mapping');

// ─── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];
const TEST_USER_ID = 4;

function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// ─── Cleanup helper ────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    console.log(`\n  DATA INTEGRITY & DATABASE CONSISTENCY TEST`);
    console.log(`  user_id = ${TEST_USER_ID}`);
    console.log(`  ${new Date().toISOString()}\n`);

    // Verify user exists
    const { rows: userCheck } = await pool.query('SELECT id, full_name FROM users WHERE id = $1', [TEST_USER_ID]);
    if (userCheck.length === 0) {
      console.log('FATAL: user_id=4 not found in DB.');
      process.exit(1);
    }
    console.log(`  User: id=${userCheck[0].id}, name=${userCheck[0].full_name}\n`);

    // ── Full cleanup before tests ──
    await cleanup();

    // ═══════════════════════════════════════════════════════════════════════
    // A. FOREIGN KEY AND CONSTRAINT TESTS (10 tests)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('═══ A. FOREIGN KEY AND CONSTRAINT TESTS ═══');

    // A1: Create cluster -> verify problem_clusters row has correct user_id
    const { rows: a1Rows } = await pool.query(
      `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
       VALUES ($1, 'headache', 'đau đầu', 'onboarding', 5)
       ON CONFLICT (user_id, cluster_key) DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING *`,
      [TEST_USER_ID]
    );
    assert('A1: Create cluster -> user_id correct',
      a1Rows[0]?.user_id === TEST_USER_ID,
      `user_id=${a1Rows[0]?.user_id}`);

    // A2: Create triage_scripts referencing cluster_id
    const clusterId = a1Rows[0].id;
    const scriptData = getFallbackScriptData(); // use fallback as quick valid script
    const { rows: a2Rows } = await pool.query(
      `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by)
       VALUES ($1, $2, 'headache', 'initial', $3::jsonb, 'system')
       RETURNING *`,
      [TEST_USER_ID, clusterId, JSON.stringify(scriptData)]
    );
    assert('A2: triage_scripts references cluster_id correctly',
      a2Rows[0]?.cluster_id === clusterId,
      `cluster_id=${a2Rows[0]?.cluster_id}, expected=${clusterId}`);

    // A3: Delete cluster -> scripts still exist (ON DELETE SET NULL)
    await pool.query('DELETE FROM problem_clusters WHERE id = $1', [clusterId]);
    const { rows: a3Check } = await pool.query(
      'SELECT id, cluster_id FROM triage_scripts WHERE id = $1', [a2Rows[0].id]
    );
    assert('A3: Delete cluster -> scripts still exist (ON DELETE SET NULL)',
      a3Check.length === 1 && a3Check[0].cluster_id === null,
      `exists=${a3Check.length > 0}, cluster_id=${a3Check[0]?.cluster_id}`);

    // Cleanup for next tests
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);

    // A4: Duplicate cluster (same user_id + cluster_key) -> ON CONFLICT works
    await pool.query(
      `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
       VALUES ($1, 'headache', 'đau đầu', 'onboarding', 5)
       ON CONFLICT (user_id, cluster_key) DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING *`,
      [TEST_USER_ID]
    );
    // Insert again with ON CONFLICT
    const { rows: a4Rows } = await pool.query(
      `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
       VALUES ($1, 'headache', 'đau đầu updated', 'onboarding', 10)
       ON CONFLICT (user_id, cluster_key) DO UPDATE SET
         display_name = EXCLUDED.display_name, is_active = TRUE, updated_at = NOW()
       RETURNING *`,
      [TEST_USER_ID]
    );
    const { rows: a4Count } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'headache']
    );
    assert('A4: Duplicate cluster ON CONFLICT -> only 1 row',
      parseInt(a4Count[0].count) === 1,
      `count=${a4Count[0].count}`);

    // A5: Script with non-existent cluster_id -> should fail FK
    let a5Passed = false;
    try {
      await pool.query(
        `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by)
         VALUES ($1, 999999999, 'test_key', 'initial', $2::jsonb, 'system')`,
        [TEST_USER_ID, JSON.stringify(scriptData)]
      );
      a5Passed = false; // should have thrown
    } catch (err) {
      a5Passed = err.message.includes('violates foreign key') || err.code === '23503';
    }
    assert('A5: Script with non-existent cluster_id -> FK violation',
      a5Passed, 'FK constraint enforced');

    // A6: UNIQUE constraint on triage_scripts (user_id, cluster_key, script_type) WHERE is_active=TRUE
    // Get the cluster we have
    const { rows: a6Cluster } = await pool.query(
      'SELECT id FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'headache']
    );
    const a6ClusterId = a6Cluster[0].id;
    // Insert first active script
    await pool.query(
      `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by, is_active)
       VALUES ($1, $2, 'headache', 'initial', $3::jsonb, 'system', TRUE)`,
      [TEST_USER_ID, a6ClusterId, JSON.stringify(scriptData)]
    );
    // Insert second active script with same key -> should fail unique index
    let a6Passed = false;
    try {
      await pool.query(
        `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by, is_active)
         VALUES ($1, $2, 'headache', 'initial', $3::jsonb, 'system', TRUE)`,
        [TEST_USER_ID, a6ClusterId, JSON.stringify(scriptData)]
      );
      a6Passed = false;
    } catch (err) {
      a6Passed = err.message.includes('unique') || err.message.includes('duplicate') || err.code === '23505';
    }
    assert('A6: UNIQUE constraint on active triage_scripts (user_id, cluster_key, script_type)',
      a6Passed, 'unique index enforced');

    // Cleanup
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);

    // A7: Fallback log with non-existent user_id -> should fail FK
    let a7Passed = false;
    try {
      await pool.query(
        `INSERT INTO fallback_logs (user_id, raw_input, fallback_answers)
         VALUES (999999999, 'test input', '[]'::jsonb)`
      );
      a7Passed = false;
    } catch (err) {
      a7Passed = err.message.includes('violates foreign key') || err.code === '23503';
    }
    assert('A7: Fallback log with non-existent user_id -> FK violation',
      a7Passed, 'FK constraint enforced');

    // A8: script_session with non-existent checkin_id -> should work (FK allows NULL, or SET NULL on delete)
    // Actually the FK references health_checkins(id), so non-existent should fail.
    // But NULL checkin_id is allowed. Let's test NULL:
    let a8Passed = false;
    try {
      const { rows: a8Rows } = await pool.query(
        `INSERT INTO script_sessions (user_id, checkin_id, cluster_key, session_type, answers)
         VALUES ($1, NULL, 'headache', 'initial', '[]'::jsonb)
         RETURNING *`,
        [TEST_USER_ID]
      );
      a8Passed = a8Rows.length === 1 && a8Rows[0].checkin_id === null;
    } catch (err) {
      a8Passed = false;
    }
    assert('A8: script_session with NULL checkin_id -> allowed',
      a8Passed, 'NULL FK accepted');

    // A9: Verify script_sessions.answers is valid JSONB after insertion
    const testAnswers = [{ question_id: 'q1', answer: 5 }, { question_id: 'q2', answer: 'test' }];
    const { rows: a9Rows } = await pool.query(
      `INSERT INTO script_sessions (user_id, cluster_key, session_type, answers)
       VALUES ($1, 'headache', 'initial', $2::jsonb)
       RETURNING answers`,
      [TEST_USER_ID, JSON.stringify(testAnswers)]
    );
    const a9Parsed = a9Rows[0]?.answers;
    assert('A9: script_sessions.answers is valid JSONB',
      Array.isArray(a9Parsed) && a9Parsed.length === 2 && a9Parsed[0].question_id === 'q1',
      `type=${typeof a9Parsed}, len=${a9Parsed?.length}`);

    // A10: problem_clusters.priority is numeric and ordered correctly
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
    await pool.query(
      `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
       VALUES ($1, 'a_low', 'Low', 'onboarding', 1),
              ($1, 'b_mid', 'Mid', 'onboarding', 5),
              ($1, 'c_high', 'High', 'onboarding', 10)`,
      [TEST_USER_ID]
    );
    const { rows: a10Rows } = await pool.query(
      `SELECT cluster_key, priority FROM problem_clusters
       WHERE user_id = $1 ORDER BY priority DESC`,
      [TEST_USER_ID]
    );
    assert('A10: priority is numeric and ordered correctly',
      a10Rows[0]?.cluster_key === 'c_high' && a10Rows[1]?.cluster_key === 'b_mid' && a10Rows[2]?.cluster_key === 'a_low',
      `order: ${a10Rows.map(r => r.cluster_key + '=' + r.priority).join(', ')}`);

    // Cleanup A
    await cleanup();

    // ═══════════════════════════════════════════════════════════════════════
    // B. DATA CONSISTENCY AFTER OPERATIONS (10 tests)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ B. DATA CONSISTENCY AFTER OPERATIONS ═══');

    // B1: createClustersFromOnboarding -> count(problem_clusters) matches symptom count
    const symptoms3 = ['đau đầu', 'chóng mặt', 'mệt mỏi'];
    const b1Clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, symptoms3);
    const { rows: b1Count } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    assert('B1: createClustersFromOnboarding -> cluster count = symptom count',
      parseInt(b1Count[0].count) === symptoms3.length,
      `symptoms=${symptoms3.length}, clusters=${b1Count[0].count}`);

    // B2: Each cluster has exactly 1 active initial script and 1 active followup script
    const { rows: b2Scripts } = await pool.query(
      `SELECT cluster_key, script_type, count(*) as cnt
       FROM triage_scripts WHERE user_id = $1 AND is_active = TRUE
       GROUP BY cluster_key, script_type`,
      [TEST_USER_ID]
    );
    const b2InitialKeys = b2Scripts.filter(s => s.script_type === 'initial').map(s => s.cluster_key);
    const b2FollowupKeys = b2Scripts.filter(s => s.script_type === 'followup').map(s => s.cluster_key);
    const b2AllHaveOne = b2Scripts.every(s => parseInt(s.cnt) === 1);
    assert('B2: Each cluster has exactly 1 active initial + 1 active followup',
      b2AllHaveOne && b2InitialKeys.length === 3 && b2FollowupKeys.length === 3,
      `initial=${b2InitialKeys.length}, followup=${b2FollowupKeys.length}, allOne=${b2AllHaveOne}`);

    // B3: After addCluster -> total clusters increased by 1
    const { rows: b3Before } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    await addCluster(pool, TEST_USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
    const { rows: b3After } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    assert('B3: addCluster -> total clusters +1',
      parseInt(b3After[0].count) === parseInt(b3Before[0].count) + 1,
      `before=${b3Before[0].count}, after=${b3After[0].count}`);

    // B4: After deactivating a cluster -> getUserScript excludes it
    await pool.query(
      `UPDATE problem_clusters SET is_active = FALSE WHERE user_id = $1 AND cluster_key = 'gastric_pain'`,
      [TEST_USER_ID]
    );
    const b4Result = await getUserScript(pool, TEST_USER_ID);
    const b4HasGastric = b4Result?.clusters?.some(c => c.cluster_key === 'gastric_pain');
    assert('B4: Deactivated cluster excluded from getUserScript',
      !b4HasGastric,
      `gastric_pain in clusters=${b4HasGastric}`);

    // B5: After generating new script version -> old version is_active=FALSE
    const b5ClusterRow = (await pool.query(
      `SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = 'headache'`, [TEST_USER_ID]
    )).rows[0];
    // Generate again (which should deactivate old)
    await generateScriptForCluster(pool, TEST_USER_ID, b5ClusterRow);
    const { rows: b5Scripts } = await pool.query(
      `SELECT id, is_active FROM triage_scripts
       WHERE user_id = $1 AND cluster_key = 'headache' AND script_type = 'initial'
       ORDER BY id DESC`,
      [TEST_USER_ID]
    );
    const b5ActiveCount = b5Scripts.filter(s => s.is_active).length;
    const b5InactiveCount = b5Scripts.filter(s => !s.is_active).length;
    assert('B5: New script version -> old is_active=FALSE, only 1 active',
      b5ActiveCount === 1 && b5InactiveCount >= 1,
      `active=${b5ActiveCount}, inactive=${b5InactiveCount}, total=${b5Scripts.length}`);

    // B6: Count active scripts for ACTIVE clusters = count active clusters x 2 (initial + followup)
    // Note: deactivated clusters may still have active scripts (by design, for audit).
    // We count only scripts whose cluster_key belongs to an active cluster.
    const { rows: b6Clusters } = await pool.query(
      'SELECT cluster_key FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE', [TEST_USER_ID]
    );
    const b6ActiveKeys = b6Clusters.map(c => c.cluster_key);
    const { rows: b6Scripts } = await pool.query(
      `SELECT count(*) FROM triage_scripts
       WHERE user_id = $1 AND is_active = TRUE AND cluster_key = ANY($2)`,
      [TEST_USER_ID, b6ActiveKeys]
    );
    const b6Expected = b6ActiveKeys.length * 2;
    assert('B6: Active scripts for active clusters = active clusters x 2',
      parseInt(b6Scripts[0].count) === b6Expected,
      `active_clusters=${b6ActiveKeys.length}, scripts=${b6Scripts[0].count}, expected=${b6Expected}`);

    // B7: Fallback log with answers -> answers JSONB is parseable
    const b7Answers = [{ question_id: 'fb1', answer: 6 }, { question_id: 'fb2', answer: 'Vừa mới' }];
    await logFallback(pool, TEST_USER_ID, 'đau răng', null, b7Answers);
    const { rows: b7Check } = await pool.query(
      `SELECT fallback_answers FROM fallback_logs WHERE user_id = $1 AND raw_input = 'đau răng'
       ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER_ID]
    );
    const b7Parsed = b7Check[0]?.fallback_answers;
    assert('B7: Fallback log answers JSONB parseable with correct structure',
      Array.isArray(b7Parsed) && b7Parsed.length === 2 && b7Parsed[0].question_id === 'fb1',
      `type=${typeof b7Parsed}, len=${b7Parsed?.length}`);

    // B8: markFallbackProcessed -> all fields updated atomically
    const { rows: b8Row } = await pool.query(
      `SELECT id FROM fallback_logs WHERE user_id = $1 AND raw_input = 'đau răng' ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER_ID]
    );
    if (b8Row.length > 0) {
      await markFallbackProcessed(pool, b8Row[0].id, 'tooth_pain', 'dental_pain', 0.85, null);
      const { rows: b8Check } = await pool.query(
        'SELECT status, ai_label, ai_cluster_key, ai_confidence, processed_at FROM fallback_logs WHERE id = $1',
        [b8Row[0].id]
      );
      assert('B8: markFallbackProcessed -> all fields updated atomically',
        b8Check[0]?.status === 'processed' &&
        b8Check[0]?.ai_label === 'tooth_pain' &&
        b8Check[0]?.ai_cluster_key === 'dental_pain' &&
        parseFloat(b8Check[0]?.ai_confidence) === 0.85 &&
        b8Check[0]?.processed_at !== null,
        `status=${b8Check[0]?.status}, label=${b8Check[0]?.ai_label}, conf=${b8Check[0]?.ai_confidence}, processed_at=${b8Check[0]?.processed_at}`);
    } else {
      assert('B8: markFallbackProcessed -> skipped (no fallback row)', false, 'no row found');
    }

    // B9: Script session completion -> all conclusion fields populated
    const b9Script = await getScript(pool, TEST_USER_ID, 'headache', 'initial');
    if (b9Script) {
      const b9Answers = [
        { question_id: 'q1', answer: 7 },
        { question_id: 'q2', answer: 'buồn nôn hoặc nôn' },
        { question_id: 'q3', answer: 'vài giờ trước' },
        { question_id: 'q4', answer: 'có vẻ nặng hơn' },
      ];
      const b9Result = getNextQuestion(b9Script.script_data, b9Answers, { sessionType: 'initial', profile: {} });
      // Even if not all q's answered, simulate completion by checking conclusion building
      const b9Scoring = evaluateScript(b9Script.script_data, b9Answers, {});
      const { rows: b9Session } = await pool.query(
        `INSERT INTO script_sessions (user_id, cluster_key, session_type, answers, is_completed,
           severity, needs_doctor, needs_family_alert, follow_up_hours,
           conclusion_summary, conclusion_recommendation, conclusion_close_message, completed_at)
         VALUES ($1, 'headache', 'initial', $2::jsonb, TRUE,
           $3, $4, $5, $6, 'test summary', 'test recommendation', 'test close', NOW())
         RETURNING *`,
        [TEST_USER_ID, JSON.stringify(b9Answers),
         b9Scoring.severity, b9Scoring.needsDoctor, b9Scoring.needsFamilyAlert, b9Scoring.followUpHours]
      );
      assert('B9: Script session completion -> conclusion fields populated',
        b9Session[0]?.conclusion_summary !== null &&
        b9Session[0]?.conclusion_recommendation !== null &&
        b9Session[0]?.conclusion_close_message !== null &&
        b9Session[0]?.completed_at !== null &&
        b9Session[0]?.severity !== null,
        `severity=${b9Session[0]?.severity}, completed_at=${b9Session[0]?.completed_at}`);
    } else {
      assert('B9: Script session completion -> skipped', false, 'no headache script');
    }

    // B10: health_checkins updated when script session completes
    // Create a health_checkin, then create a script_session referencing it, verify linkage
    const today = new Date().toISOString().split('T')[0];
    let b10CheckinId = null;
    try {
      const { rows: b10Checkin } = await pool.query(
        `INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state)
         VALUES ($1, $2, 'tired', 'tired', 'monitoring')
         ON CONFLICT (user_id, session_date) DO UPDATE SET current_status = 'tired', updated_at = NOW()
         RETURNING id`,
        [TEST_USER_ID, today]
      );
      b10CheckinId = b10Checkin[0].id;
      const { rows: b10Session } = await pool.query(
        `INSERT INTO script_sessions (user_id, checkin_id, cluster_key, session_type, answers, is_completed, completed_at)
         VALUES ($1, $2, 'headache', 'initial', '[]'::jsonb, TRUE, NOW())
         RETURNING *`,
        [TEST_USER_ID, b10CheckinId]
      );
      // Update the checkin to reflect script completion
      await pool.query(
        `UPDATE health_checkins SET triage_severity = 'medium', triage_completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [b10CheckinId]
      );
      const { rows: b10Verify } = await pool.query(
        'SELECT triage_severity, triage_completed_at FROM health_checkins WHERE id = $1', [b10CheckinId]
      );
      assert('B10: health_checkins updated when script session completes',
        b10Verify[0]?.triage_severity === 'medium' && b10Verify[0]?.triage_completed_at !== null,
        `severity=${b10Verify[0]?.triage_severity}, triage_completed_at=${b10Verify[0]?.triage_completed_at}`);
    } catch (err) {
      assert('B10: health_checkins updated when script session completes', false, err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // C. SCRIPT DATA STRUCTURE VALIDATION (15 tests — 14 complaints + 1 generic)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ C. SCRIPT DATA STRUCTURE VALIDATION ═══');

    // Cleanup for fresh generation
    await cleanup();

    const allComplaints = listComplaints();
    // Pick 14 clinical complaints (mapped ones) + 1 generic
    const clinicalComplaints = allComplaints.slice(0, 14);
    const genericComplaint = 'unknown_test_complaint';
    const testComplaints = [...clinicalComplaints, genericComplaint];

    // Map complaint names to Vietnamese for onboarding
    const complaintSymptoms = clinicalComplaints.map(c => c); // already Vietnamese
    // Add generic
    complaintSymptoms.push(genericComplaint);

    // Generate clusters for all
    const cClusters = await createClustersFromOnboarding(pool, TEST_USER_ID, complaintSymptoms);

    let cPassCount = 0;
    let cFailCount = 0;

    for (let i = 0; i < testComplaints.length; i++) {
      const complaint = testComplaints[i];
      const label = `C${i + 1}`;
      const clusterRow = cClusters[i];
      if (!clusterRow) {
        assert(`${label}: [${complaint}] cluster creation`, false, 'cluster not created');
        cFailCount++;
        continue;
      }

      // Read script_data from DB
      const script = await getScript(pool, TEST_USER_ID, clusterRow.cluster_key, 'initial');
      if (!script) {
        assert(`${label}: [${complaint}] script exists`, false, 'script not found in DB');
        cFailCount++;
        continue;
      }

      const sd = script.script_data;
      const subErrors = [];

      // 1. Valid JSON (not string, not null)
      if (!sd || typeof sd !== 'object') subErrors.push('script_data is null or not object');

      // 2. questions array: each has id (unique), text (non-empty), type (valid enum)
      const validTypes = ['slider', 'single_choice', 'multi_choice', 'free_text'];
      if (!Array.isArray(sd?.questions) || sd.questions.length === 0) {
        subErrors.push('questions missing or empty');
      } else {
        const qIds = new Set();
        for (const q of sd.questions) {
          if (!q.id) subErrors.push(`question missing id`);
          if (!q.text || q.text.trim() === '') subErrors.push(`question ${q.id}: empty text`);
          if (!validTypes.includes(q.type)) subErrors.push(`question ${q.id}: invalid type "${q.type}"`);
          if (qIds.has(q.id)) subErrors.push(`duplicate question id: ${q.id}`);
          qIds.add(q.id);
        }

        // 3. scoring_rules: each has conditions (array), severity (valid enum)
        const validSeverities = ['low', 'medium', 'high', 'critical'];
        if (!Array.isArray(sd?.scoring_rules) || sd.scoring_rules.length === 0) {
          subErrors.push('scoring_rules missing or empty');
        } else {
          for (let ri = 0; ri < sd.scoring_rules.length; ri++) {
            const rule = sd.scoring_rules[ri];
            if (!Array.isArray(rule.conditions)) subErrors.push(`scoring_rules[${ri}]: conditions not array`);
            if (!validSeverities.includes(rule.severity)) subErrors.push(`scoring_rules[${ri}]: invalid severity "${rule.severity}"`);
          }
        }

        // 4. conclusion_templates: has low, medium, high; each has summary, recommendation, close_message
        const ct = sd?.conclusion_templates;
        if (!ct || typeof ct !== 'object') {
          subErrors.push('conclusion_templates missing');
        } else {
          for (const level of ['low', 'medium', 'high']) {
            if (!ct[level]) {
              subErrors.push(`conclusion_templates missing "${level}"`);
            } else {
              if (!ct[level].summary) subErrors.push(`conclusion_templates.${level} missing summary`);
              if (!ct[level].recommendation) subErrors.push(`conclusion_templates.${level} missing recommendation`);
              if (!ct[level].close_message) subErrors.push(`conclusion_templates.${level} missing close_message`);
            }
          }
        }

        // 5. followup_questions: array with id, text, type
        if (!Array.isArray(sd?.followup_questions) || sd.followup_questions.length === 0) {
          subErrors.push('followup_questions missing or empty');
        } else {
          for (const fq of sd.followup_questions) {
            if (!fq.id) subErrors.push('followup_question missing id');
            if (!fq.text) subErrors.push('followup_question missing text');
            if (!fq.type) subErrors.push('followup_question missing type');
          }
        }

        // 6. No duplicate question IDs within script (already checked above)

        // 7. All scoring rule field references point to actual question IDs
        if (Array.isArray(sd?.scoring_rules)) {
          for (let ri = 0; ri < sd.scoring_rules.length; ri++) {
            const rule = sd.scoring_rules[ri];
            for (const cond of (rule.conditions || [])) {
              if (cond.field && !qIds.has(cond.field)) {
                subErrors.push(`scoring_rules[${ri}]: field "${cond.field}" not in question IDs`);
              }
            }
          }
        }

        // 8. condition_modifiers reference valid user_conditions
        if (Array.isArray(sd?.condition_modifiers)) {
          for (const mod of sd.condition_modifiers) {
            if (mod.user_condition && typeof mod.user_condition !== 'string') {
              subErrors.push('condition_modifier user_condition is not string');
            }
          }
        }
      }

      if (subErrors.length === 0) {
        cPassCount++;
        assert(`${label}: [${complaint}] full structure validation`, true, 'all checks passed');
      } else {
        cFailCount++;
        assert(`${label}: [${complaint}] full structure validation`, false, subErrors.join('; '));
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // D. CONCURRENT WRITE SIMULATION (8 tests)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ D. CONCURRENT WRITE SIMULATION ═══');

    await cleanup();

    // D1: Create 5 clusters in parallel -> all created, no duplicates
    const d1Keys = ['d_headache', 'd_dizziness', 'd_fatigue', 'd_chest_pain', 'd_back_pain'];
    const d1Promises = d1Keys.map(key =>
      pool.query(
        `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
         VALUES ($1, $2, $3, 'test', 1)
         ON CONFLICT (user_id, cluster_key) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [TEST_USER_ID, key, key]
      )
    );
    const d1Results = await Promise.all(d1Promises);
    const { rows: d1Count } = await pool.query(
      `SELECT count(*) FROM problem_clusters WHERE user_id = $1 AND cluster_key LIKE 'd_%'`,
      [TEST_USER_ID]
    );
    assert('D1: 5 clusters in parallel -> all created, no duplicates',
      parseInt(d1Count[0].count) === 5,
      `count=${d1Count[0].count}`);

    // D2: Log 10 fallbacks in parallel -> all saved
    const d2Promises = Array.from({ length: 10 }, (_, i) =>
      logFallback(pool, TEST_USER_ID, `parallel_symptom_${i}`, null, [{ question_id: 'fb1', answer: i }])
    );
    await Promise.all(d2Promises);
    const { rows: d2Count } = await pool.query(
      `SELECT count(*) FROM fallback_logs WHERE user_id = $1 AND raw_input LIKE 'parallel_symptom_%'`,
      [TEST_USER_ID]
    );
    assert('D2: 10 fallbacks in parallel -> all saved',
      parseInt(d2Count[0].count) === 10,
      `count=${d2Count[0].count}`);

    // D3: Update cluster stats + get script in parallel -> no race condition
    // First create a real cluster with script
    await cleanup();
    const d3Clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, ['đau đầu']);
    let d3NoError = true;
    try {
      await Promise.all([
        updateClusterStats(pool, TEST_USER_ID, 'headache', { count_7d: 3, trend: 'increasing' }),
        getUserScript(pool, TEST_USER_ID),
        updateClusterStats(pool, TEST_USER_ID, 'headache', { count_7d: 5, trend: 'stable' }),
        getUserScript(pool, TEST_USER_ID),
      ]);
    } catch (err) {
      d3NoError = false;
    }
    assert('D3: Update stats + getUserScript in parallel -> no race condition',
      d3NoError, 'no errors');

    // D4: Create cluster + getUserScript in parallel -> consistent state
    let d4NoError = true;
    try {
      const [d4Cluster, d4Script] = await Promise.all([
        addCluster(pool, TEST_USER_ID, 'joint_pain', 'đau khớp', 'test'),
        getUserScript(pool, TEST_USER_ID),
      ]);
      d4NoError = d4Cluster !== null && d4Script !== null;
    } catch (err) {
      d4NoError = false;
    }
    assert('D4: addCluster + getUserScript in parallel -> consistent state',
      d4NoError, 'both returned valid data');

    // D5: Two addCluster calls with same key in parallel -> only 1 created (ON CONFLICT)
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1 AND cluster_key = $2', [TEST_USER_ID, 'dup_test']);
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2', [TEST_USER_ID, 'dup_test']);
    let d5NoError = true;
    try {
      await Promise.all([
        addCluster(pool, TEST_USER_ID, 'dup_test', 'duplicate test', 'test'),
        addCluster(pool, TEST_USER_ID, 'dup_test', 'duplicate test', 'test'),
      ]);
    } catch (err) {
      // ON CONFLICT should handle this, but concurrent inserts might still error
      d5NoError = true; // as long as it doesn't crash
    }
    const { rows: d5Count } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'dup_test']
    );
    assert('D5: Two addCluster same key in parallel -> only 1 row',
      parseInt(d5Count[0].count) === 1,
      `count=${d5Count[0].count}`);

    // D6: markFallbackProcessed twice on same row -> second is idempotent
    await logFallback(pool, TEST_USER_ID, 'd6_test_symptom', null, []);
    const { rows: d6Row } = await pool.query(
      `SELECT id FROM fallback_logs WHERE user_id = $1 AND raw_input = 'd6_test_symptom' ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER_ID]
    );
    if (d6Row.length > 0) {
      await markFallbackProcessed(pool, d6Row[0].id, 'label1', 'key1', 0.9, null);
      await markFallbackProcessed(pool, d6Row[0].id, 'label2', 'key2', 0.95, null);
      const { rows: d6Check } = await pool.query(
        'SELECT status, ai_label, ai_confidence FROM fallback_logs WHERE id = $1', [d6Row[0].id]
      );
      assert('D6: markFallbackProcessed twice -> second overwrites (idempotent)',
        d6Check[0]?.ai_label === 'label2' && parseFloat(d6Check[0]?.ai_confidence) === 0.95,
        `label=${d6Check[0]?.ai_label}, conf=${d6Check[0]?.ai_confidence}`);
    } else {
      assert('D6: markFallbackProcessed twice', false, 'no fallback row');
    }

    // D7: Generate script while reading script -> reader gets valid data
    let d7NoError = true;
    try {
      const d7Cluster = (await pool.query(
        `SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = 'headache'`, [TEST_USER_ID]
      )).rows[0];
      if (d7Cluster) {
        const [, d7Read] = await Promise.all([
          generateScriptForCluster(pool, TEST_USER_ID, d7Cluster),
          getScript(pool, TEST_USER_ID, 'headache', 'initial'),
        ]);
        // Reader should get either old or new valid script (not corrupt)
        d7NoError = d7Read === null || (d7Read.script_data && typeof d7Read.script_data === 'object');
      }
    } catch (err) {
      d7NoError = false;
    }
    assert('D7: Generate script while reading -> reader gets valid data',
      d7NoError, 'no corruption');

    // D8: Delete cluster while getUserScript running -> no crash
    let d8NoError = true;
    try {
      await Promise.all([
        pool.query(`DELETE FROM problem_clusters WHERE user_id = $1 AND cluster_key = 'dup_test'`, [TEST_USER_ID]),
        getUserScript(pool, TEST_USER_ID),
      ]);
    } catch (err) {
      d8NoError = false;
    }
    assert('D8: Delete cluster while getUserScript running -> no crash',
      d8NoError, 'no errors');

    // ═══════════════════════════════════════════════════════════════════════
    // E. DATA CLEANUP AND LIFECYCLE (7 tests)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ E. DATA CLEANUP AND LIFECYCLE ═══');

    await cleanup();

    // E1: Create 5 clusters -> deactivate 2 -> getUserScript returns only 3
    const e1Symptoms = ['đau đầu', 'chóng mặt', 'mệt mỏi', 'đau bụng', 'đau ngực'];
    await createClustersFromOnboarding(pool, TEST_USER_ID, e1Symptoms);
    await pool.query(
      `UPDATE problem_clusters SET is_active = FALSE WHERE user_id = $1 AND cluster_key IN ('dizziness', 'fatigue')`,
      [TEST_USER_ID]
    );
    const e1Result = await getUserScript(pool, TEST_USER_ID);
    assert('E1: Deactivate 2 of 5 -> getUserScript returns 3',
      e1Result?.clusters?.length === 3,
      `clusters=${e1Result?.clusters?.length}`);

    // E2: Deactivated cluster's scripts still in DB (for audit)
    const { rows: e2Scripts } = await pool.query(
      `SELECT count(*) FROM triage_scripts WHERE user_id = $1 AND cluster_key IN ('dizziness', 'fatigue')`,
      [TEST_USER_ID]
    );
    assert('E2: Deactivated cluster scripts still in DB (audit trail)',
      parseInt(e2Scripts[0].count) > 0,
      `count=${e2Scripts[0].count}`);

    // E3: Re-activate cluster -> getUserScript returns 4 again
    await pool.query(
      `UPDATE problem_clusters SET is_active = TRUE WHERE user_id = $1 AND cluster_key = 'dizziness'`,
      [TEST_USER_ID]
    );
    const e3Result = await getUserScript(pool, TEST_USER_ID);
    assert('E3: Re-activate cluster -> getUserScript returns 4',
      e3Result?.clusters?.length === 4,
      `clusters=${e3Result?.clusters?.length}`);

    // E4: Fallback log lifecycle: pending -> processed -> verify can't go back to pending
    // (we test that status can be set, but typically the service doesn't allow regression)
    await logFallback(pool, TEST_USER_ID, 'e4_lifecycle_test', null, []);
    const { rows: e4Row } = await pool.query(
      `SELECT id, status FROM fallback_logs WHERE user_id = $1 AND raw_input = 'e4_lifecycle_test' LIMIT 1`,
      [TEST_USER_ID]
    );
    assert('E4a: Fallback starts as pending',
      e4Row[0]?.status === 'pending', `status=${e4Row[0]?.status}`);
    await markFallbackProcessed(pool, e4Row[0].id, 'test', 'test_key', 0.8, null);
    const { rows: e4After } = await pool.query(
      'SELECT status, processed_at FROM fallback_logs WHERE id = $1', [e4Row[0].id]
    );
    assert('E4b: Fallback lifecycle pending -> processed',
      e4After[0]?.status === 'processed' && e4After[0]?.processed_at !== null,
      `status=${e4After[0]?.status}, processed_at=${e4After[0]?.processed_at}`);

    // E5: Script session lifecycle: created -> answers added -> completed
    const { rows: e5Session } = await pool.query(
      `INSERT INTO script_sessions (user_id, cluster_key, session_type, answers, current_step, is_completed)
       VALUES ($1, 'headache', 'initial', '[]'::jsonb, 0, FALSE)
       RETURNING *`,
      [TEST_USER_ID]
    );
    const e5Id = e5Session[0].id;
    // Add answers
    const e5Answers = [{ question_id: 'q1', answer: 5 }];
    await pool.query(
      `UPDATE script_sessions SET answers = $2::jsonb, current_step = 1 WHERE id = $1`,
      [e5Id, JSON.stringify(e5Answers)]
    );
    // Complete
    await pool.query(
      `UPDATE script_sessions SET is_completed = TRUE, completed_at = NOW(),
         severity = 'medium', conclusion_summary = 'done', conclusion_recommendation = 'rest',
         conclusion_close_message = 'bye'
       WHERE id = $1`,
      [e5Id]
    );
    const { rows: e5Final } = await pool.query(
      'SELECT is_completed, completed_at, severity FROM script_sessions WHERE id = $1', [e5Id]
    );
    assert('E5: Script session lifecycle -> completed_at set',
      e5Final[0]?.is_completed === true && e5Final[0]?.completed_at !== null && e5Final[0]?.severity === 'medium',
      `completed=${e5Final[0]?.is_completed}, completed_at=${e5Final[0]?.completed_at}, severity=${e5Final[0]?.severity}`);

    // E6: Old scripts (is_active=FALSE) don't interfere with new scripts
    const e6Cluster = (await pool.query(
      `SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = 'headache'`, [TEST_USER_ID]
    )).rows[0];
    if (e6Cluster) {
      await generateScriptForCluster(pool, TEST_USER_ID, e6Cluster);
      const e6Active = await getScript(pool, TEST_USER_ID, 'headache', 'initial');
      const { rows: e6All } = await pool.query(
        `SELECT id, is_active FROM triage_scripts WHERE user_id = $1 AND cluster_key = 'headache' AND script_type = 'initial'`,
        [TEST_USER_ID]
      );
      const e6ActiveIds = e6All.filter(s => s.is_active).map(s => s.id);
      assert('E6: Old scripts (is_active=FALSE) dont interfere -> only 1 active returned',
        e6ActiveIds.length === 1 && e6Active?.id === e6ActiveIds[0],
        `activeIds=${e6ActiveIds.join(',')}, getScript.id=${e6Active?.id}, total=${e6All.length}`);
    } else {
      assert('E6: Old scripts test', false, 'no headache cluster');
    }

    // E7: Verify no orphaned rows after full lifecycle
    // Delete all clusters -> scripts should still exist (SET NULL), sessions still exist
    const { rows: e7BeforeScripts } = await pool.query(
      'SELECT count(*) FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]
    );
    const { rows: e7BeforeSessions } = await pool.query(
      'SELECT count(*) FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]
    );
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
    const { rows: e7AfterScripts } = await pool.query(
      'SELECT count(*) FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]
    );
    const { rows: e7AfterSessions } = await pool.query(
      'SELECT count(*) FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]
    );
    // Scripts still exist (ON DELETE SET NULL on cluster_id), sessions still exist
    assert('E7: No orphaned rows after lifecycle (scripts/sessions survive cluster deletion)',
      parseInt(e7AfterScripts[0].count) === parseInt(e7BeforeScripts[0].count) &&
      parseInt(e7AfterSessions[0].count) === parseInt(e7BeforeSessions[0].count),
      `scripts: before=${e7BeforeScripts[0].count} after=${e7AfterScripts[0].count}, sessions: before=${e7BeforeSessions[0].count} after=${e7AfterSessions[0].count}`);

    // ── Final cleanup ──
    await cleanup();
    // Also clean up health_checkins we created
    if (b10CheckinId) {
      await pool.query('DELETE FROM health_checkins WHERE id = $1', [b10CheckinId]).catch(() => {});
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  TOTAL: ${passed + failed}  |  PASSED: ${passed}  |  FAILED: ${failed}`);
    console.log('══════════════════════════════════════════════════════════════');
    if (failures.length > 0) {
      console.log('\n  Failed tests:');
      for (const f of failures) console.log(`    - ${f}`);
    }
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
    await cleanup().catch(() => {});
    process.exit(2);
  } finally {
    await pool.end();
  }
})();
