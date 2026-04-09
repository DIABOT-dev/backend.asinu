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
  toClusterKey,
  CLUSTER_KEY_MAP,
} = require('../src/services/checkin/script.service');

// ─── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

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

let TEST_USER_ID = null;

// ─── Cleanup helper ────────────────────────────────────────────────────────

async function cleanup() {
  if (!TEST_USER_ID) return;
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    // Pick a test user
    const { rows: users } = await pool.query(
      'SELECT id, display_name, full_name FROM users ORDER BY id LIMIT 5'
    );
    console.log('\n--- Available users ---');
    for (const u of users) {
      console.log(`  id=${u.id}  display_name=${u.display_name}  full_name=${u.full_name}`);
    }

    // Prefer id=3 or id=4, fallback to first available
    TEST_USER_ID = users.find(u => u.id === 3)?.id
      || users.find(u => u.id === 4)?.id
      || users[0]?.id;

    if (!TEST_USER_ID) {
      console.log('FATAL: No users found in DB. Cannot test.');
      process.exit(1);
    }
    console.log(`\nUsing TEST_USER_ID = ${TEST_USER_ID}\n`);

    // ── Cleanup before tests ──
    await cleanup();

    // ═══════════════════════════════════════════════════════════════════════
    // A. toClusterKey() mapping
    // ═══════════════════════════════════════════════════════════════════════
    console.log('=== A. toClusterKey() mapping ===');

    assert('A1: "dau dau" -> headache',
      toClusterKey('đau đầu') === 'headache',
      `got "${toClusterKey('đau đầu')}"`);

    assert('A2: "chong mat" -> dizziness',
      toClusterKey('chóng mặt') === 'dizziness',
      `got "${toClusterKey('chóng mặt')}"`);

    assert('A3: "dau co vai gay" -> neck_pain',
      toClusterKey('đau cổ vai gáy') === 'neck_pain',
      `got "${toClusterKey('đau cổ vai gáy')}"`);

    assert('A4: "met moi" -> fatigue',
      toClusterKey('mệt mỏi') === 'fatigue',
      `got "${toClusterKey('mệt mỏi')}"`);

    assert('A5: "dau bung" -> abdominal_pain',
      toClusterKey('đau bụng') === 'abdominal_pain',
      `got "${toClusterKey('đau bụng')}"`);

    const randomKey = toClusterKey('something random xyz');
    assert('A6: random string -> slugified (no crash)',
      typeof randomKey === 'string' && randomKey.length > 0,
      `got "${randomKey}"`);

    const emptyKey = toClusterKey('');
    assert('A7: empty string -> handled (no crash)',
      typeof emptyKey === 'string',
      `got "${emptyKey}"`);

    const nullKey = toClusterKey(null);
    assert('A8: null -> handled (no crash)',
      typeof nullKey === 'string',
      `got "${nullKey}"`);

    // ═══════════════════════════════════════════════════════════════════════
    // B. createClustersFromOnboarding()
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== B. createClustersFromOnboarding() ===');

    const symptoms = ['đau đầu', 'chóng mặt', 'mệt mỏi'];
    const clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, symptoms);

    assert('B1: returns 3 clusters',
      clusters.length === 3,
      `got ${clusters.length}`);

    // Verify rows in DB
    const { rows: dbClusters } = await pool.query(
      'SELECT * FROM problem_clusters WHERE user_id = $1 ORDER BY priority DESC',
      [TEST_USER_ID]
    );
    assert('B2: 3 rows in problem_clusters',
      dbClusters.length === 3,
      `got ${dbClusters.length}`);

    // Priority: first symptom has highest priority (symptoms.length - i)
    const headacheCluster = dbClusters.find(c => c.cluster_key === 'headache');
    const dizzinessCluster = dbClusters.find(c => c.cluster_key === 'dizziness');
    const fatigueCluster = dbClusters.find(c => c.cluster_key === 'fatigue');
    assert('B3: first symptom has highest priority',
      headacheCluster && dizzinessCluster && headacheCluster.priority > dizzinessCluster.priority,
      `headache.priority=${headacheCluster?.priority}, dizziness.priority=${dizzinessCluster?.priority}`);

    // Source = onboarding
    assert('B4: source = onboarding',
      dbClusters.every(c => c.source === 'onboarding'),
      `sources: ${dbClusters.map(c => c.source).join(', ')}`);

    // Verify scripts were generated
    const { rows: scripts } = await pool.query(
      'SELECT * FROM triage_scripts WHERE user_id = $1 AND is_active = TRUE',
      [TEST_USER_ID]
    );
    assert('B5: scripts generated (triage_scripts rows > 0)',
      scripts.length > 0,
      `got ${scripts.length} scripts`);

    // Both initial AND followup per cluster
    const initialScripts = scripts.filter(s => s.script_type === 'initial');
    const followupScripts = scripts.filter(s => s.script_type === 'followup');
    assert('B6: initial scripts exist for each cluster',
      initialScripts.length >= 3,
      `got ${initialScripts.length} initial scripts`);
    assert('B7: followup scripts exist for each cluster',
      followupScripts.length >= 3,
      `got ${followupScripts.length} followup scripts`);

    // Call again with same symptoms -> no duplicate
    const { rows: beforeCount } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    const clusters2 = await createClustersFromOnboarding(pool, TEST_USER_ID, symptoms);
    const { rows: afterCount } = await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    assert('B8: duplicate call -> no extra clusters (ON CONFLICT)',
      parseInt(afterCount[0].count) === parseInt(beforeCount[0].count),
      `before=${beforeCount[0].count}, after=${afterCount[0].count}`);

    // Partially overlapping symptoms
    const overlapSymptoms = ['đau đầu', 'đau bụng']; // headache exists, abdominal_pain is new
    const clusters3 = await createClustersFromOnboarding(pool, TEST_USER_ID, overlapSymptoms);
    const { rows: afterOverlap } = await pool.query(
      'SELECT * FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    );
    const hasAbdominal = afterOverlap.some(c => c.cluster_key === 'abdominal_pain');
    assert('B9: overlapping call -> adds new cluster',
      hasAbdominal,
      `clusters: ${afterOverlap.map(c => c.cluster_key).join(', ')}`);
    assert('B10: overlapping call -> existing cluster updated (not duplicated)',
      afterOverlap.filter(c => c.cluster_key === 'headache').length === 1,
      `headache count: ${afterOverlap.filter(c => c.cluster_key === 'headache').length}`);

    // ═══════════════════════════════════════════════════════════════════════
    // C. getUserScript()
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== C. getUserScript() ===');

    const userScript = await getUserScript(pool, TEST_USER_ID);

    assert('C1: returns non-null result',
      userScript !== null,
      `got ${userScript}`);

    if (userScript) {
      assert('C2: has greeting with text',
        typeof userScript.greeting === 'string' && userScript.greeting.length > 0,
        `greeting="${userScript.greeting}"`);

      assert('C3: has 3 initial_options',
        Array.isArray(userScript.initial_options) && userScript.initial_options.length === 3,
        `got ${userScript.initial_options?.length}`);

      assert('C4: clusters array with correct data',
        Array.isArray(userScript.clusters) && userScript.clusters.length > 0,
        `got ${userScript.clusters?.length} clusters`);

      assert('C5: profile has medical_conditions',
        userScript.profile && 'medical_conditions' in userScript.profile,
        `profile keys: ${Object.keys(userScript.profile || {}).join(', ')}`);
    } else {
      // mark the sub-tests as failed
      for (const lbl of ['C2', 'C3', 'C4', 'C5']) {
        assert(lbl + ': skipped (userScript is null)', false, 'userScript was null');
      }
    }

    // User with NO clusters
    // Find or create a user ID that has no clusters
    const { rows: otherUsers } = await pool.query(
      `SELECT id FROM users WHERE id NOT IN (
         SELECT DISTINCT user_id FROM problem_clusters
       ) LIMIT 1`
    );
    if (otherUsers.length > 0) {
      const emptyUserId = otherUsers[0].id;
      const emptyResult = await getUserScript(pool, emptyUserId);
      assert('C6: user with no clusters -> returns null',
        emptyResult === null,
        `got ${JSON.stringify(emptyResult)?.substring(0, 80)}`);
    } else {
      // Use a very high user ID that likely doesn't exist in problem_clusters
      const emptyResult = await getUserScript(pool, 999999);
      assert('C6: user with no clusters -> returns null',
        emptyResult === null,
        `got ${JSON.stringify(emptyResult)?.substring(0, 80)}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // D. getScript()
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== D. getScript() ===');

    const headacheScript = await getScript(pool, TEST_USER_ID, 'headache', 'initial');
    assert('D1: get headache initial script -> non-null',
      headacheScript !== null,
      `got ${headacheScript ? 'script' : 'null'}`);

    if (headacheScript) {
      const sd = headacheScript.script_data;
      assert('D2: script_data has questions',
        sd && Array.isArray(sd.questions) && sd.questions.length > 0,
        `questions count: ${sd?.questions?.length}`);
      assert('D3: script_data has scoring_rules',
        sd && Array.isArray(sd.scoring_rules) && sd.scoring_rules.length > 0,
        `scoring_rules count: ${sd?.scoring_rules?.length}`);
      assert('D4: script_data has conclusion_templates',
        sd && sd.conclusion_templates && sd.conclusion_templates.low && sd.conclusion_templates.medium && sd.conclusion_templates.high,
        `keys: ${sd?.conclusion_templates ? Object.keys(sd.conclusion_templates).join(',') : 'none'}`);
    } else {
      for (const lbl of ['D2', 'D3', 'D4']) {
        assert(lbl + ': skipped', false, 'headache script was null');
      }
    }

    // Non-existent cluster
    const noScript = await getScript(pool, TEST_USER_ID, 'nonexistent_xyz_999', 'initial');
    assert('D5: non-existent cluster -> returns null',
      noScript === null,
      `got ${noScript}`);

    // Followup script
    const followupScript = await getScript(pool, TEST_USER_ID, 'headache', 'followup');
    assert('D6: followup script type filtering',
      followupScript !== null && followupScript.script_type === 'followup',
      `got type=${followupScript?.script_type}`);

    // ═══════════════════════════════════════════════════════════════════════
    // E. addCluster()
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== E. addCluster() ===');

    const newCluster = await addCluster(pool, TEST_USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
    assert('E1: addCluster returns cluster object',
      newCluster && newCluster.cluster_key === 'gastric_pain',
      `got ${newCluster?.cluster_key}`);

    // Verify in problem_clusters
    const { rows: pcCheck } = await pool.query(
      'SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'gastric_pain']
    );
    assert('E2: gastric_pain in problem_clusters',
      pcCheck.length === 1,
      `got ${pcCheck.length} rows`);

    // Verify script auto-generated
    const gastricScript = await getScript(pool, TEST_USER_ID, 'gastric_pain', 'initial');
    assert('E3: script auto-generated for gastric_pain',
      gastricScript !== null,
      `got ${gastricScript ? 'script' : 'null'}`);

    // Add same cluster again -> no duplicate
    const dupCluster = await addCluster(pool, TEST_USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
    const { rows: pcDupCheck } = await pool.query(
      'SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'gastric_pain']
    );
    assert('E4: duplicate addCluster -> no duplicate row',
      pcDupCheck.length === 1,
      `got ${pcDupCheck.length} rows`);

    // ═══════════════════════════════════════════════════════════════════════
    // F. updateClusterStats()
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== F. updateClusterStats() ===');

    await updateClusterStats(pool, TEST_USER_ID, 'headache', {
      count_7d: 5,
      count_30d: 12,
      trend: 'increasing',
    });
    const { rows: statsCheck } = await pool.query(
      'SELECT count_7d, count_30d, trend FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'headache']
    );
    assert('F1: count_7d updated',
      statsCheck[0]?.count_7d === 5,
      `got ${statsCheck[0]?.count_7d}`);
    assert('F2: count_30d updated',
      statsCheck[0]?.count_30d === 12,
      `got ${statsCheck[0]?.count_30d}`);
    assert('F3: trend updated',
      statsCheck[0]?.trend === 'increasing',
      `got "${statsCheck[0]?.trend}"`);

    // Partial update: only count_7d
    await updateClusterStats(pool, TEST_USER_ID, 'headache', {
      count_7d: 8,
    });
    const { rows: partialCheck } = await pool.query(
      'SELECT count_7d, count_30d, trend FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'headache']
    );
    assert('F4: partial update - count_7d changed',
      partialCheck[0]?.count_7d === 8,
      `got ${partialCheck[0]?.count_7d}`);
    assert('F5: partial update - count_30d unchanged',
      partialCheck[0]?.count_30d === 12,
      `got ${partialCheck[0]?.count_30d}`);
    assert('F6: partial update - trend unchanged',
      partialCheck[0]?.trend === 'increasing',
      `got "${partialCheck[0]?.trend}"`);

    // ═══════════════════════════════════════════════════════════════════════
    // G. Script content validation
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== G. Script content validation ===');

    // Re-fetch a script for content checks
    const contentScript = await getScript(pool, TEST_USER_ID, 'headache', 'initial');
    const sd = contentScript?.script_data;

    if (sd) {
      // Questions have id, text, type
      const allQsValid = sd.questions.every(q => q.id && q.text && q.type);
      assert('G1: all questions have id, text, type',
        allQsValid,
        `first invalid: ${JSON.stringify(sd.questions.find(q => !q.id || !q.text || !q.type))}`);

      // scoring_rules array
      assert('G2: scoring_rules is non-empty array',
        Array.isArray(sd.scoring_rules) && sd.scoring_rules.length > 0,
        `count: ${sd.scoring_rules?.length}`);

      // conclusion_templates with low/medium/high
      assert('G3: conclusion_templates has low/medium/high',
        sd.conclusion_templates?.low && sd.conclusion_templates?.medium && sd.conclusion_templates?.high,
        `keys: ${Object.keys(sd.conclusion_templates || {}).join(', ')}`);

      // followup_questions
      assert('G4: followup_questions present',
        Array.isArray(sd.followup_questions) && sd.followup_questions.length > 0,
        `count: ${sd.followup_questions?.length}`);

      // fallback_questions
      assert('G5: fallback_questions present',
        Array.isArray(sd.fallback_questions) && sd.fallback_questions.length > 0,
        `count: ${sd.fallback_questions?.length}`);

      // Check if questions use clinical-mapping followUpQuestions
      // headache has followUpQuestions in clinical-mapping, so the script should use them
      const { resolveComplaint } = require('../src/services/checkin/clinical-mapping');
      const headacheMapping = resolveComplaint('đau đầu');
      if (headacheMapping && headacheMapping.data.followUpQuestions && headacheMapping.data.followUpQuestions.length > 0) {
        const mappingQ1 = headacheMapping.data.followUpQuestions[0].question;
        const scriptUsesMapping = sd.questions.some(q => q.text === mappingQ1);
        assert('G6: questions use clinical-mapping followUpQuestions',
          scriptUsesMapping,
          `mapping Q1="${mappingQ1}", script Qs: ${sd.questions.map(q => q.text.substring(0, 30)).join(' | ')}`);
      } else {
        assert('G6: headache has no followUpQuestions in mapping (skip)',
          true, 'no mapping followUpQuestions');
      }
    } else {
      for (let i = 1; i <= 6; i++) {
        assert(`G${i}: skipped`, false, 'no script data');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // H. Edge cases
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== H. Edge cases ===');

    // H1: user with no onboarding profile -> getUserScript still works (no crash)
    // We already tested with a non-existent or cluster-less user; let's also test
    // createClustersFromOnboarding for a user that may not have a profile
    try {
      // Use the test user; even if they have no profile, it should not crash
      const resultH1 = await getUserScript(pool, TEST_USER_ID);
      assert('H1: user with/without onboarding profile -> no crash',
        true, 'no crash');
    } catch (e) {
      assert('H1: user with/without onboarding profile -> no crash',
        false, e.message);
    }

    // H2: empty symptoms array -> no clusters created
    const beforeEmpty = (await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    )).rows[0].count;
    const emptyClusters = await createClustersFromOnboarding(pool, TEST_USER_ID, []);
    const afterEmpty = (await pool.query(
      'SELECT count(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]
    )).rows[0].count;
    assert('H2: empty symptoms array -> no new clusters',
      emptyClusters.length === 0 && beforeEmpty === afterEmpty,
      `returned=${emptyClusters.length}, before=${beforeEmpty}, after=${afterEmpty}`);

    // H3: very long symptom name
    try {
      const longName = 'a'.repeat(500);
      const longKey = toClusterKey(longName);
      assert('H3: very long symptom name -> handled (no crash)',
        typeof longKey === 'string',
        `key length: ${longKey.length}`);
    } catch (e) {
      assert('H3: very long symptom name -> handled (no crash)',
        false, e.message);
    }

    // H4: Unicode/Vietnamese diacritics preserved in display_name
    await cleanup();
    const vietClusters = await createClustersFromOnboarding(pool, TEST_USER_ID, ['đau đầu']);
    const { rows: vietCheck } = await pool.query(
      'SELECT display_name FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'headache']
    );
    assert('H4: Vietnamese diacritics preserved in display_name',
      vietCheck[0]?.display_name === 'đau đầu',
      `got "${vietCheck[0]?.display_name}"`);

    // ── Cleanup after tests ──
    await cleanup();

    // ═══════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════');
    console.log(`  TOTAL: ${passed + failed}  |  PASSED: ${passed}  |  FAILED: ${failed}`);
    console.log('══════════════════════════════════════════');
    if (failures.length > 0) {
      console.log('\nFailed tests:');
      for (const f of failures) console.log(`  - ${f}`);
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
