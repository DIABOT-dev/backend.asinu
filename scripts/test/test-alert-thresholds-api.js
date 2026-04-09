#!/usr/bin/env node
/**
 * Alert Thresholds API Test
 *
 * 20 full sessions via REAL API (localhost:3000).
 * Validates needsDoctor + needsFamilyAlert thresholds.
 * NO function imports — only HTTP calls.
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });

async function api(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('http://localhost:3000/api/mobile' + path, opts);
  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resetSession() {
  await api('/checkin/reset-today', {});
}

/**
 * Run a full script session: start → answer all questions → return conclusion.
 * @param {string} symptomInput - e.g. "đau đầu"
 * @param {function} answerPicker - (question, index) => answer value
 * @returns {{ conclusion, answers, questions }}
 */
async function runFullSession(symptomInput, answerPicker) {
  await delay(600);
  await resetSession();

  // Start session
  const startRes = await api('/checkin/script/start', {
    status: 'tired',
    symptom_input: symptomInput,
  });

  if (!startRes.ok) throw new Error('Start failed: ' + JSON.stringify(startRes));
  if (startRes.is_emergency) return { conclusion: { needsDoctor: true, needsFamilyAlert: true, severity: 'critical', isEmergency: true }, answers: [], questions: [] };

  const sessionId = startRes.session_id;
  const questions = [];
  const answers = [];

  // First question comes from start response
  let currentQuestion = startRes.question;
  let isDone = startRes.isDone || false;
  let step = 0;

  while (!isDone && currentQuestion && step < 15) {
    const answer = answerPicker(currentQuestion, step);
    questions.push({ id: currentQuestion.id, text: currentQuestion.text, type: currentQuestion.type, options: currentQuestion.options });
    answers.push({ question_id: currentQuestion.id, answer });

    const answerRes = await api('/checkin/script/answer', {
      session_id: sessionId,
      question_id: currentQuestion.id,
      answer,
    });

    if (!answerRes.ok) throw new Error('Answer failed: ' + JSON.stringify(answerRes));

    if (answerRes.isDone) {
      isDone = true;
      return { conclusion: answerRes.conclusion, answers, questions };
    }

    if (answerRes.is_emergency) {
      return { conclusion: { needsDoctor: true, needsFamilyAlert: true, severity: 'critical', isEmergency: true }, answers, questions };
    }

    currentQuestion = answerRes.question;
    step++;
  }

  return { conclusion: null, answers, questions };
}

// ─── Answer picker helpers ──────────────────────────────────────────────────

function pickMildest(q) {
  if (q.type === 'slider') return 1;
  if (q.type === 'free_text') return 'không có gì';
  if (q.type === 'multi_choice') {
    // Pick "không có" if available, else first option
    const noOption = (q.options || []).find(o => o.includes('không có') || o.includes('không'));
    return noOption || (q.options || [])[0] || 'không';
  }
  if (q.type === 'single_choice') {
    // Pick first option (mildest)
    return (q.options || [])[0] || 'nhẹ';
  }
  return (q.options || [])[0] || 'không';
}

function pickMedium(q) {
  if (q.type === 'slider') return 5;
  if (q.type === 'free_text') return 'hơi khó chịu';
  const opts = q.options || [];
  if (q.type === 'multi_choice') {
    // Pick one non-danger option
    const safe = opts.find(o => !o.includes('không có') && !o.includes('mờ') && !o.includes('cứng') && !o.includes('tê'));
    return safe || opts[0] || 'vừa';
  }
  // single_choice: pick middle option
  const midIdx = Math.floor(opts.length / 2);
  return opts[midIdx] || opts[0] || 'trung bình';
}

function pickWorst(q) {
  if (q.type === 'slider') return 9;
  if (q.type === 'free_text') return 'rất nặng, đau dữ dội';
  const opts = q.options || [];
  if (q.type === 'multi_choice') {
    // Pick all danger options (exclude "không có")
    const selected = opts.filter(o => !o.includes('không có') && !o.includes('không'));
    return selected.length > 0 ? selected.join(', ') : opts[opts.length - 1] || 'nặng';
  }
  // single_choice: pick last option (most severe)
  return opts[opts.length - 1] || 'nặng';
}

// ─── Test definitions ─────────────────────────────────────────────────────────

const results = [];

function assert(testId, testName, field, expected, actual, extra = '') {
  const pass = actual === expected;
  results.push({ testId, testName, field, expected, actual, pass, extra });
  return pass;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  console.log('='.repeat(80));
  console.log('ALERT THRESHOLDS API TEST — 20 sessions via localhost:3000');
  console.log('='.repeat(80));
  console.log('');

  // Ensure user has clusters for all symptoms we'll test
  console.log('Setting up clusters for all test symptoms...');
  const clusterRes = await api('/checkin/script/clusters', {
    symptoms: ['đau đầu', 'đau bụng', 'chóng mặt', 'mệt mỏi', 'ho', 'sốt', 'đau ngực', 'khó thở', 'đau lưng'],
  });
  console.log(`  Clusters: ${clusterRes.ok ? clusterRes.clusters?.map(c => c.cluster_key).join(', ') : 'FAILED: ' + JSON.stringify(clusterRes)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // MUST NOT recommend doctor (tests 1-10)
  // ═══════════════════════════════════════════════════════════════════════════

  // Test 1: Headache, all mildest options
  try {
    console.log('Test 1: Headache, all mildest...');
    const r = await runFullSession('đau đầu', (q) => pickMildest(q));
    assert(1, 'Headache mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 1, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 2: Headache, mild + "không có" associated
  try {
    console.log('Test 2: Headache, mild + không có associated...');
    const r = await runFullSession('đau đầu', (q, i) => {
      if (q.type === 'multi_choice') return 'không có';
      return pickMildest(q);
    });
    assert(2, 'Headache mild+không có → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 2, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 3: Abdominal pain, mildest
  try {
    console.log('Test 3: Abdominal pain, mildest...');
    const r = await runFullSession('đau bụng', (q) => pickMildest(q));
    assert(3, 'Abdominal pain mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 3, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 4: Dizziness, mildest
  try {
    console.log('Test 4: Dizziness, mildest...');
    const r = await runFullSession('chóng mặt', (q) => pickMildest(q));
    assert(4, 'Dizziness mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 4, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 5: Fatigue, mildest
  try {
    console.log('Test 5: Fatigue, mildest...');
    const r = await runFullSession('mệt mỏi', (q) => pickMildest(q));
    assert(5, 'Fatigue mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 5, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 6: Cough, mildest
  try {
    console.log('Test 6: Cough, mildest...');
    const r = await runFullSession('ho', (q) => pickMildest(q));
    assert(6, 'Cough mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 6, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 7: Fever, mildest
  try {
    console.log('Test 7: Fever, mildest...');
    const r = await runFullSession('sốt', (q) => pickMildest(q));
    assert(7, 'Fever mildest → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 7, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 8: Headache, medium options
  try {
    console.log('Test 8: Headache, medium options...');
    const r = await runFullSession('đau đầu', (q, i) => {
      // For severity question (q4), pick "trung bình"
      if (q.type === 'single_choice' && q.options && q.options.some(o => o.includes('trung bình'))) {
        return q.options.find(o => o.includes('trung bình'));
      }
      if (q.type === 'multi_choice') return 'không có';
      return pickMedium(q);
    });
    assert(8, 'Headache medium → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 8, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 9: Dizziness, medium
  try {
    console.log('Test 9: Dizziness, medium...');
    const r = await runFullSession('chóng mặt', (q, i) => {
      if (q.type === 'multi_choice') return 'không có';
      return pickMedium(q);
    });
    assert(9, 'Dizziness medium → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 9, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 10: Any symptom, long text but mild free-text
  try {
    console.log('Test 10: Mild long text answer...');
    const r = await runFullSession('đau đầu', (q) => {
      if (q.type === 'free_text') return 'hơi hơi đau thôi không sao';
      if (q.type === 'multi_choice') return 'không có';
      return pickMildest(q);
    });
    assert(10, 'Mild long text → needsDoctor', 'needsDoctor', false, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 10, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOULD recommend doctor (tests 11-15)
  // ═══════════════════════════════════════════════════════════════════════════

  // Test 11: Headache with danger symptom "mờ mắt" selected
  try {
    console.log('Test 11: Headache + mờ mắt danger symptom...');
    const r = await runFullSession('đau đầu', (q) => {
      // For associated symptoms question, pick "mờ mắt"
      if (q.type === 'multi_choice' && q.options && q.options.some(o => o.includes('mờ mắt'))) {
        return 'mờ mắt';
      }
      // For severity, pick severe
      if (q.type === 'single_choice' && q.options && q.options.some(o => o.includes('nặng'))) {
        return q.options.find(o => o.includes('nặng'));
      }
      return pickMildest(q);
    });
    // This test checks if the system appropriately handles danger symptoms
    // needsDoctor should ideally be true, but we'll record what actually happens
    const doc = r.conclusion?.needsDoctor;
    const sev = r.conclusion?.severity;
    assert(11, 'Headache+mờ mắt → appropriate response', 'needsDoctor', true, doc,
      `severity=${sev} (expected high or at least medium with doctor recommendation)`);
    console.log(`  severity=${sev} needsDoctor=${doc}`);
  } catch (e) { results.push({ testId: 11, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 12: Headache with "nặng, phải nằm nghỉ" + danger
  try {
    console.log('Test 12: Headache severe + danger...');
    const r = await runFullSession('đau đầu', (q) => {
      // Pick worst for severity question
      if (q.type === 'single_choice' && q.options && q.options.some(o => o.includes('nặng'))) {
        return q.options.find(o => o.includes('nặng'));
      }
      // Pick danger symptoms
      if (q.type === 'multi_choice') {
        const dangerOpts = (q.options || []).filter(o => o.includes('mờ') || o.includes('cứng'));
        return dangerOpts.length > 0 ? dangerOpts.join(', ') : pickWorst(q);
      }
      return pickMildest(q);
    });
    assert(12, 'Headache severe+danger → needsDoctor', 'needsDoctor', true, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 12, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 13: Chest pain, worst options — pick "đau tức nặng" to trigger HIGH+needsDoctor
  try {
    console.log('Test 13: Chest pain, worst...');
    const r = await runFullSession('đau ngực', (q) => {
      if (q.type === 'single_choice' && q.options) {
        // Pick the option with "nặng" explicitly → triggers HIGH rule with needs_doctor=true
        const nang = q.options.find(o => o.includes('nặng'));
        if (nang) return nang;
        return q.options[q.options.length - 1];
      }
      if (q.type === 'multi_choice' && q.options) {
        // Pick danger options: khó thở, vã mồ hôi, etc.
        const selected = q.options.filter(o => !o.includes('không có') && !o.includes('không rõ'));
        return selected.length > 0 ? selected.join(', ') : pickWorst(q);
      }
      return pickWorst(q);
    });
    console.log(`  Q&A:`, r.questions.map((q,i) => `${q.id}(${q.type}): "${r.answers[i]?.answer}"`).join(' | '));
    assert(13, 'Chest pain worst → needsDoctor', 'needsDoctor', true, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity} matchedRule=${r.conclusion?.matchedRuleIndex}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 13, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 14: Dyspnea, worst options — pick "không nói được hết câu" (last option for severity)
  try {
    console.log('Test 14: Dyspnea, worst...');
    const r = await runFullSession('khó thở', (q) => {
      if (q.type === 'single_choice' && q.options) {
        // For dyspnea severity q: "không nói được hết câu" is the worst
        const worst = q.options.find(o => o.includes('không nói'));
        if (worst) return worst;
        return q.options[q.options.length - 1];
      }
      if (q.type === 'multi_choice' && q.options) {
        // Pick danger: đau ngực, sốt, etc.
        const selected = q.options.filter(o => !o.includes('không có') && !o.includes('không rõ'));
        return selected.length > 0 ? selected.join(', ') : pickWorst(q);
      }
      return pickWorst(q);
    });
    console.log(`  Q&A:`, r.questions.map((q,i) => `${q.id}(${q.type}): "${r.answers[i]?.answer}"`).join(' | '));
    assert(14, 'Dyspnea worst → needsDoctor', 'needsDoctor', true, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity} matchedRule=${r.conclusion?.matchedRuleIndex}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 14, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 15: Unknown symptom → fallback script (slider-based), worst slider → HIGH + needsDoctor
  try {
    console.log('Test 15: Unknown symptom (fallback), worst slider + "Nặng hơn"...');
    const r = await runFullSession('triệu chứng lạ', (q) => {
      if (q.type === 'slider') return 9;  // fb1 slider >= 7 → HIGH + needs_doctor=true
      if (q.type === 'single_choice' && q.options) {
        const worst = q.options.find(o => o.includes('Nặng hơn'));
        return worst || q.options[q.options.length - 1];
      }
      return pickWorst(q);
    });
    console.log(`  Q&A:`, r.questions.map((q,i) => `${q.id}(${q.type}): "${r.answers[i]?.answer}"`).join(' | '));
    assert(15, 'Fallback worst slider → needsDoctor', 'needsDoctor', true, r.conclusion?.needsDoctor,
      `severity=${r.conclusion?.severity} matchedRule=${r.conclusion?.matchedRuleIndex}`);
    console.log(`  severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
  } catch (e) { results.push({ testId: 15, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // ═══════════════════════════════════════════════════════════════════════════
  // MUST NOT alert family (tests 16-20)
  // ═══════════════════════════════════════════════════════════════════════════

  // Test 16: Any mild case → no family alert
  try {
    console.log('Test 16: Mild case → no family alert...');
    const r = await runFullSession('đau đầu', (q) => pickMildest(q));
    assert(16, 'Mild case → needsFamilyAlert', 'needsFamilyAlert', false, r.conclusion?.needsFamilyAlert,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsFamilyAlert=${r.conclusion?.needsFamilyAlert}`);
  } catch (e) { results.push({ testId: 16, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 17: Medium case → no family alert
  try {
    console.log('Test 17: Medium case → no family alert...');
    const r = await runFullSession('đau đầu', (q) => {
      if (q.type === 'multi_choice') return 'chóng mặt';  // non-danger associated
      return pickMedium(q);
    });
    assert(17, 'Medium case → needsFamilyAlert', 'needsFamilyAlert', false, r.conclusion?.needsFamilyAlert,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsFamilyAlert=${r.conclusion?.needsFamilyAlert}`);
  } catch (e) { results.push({ testId: 17, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 18: First-time HIGH → no family alert (chỉ báo khi đã HIGH + nặng thêm)
  try {
    console.log('Test 18: First-time HIGH → no family alert...');
    const r = await runFullSession('đau đầu', (q) => {
      // Force HIGH severity
      if (q.type === 'single_choice' && q.options && q.options.some(o => o.includes('nặng'))) {
        return q.options.find(o => o.includes('nặng'));
      }
      if (q.type === 'multi_choice') return 'không có';
      return pickMildest(q);
    });
    assert(18, 'First-time HIGH → needsFamilyAlert', 'needsFamilyAlert', false, r.conclusion?.needsFamilyAlert,
      `severity=${r.conclusion?.severity} needsDoctor=${r.conclusion?.needsDoctor}`);
    console.log(`  severity=${r.conclusion?.severity} needsFamilyAlert=${r.conclusion?.needsFamilyAlert}`);
  } catch (e) { results.push({ testId: 18, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 19: Headache severe first time → no family alert
  try {
    console.log('Test 19: Headache severe first time → no family alert...');
    const r = await runFullSession('đau đầu', (q) => {
      if (q.type === 'single_choice') {
        const worst = (q.options || []).find(o => o.includes('nặng'));
        return worst || q.options[q.options.length - 1];
      }
      if (q.type === 'multi_choice') return 'sốt';
      return pickWorst(q);
    });
    assert(19, 'Headache severe 1st time → needsFamilyAlert', 'needsFamilyAlert', false, r.conclusion?.needsFamilyAlert,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsFamilyAlert=${r.conclusion?.needsFamilyAlert}`);
  } catch (e) { results.push({ testId: 19, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // Test 20: Even "nặng lắm" answer → no family alert for first session
  try {
    console.log('Test 20: Worst answers first session → no family alert...');
    const r = await runFullSession('chóng mặt', (q) => pickWorst(q));
    assert(20, 'Worst answers 1st session → needsFamilyAlert', 'needsFamilyAlert', false, r.conclusion?.needsFamilyAlert,
      `severity=${r.conclusion?.severity}`);
    console.log(`  severity=${r.conclusion?.severity} needsFamilyAlert=${r.conclusion?.needsFamilyAlert}`);
  } catch (e) { results.push({ testId: 20, pass: false, extra: e.message }); console.error('  ERROR:', e.message); }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(80));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);

  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL';
    const detail = r.extra ? ` (${r.extra})` : '';
    console.log(`  [${icon}] Test ${r.testId}: ${r.testName || 'unknown'} — ${r.field}=${r.actual} (expected ${r.expected})${detail}`);
  }

  console.log('\n' + '-'.repeat(80));
  console.log(`TOTAL: ${passed.length} PASS / ${failed.length} FAIL / ${results.length} total`);
  console.log('-'.repeat(80));

  if (failed.length > 0) {
    console.log('\nFAILED TESTS:');
    for (const r of failed) {
      console.log(`  Test ${r.testId}: ${r.testName} — got ${r.field}=${r.actual}, expected ${r.expected} (${r.extra})`);
    }
  }

  // Cleanup
  await resetSession();

  process.exit(failed.length > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
