/**
 * Test script: Run full triage flows for 4 profiles via getNextTriageQuestion directly.
 * Usage: node test-triage-flow.js
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { getNextTriageQuestion } = require('./src/services/checkin/checkin.ai.service');

// ── Profile definitions ──
const profiles = {
  A: {
    label: '68M diabetes+heart',
    profile: { birth_year: 1958, gender: 'Nam', medical_conditions: ['Tiểu đường', 'Bệnh tim'], daily_medication: 'Có', full_name: 'Trần Văn Hùng' },
    answers: [
      'mệt mỏi, khát nước',   // Q1 symptoms
      'từ sáng',               // Q2 onset
      'vẫn như cũ',            // Q3 progression
      'quên thuốc',            // Q4 cause
      'uống nước',             // Q5 action
    ],
  },
  B: {
    label: '22M healthy',
    profile: { birth_year: 2004, gender: 'Nam', medical_conditions: [], full_name: 'Nguyễn Minh Tuấn' },
    answers: [
      'mệt mỏi, đau đầu',
      'vài giờ trước',
      'đang đỡ dần',
      'ngủ ít',
    ],
  },
  C: {
    label: '45F hypertension',
    profile: { birth_year: 1981, gender: 'Nữ', medical_conditions: ['Cao huyết áp'], full_name: 'Lê Thị Hương' },
    answers: [
      'đau đầu, chóng mặt',
      'từ sáng',
      'vẫn như cũ',
      'căng thẳng',
    ],
  },
  D: {
    label: '65F diabetes+hypertension',
    profile: { birth_year: 1961, gender: 'Nữ', medical_conditions: ['Tiểu đường', 'Cao huyết áp'], full_name: 'Nguyễn Thị Mai' },
    answers: [
      'mệt mỏi, chóng mặt',
      'từ hôm qua',
      'vẫn như cũ',
      'bỏ bữa',
    ],
  },
};

async function runFlow(key, cfg) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`PROFILE ${key}: ${cfg.label}`);
  console.log(`${'='.repeat(80)}`);

  const previousAnswers = [];
  let step = 0;
  let finalResult = null;

  while (step < 10) { // safety limit
    const answerForThisStep = cfg.answers[step] || null;

    const result = await getNextTriageQuestion({
      status: 'tired',
      phase: 'initial',
      lang: 'vi',
      profile: cfg.profile,
      healthContext: {},
      previousAnswers: [...previousAnswers],
      previousSessionSummary: null,
      previousTriageMessages: [],
      pool: null,
      userId: null,
    });

    step++;
    console.log(`\n--- Step ${step} ---`);
    console.log(JSON.stringify(result, null, 2));

    if (result.isDone) {
      finalResult = result;
      break;
    }

    // Build answer
    const answer = answerForThisStep || (result.options ? result.options[0] : 'không rõ');
    previousAnswers.push({ question: result.question, answer });
    console.log(`  >> User answers: "${answer}"`);
  }

  return { key, label: cfg.label, steps: step, previousAnswers, finalResult, profile: cfg.profile };
}

// ── Validation checks ──
function validate(flowResult) {
  const { key, finalResult, previousAnswers, profile } = flowResult;
  const r = finalResult;
  const allText = JSON.stringify(finalResult) + ' ' + previousAnswers.map(a => a.question).join(' ');

  const age = new Date().getFullYear() - profile.birth_year;
  const isMale = profile.gender === 'Nam';
  const conditions = profile.medical_conditions || [];

  // Expected honorifics
  const expectedHon = { A: 'chú', B: 'bạn', C: 'chị', D: 'cô' };
  const expectedSelf = { A: 'cháu', B: 'mình', C: 'em', D: 'cháu' };

  const checks = {};

  // 1. Honorifics
  const hon = expectedHon[key];
  const questions = previousAnswers.map(a => a.question).join(' ') + ' ' + (r?.recommendation || '') + ' ' + (r?.closeMessage || '');
  checks['1_honorifics'] = questions.toLowerCase().includes(hon) ? 'PASS' : `FAIL (expected "${hon}" in questions/recommendation)`;

  // 2. No "bạn" leak for A/C/D
  if (key !== 'B') {
    const hasBan = /\bbạn\b/i.test(questions);
    checks['2_no_ban_leak'] = hasBan ? 'FAIL (found "bạn")' : 'PASS';
  } else {
    checks['2_no_ban_leak'] = 'N/A (Profile B uses "bạn")';
  }

  // 3. Emoji in questions, no em-dash
  const allQuestions = previousAnswers.map(a => a.question).join(' ');
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/u.test(allQuestions);
  const hasEmDash = allQuestions.includes('—');
  const emojiOk = hasEmoji ? 'PASS' : 'FAIL (no emoji found)';
  const dashOk = hasEmDash ? 'FAIL (found "—" em-dash)' : 'PASS';
  checks['3_emoji_no_dash'] = `emoji: ${emojiOk}, dash: ${dashOk}`;

  // 4. Severity appropriate
  if (r) {
    const sev = r.severity;
    if (key === 'A') {
      // Diabetes + forgot meds + tired → should be at least medium
      checks['4_severity'] = ['medium', 'high'].includes(sev) ? `PASS (${sev})` : `FAIL (${sev}, expected medium+)`;
    } else if (key === 'B') {
      // Young healthy, getting better → should be low or medium
      checks['4_severity'] = ['low', 'medium'].includes(sev) ? `PASS (${sev})` : `FAIL (${sev}, expected low/medium)`;
    } else if (key === 'C') {
      // Hypertension + headache/dizziness → medium or high
      checks['4_severity'] = ['medium', 'high'].includes(sev) ? `PASS (${sev})` : `FAIL (${sev}, expected medium+)`;
    } else if (key === 'D') {
      // Diabetes+hypertension + dizzy → medium or high
      checks['4_severity'] = ['medium', 'high'].includes(sev) ? `PASS (${sev})` : `FAIL (${sev}, expected medium+)`;
    }
  } else {
    checks['4_severity'] = 'FAIL (no final result)';
  }

  // 5. needsDoctor
  if (r) {
    if (key === 'A') {
      checks['5_needsDoctor'] = r.needsDoctor === true ? 'PASS' : `FAIL (expected true for diabetes+quên thuốc, got ${r.needsDoctor})`;
    } else if (key === 'B') {
      checks['5_needsDoctor'] = r.needsDoctor === false ? 'PASS' : `FAIL (expected false for healthy young, got ${r.needsDoctor})`;
    } else {
      // C and D: depends on severity
      checks['5_needsDoctor'] = `INFO (needsDoctor=${r.needsDoctor}, severity=${r.severity})`;
    }
  } else {
    checks['5_needsDoctor'] = 'FAIL (no final result)';
  }

  // 6. needsFamilyAlert
  if (r) {
    if (key === 'A') {
      // 68 year old with diabetes + forgot meds → should alert family
      checks['6_needsFamilyAlert'] = r.needsFamilyAlert === true ? 'PASS' : `FAIL (expected true for elderly+diabetes+quên thuốc, got ${r.needsFamilyAlert})`;
    } else if (key === 'B') {
      checks['6_needsFamilyAlert'] = r.needsFamilyAlert === false ? 'PASS' : `FAIL (expected false, got ${r.needsFamilyAlert})`;
    } else {
      checks['6_needsFamilyAlert'] = `INFO (needsFamilyAlert=${r.needsFamilyAlert})`;
    }
  } else {
    checks['6_needsFamilyAlert'] = 'FAIL (no final result)';
  }

  // 7. Recommendation mentions bệnh nền
  if (r && conditions.length > 0) {
    const rec = (r.recommendation || '').toLowerCase();
    const mentionsBenhNen = conditions.some(c => rec.includes(c.toLowerCase())) ||
      rec.includes('bệnh nền') || rec.includes('đường huyết') || rec.includes('huyết áp') ||
      rec.includes('thuốc') || rec.includes('đường') || rec.includes('tim');
    checks['7_rec_benh_nen'] = mentionsBenhNen ? 'PASS' : `FAIL (recommendation doesn't mention conditions: "${r.recommendation}")`;
  } else if (r && conditions.length === 0) {
    checks['7_rec_benh_nen'] = 'N/A (no conditions)';
  } else {
    checks['7_rec_benh_nen'] = 'FAIL (no final result)';
  }

  // 8. followUpHours: if severity=high → must be ≤2h
  if (r) {
    if (r.severity === 'high') {
      checks['8_followUpHours'] = r.followUpHours <= 2 ? `PASS (${r.followUpHours}h)` : `FAIL (${r.followUpHours}h, expected ≤2 for high severity)`;
    } else {
      checks['8_followUpHours'] = `PASS (${r.followUpHours}h, severity=${r.severity})`;
    }
  } else {
    checks['8_followUpHours'] = 'FAIL (no final result)';
  }

  // 9. No TYPE repetition (check question similarity)
  const questionTexts = previousAnswers.map(a => a.question.toLowerCase());
  const typeMap = new Map();
  for (const q of questionTexts) {
    let type = 'unknown';
    if (q.includes('triệu chứng') || q.includes('gặp phải') || q.includes('đang bị')) type = 'TYPE3';
    else if (q.includes('bắt đầu') || q.includes('từ khi') || q.includes('từ lúc') || q.includes('bao lâu')) type = 'TYPE4';
    else if (q.includes('thay đổi') || q.includes('đỡ hơn') || q.includes('diễn tiến') || q.includes('vẫn vậy') || q.includes('nặng hơn')) type = 'TYPE5';
    else if (q.includes('nguyên nhân') || q.includes('dẫn đến') || q.includes('gần đây')) type = 'TYPE7';
    else if (q.includes('đã làm') || q.includes('cải thiện') || q.includes('nghỉ ngơi') || q.includes('uống thuốc gì chưa')) type = 'TYPE8';
    else if (q.includes('mức độ') || q.includes('khó chịu') || q.includes('nặng thế nào')) type = 'TYPE2';
    else if (q.includes('hay bị') || q.includes('thường xuyên') || q.includes('lần đầu')) type = 'TYPE10';
    else if (q.includes('thuốc')) type = 'TYPE11';

    if (type !== 'unknown') {
      typeMap.set(type, (typeMap.get(type) || 0) + 1);
    }
  }
  const repeatedTypes = [...typeMap.entries()].filter(([_, count]) => count > 1);
  checks['9_no_type_repeat'] = repeatedTypes.length === 0 ? 'PASS' : `FAIL (repeated: ${repeatedTypes.map(([t, c]) => `${t}x${c}`).join(', ')})`;

  // 10. multiSelect correct (spot check: onset/progression should be false, symptoms/cause should be true)
  // We can't fully check this without storing multiSelect from each step, but we note it
  checks['10_multiSelect'] = 'MANUAL CHECK (see step output above)';

  return checks;
}

async function main() {
  const results = [];

  for (const [key, cfg] of Object.entries(profiles)) {
    try {
      const flowResult = await runFlow(key, cfg);
      results.push(flowResult);
    } catch (err) {
      console.error(`\nERROR in profile ${key}:`, err.message);
      results.push({ key, label: cfg.label, steps: 0, previousAnswers: [], finalResult: null, profile: cfg.profile });
    }
  }

  // ── Validation report ──
  console.log(`\n\n${'#'.repeat(80)}`);
  console.log('VALIDATION REPORT');
  console.log(`${'#'.repeat(80)}`);

  let totalPass = 0;
  let totalChecks = 0;

  for (const flowResult of results) {
    const checks = validate(flowResult);
    console.log(`\n--- PROFILE ${flowResult.key}: ${flowResult.label} (${flowResult.steps} steps) ---`);
    if (flowResult.finalResult) {
      console.log(`  Final: severity=${flowResult.finalResult.severity}, needsDoctor=${flowResult.finalResult.needsDoctor}, needsFamilyAlert=${flowResult.finalResult.needsFamilyAlert}, followUpHours=${flowResult.finalResult.followUpHours}`);
    }
    for (const [check, result] of Object.entries(checks)) {
      const icon = result.startsWith('PASS') ? '✅' : result.startsWith('FAIL') ? '❌' : 'ℹ️';
      console.log(`  ${icon} ${check}: ${result}`);
      if (!result.startsWith('N/A') && !result.startsWith('INFO') && !result.startsWith('MANUAL')) {
        totalChecks++;
        if (result.startsWith('PASS')) totalPass++;
      }
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`FINAL SCORE: ${totalPass}/${totalChecks} (of ${totalChecks} scored checks)`);
  console.log(`${'='.repeat(80)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
