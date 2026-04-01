/**
 * Comprehensive test: "very_tired" flow for 68M with ALL branching combinations
 * Tests getNextTriageQuestion directly (bypasses auth/DB)
 */

require('dotenv').config({ path: __dirname + '/.env' });

const { getNextTriageQuestion } = require('./src/services/checkin/checkin.ai.service');

const PROFILE = {
  birth_year: 1958,
  gender: 'Nam',
  medical_conditions: ['Tiểu đường', 'Bệnh tim'],
  daily_medication: 'Có',
  full_name: 'Trần Văn Hùng',
};

const BASE = {
  status: 'very_tired',
  phase: 'initial',
  lang: 'vi',
  healthContext: {},
  pool: null,
  userId: null,
};

// ─── Helpers ──────────────────────────────────────────────────────
const ISSUES = [];

function issue(severity, branch, msg) {
  ISSUES.push({ severity, branch, msg });
  console.log(`  [${'!'.repeat(severity === 'CRITICAL' ? 3 : severity === 'HIGH' ? 2 : 1)}] ${severity}: ${msg}`);
}

function checkCommon(result, branch, stepLabel) {
  // Check no "bạn" leak
  for (const field of ['question', 'summary', 'recommendation', 'closeMessage']) {
    if (result[field] && typeof result[field] === 'string') {
      // "bạn" is OK only if part of another word, but standalone "bạn" is a leak
      const matches = result[field].match(/\bbạn\b/gi);
      if (matches) {
        issue('HIGH', branch, `${stepLabel} "${field}" contains "bạn" leak: "${result[field].substring(0, 80)}..."`);
      }
    }
  }
  // Check no em dash
  for (const field of ['question', 'summary', 'recommendation', 'closeMessage']) {
    if (result[field] && typeof result[field] === 'string' && result[field].includes('—')) {
      issue('MEDIUM', branch, `${stepLabel} "${field}" contains em dash "—": "${result[field].substring(0, 80)}..."`);
    }
  }
  // Check emoji in question
  if (!result.isDone && result.question) {
    const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/u.test(result.question);
    if (!hasEmoji) {
      issue('LOW', branch, `${stepLabel} question missing emoji: "${result.question.substring(0, 80)}..."`);
    }
  }
}

function logStep(stepNum, result) {
  if (result.isDone) {
    console.log(`  Step ${stepNum} [DONE]: severity=${result.severity}, hasRedFlag=${result.hasRedFlag}, needsFamilyAlert=${result.needsFamilyAlert}, needsDoctor=${result.needsDoctor}, followUpHours=${result.followUpHours}`);
    if (result.summary) console.log(`    summary: ${result.summary.substring(0, 100)}`);
    if (result.recommendation) console.log(`    recommendation: ${result.recommendation.substring(0, 120)}`);
  } else {
    console.log(`  Step ${stepNum} [Q]: "${result.question}"`);
    console.log(`    options: [${(result.options || []).join(', ')}] multiSelect=${result.multiSelect} allowFreeText=${result.allowFreeText || false}`);
  }
}

async function runFlow(branchName, answerSequence) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`BRANCH: ${branchName}`);
  console.log(`${'='.repeat(70)}`);

  const answers = [];
  let stepNum = 0;

  while (true) {
    stepNum++;
    if (stepNum > 12) {
      issue('CRITICAL', branchName, `Flow exceeded 12 steps — infinite loop?`);
      break;
    }

    const result = await getNextTriageQuestion({
      ...BASE,
      profile: PROFILE,
      previousAnswers: answers,
    });

    logStep(stepNum, result);
    checkCommon(result, branchName, `Step ${stepNum}`);

    if (result.isDone) {
      return { answers, result, stepCount: stepNum };
    }

    // Get the next answer from the sequence
    const nextAnswer = answerSequence[stepNum - 1];
    if (nextAnswer === undefined) {
      // No more scripted answers — auto-pick first option
      const autoAnswer = result.options ? result.options[0] : 'không rõ';
      console.log(`  >> AUTO answer: "${autoAnswer}"`);
      answers.push({ question: result.question, answer: autoAnswer });
    } else {
      console.log(`  >> Answer: "${nextAnswer}"`);
      answers.push({ question: result.question, answer: nextAnswer });
    }
  }
  return { answers, result: null, stepCount: stepNum };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('Starting comprehensive very_tired triage flow tests...\n');
  console.log('Profile: 68M, Tiểu đường + Bệnh tim, daily_medication=Có');
  console.log('Status: very_tired, Phase: initial, Lang: vi\n');

  // ══════════════════════════════════════════════════
  // BRANCH 1: Red flag in symptoms (Q1)
  // ══════════════════════════════════════════════════
  const b1 = await runFlow('1: Red flag in Q1 symptoms', [
    'mệt mỏi, tức ngực, khó thở', // Q1: symptoms include red flags
  ]);
  if (b1.result) {
    if (b1.result.severity !== 'high') issue('CRITICAL', 'B1', `severity should be "high", got "${b1.result.severity}"`);
    if (!b1.result.hasRedFlag) issue('CRITICAL', 'B1', `hasRedFlag should be true`);
    if (!b1.result.needsFamilyAlert) issue('CRITICAL', 'B1', `needsFamilyAlert should be true for 68yo with high severity`);
    if (!b1.result.needsDoctor) issue('CRITICAL', 'B1', `needsDoctor should be true`);
    if (b1.stepCount > 3) issue('HIGH', 'B1', `Red flag should fast-track conclusion but took ${b1.stepCount} steps`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 2a: No red flag in Q1 → Red flag Q → "đau ngực"
  // ══════════════════════════════════════════════════
  const b2a = await runFlow('2a: Q1 no red flag → Q2 red flag "đau ngực"', [
    'mệt mỏi, chóng mặt, buồn nôn',  // Q1: no red flags
    'đau ngực',                          // Q2: red flag
  ]);
  if (b2a.result) {
    if (b2a.result.severity !== 'high') issue('CRITICAL', 'B2a', `severity should be "high", got "${b2a.result.severity}"`);
    if (!b2a.result.hasRedFlag) issue('HIGH', 'B2a', `hasRedFlag should be true for "đau ngực"`);
    if (!b2a.result.needsFamilyAlert) issue('HIGH', 'B2a', `needsFamilyAlert should be true`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 2b: Q2 red flag "khó thở, vã mồ hôi"
  // ══════════════════════════════════════════════════
  const b2b = await runFlow('2b: Q1 no red flag → Q2 "khó thở, vã mồ hôi"', [
    'mệt mỏi, chóng mặt, buồn nôn',
    'khó thở, vã mồ hôi',
  ]);
  if (b2b.result) {
    if (b2b.result.severity !== 'high') issue('CRITICAL', 'B2b', `severity should be "high", got "${b2b.result.severity}"`);
    if (!b2b.result.hasRedFlag) issue('HIGH', 'B2b', `hasRedFlag should be true for "khó thở, vã mồ hôi"`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 2c: Q2 red flag "hoa mắt"
  // ══════════════════════════════════════════════════
  const b2c = await runFlow('2c: Q1 no red flag → Q2 "hoa mắt"', [
    'mệt mỏi, chóng mặt, buồn nôn',
    'hoa mắt',
  ]);
  if (b2c.result) {
    if (b2c.result.severity !== 'high') issue('CRITICAL', 'B2c', `severity should be "high", got "${b2c.result.severity}"`);
    if (!b2c.result.hasRedFlag) issue('HIGH', 'B2c', `hasRedFlag should be true for "hoa mắt"`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 2d: Q2 red flag "ngất"
  // ══════════════════════════════════════════════════
  const b2d = await runFlow('2d: Q1 no red flag → Q2 "ngất"', [
    'mệt mỏi, chóng mặt, buồn nôn',
    'ngất',
  ]);
  if (b2d.result) {
    if (b2d.result.severity !== 'high') issue('CRITICAL', 'B2d', `severity should be "high", got "${b2d.result.severity}"`);
    if (!b2d.result.hasRedFlag) issue('HIGH', 'B2d', `hasRedFlag should be true for "ngất"`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 2e: Q2 red flag "không có" → continue flow
  // ══════════════════════════════════════════════════
  const b2e = await runFlow('2e: Q1 no red flag → Q2 "không có" → continue', [
    'mệt mỏi, chóng mặt, buồn nôn',  // Q1
    'không có',                          // Q2: no red flags
    'trung bình',                        // Q3: severity
    'từ sáng',                           // Q4: onset
    'vẫn như cũ',                        // Q5: progression
    'ngủ ít',                            // Q6: cause
    'nghỉ ngơi',                         // Q7: action
  ]);
  if (b2e.result) {
    if (b2e.result.hasRedFlag) issue('HIGH', 'B2e', `hasRedFlag should be false when "không có" selected`);
    if (b2e.stepCount < 5) issue('MEDIUM', 'B2e', `Flow ended in only ${b2e.stepCount} steps (min 5 expected)`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 3a: No red flags → severity "trung bình"
  // ══════════════════════════════════════════════════
  const b3a = await runFlow('3a: No red flags → severity "trung bình" → full flow', [
    'mệt mỏi, chóng mặt',              // Q1
    'không có',                          // Q2: red flag
    'trung bình',                        // Q3: severity
    'từ sáng',                           // Q4: onset
    'vẫn như cũ',                        // Q5: progression
    'ngủ ít, bỏ bữa',                   // Q6: cause
    'nghỉ ngơi, uống nước',             // Q7: action
  ]);
  if (b3a.result) {
    // Check severity options when they appeared
    const severityStep = b3a.answers.findIndex(a => a.answer === 'trung bình');
    if (b3a.result.severity === 'low') {
      // medium is acceptable for "trung bình" answer
    }
  }

  // ══════════════════════════════════════════════════
  // BRANCH 3b: No red flags → severity "khá nặng"
  // ══════════════════════════════════════════════════
  const b3b = await runFlow('3b: No red flags → severity "khá nặng" → full flow', [
    'mệt mỏi, chóng mặt',
    'không có',
    'khá nặng',
    'từ hôm qua',
    'vẫn như cũ',
    'căng thẳng',
    'chưa làm gì',
  ]);

  // ══════════════════════════════════════════════════
  // BRANCH 3c: No red flags → severity "rất nặng" → force high
  // ══════════════════════════════════════════════════
  const b3c = await runFlow('3c: No red flags → severity "rất nặng" → must force high', [
    'mệt mỏi, chóng mặt',
    'không có',
    'rất nặng',
    'từ sáng',
    'có vẻ nặng hơn',
    'không rõ',
    'chưa làm gì',
  ]);
  if (b3c.result) {
    if (b3c.result.severity !== 'high') issue('CRITICAL', 'B3c', `"rất nặng" selected but severity="${b3c.result.severity}" instead of "high"`);
    if (!b3c.result.needsFamilyAlert) issue('HIGH', 'B3c', `needsFamilyAlert should be true for high severity + 68yo`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 4a: Progression "đang đỡ dần"
  // ══════════════════════════════════════════════════
  const b4a = await runFlow('4a: Progression "đang đỡ dần" → may conclude early', [
    'mệt mỏi, chóng mặt',
    'không có',
    'trung bình',
    'từ sáng',
    'đang đỡ dần',
    'ngủ ít',
    'nghỉ ngơi',
  ]);
  if (b4a.result) {
    // "đang đỡ" should potentially lower severity
    console.log(`  [CHECK] B4a final severity: ${b4a.result.severity} (acceptable: low or medium)`);
  }

  // ══════════════════════════════════════════════════
  // BRANCH 4b: Progression "vẫn như cũ" → continue
  // ══════════════════════════════════════════════════
  const b4b = await runFlow('4b: Progression "vẫn như cũ" → continue', [
    'mệt mỏi, chóng mặt',
    'không có',
    'trung bình',
    'từ sáng',
    'vẫn như cũ',
    'không rõ',
    'chưa làm gì',
  ]);

  // ══════════════════════════════════════════════════
  // BRANCH 4c: Progression "có vẻ nặng hơn" → escalate
  // ══════════════════════════════════════════════════
  const b4c = await runFlow('4c: Progression "có vẻ nặng hơn" → should escalate', [
    'mệt mỏi, chóng mặt',
    'không có',
    'khá nặng',
    'từ hôm qua',
    'có vẻ nặng hơn',
    'không rõ',
    'chưa làm gì',
  ]);
  if (b4c.result) {
    if (b4c.result.severity === 'low') issue('HIGH', 'B4c', `"có vẻ nặng hơn" but severity=low — should be medium or high`);
  }

  // ══════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY OF ALL ISSUES');
  console.log(`${'='.repeat(70)}`);

  if (ISSUES.length === 0) {
    console.log('No issues found! All branches passed.');
  } else {
    const criticals = ISSUES.filter(i => i.severity === 'CRITICAL');
    const highs = ISSUES.filter(i => i.severity === 'HIGH');
    const mediums = ISSUES.filter(i => i.severity === 'MEDIUM');
    const lows = ISSUES.filter(i => i.severity === 'LOW');

    console.log(`\nTotal: ${ISSUES.length} issues (${criticals.length} CRITICAL, ${highs.length} HIGH, ${mediums.length} MEDIUM, ${lows.length} LOW)\n`);

    for (const i of ISSUES) {
      console.log(`[${i.severity}] ${i.branch}: ${i.msg}`);
    }
  }

  // ══════════════════════════════════════════════════
  // SEVERITY OPTIONS CHECK (across all branches)
  // ══════════════════════════════════════════════════
  console.log(`\n${'='.repeat(70)}`);
  console.log('CROSS-BRANCH CHECKS');
  console.log(`${'='.repeat(70)}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Test script failed:', err);
  process.exit(1);
});
