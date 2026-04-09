#!/usr/bin/env node
'use strict';

/**
 * Controller-level integration test for Script Check-in Controller
 * Tests all handler functions via mock req/res objects.
 *
 * Usage: node scripts/test-controller.js
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

const TEST_USER_ID = 4;

let passed = 0;
let failed = 0;
let total = 0;

function mockReq(userId, body = {}, query = {}) {
  return { user: { id: userId }, body, query };
}

function mockRes() {
  let _status = 200, _json = null;
  return {
    status(code) { _status = code; return this; },
    json(data) { _json = data; return this; },
    getStatus() { return _status; },
    getData() { return _json; },
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

async function cleanup() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today]);
}

async function run() {
  console.log('==========================================================');
  console.log('  Script Check-in Controller -- Integration Tests');
  console.log('==========================================================\n');

  // ── Clean up ──────────────────────────────────────────────────
  await cleanup();

  // ═══════════════════════════════════════════════════════════════
  // A. createClustersHandler
  // ═══════════════════════════════════════════════════════════════
  console.log('--- A. createClustersHandler ---');

  // A1: Valid symptoms array
  {
    const req = mockReq(TEST_USER_ID, { symptoms: ['dau dau', 'chong mat'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    const d = res.getData();
    assert(res.getStatus() === 200 && d.ok === true, 'A1: Valid symptoms -> ok:true');
    assert(Array.isArray(d.clusters) && d.clusters.length > 0, 'A1: clusters array returned');
  }

  // A2: Empty symptoms
  {
    const req = mockReq(TEST_USER_ID, { symptoms: [] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    assert(res.getStatus() === 400, 'A2: Empty symptoms -> 400');
    assert(res.getData().ok === false, 'A2: ok:false');
  }

  // A3: Missing symptoms field
  {
    const req = mockReq(TEST_USER_ID, {});
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    assert(res.getStatus() === 400, 'A3: Missing symptoms -> 400');
  }

  // A4: Duplicate call (idempotent)
  {
    const req = mockReq(TEST_USER_ID, { symptoms: ['dau dau', 'chong mat'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    assert(res.getStatus() === 200 && res.getData().ok === true, 'A4: Duplicate call -> no error (idempotent)');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // Now create proper clusters for subsequent tests (use Vietnamese diacritics)
  // ═══════════════════════════════════════════════════════════════
  await cleanup();
  {
    const req = mockReq(TEST_USER_ID, { symptoms: ['\u0111au \u0111\u1ea7u', 'ch\u00f3ng m\u1eb7t'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
  }

  // ═══════════════════════════════════════════════════════════════
  // B. getScriptHandler
  // ═══════════════════════════════════════════════════════════════
  console.log('--- B. getScriptHandler ---');

  // B1: User with clusters
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === true, 'B1: has_script:true');
    assert(typeof d.greeting === 'string' && d.greeting.length > 0, 'B1: greeting present');
    assert(Array.isArray(d.initial_options), 'B1: initial_options present');
    assert(Array.isArray(d.clusters) && d.clusters.length > 0, 'B1: clusters array present');
  }

  // B2: After creating clusters -> correct cluster count
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.clusters.length === 2, `B2: cluster count = ${d.clusters.length} (expected 2)`);
  }

  // B3: Greeting contains user name
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    // User 4 is "Chu Hung" / "Tran Van Hung" -- greeting has Vietnamese diacritics
    assert(
      d.greeting.includes('H\u00f9ng') || d.greeting.includes('h\u00f9ng'),
      `B3: Greeting contains user name: "${d.greeting}"`
    );
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // C. startScriptHandler
  // ═══════════════════════════════════════════════════════════════
  console.log('--- C. startScriptHandler ---');

  // C1: status="fine"
  {
    const req = mockReq(TEST_USER_ID, { status: 'fine' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.needs_script === false, 'C1: fine -> needs_script:false');
    assert(typeof d.message === 'string' && d.message.length > 0, 'C1: message present');
  }

  // C2: status="tired" + cluster_key="headache"
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'C2: tired+cluster -> session created');
    assert(d.question && d.question.id, 'C2: first question returned');
    assert(d.cluster_key === 'headache', 'C2: cluster_key = headache');
  }

  // C3: status="tired" + symptom_input matching cluster
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau dau' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'C3: symptom_input matching cluster -> session');
    // It might match or use fallback depending on cluster matching
    assert(d.question || d.is_emergency || d.is_fallback !== undefined, 'C3: got response');
  }

  // C4: status="tired" + symptom_input="dau sau tai" (unknown)
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau sau tai' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.is_fallback === true, `C4: unknown symptom -> is_fallback:${d.is_fallback}`);
    assert(d.session_id, 'C4: session_id present even for fallback');
  }

  // C5: status="tired" + symptom_input="dau nguc kho tho" (emergency)
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau nguc kho tho' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    // Note: emergency detector uses Vietnamese with diacritics; "dau nguc kho tho" may not match
    // Let's test with proper diacritics instead
    assert(d.ok === true, 'C5: response ok');
  }
  // C5b: With proper Vietnamese diacritics
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: '\u0111au ng\u1ef1c kh\u00f3 th\u1edf' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.is_emergency === true, `C5b: "dau nguc kho tho" (diacritics) -> is_emergency:${d.is_emergency}`);
  }

  // C6: status="invalid"
  {
    const req = mockReq(TEST_USER_ID, { status: 'invalid' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'C6: invalid status -> 400');
  }

  // C7: Missing status
  {
    const req = mockReq(TEST_USER_ID, {});
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'C7: missing status -> 400');
  }

  // C8: status="very_tired" + cluster_key -> flow_state='high_alert'
  {
    const req = mockReq(TEST_USER_ID, { status: 'very_tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'C8: very_tired -> session created');
    // Check DB for health_checkins flow_state
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    // Allow async DB write to complete
    await new Promise(r => setTimeout(r, 200));
    const { rows } = await pool.query(
      'SELECT flow_state FROM health_checkins WHERE user_id = $1 AND session_date = $2 ORDER BY id DESC LIMIT 1',
      [TEST_USER_ID, today]
    );
    assert(
      rows.length > 0 && rows[0].flow_state === 'high_alert',
      `C8: flow_state = ${rows[0]?.flow_state} (expected high_alert)`
    );
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // D. answerScriptHandler
  // ═══════════════════════════════════════════════════════════════
  console.log('--- D. answerScriptHandler ---');

  // Start a fresh session for answer tests
  let testSessionId;
  let testQuestions = [];
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    testSessionId = d.session_id;
    testQuestions.push(d.question);
  }

  // D1: Valid answer -> returns next question (isDone:false)
  {
    const q = testQuestions[testQuestions.length - 1];
    let answerVal;
    if (q.type === 'slider') answerVal = 3;
    else if (q.options && q.options.length > 0) answerVal = q.options[0];
    else answerVal = 'test answer';

    const req = mockReq(TEST_USER_ID, { session_id: testSessionId, question_id: q.id, answer: answerVal });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'D1: valid answer -> ok:true');
    if (!d.isDone) {
      assert(d.question && d.question.id, 'D1: next question returned (isDone:false)');
      testQuestions.push(d.question);
    }
  }

  // D2: Answer all questions -> returns conclusion (isDone:true)
  {
    let done = false;
    let maxIter = 15;
    while (!done && maxIter-- > 0) {
      const q = testQuestions[testQuestions.length - 1];
      if (!q) break;
      let answerVal;
      if (q.type === 'slider') answerVal = 3;
      else if (q.options && q.options.length > 0) answerVal = q.options[0];
      else answerVal = 'some answer';

      const req = mockReq(TEST_USER_ID, { session_id: testSessionId, question_id: q.id, answer: answerVal });
      const res = mockRes();
      await answerScriptHandler(pool, req, res);
      const d = res.getData();
      if (d.isDone) {
        done = true;
        assert(d.isDone === true, 'D2: all questions answered -> isDone:true');
        assert(d.conclusion && d.conclusion.severity, `D2: conclusion has severity: ${d.conclusion.severity}`);
      } else if (d.question) {
        testQuestions.push(d.question);
      } else {
        break;
      }
    }
    if (!done) {
      // Already done from D1 if very few questions
      const checkReq = mockReq(TEST_USER_ID, { session_id: testSessionId, question_id: 'dummy', answer: 'x' });
      const checkRes = mockRes();
      await answerScriptHandler(pool, checkReq, checkRes);
      // If session is already completed it returns 400
      if (checkRes.getStatus() === 400) {
        assert(true, 'D2: session already completed (isDone reached)');
      }
    }
  }

  // D3: Missing session_id
  {
    const req = mockReq(TEST_USER_ID, { question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'D3: missing session_id -> 400');
  }

  // D4: Missing question_id
  {
    const req = mockReq(TEST_USER_ID, { session_id: testSessionId, answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'D4: missing question_id -> 400');
  }

  // D5: Invalid session_id
  {
    const req = mockReq(TEST_USER_ID, { session_id: 999999, question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 404, 'D5: invalid session_id -> 404');
  }

  // D6: Already completed session
  {
    const req = mockReq(TEST_USER_ID, { session_id: testSessionId, question_id: 'q1', answer: 'test' });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    assert(res.getStatus() === 400, 'D6: already completed session -> 400');
    assert(res.getData().error.includes('already completed'), 'D6: error mentions already completed');
  }

  // D7: Emergency answer text -> is_emergency:true
  {
    // Start a new session for emergency test
    const startReq = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const startRes = mockRes();
    await startScriptHandler(pool, startReq, startRes);
    const startD = startRes.getData();
    const emergSessionId = startD.session_id;
    const emergQ = startD.question;

    const req = mockReq(TEST_USER_ID, {
      session_id: emergSessionId,
      question_id: emergQ.id,
      answer: '\u0111au ng\u1ef1c kh\u00f3 th\u1edf',  // "dau nguc kho tho" with diacritics
    });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.is_emergency === true, `D7: emergency answer -> is_emergency:${d.is_emergency}`);
  }

  // D8: Verify session saved in script_sessions after completion
  {
    const { rows } = await pool.query(
      'SELECT * FROM script_sessions WHERE id = $1',
      [testSessionId]
    );
    assert(rows.length === 1, 'D8: session exists in DB');
    assert(rows[0].is_completed === true, 'D8: session is_completed = true');
    assert(rows[0].severity !== null, `D8: severity saved: ${rows[0].severity}`);
    assert(rows[0].completed_at !== null, 'D8: completed_at set');
  }

  // D9: Verify health_checkins updated with triage_severity
  {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await new Promise(r => setTimeout(r, 200));
    const { rows } = await pool.query(
      'SELECT * FROM health_checkins WHERE user_id = $1 AND session_date = $2 ORDER BY id DESC LIMIT 1',
      [TEST_USER_ID, today]
    );
    if (rows.length > 0) {
      assert(rows[0].triage_severity !== null || rows[0].flow_state !== null,
        `D9: health_checkins updated, triage_severity=${rows[0].triage_severity}, flow_state=${rows[0].flow_state}`);
    } else {
      assert(false, 'D9: no health_checkins row found');
    }
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // E. getSessionHandler
  // ═══════════════════════════════════════════════════════════════
  console.log('--- E. getSessionHandler ---');

  // E1: After starting a session -> returns session data
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_session === true, 'E1: has_session:true');
    assert(d.session && d.session.id, 'E1: session data present');
  }

  // E2: No session today for different user
  {
    const req = mockReq(99999);  // non-existent user
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_session === false, 'E2: non-existent user -> has_session:false');
  }

  // E3: After completing -> shows is_completed:true, severity
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    // The latest session might be the emergency one or the completed one
    assert(d.session.is_completed === true, `E3: is_completed = ${d.session.is_completed}`);
    assert(d.session.severity !== null && d.session.severity !== undefined,
      `E3: severity = ${d.session.severity}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // F. Integration flow (full end-to-end)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- F. Integration flow (end-to-end) ---');

  // Clean up for fresh flow
  await cleanup();

  // F1: createClusters
  {
    const req = mockReq(TEST_USER_ID, { symptoms: ['\u0111au \u0111\u1ea7u', 'ch\u00f3ng m\u1eb7t'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'F1: createClusters ok');
    assert(d.clusters.length === 2, `F1: ${d.clusters.length} clusters created`);
  }

  // F2: getScript -> verify clusters
  let clustersList;
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === true, 'F2: getScript has_script:true');
    assert(d.clusters.length === 2, `F2: ${d.clusters.length} clusters`);
    clustersList = d.clusters;
  }

  // F3: startScript
  let flowSessionId;
  let flowQuestions = [];
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.session_id, 'F3: session started');
    flowSessionId = d.session_id;
    flowQuestions.push(d.question);
    assert(d.question && d.question.id, `F3: first question: ${d.question?.id}`);
  }

  // F4-F6: Answer all questions step by step
  {
    let stepNum = 4;
    let done = false;
    let maxIter = 15;
    while (!done && maxIter-- > 0) {
      const q = flowQuestions[flowQuestions.length - 1];
      if (!q) break;
      let answerVal;
      if (q.type === 'slider') answerVal = 5;
      else if (q.options && q.options.length > 0) answerVal = q.options[0];
      else answerVal = 'test input';

      const req = mockReq(TEST_USER_ID, { session_id: flowSessionId, question_id: q.id, answer: answerVal });
      const res = mockRes();
      await answerScriptHandler(pool, req, res);
      const d = res.getData();

      if (d.isDone) {
        done = true;
        assert(d.isDone === true, `F${stepNum}: isDone=true, severity=${d.conclusion?.severity}`);
      } else if (d.question) {
        assert(d.question.id, `F${stepNum}: got question ${d.question.id}`);
        flowQuestions.push(d.question);
      }
      stepNum++;
    }
    assert(done, 'F: all questions answered and done');
  }

  // F7: getSession -> verify completed with severity
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.has_session === true, 'F7: has_session after flow');
    assert(d.session.is_completed === true, 'F7: is_completed:true');
    assert(d.session.severity !== null, `F7: severity = ${d.session.severity}`);
  }

  // F8: Check DB: script_sessions row
  {
    const { rows } = await pool.query(
      'SELECT * FROM script_sessions WHERE id = $1',
      [flowSessionId]
    );
    assert(rows.length === 1, 'F8: session row exists in DB');
    assert(rows[0].severity !== null, `F8: severity = ${rows[0].severity}`);
    assert(rows[0].conclusion_summary !== null, `F8: conclusion_summary present`);
    assert(rows[0].completed_at !== null, 'F8: completed_at set');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // G. Edge cases
  // ═══════════════════════════════════════════════════════════════
  console.log('--- G. Edge cases ---');

  // G1: Start session without clusters (user has none) -> fallback works
  {
    // Clean clusters for this test
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);

    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau bung am i' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'G1: no clusters -> still ok');
    assert(d.is_fallback === true, `G1: is_fallback = ${d.is_fallback}`);
    assert(d.session_id, 'G1: session_id present');
  }

  // G2: Multiple sessions same day -> latest one returned by getSession
  {
    // Start another session
    const req = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'met qua' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    const secondSessionId = d.session_id;

    const getReq = mockReq(TEST_USER_ID);
    const getRes = mockRes();
    await getSessionHandler(pool, getReq, getRes);
    const gd = getRes.getData();
    assert(gd.has_session === true, 'G2: has_session:true');
    // The latest session should be returned (the one we just created)
    assert(
      String(gd.session.id) === String(secondSessionId),
      `G2: latest session returned (${gd.session.id} === ${secondSessionId})`
    );
  }

  // G3: Answer with very long string -> no crash
  {
    // Start a fresh session
    const startReq = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau lung' });
    const startRes = mockRes();
    await startScriptHandler(pool, startReq, startRes);
    const sd = startRes.getData();

    const longString = 'a'.repeat(5000);
    const req = mockReq(TEST_USER_ID, {
      session_id: sd.session_id,
      question_id: sd.question.id,
      answer: longString,
    });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'G3: long string answer -> no crash, ok:true');
  }

  // G4: Answer with numeric 0 -> handled (not treated as falsy)
  {
    // Start a fresh session
    const startReq = mockReq(TEST_USER_ID, { status: 'tired', symptom_input: 'dau chan' });
    const startRes = mockRes();
    await startScriptHandler(pool, startReq, startRes);
    const sd = startRes.getData();

    const req = mockReq(TEST_USER_ID, {
      session_id: sd.session_id,
      question_id: sd.question.id,
      answer: 0,
    });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true, 'G4: answer=0 -> ok:true (not treated as falsy)');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════
  await cleanup();

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log('==========================================================');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);
  console.log('==========================================================');

  if (failed > 0) {
    console.log('\n  Some tests FAILED -- check output above.');
  } else {
    console.log('\n  All tests PASSED.');
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test crashed:', err);
  pool.end().then(() => process.exit(1));
});
