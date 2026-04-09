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

// ─── 10 New/Unknown Symptoms ──────────────────────────────────────────────────

const SYMPTOMS = [
  'đau hàm khi nhai',
  'ngứa vùng kín',
  'đau xương sườn',
  'mất vị giác',
  'đau cổ tay khi gõ máy tính',
  'sưng hạch cổ',
  'đau mắt khi nhìn sáng',
  'chảy máu nướu răng',
  'đau bắp chân khi đi bộ',
  'ù tai liên tục',
];

// ─── 3 Answer Styles ──────────────────────────────────────────────────────────

// For each question type, define how each style answers:
// Style A = mild (first option / slider low)
// Style B = severe (last option / slider high)
// Style C = free text (varied Vietnamese phrases)

const FREE_TEXT_MILD = [
  'nhẹ thôi', 'hơi hơi', 'tí xíu thôi', 'bình thường', 'ít lắm',
  'không nhiều', 'chút chút', 'nhẹ nhàng', 'cũng ổn', 'hơi thôi',
];
const FREE_TEXT_SEVERE = [
  'nặng lắm', 'đau chịu không nổi', 'dữ dội kinh khủng', 'rất nặng',
  'quá trời luôn', 'ghê lắm', 'không chịu nổi', 'kinh khủng',
  'đau lắm luôn', 'cực kỳ khó chịu',
];
const FREE_TEXT_MIXED = [
  'cũng khá đau', 'tàm tạm thôi', 'hơi nặng nặng', 'vừa vừa',
  'cũng hơi khó chịu', 'không nhẹ không nặng', 'khá nhiều', 'cũng nặng',
  'hơi nặng', 'khá đau',
];

function getAnswer(question, style, questionIndex) {
  const type = question.type;

  if (type === 'slider') {
    const min = question.min ?? 0;
    const max = question.max ?? 10;
    if (style === 'A') return min + 1;           // low
    if (style === 'B') return max - 1;            // high
    // Style C: free text for slider
    const phrases = FREE_TEXT_MIXED;
    return phrases[questionIndex % phrases.length];
  }

  if (type === 'single_choice' || type === 'multi_choice') {
    const opts = question.options || [];
    if (opts.length === 0) return 'không rõ';
    if (style === 'A') return opts[0];            // first option (mildest)
    if (style === 'B') return opts[opts.length - 1]; // last option (most severe)
    // Style C: free text descriptions
    if (style === 'C') {
      // Use severe free text for odd indices, mild for even — to get variety
      if (questionIndex % 3 === 0) return FREE_TEXT_SEVERE[questionIndex % FREE_TEXT_SEVERE.length];
      if (questionIndex % 3 === 1) return FREE_TEXT_MILD[questionIndex % FREE_TEXT_MILD.length];
      return FREE_TEXT_MIXED[questionIndex % FREE_TEXT_MIXED.length];
    }
    return opts[0];
  }

  if (type === 'free_text') {
    if (style === 'A') return FREE_TEXT_MILD[questionIndex % FREE_TEXT_MILD.length];
    if (style === 'B') return FREE_TEXT_SEVERE[questionIndex % FREE_TEXT_SEVERE.length];
    return FREE_TEXT_MIXED[questionIndex % FREE_TEXT_MIXED.length];
  }

  // Fallback
  return 'không rõ';
}

// ─── Severity numeric value for comparison ────────────────────────────────────

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function severityNum(s) {
  return SEVERITY_RANK[(s || '').toLowerCase()] || 0;
}

// ─── Run a single session ─────────────────────────────────────────────────────

async function runSession(symptom, style) {
  const startTime = Date.now();
  const log = [];

  // 1. Start session
  const startRes = await api('/checkin/script/start', {
    status: 'tired',
    symptom_input: symptom,
  });

  if (!startRes.ok && !startRes.session_id) {
    return {
      symptom, style,
      error: startRes.error || 'start failed',
      session_id: null,
      has_questions: false,
      completed: false,
      severity: null,
      summary: null,
      recommendation: null,
      questions_count: 0,
      answers: [],
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
    };
  }

  // Emergency shortcut
  if (startRes.is_emergency) {
    return {
      symptom, style,
      session_id: null,
      has_questions: false,
      completed: true,
      is_emergency: true,
      severity: 'critical',
      summary: startRes.emergency?.message || 'Emergency detected',
      recommendation: null,
      questions_count: 0,
      answers: [],
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
    };
  }

  const sessionId = startRes.session_id;
  let currentResult = startRes;
  const answers = [];
  let questionIdx = 0;
  const MAX_QUESTIONS = 20; // safety limit

  // 2. Answer loop
  while (!currentResult.isDone && currentResult.question && questionIdx < MAX_QUESTIONS) {
    const q = currentResult.question;
    const ans = getAnswer(q, style, questionIdx);

    log.push({ q_id: q.id, q_text: q.text?.substring(0, 60), q_type: q.type, answer: ans });
    answers.push({ question_id: q.id, answer: ans });

    currentResult = await api('/checkin/script/answer', {
      session_id: sessionId,
      question_id: q.id,
      answer: ans,
    });

    // Emergency mid-session
    if (currentResult.is_emergency) {
      return {
        symptom, style,
        session_id: sessionId,
        has_questions: true,
        completed: true,
        is_emergency: true,
        severity: 'critical',
        summary: currentResult.emergency?.message || 'Emergency mid-session',
        recommendation: null,
        questions_count: questionIdx + 1,
        answers,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
      };
    }

    questionIdx++;
  }

  // 3. Extract conclusion
  const conclusion = currentResult.conclusion || {};
  const isDone = currentResult.isDone === true;

  return {
    symptom, style,
    session_id: sessionId,
    has_questions: answers.length > 0,
    completed: isDone,
    is_emergency: false,
    severity: conclusion.severity || null,
    summary: conclusion.summary || null,
    recommendation: conclusion.recommendation || null,
    questions_count: answers.length,
    answers,
    elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(100));
  console.log('  TEST: 10 New Symptoms x 3 Answer Styles = 30 Sessions');
  console.log('  Styles: A=mild (first option/low slider)  B=severe (last option/high slider)  C=free text');
  console.log('='.repeat(100));
  console.log('');

  const allResults = [];
  let passed = 0;
  let failed = 0;

  for (let si = 0; si < SYMPTOMS.length; si++) {
    const symptom = SYMPTOMS[si];
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  Symptom ${si + 1}/10: "${symptom}"`);
    console.log(`${'─'.repeat(80)}`);

    const styleResults = {};

    for (const style of ['A', 'B', 'C']) {
      const label = style === 'A' ? 'MILD' : style === 'B' ? 'SEVERE' : 'FREE_TEXT';
      process.stdout.write(`  Style ${style} (${label.padEnd(9)}) ... `);

      try {
        const result = await runSession(symptom, style);
        styleResults[style] = result;
        allResults.push(result);

        // Verify
        const checks = [];
        const hasSession = result.session_id != null || result.is_emergency;
        const hasQuestions = result.has_questions || result.is_emergency;
        const isComplete = result.completed;
        const hasSeverity = result.severity != null;
        const hasSummary = result.summary != null && result.summary.length > 0;

        if (!hasSession) checks.push('NO_SESSION');
        if (!hasQuestions) checks.push('NO_QUESTIONS');
        if (!isComplete) checks.push('NOT_DONE');
        if (!hasSeverity) checks.push('NO_SEVERITY');
        if (!hasSummary) checks.push('NO_SUMMARY');

        const ok = hasSession && hasQuestions && isComplete && hasSeverity;
        if (ok) passed++; else failed++;

        const tag = ok ? 'PASS' : 'FAIL';
        console.log(
          `[${tag}] severity=${(result.severity || '-').padEnd(8)} ` +
          `questions=${result.questions_count} ` +
          `time=${result.elapsed}s` +
          (checks.length > 0 ? `  issues=[${checks.join(',')}]` : '')
        );

        if (result.error) {
          console.log(`         ERROR: ${result.error}`);
        }
      } catch (err) {
        console.log(`[FAIL] CRASH: ${err.message}`);
        failed++;
        allResults.push({
          symptom, style,
          error: err.message,
          session_id: null,
          has_questions: false,
          completed: false,
          severity: null,
          summary: null,
          recommendation: null,
          questions_count: 0,
          answers: [],
          elapsed: '-',
        });
      }
    }

    // Compare severity across styles for this symptom
    const sA = styleResults.A?.severity;
    const sB = styleResults.B?.severity;
    const sC = styleResults.C?.severity;

    const rankA = severityNum(sA);
    const rankB = severityNum(sB);

    const ordering = rankA <= rankB ? 'OK (mild <= severe)' : 'INVERTED (mild > severe)';
    console.log(`  >> Severity comparison: A(${sA || '-'})=${rankA} vs B(${sB || '-'})=${rankB} => ${ordering}`);
    console.log(`  >> Free text C severity: ${sC || '-'} (rank=${severityNum(sC)})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n' + '='.repeat(100));
  console.log('  SUMMARY');
  console.log('='.repeat(100));
  console.log(`  Total sessions: ${allResults.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  // ── Results Table ──
  console.log('\n' + '─'.repeat(100));
  console.log(
    '  # | Symptom                           | Style | Severity | Qs | Time   | Status'
  );
  console.log('─'.repeat(100));

  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    const symShort = (r.symptom || '').substring(0, 33).padEnd(33);
    const styleName = r.style === 'A' ? 'MILD ' : r.style === 'B' ? 'SEVER' : 'FREE ';
    const sev = (r.severity || '-').padEnd(8);
    const qs = String(r.questions_count).padStart(2);
    const time = String(r.elapsed).padStart(6) + 's';
    const status = r.completed ? (r.error ? 'ERR' : 'DONE') : 'INCOMPLETE';
    console.log(`  ${String(i + 1).padStart(2)} | ${symShort} | ${styleName} | ${sev} | ${qs} | ${time} | ${status}`);
  }

  // ── Severity Comparison Table ──
  console.log('\n' + '─'.repeat(100));
  console.log('  SEVERITY COMPARISON: Does answer style affect severity? (mild < severe expected)');
  console.log('─'.repeat(100));
  console.log(
    '  Symptom                            | A(mild)  | B(severe)| C(free)  | A<=B? | Makes Sense?'
  );
  console.log('─'.repeat(100));

  let orderingCorrect = 0;
  let orderingTotal = 0;

  for (let si = 0; si < SYMPTOMS.length; si++) {
    const symptom = SYMPTOMS[si];
    const rA = allResults.find(r => r.symptom === symptom && r.style === 'A');
    const rB = allResults.find(r => r.symptom === symptom && r.style === 'B');
    const rC = allResults.find(r => r.symptom === symptom && r.style === 'C');

    const sA = rA?.severity || '-';
    const sB = rB?.severity || '-';
    const sC = rC?.severity || '-';
    const rankA = severityNum(sA);
    const rankB = severityNum(sB);

    let orderCheck = '-';
    if (rankA > 0 && rankB > 0) {
      orderingTotal++;
      if (rankA <= rankB) {
        orderingCorrect++;
        orderCheck = 'YES';
      } else {
        orderCheck = 'NO (inverted!)';
      }
    }

    const symShort = symptom.substring(0, 36).padEnd(36);
    console.log(
      `  ${symShort} | ${sA.padEnd(8)} | ${sB.padEnd(8)} | ${sC.padEnd(8)} | ${String(rankA <= rankB).padEnd(5)} | ${orderCheck}`
    );
  }

  console.log('─'.repeat(100));
  console.log(`  Severity ordering correct: ${orderingCorrect}/${orderingTotal} symptoms have A(mild) <= B(severe)`);

  // ── Timing Stats ──
  const times = allResults.map(r => parseFloat(r.elapsed) || 0).filter(t => t > 0);
  if (times.length > 0) {
    console.log('\n  TIMING:');
    console.log(`    Min: ${Math.min(...times).toFixed(1)}s`);
    console.log(`    Max: ${Math.max(...times).toFixed(1)}s`);
    console.log(`    Avg: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}s`);
    console.log(`    Total: ${times.reduce((a, b) => a + b, 0).toFixed(1)}s`);
  }

  // ── Failures ──
  const failures = allResults.filter(r => !r.completed || r.error);
  if (failures.length > 0) {
    console.log('\n  FAILURES:');
    for (const f of failures) {
      console.log(`    "${f.symptom}" style=${f.style}: ${f.error || 'incomplete'}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log(`  FINAL: ${passed} PASS / ${failed} FAIL out of ${allResults.length} sessions`);
  console.log('='.repeat(100));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
