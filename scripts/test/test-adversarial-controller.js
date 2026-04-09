#!/usr/bin/env node
'use strict';

/**
 * ADVERSARIAL Controller-level Tests for Script Check-in Controller
 *
 * Tests: Invalid inputs, session state attacks, concurrent-like ops,
 *        and response format validation.
 *
 * Usage: node scripts/test-adversarial-controller.js
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

const { createClustersFromOnboarding } = require('../src/services/checkin/script.service');
const { getFallbackScriptData } = require('../src/services/checkin/fallback.service');

const TEST_USER_ID = 4;

let passed = 0;
let failed = 0;
let total = 0;

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

async function cleanup() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  await pool.query('DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2', [TEST_USER_ID, today]);
}

/** Helper: start a session and return { session_id, question } */
async function startSession(clusterKey = 'headache', status = 'tired') {
  const req = mockReq(TEST_USER_ID, { status, cluster_key: clusterKey });
  const res = mockRes();
  await startScriptHandler(pool, req, res);
  const d = res.getData();
  return { session_id: d.session_id, question: d.question, data: d };
}

/** Helper: answer all questions in a session until done */
async function completeSession(sessionId, firstQuestion) {
  let questions = [firstQuestion];
  let done = false;
  let lastData = null;
  let maxIter = 20;
  while (!done && maxIter-- > 0) {
    const q = questions[questions.length - 1];
    if (!q) break;
    let answerVal;
    if (q.type === 'slider') answerVal = 3;
    else if (q.options && q.options.length > 0) answerVal = q.options[0];
    else answerVal = 'test answer';

    const req = mockReq(TEST_USER_ID, { session_id: sessionId, question_id: q.id, answer: answerVal });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    lastData = res.getData();
    if (lastData.isDone) {
      done = true;
    } else if (lastData.question) {
      questions.push(lastData.question);
    } else {
      break;
    }
  }
  return lastData;
}

async function run() {
  console.log('==========================================================');
  console.log('  ADVERSARIAL Controller Tests -- Script Check-in');
  console.log('==========================================================\n');

  // ── Clean up & Setup ─────────────────────────────────────────
  await cleanup();
  await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);

  // ═══════════════════════════════════════════════════════════════
  // A. Invalid Request Bodies (20 tests)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- A. Invalid Request Bodies ---');

  // A1: startScript with body=null
  {
    const req = { user: { id: TEST_USER_ID }, body: null, query: {} };
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A1: startScript body=null -> no crash');
    assert(res.getStatus() >= 400 || (res.getData() && res.getData().ok !== undefined),
      `A1: got response status=${res.getStatus()}`);
  }

  // A2: startScript with body=undefined
  {
    const req = { user: { id: TEST_USER_ID }, body: undefined, query: {} };
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A2: startScript body=undefined -> no crash');
  }

  // A3: startScript with body="" (string)
  {
    const req = { user: { id: TEST_USER_ID }, body: "", query: {} };
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A3: startScript body="" -> no crash');
  }

  // A4: startScript with body=123 (number)
  {
    const req = { user: { id: TEST_USER_ID }, body: 123, query: {} };
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A4: startScript body=123 -> no crash');
  }

  // A5: startScript with {status: null}
  {
    const req = mockReq(TEST_USER_ID, { status: null });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A5: startScript status=null -> no crash');
    assert(res.getStatus() === 400, `A5: status=${res.getStatus()} (expected 400)`);
  }

  // A6: startScript with {status: ""}
  {
    const req = mockReq(TEST_USER_ID, { status: "" });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A6: startScript status="" -> no crash');
    assert(res.getStatus() === 400, `A6: status=${res.getStatus()} (expected 400)`);
  }

  // A7: startScript with {status: "TIRED"} (uppercase)
  {
    const req = mockReq(TEST_USER_ID, { status: "TIRED" });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A7: startScript status="TIRED" -> no crash');
    assert(res.getStatus() === 400, `A7: uppercase TIRED -> 400 (status=${res.getStatus()})`);
  }

  // A8: startScript with {status: "tired", cluster_key: 12345} (number key)
  {
    const req = mockReq(TEST_USER_ID, { status: "tired", cluster_key: 12345 });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A8: startScript cluster_key=12345 -> no crash');
    // Should fallback since no script for numeric key
    const d = res.getData();
    assert(d && d.ok === true, `A8: responded ok=${d?.ok}`);
  }

  // A9: startScript with {status: "tired", cluster_key: null}
  {
    const req = mockReq(TEST_USER_ID, { status: "tired", cluster_key: null });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A9: startScript cluster_key=null -> no crash');
    const d = res.getData();
    assert(d && d.ok === true, `A9: responded ok=${d?.ok}`);
  }

  // A10: startScript with {status: "tired", symptom_input: 12345}
  {
    const req = mockReq(TEST_USER_ID, { status: "tired", symptom_input: 12345 });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A10: startScript symptom_input=12345 -> no crash');
  }

  // A11: answerScript with body=null
  {
    const req = { user: { id: TEST_USER_ID }, body: null, query: {} };
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A11: answerScript body=null -> no crash');
    assert(res.getStatus() >= 400, `A11: status=${res.getStatus()} (expected >=400)`);
  }

  // A12: answerScript with {session_id: "abc"} (string instead of number)
  {
    const req = mockReq(TEST_USER_ID, { session_id: "abc", question_id: "q1", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A12: answerScript session_id="abc" -> no crash');
    assert(res.getStatus() >= 400, `A12: status=${res.getStatus()} (expected >=400)`);
  }

  // A13: answerScript with {session_id: -1}
  {
    const req = mockReq(TEST_USER_ID, { session_id: -1, question_id: "q1", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A13: answerScript session_id=-1 -> no crash');
    assert(res.getStatus() === 404, `A13: status=${res.getStatus()} (expected 404)`);
  }

  // A14: answerScript with {session_id: 0}
  {
    const req = mockReq(TEST_USER_ID, { session_id: 0, question_id: "q1", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A14: answerScript session_id=0 -> no crash');
    // session_id 0 is falsy -> should trigger 400 "Missing session_id"
    assert(res.getStatus() === 400 || res.getStatus() === 404,
      `A14: status=${res.getStatus()} (expected 400 or 404)`);
  }

  // A15: answerScript with {session_id: 999999, question_id: "q1", answer: "test"}
  {
    const req = mockReq(TEST_USER_ID, { session_id: 999999, question_id: "q1", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A15: answerScript session_id=999999 -> no crash');
    assert(res.getStatus() === 404, `A15: status=${res.getStatus()} (expected 404)`);
  }

  // A16: answerScript with {session_id: valid, question_id: "", answer: "test"}
  {
    const { session_id } = await startSession();
    const req = mockReq(TEST_USER_ID, { session_id, question_id: "", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A16: answerScript question_id="" -> no crash');
    assert(res.getStatus() === 400, `A16: status=${res.getStatus()} (expected 400)`);
  }

  // A17: answerScript with {session_id: valid, question_id: null, answer: "test"}
  {
    const { session_id } = await startSession();
    const req = mockReq(TEST_USER_ID, { session_id, question_id: null, answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A17: answerScript question_id=null -> no crash');
    assert(res.getStatus() === 400, `A17: status=${res.getStatus()} (expected 400)`);
  }

  // A18: createClusters with {symptoms: "not an array"}
  {
    const req = mockReq(TEST_USER_ID, { symptoms: "not an array" });
    const res = mockRes();
    let crashed = false;
    try { await createClustersHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A18: createClusters symptoms=string -> no crash');
    assert(res.getStatus() === 400, `A18: status=${res.getStatus()} (expected 400)`);
  }

  // A19: createClusters with {symptoms: [null, undefined, "", 123]}
  {
    const req = mockReq(TEST_USER_ID, { symptoms: [null, undefined, "", 123] });
    const res = mockRes();
    let crashed = false;
    try { await createClustersHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A19: createClusters symptoms=[null,undefined,"",123] -> no crash');
    // Should still return 200 since array is non-empty, or handle gracefully
    const d = res.getData();
    assert(d !== null, `A19: got response data`);
  }

  // A20: createClusters with {symptoms: []} (empty)
  {
    const req = mockReq(TEST_USER_ID, { symptoms: [] });
    const res = mockRes();
    let crashed = false;
    try { await createClustersHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'A20: createClusters symptoms=[] -> no crash');
    assert(res.getStatus() === 400, `A20: status=${res.getStatus()} (expected 400)`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // B. Session State Attacks (15 tests)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- B. Session State Attacks ---');

  // Cleanup for fresh state
  await cleanup();
  await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);

  // B1: Answer a session that belongs to a different user -> should reject or 404
  {
    const { session_id, question } = await startSession();
    const req = mockReq(99999, { session_id, question_id: question.id, answer: "hack" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B1: answer other user session -> no crash');
    assert(res.getStatus() === 404, `B1: status=${res.getStatus()} (expected 404 - access denied)`);
  }

  // B2: Start session, then call answerScript with wrong session_id format
  {
    await startSession();
    const req = mockReq(TEST_USER_ID, { session_id: "not-a-number", question_id: "q1", answer: "test" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B2: answerScript wrong session_id format -> no crash');
    assert(res.getStatus() >= 400, `B2: status=${res.getStatus()} (expected >=400)`);
  }

  // B3: Complete a session, then try to answer it again -> 400
  {
    const { session_id, question } = await startSession();
    await completeSession(session_id, question);
    const req = mockReq(TEST_USER_ID, { session_id, question_id: "q1", answer: "post-complete" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B3: answer completed session -> no crash');
    assert(res.getStatus() === 400, `B3: status=${res.getStatus()} (expected 400)`);
    assert(res.getData()?.error?.includes('already completed'),
      `B3: error="${res.getData()?.error}"`);
  }

  // B4: Complete a session, then start another with same cluster -> should create new
  {
    const { session_id: s1 } = await startSession();
    // Complete s1 quickly via DB
    await pool.query('UPDATE script_sessions SET is_completed = TRUE WHERE id = $1', [s1]);
    const { session_id: s2 } = await startSession();
    assert(s2 !== s1, `B4: new session created (${s2} != ${s1})`);
    // Note: PG bigint/bigserial returned as string by node-postgres driver
    assert(s2 !== undefined && s2 !== null, `B4: session_id is present (type=${typeof s2}, pg bigint->string is known)`);
  }

  // B5: Start 10 sessions rapidly -> all should create separate rows
  {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const { session_id } = await startSession();
      ids.push(session_id);
    }
    const uniqueIds = new Set(ids);
    assert(uniqueIds.size === 10, `B5: 10 rapid starts -> ${uniqueIds.size} unique sessions (expected 10)`);
  }

  // B6: Answer with session_id=0 -> 400 or 404
  {
    const req = mockReq(TEST_USER_ID, { session_id: 0, question_id: "q1", answer: "x" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B6: session_id=0 -> no crash');
    assert(res.getStatus() === 400 || res.getStatus() === 404,
      `B6: status=${res.getStatus()} (expected 400 or 404)`);
  }

  // B7: Answer with session_id=null -> 400
  {
    const req = mockReq(TEST_USER_ID, { session_id: null, question_id: "q1", answer: "x" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B7: session_id=null -> no crash');
    assert(res.getStatus() === 400, `B7: status=${res.getStatus()} (expected 400)`);
  }

  // B8: Answer with session_id=undefined -> 400
  {
    const req = mockReq(TEST_USER_ID, { session_id: undefined, question_id: "q1", answer: "x" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B8: session_id=undefined -> no crash');
    assert(res.getStatus() === 400, `B8: status=${res.getStatus()} (expected 400)`);
  }

  // B9: Start session with cluster that has no script in DB -> should fallback
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'nonexistent_cluster_xyz' });
    const res = mockRes();
    let crashed = false;
    try { await startScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B9: nonexistent cluster -> no crash');
    const d = res.getData();
    assert(d && d.ok === true, `B9: ok=${d?.ok}`);
    assert(d.is_fallback === true, `B9: is_fallback=${d?.is_fallback} (expected true)`);
  }

  // B10: Get session when no sessions exist today -> has_session:false
  {
    // Clean sessions
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_session === false,
      `B10: no sessions -> has_session=${d.has_session}`);
  }

  // B11: Start session -> don't answer -> start another -> getSession returns latest
  {
    const { session_id: s1 } = await startSession();
    const { session_id: s2 } = await startSession();
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.has_session === true, 'B11: has_session=true');
    assert(d.session.id === s2, `B11: latest session returned (${d.session.id} === ${s2})`);
  }

  // B12: Answer with extra fields in body -> extra fields ignored
  {
    const { session_id, question } = await startSession();
    const req = mockReq(TEST_USER_ID, {
      session_id,
      question_id: question.id,
      answer: "test",
      hacker_field: "xxx",
      __proto__: { admin: true },
      constructor: "evil",
    });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B12: extra fields in body -> no crash');
    assert(res.getData()?.ok === true, `B12: ok=${res.getData()?.ok}`);
  }

  // B13: Answer with answer=null -> should handle
  {
    const { session_id, question } = await startSession();
    const req = mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: null });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B13: answer=null -> no crash');
    assert(res.getData()?.ok === true, `B13: ok=${res.getData()?.ok}`);
  }

  // B14: Answer with answer=undefined -> should handle
  {
    const { session_id, question } = await startSession();
    const req = mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: undefined });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B14: answer=undefined -> no crash');
    assert(res.getData()?.ok === true, `B14: ok=${res.getData()?.ok}`);
  }

  // B15: Answer with answer="" -> should handle
  {
    const { session_id, question } = await startSession();
    const req = mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: "" });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'B15: answer="" -> no crash');
    assert(res.getData()?.ok === true, `B15: ok=${res.getData()?.ok}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // C. Concurrent-like Operations (10 tests)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- C. Concurrent-like Operations ---');

  // Cleanup
  await cleanup();
  await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);

  // C1: Call getScriptHandler 5 times in parallel -> all return same data
  {
    const promises = Array.from({ length: 5 }, () => {
      const req = mockReq(TEST_USER_ID);
      const res = mockRes();
      return getScriptHandler(pool, req, res).then(() => res.getData());
    });
    let crashed = false;
    let results;
    try { results = await Promise.all(promises); } catch (e) { crashed = true; }
    assert(!crashed, 'C1: 5 parallel getScript -> no crash');
    if (results) {
      const allOk = results.every(r => r && r.ok === true && r.has_script === true);
      assert(allOk, `C1: all 5 returned ok=true, has_script=true`);
      // Check they all return same greeting
      const greetings = results.map(r => r.greeting);
      const allSame = greetings.every(g => g === greetings[0]);
      assert(allSame, `C1: all 5 returned same greeting`);
    }
  }

  // C2: Call startScriptHandler 3 times with same params -> 3 different sessions
  {
    const promises = Array.from({ length: 3 }, () => {
      const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
      const res = mockRes();
      return startScriptHandler(pool, req, res).then(() => res.getData());
    });
    let crashed = false;
    let results;
    try { results = await Promise.all(promises); } catch (e) { crashed = true; }
    assert(!crashed, 'C2: 3 parallel starts -> no crash');
    if (results) {
      const ids = results.map(r => r.session_id);
      const unique = new Set(ids);
      assert(unique.size === 3, `C2: 3 different sessions (${unique.size} unique)`);
    }
  }

  // C3: Call answerScriptHandler twice with same answer for same session
  {
    const { session_id, question } = await startSession();
    const makeReq = () => mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: "dup" });
    const res1 = mockRes();
    const res2 = mockRes();
    let crashed = false;
    try {
      await Promise.all([
        answerScriptHandler(pool, makeReq(), res1),
        answerScriptHandler(pool, makeReq(), res2),
      ]);
    } catch (e) { crashed = true; }
    assert(!crashed, 'C3: duplicate answer -> no crash');
    // At least one should succeed
    const ok1 = res1.getData()?.ok;
    const ok2 = res2.getData()?.ok;
    assert(ok1 === true || ok2 === true, `C3: at least one succeeded (ok1=${ok1}, ok2=${ok2})`);
  }

  // C4: createClusters then immediately getScript -> script available
  {
    await cleanup();
    await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === true,
      `C4: createClusters then getScript -> has_script=${d.has_script}`);
  }

  // C5: createClusters with 20 symptoms -> all clusters created
  {
    await cleanup();
    const symptoms = [
      '\u0111au \u0111\u1ea7u', '\u0111au b\u1ee5ng', 'ch\u00f3ng m\u1eb7t',
      'm\u1ec7t m\u1ecfi', '\u0111au ng\u1ef1c', 'kh\u00f3 th\u1edf',
      '\u0111au l\u01b0ng', '\u0111au kh\u1edbp', 'm\u1ea5t ng\u1ee7',
      's\u1ed1t', 'ho', 'bu\u1ed3n n\u00f4n',
      'ti\u00eau ch\u1ea3y', 't\u00e1o b\u00f3n', 'ph\u00e1t ban',
      '\u0111au vai', '\u0111au c\u1ed5', 't\u1ee9c ng\u1ef1c',
      'huy\u1ebft \u00e1p cao', '\u0111\u01b0\u1eddng huy\u1ebft cao'
    ];
    const req = mockReq(TEST_USER_ID, { symptoms });
    const res = mockRes();
    let crashed = false;
    try { await createClustersHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'C5: 20 symptoms -> no crash');
    const d = res.getData();
    assert(d && d.ok === true, `C5: ok=${d?.ok}`);
    assert(d.clusters && d.clusters.length >= 15,
      `C5: ${d?.clusters?.length} clusters created (expected >=15)`);
    // Reset to just headache for remaining tests
    await cleanup();
    await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);
  }

  // C6: startScript then immediately getSession -> session found
  {
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    const { session_id } = await startSession();
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.has_session === true, `C6: session found immediately after start`);
    assert(d.session.id === session_id, `C6: correct session id`);
  }

  // C7: Answer all questions then immediately getSession -> completed
  {
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    const { session_id, question } = await startSession();
    await completeSession(session_id, question);
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.has_session === true && d.session.is_completed === true,
      `C7: session completed immediately visible`);
  }

  // C8: Delete all clusters from DB -> getScriptHandler returns has_script:false
  {
    await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.ok === true && d.has_script === false,
      `C8: no clusters -> has_script=${d.has_script}`);
    // Restore
    await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);
  }

  // C9: Delete script from DB mid-session -> answerScript should fallback or handle
  {
    const { session_id, question } = await startSession();
    // Delete the triage_script mid-session
    await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
    const req = mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: 3 });
    const res = mockRes();
    let crashed = false;
    try { await answerScriptHandler(pool, req, res); } catch (e) { crashed = true; }
    assert(!crashed, 'C9: deleted script mid-session -> no crash');
    const d = res.getData();
    assert(d && d.ok === true, `C9: handled gracefully ok=${d?.ok}`);
    // Restore
    await cleanup();
    await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);
  }

  // C10: Call all 5 handlers in sequence for a complete flow -> all succeed
  {
    await cleanup();
    // 1. createClusters
    const c1req = mockReq(TEST_USER_ID, { symptoms: ['\u0111au \u0111\u1ea7u'] });
    const c1res = mockRes();
    await createClustersHandler(pool, c1req, c1res);
    assert(c1res.getData()?.ok === true, 'C10: createClusters ok');

    // 2. getScript
    const c2req = mockReq(TEST_USER_ID);
    const c2res = mockRes();
    await getScriptHandler(pool, c2req, c2res);
    assert(c2res.getData()?.ok === true, 'C10: getScript ok');

    // 3. startScript
    const c3req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const c3res = mockRes();
    await startScriptHandler(pool, c3req, c3res);
    const startD = c3res.getData();
    assert(startD?.ok === true && startD?.session_id, 'C10: startScript ok');

    // 4. answerScript (one answer)
    const c4req = mockReq(TEST_USER_ID, {
      session_id: startD.session_id,
      question_id: startD.question.id,
      answer: 3,
    });
    const c4res = mockRes();
    await answerScriptHandler(pool, c4req, c4res);
    assert(c4res.getData()?.ok === true, 'C10: answerScript ok');

    // 5. getSession
    const c5req = mockReq(TEST_USER_ID);
    const c5res = mockRes();
    await getSessionHandler(pool, c5req, c5res);
    assert(c5res.getData()?.ok === true && c5res.getData()?.has_session === true,
      'C10: getSession ok');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // D. Response Format Validation (10 tests)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- D. Response Format Validation ---');

  // Cleanup for clean state
  await cleanup();
  await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);

  // D1: getScript response format
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok'), 'D1: has ok field');
    assert(d.hasOwnProperty('has_script'), 'D1: has has_script field');
    assert(typeof d.greeting === 'string', `D1: greeting is string (type=${typeof d.greeting})`);
    assert(Array.isArray(d.initial_options) && d.initial_options.length === 3,
      `D1: initial_options is array of 3 (len=${d.initial_options?.length})`);
    assert(Array.isArray(d.clusters), `D1: clusters is array`);
    // Each initial_option has label, value, emoji
    const opt = d.initial_options[0];
    assert(opt.label && opt.value && opt.emoji,
      `D1: initial_option has label/value/emoji`);
  }

  // D2: startScript fine response format
  {
    const req = mockReq(TEST_USER_ID, { status: 'fine' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok') && d.ok === true, 'D2: has ok=true');
    assert(d.hasOwnProperty('needs_script') && d.needs_script === false,
      'D2: has needs_script=false');
    assert(typeof d.message === 'string' && d.message.length > 0, 'D2: has message string');
  }

  // D3: startScript tired response format
  {
    const req = mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' });
    const res = mockRes();
    await startScriptHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok') && d.ok === true, 'D3: has ok=true');
    // PG bigint returned as string by node-postgres; verify it's a valid numeric value
    assert(d.session_id !== undefined && d.session_id !== null && !isNaN(Number(d.session_id)),
      `D3: session_id is numeric-coercible (type=${typeof d.session_id}, val=${d.session_id})`);
    assert(typeof d.isDone === 'boolean', `D3: isDone is boolean (${typeof d.isDone})`);
    assert(d.question && typeof d.question === 'object', 'D3: question is object');
    assert(d.question.id && d.question.text && d.question.type,
      `D3: question has id/text/type`);
  }

  // D4: answerScript not done response format
  {
    const { session_id, question } = await startSession();
    let answerVal = question.type === 'slider' ? 3 :
      (question.options?.length > 0 ? question.options[0] : 'test');
    const req = mockReq(TEST_USER_ID, { session_id, question_id: question.id, answer: answerVal });
    const res = mockRes();
    await answerScriptHandler(pool, req, res);
    const d = res.getData();
    if (!d.isDone) {
      assert(d.hasOwnProperty('ok') && d.ok === true, 'D4: has ok=true');
      assert(d.hasOwnProperty('session_id'), 'D4: has session_id');
      assert(d.isDone === false, 'D4: isDone=false');
      assert(d.question && d.question.id && d.question.text && d.question.type,
        'D4: question has id/text/type');
    } else {
      // Script only has a few questions, already done
      assert(d.ok === true, 'D4: ok=true (already done on first answer)');
    }
  }

  // D5: answerScript done response format
  {
    const { session_id, question } = await startSession();
    const lastData = await completeSession(session_id, question);
    assert(lastData.hasOwnProperty('ok') && lastData.ok === true, 'D5: has ok=true');
    assert(lastData.hasOwnProperty('session_id'), 'D5: has session_id');
    assert(lastData.isDone === true, 'D5: isDone=true');
    assert(lastData.conclusion && typeof lastData.conclusion === 'object', 'D5: has conclusion object');
    const c = lastData.conclusion;
    assert(typeof c.severity === 'string', `D5: conclusion.severity is string (${c.severity})`);
    assert(typeof c.summary === 'string', `D5: conclusion.summary is string`);
    assert(typeof c.recommendation === 'string', `D5: conclusion.recommendation is string`);
  }

  // D6: getSession found response format
  {
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok') && d.ok === true, 'D6: has ok=true');
    assert(d.has_session === true, 'D6: has_session=true');
    assert(d.session && typeof d.session === 'object', 'D6: session is object');
    // PG bigint returned as string by node-postgres
    assert(d.session.id !== undefined && !isNaN(Number(d.session.id)),
      `D6: session.id is numeric-coercible (type=${typeof d.session.id})`);
    assert(typeof d.session.cluster_key === 'string', `D6: session.cluster_key is string`);
    assert(typeof d.session.is_completed === 'boolean', `D6: session.is_completed is boolean`);
  }

  // D7: getSession empty response format
  {
    await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
    const req = mockReq(TEST_USER_ID);
    const res = mockRes();
    await getSessionHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok') && d.ok === true, 'D7: has ok=true');
    assert(d.has_session === false, 'D7: has_session=false');
  }

  // D8: createClusters response format
  {
    await cleanup();
    const req = mockReq(TEST_USER_ID, { symptoms: ['\u0111au \u0111\u1ea7u'] });
    const res = mockRes();
    await createClustersHandler(pool, req, res);
    const d = res.getData();
    assert(d.hasOwnProperty('ok') && d.ok === true, 'D8: has ok=true');
    assert(Array.isArray(d.clusters), 'D8: clusters is array');
    if (d.clusters.length > 0) {
      const cl = d.clusters[0];
      assert(typeof cl.cluster_key === 'string', `D8: cluster_key is string (${cl.cluster_key})`);
      assert(typeof cl.display_name === 'string', `D8: display_name is string (${cl.display_name})`);
    }
  }

  // D9: Error responses format
  {
    // 400 error
    const req1 = mockReq(TEST_USER_ID, { status: 'invalid_xyz' });
    const res1 = mockRes();
    await startScriptHandler(pool, req1, res1);
    const d1 = res1.getData();
    assert(d1.hasOwnProperty('ok') && d1.ok === false, 'D9: error has ok=false');
    assert(typeof d1.error === 'string', `D9: error is string (${d1.error})`);

    // 404 error
    const req2 = mockReq(TEST_USER_ID, { session_id: 999999, question_id: 'q1', answer: 'x' });
    const res2 = mockRes();
    await answerScriptHandler(pool, req2, res2);
    const d2 = res2.getData();
    assert(d2.ok === false, 'D9: 404 has ok=false');
    assert(typeof d2.error === 'string', 'D9: 404 error is string');
  }

  // D10: All responses have ok field (boolean) - meta test across handlers
  {
    await cleanup();
    await createClustersFromOnboarding(pool, TEST_USER_ID, ['\u0111au \u0111\u1ea7u']);

    const responses = [];

    // getScript
    const r1 = mockRes();
    await getScriptHandler(pool, mockReq(TEST_USER_ID), r1);
    responses.push({ handler: 'getScript', data: r1.getData() });

    // startScript fine
    const r2 = mockRes();
    await startScriptHandler(pool, mockReq(TEST_USER_ID, { status: 'fine' }), r2);
    responses.push({ handler: 'startScript(fine)', data: r2.getData() });

    // startScript tired
    const r3 = mockRes();
    await startScriptHandler(pool, mockReq(TEST_USER_ID, { status: 'tired', cluster_key: 'headache' }), r3);
    responses.push({ handler: 'startScript(tired)', data: r3.getData() });

    // getSession
    const r4 = mockRes();
    await getSessionHandler(pool, mockReq(TEST_USER_ID), r4);
    responses.push({ handler: 'getSession', data: r4.getData() });

    // createClusters (already have them, will upsert)
    const r5 = mockRes();
    await createClustersHandler(pool, mockReq(TEST_USER_ID, { symptoms: ['ho'] }), r5);
    responses.push({ handler: 'createClusters', data: r5.getData() });

    // Error case
    const r6 = mockRes();
    await startScriptHandler(pool, mockReq(TEST_USER_ID, { status: 'bad' }), r6);
    responses.push({ handler: 'startScript(error)', data: r6.getData() });

    const allHaveOk = responses.every(r => {
      const hasOk = r.data && r.data.hasOwnProperty('ok') && typeof r.data.ok === 'boolean';
      if (!hasOk) console.log(`    >> ${r.handler} missing ok field:`, r.data);
      return hasOk;
    });
    assert(allHaveOk, `D10: all ${responses.length} responses have ok (boolean)`);
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
  console.log(`  ADVERSARIAL RESULTS: ${passed} passed, ${failed} failed, ${total} total`);
  console.log('==========================================================');

  if (failed > 0) {
    console.log('\n  Some tests FAILED -- review output above.');
  } else {
    console.log('\n  All adversarial tests PASSED.');
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  pool.end().then(() => process.exit(1));
});
