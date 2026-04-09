#!/usr/bin/env node
'use strict';

/**
 * Round 4 — Controller-layer end-to-end test
 * 3 complete user journeys + 10 error cases
 *
 * Usage: node scripts/test-round4.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  getScriptHandler,
  startScriptHandler,
  answerScriptHandler,
  getSessionHandler,
  createClustersHandler,
} = require('../src/controllers/script-checkin.controller');

const scriptService = require('../src/services/checkin/script.service');
const fallbackService = require('../src/services/checkin/fallback.service');

const TEST_USER_ID = 4;

let passed = 0;
let failed = 0;
let total = 0;

// ─── Mock helpers ──────────────────────────────────────────────────────────

function mockReq(userId, body = {}, query = {}) {
  return { user: { id: userId }, body, query };
}

function mockRes() {
  let _s = 200, _j = null;
  return {
    status(c) { _s = c; return this; },
    json(d) { _j = d; return this; },
    getStatus() { return _s; },
    getData() { return _j; },
  };
}

function assert(condition, label) {
  total++;
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today]);
}

// ─── Helper: answer all questions, picking first option each time ──────────

async function answerAllQuestions(sessionId, firstQuestion) {
  const questions = [];
  let currentQ = firstQuestion;
  let done = false;
  let lastData = null;
  let maxIter = 20;

  while (!done && maxIter-- > 0) {
    if (!currentQ) break;
    questions.push(currentQ);

    let answerVal;
    if (currentQ.type === 'slider') answerVal = 3;
    else if (currentQ.options && currentQ.options.length > 0) answerVal = currentQ.options[0];
    else answerVal = 'some answer';

    const req = mockReq(TEST_USER_ID, {
      session_id: sessionId,
      question_id: currentQ.id,
      answer: answerVal,
    });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    lastData = res.getData();

    if (lastData.isDone) {
      done = true;
    } else if (lastData.question) {
      currentQ = lastData.question;
    } else {
      break;
    }
  }

  return { done, lastData, questionCount: questions.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Round 4 — Controller E2E: 3 Journeys + Error Cases');
  console.log('══════════════════════════════════════════════════════════\n');

  await cleanup();

  // ═══════════════════════════════════════════════════════════════════════
  // JOURNEY 1: Normal check-in with known symptom
  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  JOURNEY 1: Normal check-in with known symptom');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1.1 createClustersHandler
  {
    const req = mockReq(TEST_USER_ID, { symptoms: ['đau đầu', 'chóng mặt', 'mệt mỏi'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    const d = res.getData();
    assert(res.getStatus() === 200 && d.ok === true, 'J1.1 createClusters -> ok');
    assert(Array.isArray(d.clusters) && d.clusters.length === 3,
      `J1.1 created 3 clusters (got ${d.clusters?.length})`);
  }

  // 1.2 getScriptHandler
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === true, 'J1.2 getScript -> has_script:true');
    assert(Array.isArray(d.clusters) && d.clusters.length === 3,
      `J1.2 clusters count = ${d.clusters?.length} (expected 3)`);
    assert(
      d.greeting && (d.greeting.includes('Hùng') || d.greeting.includes('hùng')),
      `J1.2 greeting contains "Hùng": "${d.greeting}"`
    );
  }

  // 1.3 startScriptHandler
  let j1SessionId;
  let j1FirstQ;
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'J1.3 startScript -> session_id present');
    assert(d.question && d.question.id, `J1.3 first question returned: ${d.question?.id}`);
    j1SessionId = d.session_id;
    j1FirstQ = d.question;
  }

  // 1.4 Loop answerScriptHandler until isDone
  let j1QuestionCount = 0;
  let j1Conclusion = null;
  {
    const result = await answerAllQuestions(j1SessionId, j1FirstQ);
    j1QuestionCount = result.questionCount;
    j1Conclusion = result.lastData?.conclusion;
    assert(result.done === true, 'J1.4 all questions answered -> isDone:true');
  }

  // 1.5 Verify final response
  {
    assert(j1Conclusion && j1Conclusion.severity,
      `J1.5 conclusion has severity: ${j1Conclusion?.severity}`);
    assert(j1Conclusion && j1Conclusion.summary && j1Conclusion.summary.length > 0,
      'J1.5 conclusion has summary');
    assert(j1Conclusion && j1Conclusion.recommendation && j1Conclusion.recommendation.length > 0,
      'J1.5 conclusion has recommendation');
  }

  // 1.6 getSessionHandler
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.has_session === true, 'J1.6 getSession -> has_session:true');
    assert(d.session.is_completed === true, 'J1.6 session is_completed:true');
  }

  // 1.7 Verify DB
  {
    // Allow async DB writes to settle
    await new Promise(r => setTimeout(r, 300));

    const { rows: sessRows } = await pool.query(
      'SELECT * FROM script_sessions WHERE id = $1', [j1SessionId]
    );
    assert(sessRows.length === 1 && sessRows[0].is_completed === true,
      'J1.7 DB: script_sessions has completed row');

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const { rows: checkinRows } = await pool.query(
      'SELECT * FROM health_checkins WHERE user_id = $1 AND session_date = $2 ORDER BY id DESC LIMIT 1',
      [TEST_USER_ID, today]
    );
    assert(checkinRows.length > 0 && checkinRows[0].triage_severity !== null,
      `J1.7 DB: health_checkins has triage_severity: ${checkinRows[0]?.triage_severity}`);
  }

  // 1.8 Count questions
  {
    assert(j1QuestionCount > 0,
      `J1.8 questions asked: ${j1QuestionCount} (expected >0)`);
  }

  console.log(`\n  Journey 1 complete: ${j1QuestionCount} questions, severity=${j1Conclusion?.severity}\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // JOURNEY 2: Unknown symptom -> fallback -> R&D -> re-check
  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  JOURNEY 2: Unknown symptom -> fallback -> R&D -> re-check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Clean sessions for fresh journey (keep clusters from J1)
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  const today2 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today2]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);

  // 2.1 startScript with unknown symptom (use something that won't token-match existing clusters)
  //     Existing clusters: đau đầu (headache), chóng mặt (dizziness), mệt mỏi (fatigue)
  //     matchCluster does token overlap, so "đau X" would match "đau đầu". Use unique term.
  let j2FallbackSessionId;
  let j2FallbackFirstQ;
  let j2IsFallback = false;
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'tê bì tay chân' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'J2.1 startScript with unknown symptom -> ok');
    j2IsFallback = d.is_fallback === true;
    assert(j2IsFallback, `J2.1 unknown symptom "tê bì tay chân" -> is_fallback: ${d.is_fallback}`);
    j2FallbackSessionId = d.session_id;
    j2FallbackFirstQ = d.question;
  }

  // 2.2 Answer fallback questions (should be 3: fb1, fb2, fb3)
  let j2FallbackQCount = 0;
  let j2FallbackConclusion = null;
  {
    const result = await answerAllQuestions(j2FallbackSessionId, j2FallbackFirstQ);
    j2FallbackQCount = result.questionCount;
    j2FallbackConclusion = result.lastData?.conclusion;
    assert(result.done === true, 'J2.2 fallback questions answered -> isDone:true');
    assert(j2FallbackConclusion && j2FallbackConclusion.severity,
      `J2.2 fallback conclusion severity: ${j2FallbackConclusion?.severity}`);
  }

  // 2.3 Verify fallback_logs
  {
    await new Promise(r => setTimeout(r, 300));
    const { rows } = await pool.query(
      'SELECT * FROM fallback_logs WHERE user_id = $1 ORDER BY created_at DESC',
      [TEST_USER_ID]
    );
    assert(rows.length > 0, `J2.3 fallback_logs has ${rows.length} entries`);
  }

  // 2.4 Simulate R&D: addCluster for "numbness" (tê bì)
  {
    await scriptService.addCluster(pool, TEST_USER_ID, 'numbness', 'tê bì tay chân', 'rnd_cycle');
    // Verify cluster was created
    const { rows } = await pool.query(
      'SELECT * FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2',
      [TEST_USER_ID, 'numbness']
    );
    assert(rows.length === 1, 'J2.4 R&D: numbness cluster created');
    // Verify script was generated
    const { rows: scriptRows } = await pool.query(
      'SELECT * FROM triage_scripts WHERE user_id = $1 AND cluster_key = $2 AND is_active = TRUE',
      [TEST_USER_ID, 'numbness']
    );
    assert(scriptRows.length > 0, 'J2.4 R&D: script generated for numbness');
  }

  // 2.5 Start again with same symptom -> should now match cluster
  let j2ScriptSessionId;
  let j2ScriptFirstQ;
  {
    // Clean sessions so we can start fresh
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today2]);

    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'tê bì tay chân' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'J2.5 re-start with same symptom -> ok');
    assert(d.is_fallback === false || d.is_fallback === undefined,
      `J2.5 now matches cluster (is_fallback=${d.is_fallback})`);
    assert(d.cluster_key === 'numbness',
      `J2.5 cluster_key = ${d.cluster_key} (expected numbness)`);
    j2ScriptSessionId = d.session_id;
    j2ScriptFirstQ = d.question;
  }

  // 2.6 Answer all script questions
  let j2ScriptQCount = 0;
  let j2ScriptConclusion = null;
  {
    const result = await answerAllQuestions(j2ScriptSessionId, j2ScriptFirstQ);
    j2ScriptQCount = result.questionCount;
    j2ScriptConclusion = result.lastData?.conclusion;
    assert(result.done === true, 'J2.6 script questions answered -> isDone:true');
    assert(j2ScriptConclusion && j2ScriptConclusion.severity,
      `J2.6 script conclusion severity: ${j2ScriptConclusion?.severity}`);
  }

  // 2.7 Compare: fallback had 3 questions, script should have more (or at least same)
  {
    console.log(`\n  Fallback questions: ${j2FallbackQCount}, Script questions: ${j2ScriptQCount}`);
    // Fallback uses 3 standard questions (fb1, fb2, fb3)
    assert(j2FallbackQCount === 3,
      `J2.7 fallback had ${j2FallbackQCount} questions (expected 3)`);
    // Script (generic template for unknown cluster) has 3 questions too, but may have more
    // if clinical-mapping provides followUpQuestions
    assert(j2ScriptQCount >= j2FallbackQCount,
      `J2.7 script has ${j2ScriptQCount} questions >= fallback ${j2FallbackQCount}`);
  }

  console.log(`\n  Journey 2 complete: fallback=${j2FallbackQCount}q, script=${j2ScriptQCount}q\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // JOURNEY 3: Emergency bypass
  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  JOURNEY 3: Emergency bypass');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Clean sessions
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today2]);

  // 3.1 Emergency symptom at start
  {
    const req = mockReq(TEST_USER_ID, { status: 'very_tired', symptom_input: 'đau ngực khó thở' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.is_emergency === true,
      `J3.1 emergency symptom -> is_emergency: ${d.is_emergency}`);
    assert(d.emergency && d.emergency.type,
      `J3.1 emergency.type = ${d.emergency?.type}`);
  }

  // 3.2 Verify emergency.type exists (MI or similar)
  {
    const req = mockReq(TEST_USER_ID, { status: 'very_tired', symptom_input: 'đau ngực khó thở' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.emergency && typeof d.emergency.type === 'string' && d.emergency.type.length > 0,
      `J3.2 emergency type is a non-empty string: "${d.emergency?.type}"`);
  }

  // 3.3 Verify NO session created for emergency
  {
    const { rows } = await pool.query(
      `SELECT * FROM script_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER_ID]
    );
    // There should be no sessions since emergency returns immediately before creating one
    assert(rows.length === 0,
      `J3.3 no session created for emergency (found ${rows.length})`);
  }

  // 3.4 Start normal session
  let j3SessionId;
  let j3FirstQ;
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'J3.4 normal session started after emergency');
    j3SessionId = d.session_id;
    j3FirstQ = d.question;
  }

  // 3.5 Answer with emergency text mid-session
  {
    const req = mockReq(TEST_USER_ID, {
      session_id: j3SessionId,
      question_id: j3FirstQ.id,
      answer: 'đau ngực dữ dội khó thở',
    });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.is_emergency === true,
      `J3.5 emergency text mid-session -> is_emergency: ${d.is_emergency}`);
  }

  // 3.6 Verify session marked completed with severity=critical
  {
    await new Promise(r => setTimeout(r, 200));
    const { rows } = await pool.query(
      'SELECT * FROM script_sessions WHERE id = $1', [j3SessionId]
    );
    assert(rows.length === 1 && rows[0].is_completed === true,
      'J3.6 session marked completed after emergency');
    assert(rows[0].severity === 'critical',
      `J3.6 severity = ${rows[0].severity} (expected critical)`);
  }

  console.log('\n  Journey 3 complete: emergency detection verified\n');

  // ═══════════════════════════════════════════════════════════════════════
  // ERROR CASES (10 tests)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ERROR CASES (10 tests)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // E1: startScript with status="invalid"
  {
    const req = mockReq(TEST_USER_ID, { status: 'invalid' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E1 startScript status="invalid" -> 400');
  }

  // E2: startScript with missing status
  {
    const req = mockReq(TEST_USER_ID, {});
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E2 startScript missing status -> 400');
  }

  // E3: answerScript with missing session_id
  {
    const req = mockReq(TEST_USER_ID, { question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E3 answerScript missing session_id -> 400');
  }

  // E4: answerScript with missing question_id
  {
    const req = mockReq(TEST_USER_ID, { session_id: 1, answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E4 answerScript missing question_id -> 400');
  }

  // E5: answerScript with non-existent session_id=99999
  {
    const req = mockReq(TEST_USER_ID, { session_id: 99999, question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 404, 'E5 answerScript session_id=99999 -> 404');
  }

  // E6: answerScript on completed session
  {
    // j3SessionId was completed by emergency
    const req = mockReq(TEST_USER_ID, { session_id: j3SessionId, question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E6 answerScript on completed session -> 400');
  }

  // E7: createClusters with empty array
  {
    const req = mockReq(TEST_USER_ID, { symptoms: [] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E7 createClusters empty array -> 400');
  }

  // E8: createClusters with missing field
  {
    const req = mockReq(TEST_USER_ID, {});
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    assert(res.getStatus() === 400, 'E8 createClusters missing symptoms -> 400');
  }

  // E9: getScript for user with no clusters
  {
    // Use a user ID that has no clusters
    const req = mockReq(99998);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === false,
      `E9 getScript no clusters -> has_script: ${d.has_script}`);
  }

  // E10: startScript with status="fine" -> needs_script=false
  {
    const req = mockReq(TEST_USER_ID, { status: 'fine' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.needs_script === false,
      `E10 status="fine" -> needs_script: ${d.needs_script}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════
  await cleanup();

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  ROUND 4 RESULTS: ${passed} passed, ${failed} failed, ${total} total`);
  console.log('══════════════════════════════════════════════════════════');

  console.log('\n  Journey 1 (Normal check-in):  ' +
    `${j1QuestionCount} questions, severity=${j1Conclusion?.severity}`);
  console.log('  Journey 2 (Fallback -> R&D):  ' +
    `fallback=${j2FallbackQCount}q, script=${j2ScriptQCount}q`);
  console.log('  Journey 3 (Emergency bypass): ' +
    'emergency detected at start + mid-session');
  console.log(`  Error cases: 10 tests\n`);

  if (failed > 0) {
    console.log('  Some tests FAILED -- check output above.\n');
  } else {
    console.log('  All tests PASSED.\n');
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test crashed:', err);
  pool.end().then(() => process.exit(1));
});
