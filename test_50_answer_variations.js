'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });

async function api(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch('http://localhost:3000/api/mobile' + path, opts);
  return resp.json();
}

// ─── 5 Clusters ───────────────────────────────────────────────────────────────
const CLUSTERS = [
  { key: 'headache',       symptom: 'đau đầu' },
  { key: 'abdominal_pain', symptom: 'đau bụng' },
  { key: 'dizziness',      symptom: 'chóng mặt' },
  { key: 'fatigue',        symptom: 'mệt mỏi' },
  { key: 'chest_pain',     symptom: 'đau ngực' },
];

// ─── 10 Answer Strategies ─────────────────────────────────────────────────────
const STRATEGIES = [
  'first',       // always pick first option
  'last',        // always pick last option
  'middle',      // pick middle option
  'random',      // pick random option
  'mild_text',   // type mild free text
  'severe_text', // type severe free text
  'no_diac',     // type without diacritics
  'slang',       // type with slang
  'mixed',       // first 2 questions = option, last = free text
  'reverse',     // first 2 questions = free text, last = options
];

const MILD_TEXTS = ['nhẹ thôi', 'hơi hơi', 'không sao', 'bình thường', 'chút xíu'];
const SEVERE_TEXTS = ['nặng lắm', 'dữ dội', 'kinh khủng', 'đau quá trời', 'không chịu nổi'];
const NO_DIAC_TEXTS = ['nhe thoi', 'hoi hoi', 'khong sao', 'binh thuong', 'chut xiu'];
const SLANG_TEXTS = ['mệt vãi', 'đau quá xá', 'ối giời ơi', 'hết hồn luôn', 'chịu ko nổi'];

/**
 * Pick an answer for a question based on strategy.
 * @param {object} question - { id, text, type, options, min, max }
 * @param {string} strategy - one of STRATEGIES
 * @param {number} questionIndex - 0-based index in the session
 * @param {number} totalQuestions - total questions in session
 */
function pickAnswer(question, strategy, questionIndex, totalQuestions) {
  const opts = question.options || [];
  const hasOptions = opts.length > 0;
  const isSlider = question.type === 'slider';

  // Helper: pick option value
  function optionValue(index) {
    if (!hasOptions) return 'có';
    const opt = opts[Math.min(index, opts.length - 1)];
    return typeof opt === 'object' ? (opt.value ?? opt.label ?? opt.text ?? String(index)) : opt;
  }

  function firstOption() {
    if (isSlider) return question.min ?? 1;
    return optionValue(0);
  }
  function lastOption() {
    if (isSlider) return question.max ?? 10;
    return optionValue(opts.length - 1);
  }
  function middleOption() {
    if (isSlider) return Math.round(((question.min ?? 1) + (question.max ?? 10)) / 2);
    return optionValue(Math.floor(opts.length / 2));
  }
  function randomOption() {
    if (isSlider) {
      const min = question.min ?? 1;
      const max = question.max ?? 10;
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    return optionValue(Math.floor(Math.random() * Math.max(opts.length, 1)));
  }

  function mildText() {
    return MILD_TEXTS[questionIndex % MILD_TEXTS.length];
  }
  function severeText() {
    return SEVERE_TEXTS[questionIndex % SEVERE_TEXTS.length];
  }
  function noDiacText() {
    return NO_DIAC_TEXTS[questionIndex % NO_DIAC_TEXTS.length];
  }
  function slangText() {
    return SLANG_TEXTS[questionIndex % SLANG_TEXTS.length];
  }

  switch (strategy) {
    case 'first':       return firstOption();
    case 'last':        return lastOption();
    case 'middle':      return middleOption();
    case 'random':      return randomOption();
    case 'mild_text':   return mildText();
    case 'severe_text': return severeText();
    case 'no_diac':     return noDiacText();
    case 'slang':       return slangText();
    case 'mixed':
      // first 2 questions use option, rest use free text
      return questionIndex < 2 ? firstOption() : mildText();
    case 'reverse':
      // first 2 questions use free text, rest use option
      return questionIndex < 2 ? severeText() : lastOption();
    default:
      return firstOption();
  }
}

// ─── Run a single session ─────────────────────────────────────────────────────

async function runSession(cluster, strategy) {
  const startTime = Date.now();
  const record = {
    cluster: cluster.key,
    strategy,
    answers: [],
    severity: null,
    needsDoctor: null,
    needsFamilyAlert: null,
    summary: null,
    isDone: false,
    error: null,
    steps: 0,
    timeMs: 0,
  };

  try {
    // 1. Start session
    const startRes = await api('/checkin/script/start', {
      status: 'tired',
      symptom_input: cluster.symptom,
    });

    if (!startRes.ok || !startRes.session_id) {
      // Could be emergency or error
      if (startRes.is_emergency) {
        record.error = 'EMERGENCY_DETECTED';
        record.timeMs = Date.now() - startTime;
        return record;
      }
      record.error = `START_FAILED: ${JSON.stringify(startRes).substring(0, 200)}`;
      record.timeMs = Date.now() - startTime;
      return record;
    }

    const sessionId = startRes.session_id;
    let currentQuestion = startRes.question;
    let isDone = startRes.isDone || false;
    let questionIndex = 0;
    const MAX_STEPS = 20; // safety limit

    // 2. Answer loop
    while (!isDone && currentQuestion && questionIndex < MAX_STEPS) {
      const answer = pickAnswer(currentQuestion, strategy, questionIndex, MAX_STEPS);
      record.answers.push({
        question_id: currentQuestion.id,
        question_type: currentQuestion.type,
        answer,
      });

      const ansRes = await api('/checkin/script/answer', {
        session_id: sessionId,
        question_id: currentQuestion.id,
        answer,
      });

      if (!ansRes.ok) {
        record.error = `ANSWER_FAILED step=${questionIndex}: ${ansRes.error || JSON.stringify(ansRes).substring(0, 200)}`;
        break;
      }

      isDone = ansRes.isDone || false;
      currentQuestion = ansRes.question || null;
      questionIndex++;

      if (isDone && ansRes.conclusion) {
        record.severity = ansRes.conclusion.severity;
        record.needsDoctor = ansRes.conclusion.needsDoctor;
        record.needsFamilyAlert = ansRes.conclusion.needsFamilyAlert;
        record.summary = ansRes.conclusion.summary;
      }
    }

    record.isDone = isDone;
    record.steps = questionIndex;

    // If done but no conclusion in last answer, check session
    if (isDone && !record.severity) {
      const sessRes = await api('/checkin/script/session');
      if (sessRes.ok && sessRes.session) {
        record.severity = sessRes.session.severity;
        record.summary = sessRes.session.conclusion_summary;
        record.needsDoctor = sessRes.session.needs_doctor;
      }
    }
  } catch (err) {
    record.error = `CRASH: ${err.message}`;
  }

  record.timeMs = Date.now() - startTime;
  return record;
}

// ─── Severity ordering helper ─────────────────────────────────────────────────

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
function sevLevel(s) {
  if (!s) return -1;
  return SEVERITY_ORDER[s.toLowerCase()] ?? -1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('  50 ANSWER VARIATION TESTS — 5 clusters x 10 strategies');
  console.log('  Target: http://localhost:3000');
  console.log('  Token user_id: 4');
  console.log('='.repeat(70));

  const allResults = [];
  let testNum = 0;

  for (const cluster of CLUSTERS) {
    console.log(`\n══ Cluster: ${cluster.key} (${cluster.symptom}) ══`);
    for (const strategy of STRATEGIES) {
      testNum++;
      const label = `[${String(testNum).padStart(2)}/50]`;
      process.stdout.write(`  ${label} ${strategy.padEnd(12)} ... `);
      const result = await runSession(cluster, strategy);
      allResults.push(result);

      const status = result.isDone ? 'DONE' : (result.error ? 'ERR' : 'INCOMPLETE');
      const sevStr = result.severity || '-';
      console.log(`${status} | severity=${sevStr} | steps=${result.steps} | ${result.timeMs}ms${result.error ? ' | ' + result.error : ''}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log('  VERIFICATION');
  console.log('='.repeat(70));

  let passed = 0;
  let failed = 0;
  function check(name, condition, detail) {
    if (condition) { passed++; console.log(`  [PASS] ${name}  ${detail}`); }
    else           { failed++; console.log(`  [FAIL] ${name}  ${detail}`); }
  }

  // V1: All 50 sessions complete (isDone=true)
  const doneCount = allResults.filter(r => r.isDone).length;
  check('V1: All 50 sessions isDone=true',
    doneCount === 50,
    `${doneCount}/50 done`);

  // V2: All have severity + summary
  const withSeverity = allResults.filter(r => r.severity != null);
  const withSummary = allResults.filter(r => r.summary != null && r.summary.length > 0);
  check('V2a: All have severity',
    withSeverity.length === 50,
    `${withSeverity.length}/50 have severity`);
  check('V2b: All have summary',
    withSummary.length === 50,
    `${withSummary.length}/50 have summary`);

  // V3: 'first'/'mild_text' → lower severity than 'last'/'severe_text'
  // Compare within each cluster
  let mildVsSeverePass = 0;
  let mildVsSevereTotal = 0;
  for (const cluster of CLUSTERS) {
    const clusterResults = allResults.filter(r => r.cluster === cluster.key);
    const firstSev = clusterResults.find(r => r.strategy === 'first')?.severity;
    const lastSev = clusterResults.find(r => r.strategy === 'last')?.severity;
    const mildSev = clusterResults.find(r => r.strategy === 'mild_text')?.severity;
    const severeSev = clusterResults.find(r => r.strategy === 'severe_text')?.severity;

    if (firstSev && lastSev) {
      mildVsSevereTotal++;
      if (sevLevel(firstSev) <= sevLevel(lastSev)) mildVsSeverePass++;
      else console.log(`    (!) ${cluster.key}: first(${firstSev}) > last(${lastSev})`);
    }
    if (mildSev && severeSev) {
      mildVsSevereTotal++;
      if (sevLevel(mildSev) <= sevLevel(severeSev)) mildVsSeverePass++;
      else console.log(`    (!) ${cluster.key}: mild_text(${mildSev}) > severe_text(${severeSev})`);
    }
  }
  check('V3: first/mild ≤ last/severe severity',
    mildVsSeverePass === mildVsSevereTotal,
    `${mildVsSeverePass}/${mildVsSevereTotal} comparisons hold`);

  // V4: needsFamilyAlert=false for all
  const alertCount = allResults.filter(r => r.needsFamilyAlert === true).length;
  check('V4: needsFamilyAlert=false for all',
    alertCount === 0,
    `${alertCount} sessions triggered family alert`);

  // V5: Free text sessions produce valid results (no crash)
  const freeTextStrategies = ['mild_text', 'severe_text', 'no_diac', 'slang', 'mixed', 'reverse'];
  const freeTextResults = allResults.filter(r => freeTextStrategies.includes(r.strategy));
  const freeTextErrors = freeTextResults.filter(r => r.error && r.error.startsWith('CRASH'));
  check('V5: Free text sessions no crashes',
    freeTextErrors.length === 0,
    `${freeTextErrors.length} crashes out of ${freeTextResults.length} free-text sessions`);

  // V6: No errors at all
  const errorResults = allResults.filter(r => r.error != null);
  check('V6: No errors in any session',
    errorResults.length === 0,
    `${errorResults.length} errors`);

  // ═══════════════════════════════════════════════════════════════
  // RESULTS TABLE: cluster × strategy → severity
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log('  RESULTS TABLE: cluster x strategy → severity');
  console.log('='.repeat(70));

  // Header
  const stratColWidth = 12;
  const header = ''.padEnd(16) + STRATEGIES.map(s => s.padEnd(stratColWidth)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const cluster of CLUSTERS) {
    const clusterResults = allResults.filter(r => r.cluster === cluster.key);
    let row = cluster.key.padEnd(16);
    for (const strategy of STRATEGIES) {
      const r = clusterResults.find(r => r.strategy === strategy);
      const sev = r?.severity || 'ERR';
      const tag = sev.toUpperCase();
      row += tag.padEnd(stratColWidth);
    }
    console.log(row);
  }

  // ═══════════════════════════════════════════════════════════════
  // SEVERITY DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log('  SEVERITY DISTRIBUTION');
  console.log('='.repeat(70));

  const sevCounts = {};
  for (const r of allResults) {
    const s = (r.severity || 'UNKNOWN').toUpperCase();
    sevCounts[s] = (sevCounts[s] || 0) + 1;
  }
  for (const [sev, count] of Object.entries(sevCounts).sort()) {
    const bar = '█'.repeat(count);
    console.log(`  ${sev.padEnd(10)} ${String(count).padStart(3)}  ${bar}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // COMBINATION DETAIL — which combos produce LOW/MEDIUM/HIGH
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log('  COMBINATIONS BY SEVERITY LEVEL');
  console.log('='.repeat(70));

  const bySev = {};
  for (const r of allResults) {
    const s = (r.severity || 'UNKNOWN').toUpperCase();
    if (!bySev[s]) bySev[s] = [];
    bySev[s].push(`${r.cluster}/${r.strategy}`);
  }
  for (const [sev, combos] of Object.entries(bySev).sort()) {
    console.log(`\n  ${sev}:`);
    for (const c of combos) {
      console.log(`    - ${c}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TIMING
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log('  TIMING');
  console.log('='.repeat(70));
  const times = allResults.map(r => r.timeMs);
  console.log(`  Min:   ${Math.min(...times)}ms`);
  console.log(`  Max:   ${Math.max(...times)}ms`);
  console.log(`  Avg:   ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`);
  console.log(`  Total: ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);

  // ═══════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(70));
  console.log(`  FINAL: ${passed + failed} checks | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('='.repeat(70));

  if (failed > 0) {
    console.log('\n  *** SOME CHECKS FAILED — review output above ***');
    process.exit(1);
  } else {
    console.log('\n  ALL CHECKS PASSED');
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
