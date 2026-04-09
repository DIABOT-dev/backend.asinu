'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });
const NO_TOKEN = null;

let passed = 0;
let failed = 0;
const results = [];

function report(section, name, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  const line = `[${tag}] ${section} > ${name}  ${detail}`;
  results.push(line);
  console.log(line);
}

async function api(path, body = null, token = TOKEN) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch('http://localhost:3000/api/mobile' + path, opts);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

// ═══════════════════════════════════════════════════════════════
// A. RAPID FIRE — 10 starts in sequence
// ═══════════════════════════════════════════════════════════════

async function sectionA() {
  console.log('\n══════ A. RAPID FIRE — 10 sequential starts ══════');
  const symptoms = [
    'dau dau', 'chong mat', 'met moi', 'dau bung', 'ho',
    'sot', 'dau lung', 'buon non', 'kho tho', 'te tay',
  ];

  for (let i = 0; i < symptoms.length; i++) {
    const sym = symptoms[i];
    try {
      const r = await api('/checkin/script/start', {
        status: 'tired',
        symptom_input: sym,
      });
      const ok = r.status === 200 && r.body.session_id != null;
      report('A', `Rapid #${i + 1} "${sym}"`, ok,
        `status=${r.status} session_id=${r.body.session_id || 'NONE'}`);
    } catch (err) {
      report('A', `Rapid #${i + 1} "${sym}"`, false, `ERROR: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// B. CONCURRENT — 5 starts at same time via Promise.all
// ═══════════════════════════════════════════════════════════════

async function sectionB() {
  console.log('\n══════ B. CONCURRENT — 5 simultaneous starts ══════');
  const symptoms = ['dau dau', 'chong mat', 'met moi', 'dau bung', 'ho'];

  const promises = symptoms.map(sym =>
    api('/checkin/script/start', { status: 'tired', symptom_input: sym })
  );

  const responses = await Promise.all(promises);

  responses.forEach((r, i) => {
    const ok = r.status === 200 && r.body.session_id != null;
    report('B', `Concurrent #${i + 1} "${symptoms[i]}"`, ok,
      `status=${r.status} session_id=${r.body.session_id || 'NONE'}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// C. ANSWER EDGE CASES — 10 tests
// ═══════════════════════════════════════════════════════════════

async function sectionC() {
  console.log('\n══════ C. ANSWER EDGE CASES ══════');

  // Start one session to get a real session_id and question_id
  const startR = await api('/checkin/script/start', {
    status: 'tired',
    symptom_input: 'dau dau',
  });
  const sessionId = startR.body.session_id;
  const questionId = startR.body.question?.id || startR.body.question_id || null;
  console.log(`  (helper session: id=${sessionId}, first_question=${questionId})`);

  // C1: null body → 400
  {
    const r = await api('/checkin/script/answer', null);
    // null body means GET, which won't match POST route → likely 404
    // Actually with null body we send GET. Let's send POST with empty.
  }
  // Redo C1 properly: POST with empty object
  {
    const r = await api('/checkin/script/answer', {});
    const ok = r.status === 400;
    report('C', '1. Empty body → 400', ok,
      `status=${r.status} error=${r.body.error || 'none'}`);
  }

  // C2: missing session_id
  {
    const r = await api('/checkin/script/answer', { question_id: 'q1', answer: 'yes' });
    const ok = r.status === 400;
    report('C', '2. Missing session_id → 400', ok,
      `status=${r.status} error=${r.body.error || 'none'}`);
  }

  // C3: missing question_id
  {
    const r = await api('/checkin/script/answer', { session_id: sessionId, answer: 'yes' });
    const ok = r.status === 400;
    report('C', '3. Missing question_id → 400', ok,
      `status=${r.status} error=${r.body.error || 'none'}`);
  }

  // C4: session_id=999999 → 404
  {
    const r = await api('/checkin/script/answer', { session_id: 999999, question_id: 'q1', answer: 'yes' });
    const ok = r.status === 404;
    report('C', '4. session_id=999999 → 404', ok,
      `status=${r.status} error=${r.body.error || 'none'}`);
  }

  // C5: empty string answer → should not crash
  {
    const r = await api('/checkin/script/answer', {
      session_id: sessionId,
      question_id: questionId,
      answer: '',
    });
    const ok = r.status === 200;
    report('C', '5. Empty string answer → 200', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }

  // C6: very long string (2000 chars)
  {
    const longStr = 'A'.repeat(2000);
    // Start a fresh session for this
    const s = await api('/checkin/script/start', { status: 'tired', symptom_input: 'dau dau' });
    const sid = s.body.session_id;
    const qid = s.body.question?.id || s.body.question_id;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: longStr,
    });
    const ok = r.status === 200;
    report('C', '6. 2000-char answer → 200', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }

  // C7: answer with number 0
  {
    const s = await api('/checkin/script/start', { status: 'tired', symptom_input: 'met moi' });
    const sid = s.body.session_id;
    const qid = s.body.question?.id || s.body.question_id;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: 0,
    });
    const ok = r.status === 200;
    report('C', '7. Answer = 0 → 200', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }

  // C8: answer with boolean false
  {
    const s = await api('/checkin/script/start', { status: 'tired', symptom_input: 'sot' });
    const sid = s.body.session_id;
    const qid = s.body.question?.id || s.body.question_id;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: false,
    });
    const ok = r.status === 200;
    report('C', '8. Answer = false → 200', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }

  // C9: SQL injection
  {
    const s = await api('/checkin/script/start', { status: 'tired', symptom_input: 'ho' });
    const sid = s.body.session_id;
    const qid = s.body.question?.id || s.body.question_id;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: "'; DROP TABLE users;--",
    });
    const ok = r.status === 200;
    report('C', '9. SQL injection answer → 200 (no crash)', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }

  // C10: XSS
  {
    const s = await api('/checkin/script/start', { status: 'tired', symptom_input: 'dau lung' });
    const sid = s.body.session_id;
    const qid = s.body.question?.id || s.body.question_id;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: '<script>alert(1)</script>',
    });
    const ok = r.status === 200;
    report('C', '10. XSS answer → 200 (no crash)', ok,
      `status=${r.status} ok=${r.body.ok}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// D. SESSION STATE — 5 tests
// ═══════════════════════════════════════════════════════════════

async function sectionD() {
  console.log('\n══════ D. SESSION STATE ══════');

  // D1: Complete a session, then answer again → 400 "already completed"
  // Start a session and answer all questions until done
  const startR = await api('/checkin/script/start', {
    status: 'tired',
    symptom_input: 'dau dau',
  });
  let sid = startR.body.session_id;
  let qid = startR.body.question?.id || startR.body.question_id;
  let isDone = startR.body.isDone || false;

  // Answer questions until session is done (max 20 iterations safety)
  let iterations = 0;
  while (!isDone && qid && iterations < 20) {
    iterations++;
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: qid,
      answer: 'co',  // generic yes answer
    });
    isDone = r.body.isDone || false;
    qid = r.body.question?.id || r.body.question_id || null;
  }

  // Now try to answer again → should get 400
  {
    const r = await api('/checkin/script/answer', {
      session_id: sid,
      question_id: 'any_q',
      answer: 'test',
    });
    const ok = r.status === 400 && (r.body.error || '').toLowerCase().includes('completed');
    report('D', '1. Answer completed session → 400', ok,
      `status=${r.status} error="${r.body.error || 'none'}"`);
  }

  // D2: GET session → should show completed with severity
  {
    const r = await api('/checkin/script/session');
    const sess = r.body.session;
    const ok = r.status === 200 && r.body.has_session === true &&
               sess && sess.is_completed === true && sess.severity != null;
    report('D', '2. GET session → completed + severity', ok,
      `status=${r.status} completed=${sess?.is_completed} severity=${sess?.severity}`);
  }

  // D3: Start new session after completed → should create new one
  {
    const r = await api('/checkin/script/start', {
      status: 'tired',
      symptom_input: 'chong mat',
    });
    const ok = r.status === 200 && r.body.session_id != null && r.body.session_id !== sid;
    report('D', '3. New session after completed', ok,
      `status=${r.status} new_id=${r.body.session_id} old_id=${sid}`);
  }

  // D4: Start session with invalid status → 400
  {
    const r = await api('/checkin/script/start', {
      status: 'blah',
      symptom_input: 'dau dau',
    });
    const ok = r.status === 400;
    report('D', '4. Invalid status "blah" → 400', ok,
      `status=${r.status} error="${r.body.error || 'none'}"`);
  }

  // D5: Start session without auth token → 401
  {
    const r = await api('/checkin/script/start', {
      status: 'tired',
      symptom_input: 'dau dau',
    }, NO_TOKEN);
    const ok = r.status === 401;
    report('D', '5. No auth token → 401', ok,
      `status=${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('='.repeat(60));
  console.log('  30 RAPID-FIRE & EDGE CASE TESTS via REAL API');
  console.log('  Target: http://localhost:3000');
  console.log('  Token user_id: 4');
  console.log('='.repeat(60));

  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();

  console.log('\n' + '='.repeat(60));
  console.log(`  TOTAL: ${passed + failed} tests | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.startsWith('[FAIL]')).forEach(r => console.log('  ' + r));
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
