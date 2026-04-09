#!/usr/bin/env node
'use strict';

/**
 * Round 1 — Happy-path test for ALL 14 clinical complaints.
 *
 * For each complaint:
 *   1. Validate script structure
 *   2. Run full initial session (pick first option every time)
 *   3. Verify conclusion fields + Vietnamese summary
 *   4. Run follow-up "better" session  → expect severity=low
 *   5. Run follow-up "worse"  session  → expect severity=high
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { createClustersFromOnboarding, getUserScript, getScript } = require('../src/services/checkin/script.service');
const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');
const { listComplaints } = require('../src/services/checkin/clinical-mapping');

const USER_ID = 4;

const profile = {
  birth_year: 1958,
  gender: 'Nam',
  full_name: 'Trần Văn Hùng',
  medical_conditions: ['Tiểu đường'],
  age: 68,
};

let totalPass = 0;
let totalFail = 0;

function assert(condition, label) {
  if (condition) {
    totalPass++;
    return true;
  }
  totalFail++;
  console.log(`    FAIL: ${label}`);
  return false;
}

// ── Vietnamese text check ──────────────────────────────────────────────────
function isVietnamese(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return false;
  // Must contain at least one Vietnamese diacritical character or common Vietnamese word
  return /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(text);
}

// ── Simulate a full session (answer first option for every question) ──────
function simulateInitialSession(scriptData) {
  const answers = [];
  let iterations = 0;
  const maxIter = 50;

  while (iterations < maxIter) {
    iterations++;
    const result = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });

    if (result.isDone) {
      return { ok: true, conclusion: result.conclusion, answers, steps: iterations };
    }

    const q = result.question;
    let answer;

    if (q.type === 'slider') {
      answer = 5;
    } else if ((q.type === 'single_choice' || q.type === 'multi_choice') && q.options && q.options.length > 0) {
      answer = q.options[0];
    } else if (q.type === 'free_text') {
      answer = 'bình thường';
    } else {
      answer = q.options ? q.options[0] : 'ok';
    }

    answers.push({ question_id: q.id, answer });
  }

  return { ok: false, error: 'Max iterations reached' };
}

// ── Simulate a follow-up session with specific answers ───────────────────
function simulateFollowUp(scriptData, fuAnswers) {
  // Follow-up uses the followup_questions array inside the initial script
  const answers = [];
  let iterations = 0;
  const maxIter = 20;

  while (iterations < maxIter) {
    iterations++;
    const result = getNextQuestion(scriptData, answers, {
      sessionType: 'followup',
      profile,
      previousSeverity: 'medium',
    });

    if (result.isDone) {
      return { ok: true, conclusion: result.conclusion };
    }

    const q = result.question;
    // Pick answer from fuAnswers by index, fallback to first option
    const answer = fuAnswers[answers.length] !== undefined
      ? fuAnswers[answers.length]
      : (q.options ? q.options[0] : 'ok');

    answers.push({ question_id: q.id, answer });
  }

  return { ok: false, error: 'Max iterations' };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function run() {
  console.log('================================================================');
  console.log('  Round 1 — Happy-path test for ALL 14 clinical complaints');
  console.log('================================================================\n');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);
  console.log('[Setup] Cleaned up test data for user_id=' + USER_ID + '\n');

  // ── Step 1: Get all 14 complaints ────────────────────────────────────────
  const complaints = listComplaints();
  console.log(`[Step 1] listComplaints() returned ${complaints.length} complaints:`);
  console.log(`         ${complaints.join(', ')}\n`);

  // ── Step 2: Create clusters from ALL complaints ──────────────────────────
  const clusters = await createClustersFromOnboarding(pool, USER_ID, complaints);
  console.log(`[Step 2] createClustersFromOnboarding created ${clusters.length} clusters\n`);

  // ── Step 3: getUserScript — verify all clusters returned ─────────────────
  const userScript = await getUserScript(pool, USER_ID);
  const clusterCount = userScript ? userScript.clusters.length : 0;
  assert(userScript !== null, 'getUserScript returns non-null');
  assert(clusterCount >= 14, `getUserScript returns >= 14 clusters (got ${clusterCount})`);
  console.log(`[Step 3] getUserScript returned ${clusterCount} clusters\n`);

  // ── Step 4: Per-complaint tests ──────────────────────────────────────────
  console.log('[Step 4] Per-complaint testing...\n');

  const results = [];

  for (const complaint of complaints) {
    const row = {
      complaint,
      valid: false,
      session: false,
      conclusion: false,
      fuBetter: false,
      fuWorse: false,
      errors: [],
    };

    try {
      // 4a: getScript for this cluster
      const clusterInfo = userScript.clusters.find(c => c.display_name === complaint);
      if (!clusterInfo) {
        row.errors.push('cluster not found in getUserScript');
        results.push(row);
        continue;
      }

      const scriptRow = await getScript(pool, USER_ID, clusterInfo.cluster_key, 'initial');
      if (!scriptRow) {
        row.errors.push('getScript returned null');
        results.push(row);
        continue;
      }

      const scriptData = scriptRow.script_data;

      // 4b: validateScript
      const { valid, errors: valErrors } = validateScript(scriptData);
      row.valid = valid;
      if (!valid) row.errors.push('validate: ' + valErrors.join('; '));
      assert(valid, `${complaint}: validateScript passes`);

      // 4c: Run full initial session (first option)
      const sessionResult = simulateInitialSession(scriptData);
      row.session = sessionResult.ok;
      assert(sessionResult.ok, `${complaint}: session completes (isDone=true)`);

      if (sessionResult.ok) {
        const c = sessionResult.conclusion;

        // 4e: Verify conclusion fields
        const hasSeverity      = assert(typeof c.severity === 'string', `${complaint}: conclusion.severity is string`);
        const hasFollowUp      = assert(typeof c.followUpHours === 'number', `${complaint}: conclusion.followUpHours is number`);
        const hasNeedsDoctor   = assert(typeof c.needsDoctor === 'boolean', `${complaint}: conclusion.needsDoctor is boolean`);
        const hasSummary       = assert(typeof c.summary === 'string' && c.summary.length > 0, `${complaint}: conclusion.summary non-empty`);
        const hasRecommendation = assert(typeof c.recommendation === 'string' && c.recommendation.length > 0, `${complaint}: conclusion.recommendation non-empty`);
        const hasCloseMessage  = assert(typeof c.closeMessage === 'string' && c.closeMessage.length > 0, `${complaint}: conclusion.closeMessage non-empty`);

        row.conclusion = hasSeverity && hasFollowUp && hasNeedsDoctor && hasSummary && hasRecommendation && hasCloseMessage;

        // 4f: Verify Vietnamese text in summary
        assert(isVietnamese(c.summary), `${complaint}: summary is Vietnamese text ("${c.summary}")`);
      }

      // 4g: Follow-up "better" session — ["Đỡ hơn", "Không"] → severity=low
      const fuBetter = simulateFollowUp(scriptData, ['Đỡ hơn', 'Không']);
      if (fuBetter.ok) {
        row.fuBetter = assert(
          fuBetter.conclusion.severity === 'low',
          `${complaint}: FU-Better severity=low (got ${fuBetter.conclusion.severity})`
        );
      } else {
        row.errors.push('FU-Better session failed');
      }

      // 4h: Follow-up "worse" session — ["Nặng hơn", "Có"] → severity=high
      const fuWorse = simulateFollowUp(scriptData, ['Nặng hơn', 'Có']);
      if (fuWorse.ok) {
        row.fuWorse = assert(
          fuWorse.conclusion.severity === 'high',
          `${complaint}: FU-Worse severity=high (got ${fuWorse.conclusion.severity})`
        );
      } else {
        row.errors.push('FU-Worse session failed');
      }

    } catch (err) {
      row.errors.push(err.message);
      console.log(`    ERROR [${complaint}]: ${err.message}`);
    }

    results.push(row);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary table
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n================================================================');
  console.log('  SUMMARY TABLE');
  console.log('================================================================\n');

  const ok = (b) => b ? 'PASS' : 'FAIL';
  const pad = (s, n) => String(s).padEnd(n);

  const hdr = [
    pad('Complaint', 18),
    pad('Valid', 6),
    pad('Session', 8),
    pad('Conclusion', 11),
    pad('FU-Better', 10),
    pad('FU-Worse', 9),
  ];
  console.log('| ' + hdr.join(' | ') + ' |');
  console.log('|' + hdr.map(h => '-'.repeat(h.length + 2)).join('|') + '|');

  let cValid = 0, cSession = 0, cConclusion = 0, cBetter = 0, cWorse = 0;

  for (const r of results) {
    const cols = [
      pad(r.complaint, 18),
      pad(ok(r.valid), 6),
      pad(ok(r.session), 8),
      pad(ok(r.conclusion), 11),
      pad(ok(r.fuBetter), 10),
      pad(ok(r.fuWorse), 9),
    ];
    console.log('| ' + cols.join(' | ') + ' |');

    if (r.valid) cValid++;
    if (r.session) cSession++;
    if (r.conclusion) cConclusion++;
    if (r.fuBetter) cBetter++;
    if (r.fuWorse) cWorse++;
  }

  console.log('');
  console.log(`Valid: ${cValid}/${results.length}  |  Session: ${cSession}/${results.length}  |  Conclusion: ${cConclusion}/${results.length}  |  FU-Better: ${cBetter}/${results.length}  |  FU-Worse: ${cWorse}/${results.length}`);

  // Print errors if any
  const errorRows = results.filter(r => r.errors.length > 0);
  if (errorRows.length > 0) {
    console.log('\n--- Errors ---');
    for (const r of errorRows) {
      console.log(`  ${r.complaint}: ${r.errors.join('; ')}`);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);
  console.log('\n[Cleanup] Test data removed.');

  console.log(`\n${'='.repeat(64)}`);
  console.log(`TOTAL assertions: ${totalPass} passed, ${totalFail} failed`);
  if (totalFail === 0) {
    console.log('  ALL TESTS PASSED');
  } else {
    console.log(`  ${totalFail} ASSERTION(S) FAILED`);
  }
  console.log('='.repeat(64));

  if (totalFail > 0) process.exitCode = 1;
}

run()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
