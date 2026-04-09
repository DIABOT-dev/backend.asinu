'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });

let passed = 0;
let failed = 0;
const results = [];
const completedPaths = [];
const inconsistencies = [];

function report(section, name, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  const line = `[${tag}] ${section} > ${name}  ${detail}`;
  results.push(line);
  console.log(line);
}

async function api(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch('http://localhost:3000/api/mobile' + path, opts);
  return resp.json();
}

// Start a fresh session for headache cluster
async function startSession() {
  return api('/checkin/script/start', { status: 'tired', cluster_key: 'headache' });
}

// Answer a question in a session
async function answer(sessionId, questionId, answerValue) {
  return api('/checkin/script/answer', { session_id: sessionId, question_id: questionId, answer: answerValue });
}

// Run a complete path through the headache script
// answerChoices is an array of answer values, one per question
// Returns the final conclusion or null on error
async function runCompletePath(answerChoices, label) {
  const start = await startSession();
  if (!start.ok || !start.session_id) {
    console.log(`  [ERROR] Failed to start session for path: ${label}`);
    return null;
  }

  const sessionId = start.session_id;
  let currentQuestion = start.question;
  let currentStep = start.currentStep;
  let totalSteps = start.totalSteps;
  const answersGiven = [];

  for (let i = 0; i < answerChoices.length; i++) {
    if (!currentQuestion) {
      console.log(`  [ERROR] No question at step ${i} for path: ${label}`);
      return null;
    }

    const chosenAnswer = answerChoices[i];
    answersGiven.push({ qId: currentQuestion.id, answer: chosenAnswer, text: currentQuestion.text });

    const resp = await answer(sessionId, currentQuestion.id, chosenAnswer);
    if (!resp.ok) {
      console.log(`  [ERROR] Answer failed at step ${i} for path: ${label}: ${JSON.stringify(resp)}`);
      return null;
    }

    // Emergency detection triggered by free text
    if (resp.is_emergency) {
      return {
        answers: answersGiven,
        conclusion: {
          severity: 'critical',
          needsDoctor: true,
          needsFamilyAlert: true,
          summary: `EMERGENCY: ${resp.emergency?.type || 'unknown'} detected`,
        },
        isDone: true,
        isEmergency: true,
        emergencyType: resp.emergency?.type,
        totalSteps,
      };
    }

    if (resp.isDone) {
      return {
        answers: answersGiven,
        conclusion: resp.conclusion,
        isDone: resp.isDone,
        totalSteps,
      };
    }

    currentQuestion = resp.question;
    currentStep = resp.currentStep;
  }

  // If we get here, we ran out of answer choices but aren't done
  console.log(`  [WARN] Ran out of answer choices for path: ${label}, still at step ${currentStep}/${totalSteps}`);
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SECTION A: Discover the headache script structure
// ═══════════════════════════════════════════════════════════════
async function discoverStructure() {
  console.log('\n══════ DISCOVERING HEADACHE SCRIPT STRUCTURE ══════');

  const start = await startSession();
  if (!start.ok) {
    console.log('FATAL: Cannot start headache session:', JSON.stringify(start));
    process.exit(1);
  }

  console.log(`Session started: id=${start.session_id}, cluster=${start.cluster_key}`);
  console.log(`First question: ${start.question?.id} - "${start.question?.text}"`);
  console.log(`  Type: ${start.question?.type}`);
  console.log(`  Options: ${JSON.stringify(start.question?.options?.map(o => o.value || o.label || o))}`);
  console.log(`  Steps: ${start.currentStep + 1}/${start.totalSteps}`);

  const questions = [{ ...start.question, step: start.currentStep }];
  const sessionId = start.session_id;

  // Walk through with first option each time to discover all questions
  let q = start.question;
  for (let step = 0; step < start.totalSteps && q; step++) {
    const firstOption = q.options ? (q.options[0].value ?? q.options[0].label ?? q.options[0]) : 1;
    const resp = await answer(sessionId, q.id, firstOption);

    if (resp.isDone) {
      console.log(`\nScript complete after ${step + 1} questions`);
      console.log(`Conclusion: severity=${resp.conclusion?.severity}, needsDoctor=${resp.conclusion?.needsDoctor}`);
      break;
    }

    q = resp.question;
    if (q) {
      questions.push({ ...q, step: resp.currentStep });
      console.log(`\nQ${resp.currentStep + 1}: ${q.id} - "${q.text}"`);
      console.log(`  Type: ${q.type}`);
      if (q.options) {
        console.log(`  Options: ${JSON.stringify(q.options.map(o => o.value || o.label || o))}`);
      }
      if (q.min !== undefined) {
        console.log(`  Range: ${q.min}-${q.max}`);
      }
    }
  }

  return questions;
}

// ═══════════════════════════════════════════════════════════════
// SECTION B: Test ALL options for each question level
// ═══════════════════════════════════════════════════════════════
async function testAllOptionsPerLevel(questions) {
  console.log('\n\n══════ B. TEST ALL OPTIONS PER LEVEL ══════');

  // For each question, we test every option while using first-option defaults for other questions
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    const options = q.options
      ? q.options.map(o => o.value ?? o.label ?? o)
      : (q.type === 'slider' ? Array.from({ length: q.max - q.min + 1 }, (_, i) => q.min + i) : ['test']);

    console.log(`\n── Q${qIdx + 1} (${q.id}): Testing ${options.length} options ──`);

    for (const opt of options) {
      // Build answer array: first option for everything before this Q, chosen opt for this Q, first option after
      const answerChoices = [];
      for (let i = 0; i < questions.length; i++) {
        if (i === qIdx) {
          answerChoices.push(opt);
        } else {
          const qi = questions[i];
          const firstOpt = qi.options
            ? (qi.options[0].value ?? qi.options[0].label ?? qi.options[0])
            : (qi.type === 'slider' ? qi.min : 'test');
          answerChoices.push(firstOpt);
        }
      }

      const label = `Q${qIdx + 1}=${opt}`;
      const result = await runCompletePath(answerChoices, label);

      if (result) {
        const c = result.conclusion;
        const ok = result.isDone && c && c.severity && c.summary;
        report('B-AllOpts', label, ok,
          `severity=${c?.severity} needsDoctor=${c?.needsDoctor} needsFamilyAlert=${c?.needsFamilyAlert}`);

        // Verify needsFamilyAlert=false for first-time
        if (c?.needsFamilyAlert === true) {
          inconsistencies.push(`${label}: needsFamilyAlert=true on first session`);
        }

        completedPaths.push({
          label,
          answers: answerChoices,
          severity: c?.severity,
          needsDoctor: c?.needsDoctor,
          needsFamilyAlert: c?.needsFamilyAlert,
          summary: c?.summary?.substring(0, 80),
        });
      } else {
        report('B-AllOpts', label, false, 'Path did not complete');
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION C: 10 RANDOM complete paths
// ═══════════════════════════════════════════════════════════════
async function testRandomPaths(questions) {
  console.log('\n\n══════ C. 10 RANDOM COMPLETE PATHS ══════');

  for (let r = 0; r < 10; r++) {
    const answerChoices = [];
    const choiceLabels = [];

    for (const q of questions) {
      let chosen;
      if (q.options) {
        const opts = q.options.map(o => o.value ?? o.label ?? o);
        chosen = opts[Math.floor(Math.random() * opts.length)];
      } else if (q.type === 'slider') {
        chosen = q.min + Math.floor(Math.random() * (q.max - q.min + 1));
      } else {
        chosen = 'random text';
      }
      answerChoices.push(chosen);
      choiceLabels.push(`${q.id}=${chosen}`);
    }

    const label = `Random#${r + 1}: [${choiceLabels.join(', ')}]`;
    const result = await runCompletePath(answerChoices, label);

    if (result) {
      const c = result.conclusion;
      const ok = result.isDone && c && c.severity && c.summary;
      report('C-Random', `Path#${r + 1}`, ok,
        `severity=${c?.severity} needsDoctor=${c?.needsDoctor} answers=[${answerChoices.join(',')}]`);

      if (c?.needsFamilyAlert === true) {
        inconsistencies.push(`Random#${r + 1}: needsFamilyAlert=true on first session`);
      }

      completedPaths.push({
        label: `Random#${r + 1}`,
        answers: answerChoices,
        severity: c?.severity,
        needsDoctor: c?.needsDoctor,
        needsFamilyAlert: c?.needsFamilyAlert,
        summary: c?.summary?.substring(0, 80),
      });
    } else {
      report('C-Random', `Path#${r + 1}`, false, 'Path did not complete');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION D: FREE TEXT answers
// ═══════════════════════════════════════════════════════════════
async function testFreeText(questions) {
  console.log('\n\n══════ D. FREE TEXT ANSWERS ══════');

  const freeTextSets = [
    ['dau 1 ben',   'nhuc am i suot ngay',  'buon non chong mat',    'nhe thoi van di lam'],
    ['dau ca dau',  'nhoi tung con',        'nhin mo mo',            'kha nang kho tap trung'],
    ['nhuc sau gay','nhu ai bop dau',       'cung co sot',           'nang lam nam liet'],
    ['dau vung tran','dau theo nhip tim dap','khong co gi them',     'nhe thoi van di lam'],
    ['dau quanh mat','nhuc am i suot ngay',  'cung co sot',          'nang lam nam liet'],
  ];

  // Also test with Vietnamese diacritics
  const freeTextVietnamese = [
    ['đau 1 bên',     'nhức âm ỉ suốt ngày',    'buồn nôn chóng mặt',  'nhẹ thôi vẫn đi làm'],
    ['đau cả đầu',    'nhói từng cơn',            'nhìn mờ mờ',          'khá nặng khó tập trung'],
    ['nhức sau gáy',  'như ai bóp đầu',           'cứng cổ sốt',         'nặng lắm nằm liệt'],
    ['đau vùng trán', 'đau theo nhịp tim đập',    'không có gì thêm',    'nhẹ thôi vẫn đi làm'],
    ['đau quanh mắt', 'nhức âm ỉ suốt ngày',     'cứng cổ sốt',         'nặng lắm nằm liệt'],
  ];

  const allSets = [...freeTextSets, ...freeTextVietnamese];

  for (let i = 0; i < allSets.length; i++) {
    const texts = allSets[i];
    // Trim to match question count
    const answerChoices = texts.slice(0, questions.length);
    const label = `FreeText#${i + 1}: [${answerChoices.join(' | ')}]`;

    const result = await runCompletePath(answerChoices, label);

    if (result) {
      const c = result.conclusion;
      const ok = result.isDone && c && c.severity && c.summary;
      const emergencyTag = result.isEmergency ? ` [EMERGENCY:${result.emergencyType}]` : '';
      report('D-FreeText', `Set#${i + 1}`, ok,
        `severity=${c?.severity} needsDoctor=${c?.needsDoctor}${emergencyTag} summary="${c?.summary?.substring(0, 60)}"`);

      // Emergency paths legitimately have needsFamilyAlert=true
      if (c?.needsFamilyAlert === true && !result.isEmergency) {
        inconsistencies.push(`FreeText#${i + 1}: needsFamilyAlert=true on first session (non-emergency)`);
      }

      completedPaths.push({
        label: `FreeText#${i + 1}`,
        answers: answerChoices,
        severity: c?.severity,
        needsDoctor: c?.needsDoctor,
        needsFamilyAlert: c?.needsFamilyAlert,
        summary: c?.summary?.substring(0, 80),
        isEmergency: result.isEmergency || false,
      });
    } else {
      report('D-FreeText', `Set#${i + 1}`, false, 'Path did not complete');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION E: Severity consistency checks
// ═══════════════════════════════════════════════════════════════
function checkSeverityConsistency() {
  console.log('\n\n══════ E. SEVERITY CONSISTENCY CHECKS ══════');

  const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

  // Find paths with "mild" answers vs "severe" answers
  const mildPaths = completedPaths.filter(p => {
    const answers = p.answers.map(a => String(a).toLowerCase());
    return answers.some(a =>
      a.includes('nhe') || a.includes('nhẹ') || a.includes('it') || a.includes('ít')
      || a === '1' || a === '2' || a.includes('khong') || a.includes('không')
    );
  });

  const severePaths = completedPaths.filter(p => {
    const answers = p.answers.map(a => String(a).toLowerCase());
    return answers.some(a =>
      a.includes('nang') || a.includes('nặng') || a.includes('du doi') || a.includes('dữ dội')
      || a === '9' || a === '10' || a.includes('liet') || a.includes('liệt')
    );
  });

  if (mildPaths.length > 0 && severePaths.length > 0) {
    const avgMild = mildPaths.reduce((s, p) => s + (SEVERITY_ORDER[p.severity] || 0), 0) / mildPaths.length;
    const avgSevere = severePaths.reduce((s, p) => s + (SEVERITY_ORDER[p.severity] || 0), 0) / severePaths.length;

    const ok = avgSevere >= avgMild;
    report('E-Consistency', 'Mild avg vs Severe avg', ok,
      `mild_avg=${avgMild.toFixed(2)} severe_avg=${avgSevere.toFixed(2)} (${mildPaths.length} mild, ${severePaths.length} severe paths)`);

    if (!ok) {
      inconsistencies.push(`Severity inconsistency: mild avg (${avgMild.toFixed(2)}) > severe avg (${avgSevere.toFixed(2)})`);
    }
  } else {
    console.log(`  Skipped: ${mildPaths.length} mild paths, ${severePaths.length} severe paths found`);
  }

  // Check needsDoctor only for high/critical
  for (const p of completedPaths) {
    if (p.needsDoctor && p.severity === 'low') {
      inconsistencies.push(`${p.label}: needsDoctor=true but severity=low`);
      report('E-Consistency', `${p.label} doctor+low`, false, 'needsDoctor=true with severity=low');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  HEADACHE CLUSTER - BRANCHING PATH EXPLORER          ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // A: Discover structure
  const questions = await discoverStructure();

  if (questions.length === 0) {
    console.log('FATAL: No questions discovered');
    process.exit(1);
  }

  // B: Test all options per level
  await testAllOptionsPerLevel(questions);

  // C: Random paths
  await testRandomPaths(questions);

  // D: Free text
  await testFreeText(questions);

  // E: Consistency
  checkSeverityConsistency();

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY TABLE
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('           COMPLETED PATHS SUMMARY TABLE');
  console.log('══════════════════════════════════════════════════════');
  console.log(`${'#'.padEnd(4)} ${'Label'.padEnd(30)} ${'Severity'.padEnd(10)} ${'Doctor'.padEnd(8)} ${'FamAlert'.padEnd(10)} ${'Emerg'.padEnd(7)} Answers`);
  console.log('─'.repeat(120));

  for (let i = 0; i < completedPaths.length; i++) {
    const p = completedPaths[i];
    console.log(
      `${String(i + 1).padEnd(4)} ` +
      `${p.label.substring(0, 29).padEnd(30)} ` +
      `${(p.severity || '??').padEnd(10)} ` +
      `${String(p.needsDoctor ?? '??').padEnd(8)} ` +
      `${String(p.needsFamilyAlert ?? '??').padEnd(10)} ` +
      `${String(p.isEmergency ? 'YES' : '-').padEnd(7)} ` +
      `[${p.answers.map(a => String(a).substring(0, 15)).join(', ')}]`
    );
  }

  // Severity distribution
  console.log('\n── Severity Distribution ──');
  const dist = {};
  for (const p of completedPaths) {
    dist[p.severity] = (dist[p.severity] || 0) + 1;
  }
  for (const [sev, count] of Object.entries(dist).sort()) {
    const bar = '█'.repeat(count);
    console.log(`  ${sev.padEnd(10)} ${String(count).padEnd(4)} ${bar}`);
  }

  // Inconsistencies
  if (inconsistencies.length > 0) {
    console.log('\n── INCONSISTENCIES FOUND ──');
    for (const inc of inconsistencies) {
      console.log(`  ⚠ ${inc}`);
    }
  } else {
    console.log('\n── No inconsistencies found ──');
  }

  // Final tally
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`TOTAL PATHS TESTED: ${completedPaths.length}`);
  console.log(`PASSED: ${passed}  |  FAILED: ${failed}  |  TOTAL CHECKS: ${passed + failed}`);
  console.log('══════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
