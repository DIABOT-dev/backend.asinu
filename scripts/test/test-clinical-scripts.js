#!/usr/bin/env node
'use strict';

/**
 * Comprehensive test: Clinical Mapping -> Script Generation -> Session Simulation
 *
 * Tests ALL chief complaints in clinical-mapping.js produce valid, usable scripts.
 * Usage: node scripts/test-clinical-scripts.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Imports
const { listComplaints, resolveComplaint, symptomMap } = require('../src/services/checkin/clinical-mapping');
const { createClustersFromOnboarding, toClusterKey } = require('../src/services/checkin/script.service');
const { validateScript, getNextQuestion } = require('../src/services/checkin/script-runner');
const { evaluateScript } = require('../src/services/checkin/scoring-engine');

const TEST_USER_ID = 3;

let totalPass = 0;
let totalFail = 0;

function assert(condition, label) {
  if (condition) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`    FAIL: ${label}`);
  }
  return condition;
}

// ============================================================================
// Cleanup
// ============================================================================

async function cleanup() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);
}

// ============================================================================
// Helper: simulate a session with a strategy for answering
// strategy: 'first' = pick first option / 5 for slider
//           'high'  = pick last (worst) option / 8 for slider
//           'low'   = pick first (mildest) option / 2 for slider
// ============================================================================

function simulateSession(scriptData, strategy = 'first') {
  const answers = [];
  const profile = { birth_year: 1965, gender: 'male', full_name: 'Nguyen Van Test' };
  let iterations = 0;
  const maxIterations = 50;

  // For HIGH strategy, figure out which answers the scoring rules actually look for
  let highTargetAnswers = {};
  if (strategy === 'high' && scriptData.scoring_rules) {
    for (const rule of scriptData.scoring_rules) {
      if (rule.severity !== 'high') continue;
      for (const cond of (rule.conditions || [])) {
        if (cond.op === 'gte') {
          highTargetAnswers[cond.field] = { type: 'gte', value: cond.value + 1 };
        } else if (cond.op === 'eq') {
          highTargetAnswers[cond.field] = { type: 'eq', value: cond.value };
        } else if (cond.op === 'contains') {
          highTargetAnswers[cond.field] = { type: 'contains', value: cond.value };
        }
      }
    }
  }

  while (iterations < maxIterations) {
    iterations++;
    const result = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });

    if (result.isDone) {
      return { ok: true, conclusion: result.conclusion, answers, steps: iterations };
    }

    const q = result.question;
    let answer;

    // Check if scoring rules have a specific target for this question
    const target = highTargetAnswers[q.id];

    if (q.type === 'slider') {
      if (strategy === 'high') answer = target ? Math.max(target.value, 8) : 8;
      else if (strategy === 'low') answer = 2;
      else answer = 5;
    } else if (q.type === 'single_choice' && q.options && q.options.length > 0) {
      if (strategy === 'high' && target && target.type === 'eq') {
        // Pick the exact option the scoring rule expects
        answer = target.value;
      } else if (strategy === 'high') {
        answer = q.options[q.options.length - 1];
      } else {
        answer = q.options[0];
      }
    } else if (q.type === 'multi_choice' && q.options && q.options.length > 0) {
      if (strategy === 'high' && target && target.type === 'contains') {
        // Include the danger symptom text the rule looks for
        answer = target.value;
      } else if (strategy === 'high') {
        answer = q.options.filter(o => !o.includes('không')).slice(-2).join(', ');
      } else if (strategy === 'low') {
        const noOption = q.options.find(o => o.includes('không'));
        answer = noOption || q.options[0];
      } else {
        answer = q.options[0];
      }
    } else if (q.type === 'free_text') {
      answer = 'binh thuong';
    } else {
      answer = q.options ? q.options[0] : 'ok';
    }

    answers.push({ question_id: q.id, answer });
  }

  return { ok: false, error: 'Max iterations reached', answers };
}

// ============================================================================
// MAIN TEST
// ============================================================================

async function run() {
  console.log('================================================================');
  console.log('  Clinical Mapping -> Script Generation -> Full Validation Test');
  console.log('================================================================\n');

  // --- Cleanup ---
  await cleanup();
  console.log('[Setup] Cleaned up test data for user_id=' + TEST_USER_ID + '\n');

  // ========================================================================
  // A. List all chief complaints
  // ========================================================================
  console.log('--- A. Chief Complaints in clinical-mapping ---');
  const complaints = listComplaints();
  console.log(`Total chief complaints: ${complaints.length}`);
  console.log(`Keys: ${complaints.join(', ')}\n`);

  // Verify each has required fields
  for (const key of complaints) {
    const resolved = resolveComplaint(key);
    assert(resolved !== null, `${key}: resolveComplaint returns non-null`);
    if (resolved) {
      assert(Array.isArray(resolved.data.associatedSymptoms), `${key}: has associatedSymptoms`);
      assert(Array.isArray(resolved.data.redFlags), `${key}: has redFlags`);
      assert(Array.isArray(resolved.data.causes), `${key}: has causes`);
      assert(Array.isArray(resolved.data.followUpQuestions), `${key}: has followUpQuestions`);
    }
  }
  console.log(`Section A: all ${complaints.length} complaints have required fields.\n`);

  // ========================================================================
  // B + C + D. For each complaint: generate script, validate, simulate
  // ========================================================================
  console.log('--- B/C/D. Per-complaint script generation, validation, simulation ---\n');

  const results = [];

  for (const complaint of complaints) {
    const row = {
      complaint,
      questions: 0,
      rules: 0,
      valid: false,
      sessionOk: false,
      highOk: false,
      lowOk: false,
      errors: [],
    };

    try {
      // Clean previous clusters/scripts for this user
      await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
      await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);

      // B: Create cluster + generate script
      const clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, [complaint]);
      assert(clusters.length > 0, `${complaint}: cluster created`);

      const clusterKey = toClusterKey(complaint);

      // Get the generated script from DB
      const { rows: scriptRows } = await pool.query(
        `SELECT * FROM triage_scripts
         WHERE user_id = $1 AND cluster_key = $2 AND script_type = 'initial' AND is_active = TRUE
         ORDER BY version DESC LIMIT 1`,
        [TEST_USER_ID, clusterKey]
      );

      if (scriptRows.length === 0) {
        row.errors.push('No script generated');
        results.push(row);
        continue;
      }

      const scriptData = scriptRows[0].script_data;

      // Validate script
      const { valid, errors } = validateScript(scriptData);
      row.valid = valid;
      if (!valid) row.errors.push('Validation: ' + errors.join('; '));
      assert(valid, `${complaint}: validateScript passes`);

      // Check structure
      row.questions = (scriptData.questions || []).length;
      row.rules = (scriptData.scoring_rules || []).length;

      assert(row.questions > 0, `${complaint}: has questions (${row.questions})`);
      assert(row.rules > 0, `${complaint}: has scoring_rules (${row.rules})`);

      // conclusion_templates
      const ct = scriptData.conclusion_templates || {};
      assert(ct.low !== undefined, `${complaint}: has conclusion_templates.low`);
      assert(ct.medium !== undefined, `${complaint}: has conclusion_templates.medium`);
      assert(ct.high !== undefined, `${complaint}: has conclusion_templates.high`);

      // followup_questions & fallback_questions
      assert(
        scriptData.followup_questions && scriptData.followup_questions.length > 0,
        `${complaint}: has followup_questions`
      );
      assert(
        scriptData.fallback_questions && scriptData.fallback_questions.length > 0,
        `${complaint}: has fallback_questions`
      );

      // C: Simulate session (first-option strategy)
      const sessionResult = simulateSession(scriptData, 'first');
      row.sessionOk = sessionResult.ok;
      assert(sessionResult.ok, `${complaint}: session completes without error`);

      if (sessionResult.ok) {
        const c = sessionResult.conclusion;
        assert(c.severity !== undefined, `${complaint}: conclusion has severity`);
        assert(c.followUpHours !== undefined, `${complaint}: conclusion has followUpHours`);
        assert(c.summary !== undefined, `${complaint}: conclusion has summary`);
        assert(c.recommendation !== undefined, `${complaint}: conclusion has recommendation`);
      }

      // D: HIGH scoring edge case
      const highResult = simulateSession(scriptData, 'high');
      if (highResult.ok) {
        const hc = highResult.conclusion;
        // For scripts with sliders, answering 8 should give high severity
        // For scripts without sliders, picking worst option may give high
        // We check that high-strategy gives severity='high' and needsDoctor=true
        const highSev = hc.severity === 'high';
        const highDoc = hc.needsDoctor === true;
        row.highOk = highSev && highDoc;
        assert(highSev, `${complaint}: HIGH strategy -> severity=high (got ${hc.severity})`);
        assert(highDoc, `${complaint}: HIGH strategy -> needsDoctor=true (got ${hc.needsDoctor})`);
      } else {
        row.errors.push('HIGH session failed');
      }

      // D: LOW scoring edge case
      const lowResult = simulateSession(scriptData, 'low');
      if (lowResult.ok) {
        const lc = lowResult.conclusion;
        row.lowOk = lc.severity === 'low';
        assert(lc.severity === 'low', `${complaint}: LOW strategy -> severity=low (got ${lc.severity})`);
      } else {
        row.errors.push('LOW session failed');
      }

    } catch (err) {
      row.errors.push(err.message);
      console.log(`    ERROR for ${complaint}: ${err.message}`);
    }

    results.push(row);
  }

  // ========================================================================
  // E. Specific complaint quality checks
  // ========================================================================
  console.log('\n--- E. Specific Complaint Quality Checks ---\n');

  // Helper: get script data for a complaint (already generated above)
  async function getScriptData(complaint) {
    const clusterKey = toClusterKey(complaint);
    // Re-generate to ensure fresh
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1 AND cluster_key = $2', [TEST_USER_ID, clusterKey]);
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2', [TEST_USER_ID, clusterKey]);
    const clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, [complaint]);
    const { rows } = await pool.query(
      `SELECT * FROM triage_scripts
       WHERE user_id = $1 AND cluster_key = $2 AND script_type = 'initial' AND is_active = TRUE
       ORDER BY version DESC LIMIT 1`,
      [TEST_USER_ID, clusterKey]
    );
    return rows[0]?.script_data || null;
  }

  function questionsContain(scriptData, keyword) {
    if (!scriptData || !scriptData.questions) return false;
    return scriptData.questions.some(q => {
      const text = (q.text || '').toLowerCase();
      const opts = (q.options || []).join(' ').toLowerCase();
      return text.includes(keyword) || opts.includes(keyword);
    });
  }

  // E1: headache
  {
    const sd = await getScriptData('\u0111au \u0111\u1ea7u');
    if (sd) {
      assert(questionsContain(sd, 'v\u1ecb tr\u00ed'), '\u0111au \u0111\u1ea7u: asks about location');
      assert(questionsContain(sd, 'ki\u1ec3u') || questionsContain(sd, 'th\u1ebf n\u00e0o'), '\u0111au \u0111\u1ea7u: asks about type');
      assert(questionsContain(sd, 'tri\u1ec7u ch\u1ee9ng') || questionsContain(sd, '\u0111i k\u00e8m'), '\u0111au \u0111\u1ea7u: asks about associated symptoms');
      assert(questionsContain(sd, 'm\u1ee9c') || questionsContain(sd, '\u0111\u1ed9'), '\u0111au \u0111\u1ea7u: asks about severity');
      console.log('  \u0111au \u0111\u1ea7u (headache): quality checks done');
    } else {
      console.log('  WARN: could not get script for \u0111au \u0111\u1ea7u');
    }
  }

  // E2: abdominal pain
  {
    const sd = await getScriptData('\u0111au b\u1ee5ng');
    if (sd) {
      assert(questionsContain(sd, 'ki\u1ec3u') || questionsContain(sd, 'th\u1ebf n\u00e0o'), '\u0111au b\u1ee5ng: asks about pain type');
      assert(questionsContain(sd, 'v\u1ecb tr\u00ed') || questionsContain(sd, 'v\u00f9ng'), '\u0111au b\u1ee5ng: asks about location');
      assert(questionsContain(sd, 'tri\u1ec7u ch\u1ee9ng') || questionsContain(sd, '\u0111i k\u00e8m') || questionsContain(sd, 'th\u00eam'), '\u0111au b\u1ee5ng: asks about associated');
      console.log('  \u0111au b\u1ee5ng (abdominal pain): quality checks done');
    } else {
      console.log('  WARN: could not get script for \u0111au b\u1ee5ng');
    }
  }

  // E3: dizziness
  {
    const sd = await getScriptData('ch\u00f3ng m\u1eb7t');
    if (sd) {
      assert(
        questionsContain(sd, 'ki\u1ec3u') || questionsContain(sd, 'lo\u1ea1i') || questionsContain(sd, 'c\u1ea3m gi\u00e1c') || questionsContain(sd, 'ch\u00f3ng m\u1eb7t'),
        'ch\u00f3ng m\u1eb7t: asks about type of dizziness'
      );
      assert(
        questionsContain(sd, 'khi n\u00e0o') || questionsContain(sd, 'l\u00fac n\u00e0o') || questionsContain(sd, 't\u00ecnh hu\u1ed1ng') || questionsContain(sd, 'xu\u1ea5t hi\u1ec7n'),
        'ch\u00f3ng m\u1eb7t: asks about triggers'
      );
      console.log('  ch\u00f3ng m\u1eb7t (dizziness): quality checks done');
    } else {
      console.log('  WARN: could not get script for ch\u00f3ng m\u1eb7t');
    }
  }

  // E4: dyspnea
  {
    const sd = await getScriptData('kh\u00f3 th\u1edf');
    if (sd) {
      const hasRedFlagAwareness = sd.scoring_rules && sd.scoring_rules.some(r => r.severity === 'high');
      assert(hasRedFlagAwareness, 'kh\u00f3 th\u1edf: has high-severity scoring rule (danger awareness)');
      assert(sd.questions && sd.questions.length >= 2, 'kh\u00f3 th\u1edf: has at least 2 questions');
      console.log('  kh\u00f3 th\u1edf (dyspnea): quality checks done');
    } else {
      console.log('  WARN: could not get script for kh\u00f3 th\u1edf');
    }
  }

  // ========================================================================
  // F. Summary table
  // ========================================================================
  console.log('\n================================================================');
  console.log('  SUMMARY TABLE');
  console.log('================================================================\n');

  // Header
  const hdr = [
    'Complaint'.padEnd(16),
    'Questions'.padEnd(10),
    'Rules'.padEnd(6),
    'Valid'.padEnd(6),
    'Session'.padEnd(8),
    'HIGH'.padEnd(6),
    'LOW'.padEnd(6),
  ];
  console.log('| ' + hdr.join(' | ') + ' |');
  console.log('|' + hdr.map(h => '-'.repeat(h.length + 2)).join('|') + '|');

  let allValid = 0;
  let allSession = 0;
  let allHigh = 0;
  let allLow = 0;

  for (const r of results) {
    const ok = (b) => b ? 'PASS' : 'FAIL';
    const cols = [
      r.complaint.padEnd(16),
      String(r.questions).padEnd(10),
      String(r.rules).padEnd(6),
      ok(r.valid).padEnd(6),
      ok(r.sessionOk).padEnd(8),
      ok(r.highOk).padEnd(6),
      ok(r.lowOk).padEnd(6),
    ];
    console.log('| ' + cols.join(' | ') + ' |');

    if (r.valid) allValid++;
    if (r.sessionOk) allSession++;
    if (r.highOk) allHigh++;
    if (r.lowOk) allLow++;
  }

  console.log('');
  console.log(`Valid: ${allValid}/${results.length}  |  Session: ${allSession}/${results.length}  |  HIGH: ${allHigh}/${results.length}  |  LOW: ${allLow}/${results.length}`);
  console.log(`\nTotal assertions: ${totalPass} passed, ${totalFail} failed`);

  // Print errors if any
  const errorRows = results.filter(r => r.errors.length > 0);
  if (errorRows.length > 0) {
    console.log('\n--- Errors ---');
    for (const r of errorRows) {
      console.log(`  ${r.complaint}: ${r.errors.join('; ')}`);
    }
  }

  // --- Cleanup ---
  await cleanup();
  console.log('\n[Cleanup] Test data removed.');

  console.log(`\n${'='.repeat(64)}`);
  if (totalFail === 0) {
    console.log('  ALL TESTS PASSED');
  } else {
    console.log(`  ${totalFail} ASSERTION(S) FAILED`);
  }
  console.log('='.repeat(64));
}

run()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
