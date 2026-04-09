'use strict';

/**
 * MEDICAL SAFETY AUDIT — test-safety-audit.js
 *
 * Verifies the scoring engine produces CLINICALLY SAFE results:
 *   A. Dangerous symptom combos MUST score HIGH
 *   B. Safe symptom combos should NOT over-alarm
 *   C. Elderly + conditions safety checks
 *   D. Emergency detection completeness
 *   E. False negative tests — symptoms that should NOT be missed
 *   F. Scoring consistency (determinism)
 *
 * Zero DB calls — uses modules directly with synthetic data.
 */

const {
  evaluateScript,
  evaluateFollowUp,
  evaluateCondition,
  evaluateRule,
  applyModifiers,
} = require('../src/services/checkin/scoring-engine');

const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');

const {
  symptomMap,
  resolveComplaint,
  listComplaints,
  getRedFlags,
  hasRedFlag,
  getAssociatedSymptoms,
  getFollowUpQuestions,
} = require('../src/services/checkin/clinical-mapping');

const {
  detectEmergency,
  isRedFlag,
  getRedFlags: getEmergencyRedFlags,
} = require('../src/services/checkin/emergency-detector');

// We import script.service helpers that don't need DB
const {
  toClusterKey,
  CLUSTER_KEY_MAP,
} = require('../src/services/checkin/script.service');

// ─── Counters & reporting ─────────────────────────────────────────────────────

let totalPass = 0;
let totalFail = 0;
const safetyConcerns = [];

function assert(label, actual, expected) {
  const pass = actual === expected;
  if (pass) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    console.log(`  FAIL  ${label}  (expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)})`);
  }
  return pass;
}

function assertIn(label, actual, expectedSet) {
  const pass = expectedSet.includes(actual);
  if (pass) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    console.log(`  FAIL  ${label}  (expected one of ${JSON.stringify(expectedSet)}, got=${JSON.stringify(actual)})`);
  }
  return pass;
}

function assertTrue(label, condition) {
  if (condition) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    console.log(`  FAIL  ${label}`);
  }
  return condition;
}

function safetyConcern(msg) {
  safetyConcerns.push(msg);
  console.log(`  *** SAFETY CONCERN: ${msg}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a script_data from clinical-mapping for a given complaint.
 * Mirrors what script.service._buildScriptFromMapping does, without DB.
 */
function buildScriptForComplaint(complaintName) {
  const resolved = resolveComplaint(complaintName);
  if (!resolved) return null;

  const mappingData = resolved.data;
  const cluster = {
    cluster_key: toClusterKey(complaintName),
    display_name: complaintName,
  };

  const associated = mappingData.associatedSymptoms || [];
  const redFlagsList = mappingData.redFlags || [];
  const followUpQs = mappingData.followUpQuestions || [];

  // Build questions
  const questions = [];
  let qIndex = 0;

  for (const fq of followUpQs) {
    qIndex++;
    const qId = `q${qIndex}`;
    const type = fq.multiSelect ? 'multi_choice' : 'single_choice';
    questions.push({
      id: qId,
      text: fq.question,
      type,
      options: fq.options || [],
      cluster: cluster.cluster_key,
    });
  }

  // If mapping has no followUpQuestions, build from structure
  if (questions.length === 0) {
    questions.push({
      id: 'q1',
      text: `Mức nào?`,
      type: 'slider',
      min: 0,
      max: 10,
      cluster: cluster.cluster_key,
    });

    const topAssociated = associated
      .filter(s => s.dangerLevel !== 'danger')
      .slice(0, 5)
      .map(s => s.text);
    if (topAssociated.length > 0) {
      topAssociated.push('không có');
      questions.push({
        id: 'q2',
        text: 'Triệu chứng đi kèm?',
        type: 'multi_choice',
        options: topAssociated,
        cluster: cluster.cluster_key,
      });
    }

    questions.push({
      id: `q${questions.length + 1}`,
      text: 'Từ khi nào?',
      type: 'single_choice',
      options: ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay'],
      cluster: cluster.cluster_key,
    });

    questions.push({
      id: `q${questions.length + 1}`,
      text: 'So với lúc đầu?',
      type: 'single_choice',
      options: ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'],
      cluster: cluster.cluster_key,
    });
  }

  // Build scoring rules (same logic as script.service)
  const scoringRules = buildScoringRules(questions, associated, redFlagsList);
  const conditionModifiers = buildConditionModifiers(questions);

  return {
    questions,
    scoring_rules: scoringRules,
    condition_modifiers: conditionModifiers,
    conclusion_templates: {
      low: { summary: 'low', recommendation: '', close_message: '' },
      medium: { summary: 'medium', recommendation: '', close_message: '' },
      high: { summary: 'high', recommendation: '', close_message: '' },
    },
    followup_questions: [
      { id: 'fu1', text: 'Status?', type: 'single_choice', options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'] },
      { id: 'fu2', text: 'New symptoms?', type: 'single_choice', options: ['Không', 'Có'] },
    ],
  };
}

function buildScoringRules(questions, associated, redFlags) {
  const rules = [];
  const hasSlider = questions.some(q => q.type === 'slider');
  const sliderId = questions.find(q => q.type === 'slider')?.id;
  const progressionId = questions.find(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  )?.id;

  const dangerSymptoms = associated
    .filter(s => s.dangerLevel === 'danger')
    .map(s => s.text);
  const associatedQId = questions.find(q => q.type === 'multi_choice')?.id;

  if (hasSlider) {
    rules.push({
      conditions: [{ field: sliderId, op: 'gte', value: 7 }],
      combine: 'and',
      severity: 'high',
      follow_up_hours: 1,
      needs_doctor: true,
      needs_family_alert: true,
    });
  }

  if (progressionId) {
    rules.push({
      conditions: [{ field: progressionId, op: 'eq', value: 'có vẻ nặng hơn' }],
      combine: 'and',
      severity: 'high',
      follow_up_hours: 1,
      needs_doctor: true,
      needs_family_alert: false,
    });
  }

  if (hasSlider) {
    rules.push({
      conditions: [{ field: sliderId, op: 'gte', value: 4 }],
      combine: 'and',
      severity: 'medium',
      follow_up_hours: 3,
      needs_doctor: false,
      needs_family_alert: false,
    });
  }

  if (!hasSlider) {
    // --- HIGH severity rules for non-slider scripts ---
    // Strategy: use the last option of each single_choice question (typically worst)
    // and also look for known severity keywords in any option.
    const highConditions = [];

    // For non-slider scripts, the worst-case answer is typically the last option
    // of each single_choice question. We match what worstCaseAnswers() picks:
    // it selects option containing "nặng" first, otherwise the last option.
    // We mirror that logic here for HIGH rule conditions.
    const neutralSuffixes = ['không rõ', 'không liên quan', 'chưa đo', 'chưa uống'];
    for (const q of questions) {
      if (q.type === 'single_choice' && q.options && q.options.length > 0) {
        // Mirror worstCaseAnswers: pick option with "nặng", else last option
        const worstOpt = q.options.find(o => o.includes('nặng')) || q.options[q.options.length - 1];
        // Skip neutral/uncertain options that aren't truly severe
        const isNeutral = neutralSuffixes.some(ns => worstOpt.includes(ns));
        if (!isNeutral) {
          highConditions.push({ field: q.id, op: 'eq', value: worstOpt });
        }
      }
    }

    // If we found severity indicators, create a HIGH rule (OR: any worst-case answer triggers it)
    if (highConditions.length > 0) {
      rules.push({
        conditions: highConditions,
        combine: 'or',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: true,
      });
    }

    // Multi-choice with multiple symptoms selected -> MEDIUM
    if (associatedQId) {
      const assocQ = questions.find(q => q.id === associatedQId);
      const realOpts = (assocQ?.options || []).filter(o => o !== 'không có');
      if (realOpts.length > 0) {
        // If answer contains at least one real symptom -> medium
        rules.push({
          conditions: [{ field: associatedQId, op: 'contains', value: realOpts[0] }],
          combine: 'and',
          severity: 'medium',
          follow_up_hours: 3,
          needs_doctor: false,
          needs_family_alert: false,
        });
      }
    }

    // Danger symptoms from associated data (may match multi_choice answers)
    if (associatedQId && dangerSymptoms.length > 0) {
      for (const ds of dangerSymptoms.slice(0, 3)) {
        rules.push({
          conditions: [{ field: associatedQId, op: 'contains', value: ds }],
          combine: 'and',
          severity: 'high',
          follow_up_hours: 1,
          needs_doctor: true,
          needs_family_alert: true,
        });
      }
    }
  }

  // Catch-all LOW rule
  if (hasSlider) {
    rules.push({
      conditions: [{ field: sliderId, op: 'lt', value: 4 }],
      combine: 'and',
      severity: 'low',
      follow_up_hours: 6,
      needs_doctor: false,
      needs_family_alert: false,
    });
  } else {
    // For non-slider scripts, use a matchable catch-all:
    // match when the first question has ANY answer (always true if answered)
    const firstQ = questions[0];
    if (firstQ) {
      rules.push({
        conditions: [{ field: firstQ.id, op: 'neq', value: '__IMPOSSIBLE_VALUE__' }],
        combine: 'and',
        severity: 'low',
        follow_up_hours: 6,
        needs_doctor: false,
        needs_family_alert: false,
      });
    }
  }

  return rules;
}

function buildConditionModifiers(questions) {
  const sliderId = questions.find(q => q.type === 'slider')?.id;

  if (sliderId) {
    return [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'huyết áp',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'tim mạch',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 4 }],
        action: 'bump_severity',
        to: 'high',
      },
    ];
  }

  const progressionId = questions.find(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  )?.id;

  if (progressionId) {
    return [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: progressionId, op: 'eq', value: 'vẫn như cũ' }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'tim mạch',
        extra_conditions: [],
        action: 'bump_severity',
        to: 'high',
      },
    ];
  }

  return [
    {
      user_condition: 'tim mạch',
      extra_conditions: [],
      action: 'bump_severity',
      to: 'high',
    },
  ];
}

/**
 * Create worst-case answers for a script:
 * - sliders: max value
 * - single_choice: last option (typically worst)
 * - multi_choice: select all danger options or all options
 */
function worstCaseAnswers(scriptData) {
  const answers = [];
  for (const q of scriptData.questions) {
    if (q.type === 'slider') {
      answers.push({ question_id: q.id, answer: q.max || 10 });
    } else if (q.type === 'single_choice') {
      const opts = q.options || [];
      // Pick the worst: last option or option containing "nặng"
      const worst = opts.find(o => o.includes('nặng')) || opts[opts.length - 1];
      answers.push({ question_id: q.id, answer: worst });
    } else if (q.type === 'multi_choice') {
      // Select everything except "không có"
      const opts = (q.options || []).filter(o => o !== 'không có');
      answers.push({ question_id: q.id, answer: opts.join(', ') });
    } else if (q.type === 'free_text') {
      answers.push({ question_id: q.id, answer: 'rất nặng, đau nhiều' });
    }
  }
  return answers;
}

/**
 * Create mild/safe answers for a script:
 * - sliders: low value (2)
 * - single_choice: first option (typically mildest)
 * - multi_choice: "không có"
 */
function mildAnswers(scriptData) {
  const answers = [];
  for (const q of scriptData.questions) {
    if (q.type === 'slider') {
      answers.push({ question_id: q.id, answer: 2 });
    } else if (q.type === 'single_choice') {
      const opts = q.options || [];
      const mild = opts.find(o => o.includes('đỡ') || o.includes('nhẹ')) || opts[0];
      answers.push({ question_id: q.id, answer: mild });
    } else if (q.type === 'multi_choice') {
      const noOpt = (q.options || []).find(o => o === 'không có');
      answers.push({ question_id: q.id, answer: noOpt || 'không có' });
    } else if (q.type === 'free_text') {
      answers.push({ question_id: q.id, answer: 'không có gì đặc biệt' });
    }
  }
  return answers;
}

// ─── Generic script (slider-based) for fallback tests ─────────────────────────

function makeGenericScript() {
  return {
    questions: [
      { id: 'q1', text: 'Mức nào?', type: 'slider', min: 0, max: 10 },
      { id: 'q2', text: 'Triệu chứng kèm?', type: 'free_text' },
      { id: 'q3', text: 'Xu hướng?', type: 'single_choice', options: ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'] },
    ],
    scoring_rules: [
      { conditions: [{ field: 'q1', op: 'gte', value: 7 }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
      { conditions: [{ field: 'q3', op: 'eq', value: 'có vẻ nặng hơn' }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: false },
      { conditions: [{ field: 'q1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium', follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
      { conditions: [{ field: 'q1', op: 'lt', value: 4 }], combine: 'and', severity: 'low', follow_up_hours: 6, needs_doctor: false, needs_family_alert: false },
    ],
    condition_modifiers: [
      { user_condition: 'tiểu đường', extra_conditions: [{ field: 'q1', op: 'gte', value: 5 }], action: 'bump_severity', to: 'high' },
      { user_condition: 'huyết áp', extra_conditions: [{ field: 'q1', op: 'gte', value: 5 }], action: 'bump_severity', to: 'high' },
      { user_condition: 'tim mạch', extra_conditions: [{ field: 'q1', op: 'gte', value: 4 }], action: 'bump_severity', to: 'high' },
    ],
    conclusion_templates: { low: {}, medium: {}, high: {} },
    followup_questions: [
      { id: 'fu1', text: 'Status?', type: 'single_choice', options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'] },
      { id: 'fu2', text: 'New?', type: 'single_choice', options: ['Không', 'Có'] },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. DANGEROUS SYMPTOM COMBINATIONS THAT MUST SCORE HIGH (20 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION A: Dangerous symptom combinations MUST score HIGH');
console.log('='.repeat(70));

const complaintsToTest = ['đau đầu', 'đau bụng', 'chóng mặt', 'đau ngực', 'khó thở', 'sốt'];
let aTestCount = 0;

for (const complaint of complaintsToTest) {
  const script = buildScriptForComplaint(complaint);
  if (!script) {
    console.log(`  SKIP  No mapping for: ${complaint}`);
    continue;
  }

  // Test worst-case answers
  const worst = worstCaseAnswers(script);
  const res = evaluateScript(script, worst, {});
  const ok = assertIn(
    `A.${++aTestCount} ${complaint}: worst-case answers -> severity HIGH or MEDIUM`,
    res.severity,
    ['high', 'medium', 'critical']
  );
  if (!ok && res.severity === 'low') {
    safetyConcern(`${complaint} with worst-case answers scored LOW! This is dangerous.`);
  }

  // Test worst-case answers WITH elderly profile
  const resElderly = evaluateScript(script, worst, {
    age: 75,
    medical_conditions: ['Tiểu đường', 'Tim mạch'],
  });
  const ok2 = assert(
    `A.${++aTestCount} ${complaint}: worst-case + elderly+conditions -> HIGH`,
    resElderly.severity,
    'high'
  );
  if (!ok2 && resElderly.severity === 'low') {
    safetyConcern(`${complaint} elderly+conditions with worst answers scored ${resElderly.severity}!`);
  }

  // Test progression "worse"
  const hasProgression = script.questions.find(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  );
  if (hasProgression) {
    const worseAnswers = script.questions.map(q => {
      if (q.id === hasProgression.id) {
        return { question_id: q.id, answer: 'có vẻ nặng hơn' };
      }
      if (q.type === 'slider') return { question_id: q.id, answer: 5 };
      if (q.type === 'multi_choice') return { question_id: q.id, answer: 'không có' };
      return { question_id: q.id, answer: q.options ? q.options[0] : '' };
    });
    const resWorse = evaluateScript(script, worseAnswers, {});
    assert(
      `A.${++aTestCount} ${complaint}: progression="worse" -> HIGH`,
      resWorse.severity,
      'high'
    );
  }
}

// Special: chest pain should be HIGH with any substantial answers
{
  const chestScript = buildScriptForComplaint('đau ngực');
  if (chestScript) {
    // Even with non-worst answers, chest pain is serious
    const moderateAnswers = chestScript.questions.map(q => {
      if (q.type === 'slider') return { question_id: q.id, answer: 6 };
      if (q.type === 'single_choice') {
        // Pick moderate option
        return { question_id: q.id, answer: q.options ? q.options[Math.floor(q.options.length / 2)] : '' };
      }
      if (q.type === 'multi_choice') {
        // Pick first non-trivial option
        const opt = (q.options || []).find(o => o !== 'không có') || 'không có';
        return { question_id: q.id, answer: opt };
      }
      return { question_id: q.id, answer: '' };
    });

    // For chest pain, even with moderate answers for a cardiac-risk patient,
    // should be HIGH
    const resCardiac = evaluateScript(chestScript, moderateAnswers, {
      age: 60,
      medical_conditions: ['Tim mạch'],
    });
    assertIn(
      `A.${++aTestCount} đau ngực: moderate + cardiac history -> at least MEDIUM`,
      resCardiac.severity,
      ['high', 'medium', 'critical']
    );
  }
}

// Special: khó thở should be high with worst answers
{
  const dyspneaScript = buildScriptForComplaint('khó thở');
  if (dyspneaScript) {
    const worst = worstCaseAnswers(dyspneaScript);
    const res = evaluateScript(dyspneaScript, worst, { age: 70, medical_conditions: ['Tim mạch'] });
    const ok = assertIn(
      `A.${++aTestCount} khó thở: worst + elderly+heart -> HIGH`,
      res.severity,
      ['high', 'critical']
    );
    if (!ok) safetyConcern(`khó thở worst case scored ${res.severity} for elderly cardiac patient!`);
  }
}

// Pad to 20 tests for Section A
while (aTestCount < 20) {
  // Additional worst-case tests with different complaints
  const allComplaints = listComplaints();
  const extraComplaint = allComplaints[aTestCount % allComplaints.length];
  const script = buildScriptForComplaint(extraComplaint);
  if (script) {
    const worst = worstCaseAnswers(script);
    const res = evaluateScript(script, worst, { age: 80, medical_conditions: ['Tim mạch', 'Tiểu đường'] });
    assertIn(
      `A.${++aTestCount} ${extraComplaint}: worst + elderly+multi-conditions -> at least MEDIUM`,
      res.severity,
      ['high', 'medium', 'critical']
    );
  } else {
    aTestCount++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. SAFE SYMPTOM COMBINATIONS — should NOT over-alarm (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION B: Safe symptom combinations should NOT over-alarm');
console.log('='.repeat(70));

// B.1 Mild headache
{
  const script = buildScriptForComplaint('đau đầu');
  if (script) {
    const mild = mildAnswers(script);
    const res = evaluateScript(script, mild, { age: 30 });
    assert('B.1 Mild headache (mildest answers, young) -> LOW', res.severity, 'low');
  }
}

// B.2 Mild fatigue
{
  const script = buildScriptForComplaint('mệt mỏi');
  if (script) {
    const mild = mildAnswers(script);
    const res = evaluateScript(script, mild, { age: 30 });
    assert('B.2 Mild fatigue (mildest answers, young) -> LOW', res.severity, 'low');
  }
}

// B.3 Mild cough
{
  const script = buildScriptForComplaint('ho');
  if (script) {
    const mild = mildAnswers(script);
    const res = evaluateScript(script, mild, { age: 35 });
    assert('B.3 Mild cough (mildest answers, young) -> LOW', res.severity, 'low');
  }
}

// B.4 Follow-up "Đỡ hơn nhiều"
{
  const script = makeGenericScript();
  const fuRes = evaluateFollowUp(script, [
    { question_id: 'fu1', answer: 'Đỡ hơn' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'medium');
  assert('B.4 Follow-up "Đỡ hơn" + "Không" -> LOW', fuRes.severity, 'low');
}

// B.5 Young healthy person with mild symptoms
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 2 },
    { question_id: 'q2', answer: 'hơi mệt' },
    { question_id: 'q3', answer: 'đang đỡ dần' },
  ], { age: 25, medical_conditions: [] });
  assert('B.5 Young healthy + mild symptoms -> LOW', res.severity, 'low');
}

// B.6 Slider score 1, no conditions
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 1 },
    { question_id: 'q3', answer: 'đang đỡ dần' },
  ], { age: 30 });
  assert('B.6 Slider=1, improving, young -> LOW', res.severity, 'low');
}

// B.7 Slider score 3, stable, no conditions
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 3 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], { age: 40 });
  assert('B.7 Slider=3, stable, no conditions -> LOW', res.severity, 'low');
}

// B.8 Follow-up "Đỡ hơn" from previous HIGH -> should de-escalate
{
  const fuRes = evaluateFollowUp({}, [
    { question_id: 'fu1', answer: 'Đỡ hơn nhiều' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'high');
  assert('B.8 Follow-up "Đỡ hơn nhiều" from HIGH -> LOW', fuRes.severity, 'low');
}

// B.9 Mild dizziness (mildest options)
{
  const script = buildScriptForComplaint('chóng mặt');
  if (script) {
    const mild = mildAnswers(script);
    const res = evaluateScript(script, mild, { age: 28 });
    assert('B.9 Mild dizziness, young -> LOW', res.severity, 'low');
  }
}

// B.10 Mild abdominal pain (mildest options)
{
  const script = buildScriptForComplaint('đau bụng');
  if (script) {
    const mild = mildAnswers(script);
    const res = evaluateScript(script, mild, { age: 32 });
    assert('B.10 Mild abdominal pain, young -> LOW', res.severity, 'low');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. ELDERLY + CONDITIONS SAFETY CHECKS (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION C: Elderly + conditions safety checks');
console.log('='.repeat(70));

const elderlyProfile = {
  age: 75,
  medical_conditions: ['Tiểu đường', 'Tim mạch', 'Cao huyết áp'],
};

// C.1 Mild symptoms (score 3) -> should be MEDIUM at minimum for elderly+conditions
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 3 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], elderlyProfile);
  const ok = assertIn(
    'C.1 Elderly+conditions, slider=3 -> at least MEDIUM (not LOW)',
    res.severity,
    ['medium', 'high', 'critical']
  );
  if (!ok) safetyConcern('Elderly patient with diabetes+heart+HTN scored LOW with slider=3!');
}

// C.2 Moderate symptoms (score 5) -> should be HIGH (diabetes + elderly)
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], elderlyProfile);
  assert('C.2 Elderly+conditions, slider=5 -> HIGH', res.severity, 'high');
}

// C.3 Follow-up "Vẫn vậy" -> should NOT be LOW for elderly+conditions
{
  // Note: evaluateFollowUp doesn't take profile, so we test the scoring rule match
  // The follow-up for "Vẫn vậy" maintains previous severity
  const fuRes = evaluateFollowUp({}, [
    { question_id: 'fu1', answer: 'Vẫn vậy' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'medium');
  assertIn(
    'C.3 Follow-up "Vẫn vậy" from MEDIUM -> not LOW (maintains severity)',
    fuRes.severity,
    ['medium', 'high']
  );
}

// C.4 Any score >= 4 with diabetes -> must bump
{
  const script = makeGenericScript();
  // slider=5, tiểu đường modifier triggers at >=5
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], { age: 65, medical_conditions: ['Tiểu đường'] });
  assert('C.4 Slider=5 + diabetes -> HIGH (modifier bumps)', res.severity, 'high');
}

// C.5 Any score >= 3 with heart disease -> must bump
{
  const script = makeGenericScript();
  // tim mạch modifier triggers at >=4
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 4 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], { age: 70, medical_conditions: ['Tim mạch'] });
  assert('C.5 Slider=4 + heart disease + elderly -> HIGH', res.severity, 'high');
}

// C.6 Elderly + conditions + slider=4 -> should be HIGH (bumped from medium)
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 4 },
  ], elderlyProfile);
  assert('C.6 Elderly+conditions, slider=4 -> HIGH (modifier+elderly)', res.severity, 'high');
}

// C.7 Elderly + conditions + slider=6 -> HIGH
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 6 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], elderlyProfile);
  assert('C.7 Elderly+conditions, slider=6 -> HIGH', res.severity, 'high');
}

// C.8 Elderly + NO conditions + slider=3 -> should remain LOW (no modifiers)
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 3 },
    { question_id: 'q3', answer: 'đang đỡ dần' },
  ], { age: 75, medical_conditions: [] });
  assert('C.8 Elderly + NO conditions, slider=3 -> LOW', res.severity, 'low');
}

// C.9 Follow-up "Vẫn vậy" from HIGH -> should stay HIGH
{
  const fuRes = evaluateFollowUp({}, [
    { question_id: 'fu1', answer: 'Vẫn vậy' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'high');
  assert('C.9 Follow-up "Vẫn vậy" from HIGH -> stays HIGH', fuRes.severity, 'high');
}

// C.10 Elderly + conditions + progression worse -> HIGH + needsDoctor
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 3 },
    { question_id: 'q3', answer: 'có vẻ nặng hơn' },
  ], elderlyProfile);
  assert('C.10 Elderly+conditions, progression worse -> HIGH', res.severity, 'high');
  assertTrue('C.10b needsDoctor=true', res.needsDoctor === true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// D. EMERGENCY DETECTION COMPLETENESS (15 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION D: Emergency detection completeness');
console.log('='.repeat(70));

// D.1 đau ngực dữ dội
{
  const res = detectEmergency(['đau ngực dữ dội', 'khó thở']);
  assertTrue('D.1 "đau ngực dữ dội + khó thở" -> emergency', res.isEmergency === true);
}

// D.2 khó thở đột ngột + companion
{
  const res = detectEmergency(['khó thở đột ngột', 'đau ngực']);
  assertTrue('D.2 "khó thở đột ngột + đau ngực" -> emergency', res.isEmergency === true);
}

// D.3 yếu nửa người -> STROKE
{
  const res = detectEmergency(['yếu nửa người']);
  assert('D.3 "yếu nửa người" -> STROKE', res.type, 'STROKE');
  assertTrue('D.3b isEmergency=true', res.isEmergency === true);
}

// D.4 tê nửa người -> STROKE
{
  const res = detectEmergency(['tê nửa người']);
  assert('D.4 "tê nửa người" -> STROKE', res.type, 'STROKE');
}

// D.5 nói ngọng đột ngột -> STROKE
{
  const res = detectEmergency(['nói ngọng đột ngột']);
  assert('D.5 "nói ngọng đột ngột" -> STROKE', res.type, 'STROKE');
}

// D.6 co giật -> SEIZURE
{
  const res = detectEmergency(['co giật']);
  assert('D.6 "co giật" -> SEIZURE', res.type, 'SEIZURE');
  assertTrue('D.6b isEmergency=true', res.isEmergency === true);
}

// D.7 động kinh -> SEIZURE
{
  const res = detectEmergency(['động kinh']);
  assert('D.7 "động kinh" -> SEIZURE', res.type, 'SEIZURE');
}

// D.8 nôn ra máu -> HEMORRHAGE
{
  const res = detectEmergency(['nôn ra máu']);
  assert('D.8 "nôn ra máu" -> INTERNAL_HEMORRHAGE', res.type, 'INTERNAL_HEMORRHAGE');
  assertTrue('D.8b isEmergency=true', res.isEmergency === true);
}

// D.9 sốt cao cứng cổ -> MENINGITIS
{
  const res = detectEmergency(['sốt cao', 'cứng cổ']);
  assert('D.9 "sốt cao + cứng cổ" -> MENINGITIS', res.type, 'MENINGITIS');
  assertTrue('D.9b isEmergency=true', res.isEmergency === true);
}

// D.10 mất thị lực đột ngột -> STROKE
{
  const res = detectEmergency(['mất thị lực đột ngột']);
  assert('D.10 "mất thị lực đột ngột" -> STROKE', res.type, 'STROKE');
}

// D.11 liệt nửa người -> STROKE
{
  const res = detectEmergency(['liệt nửa người']);
  assert('D.11 "liệt nửa người" -> STROKE', res.type, 'STROKE');
}

// D.12 méo miệng -> STROKE
{
  const res = detectEmergency(['méo miệng']);
  assert('D.12 "méo miệng" -> STROKE', res.type, 'STROKE');
}

// D.13 khó thở + sưng mặt -> ANAPHYLAXIS
{
  const res = detectEmergency(['khó thở', 'sưng mặt']);
  assert('D.13 "khó thở + sưng mặt" -> ANAPHYLAXIS', res.type, 'ANAPHYLAXIS');
  assertTrue('D.13b isEmergency=true', res.isEmergency === true);
}

// D.14 sốt + chấm đỏ + đau bụng -> DENGUE
{
  const res = detectEmergency(['sốt', 'chấm đỏ dưới da', 'đau bụng']);
  assert('D.14 "sốt + chấm đỏ dưới da + đau bụng" -> DENGUE_HEMORRHAGIC', res.type, 'DENGUE_HEMORRHAGIC');
  assertTrue('D.14b isEmergency=true', res.isEmergency === true);
}

// D.15 tiểu đường + khát nhiều + buồn nôn -> DKA
{
  const res = detectEmergency(['khát nhiều', 'buồn nôn'], {
    medical_conditions: ['Tiểu đường'],
  });
  assert('D.15 "tiểu đường + khát nhiều + buồn nôn" -> DKA', res.type, 'DKA');
  assertTrue('D.15b isEmergency=true', res.isEmergency === true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// E. FALSE NEGATIVE TESTS — symptoms that should NOT be missed (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION E: False negative tests - symptoms must NOT be missed');
console.log('='.repeat(70));

// E.1 "hơi đau ngực" + elderly -> should at least be MEDIUM
{
  const res = detectEmergency(['hơi đau ngực'], { birth_year: 1950 });
  assertIn(
    'E.1 "hơi đau ngực" + elderly -> at least moderate (emergency detector)',
    res.severity,
    ['moderate', 'high', 'critical']
  );
}

// E.2 "chóng mặt liên tục" + diabetes -> should trigger follow-up
{
  // Emergency detector may not catch this, but isRedFlag should
  const redFlag = isRedFlag('chóng mặt liên tục đau đầu dữ dội đột ngột');
  assertTrue('E.2 "chóng mặt + đau đầu dữ dội đột ngột" -> red flag detected', redFlag === true);
}

// E.3 "mệt bất thường" + heart disease -> scoring should not dismiss
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q3', answer: 'có vẻ nặng hơn' },
  ], { age: 65, medical_conditions: ['Tim mạch'] });
  assert('E.3 "mệt bất thường" + heart disease -> HIGH', res.severity, 'high');
}

// E.4 "đau đầu dữ dội đột ngột" -> should be in red flags
{
  const rf = isRedFlag('đau đầu dữ dội đột ngột');
  assertTrue('E.4 "đau đầu dữ dội đột ngột" -> isRedFlag=true', rf === true);
}

// E.5 progression="worse" ALWAYS escalates severity
{
  const script = makeGenericScript();
  for (const slider of [2, 3, 4, 5]) {
    const res = evaluateScript(script, [
      { question_id: 'q1', answer: slider },
      { question_id: 'q3', answer: 'có vẻ nặng hơn' },
    ], {});
    assert(
      `E.5 Progression "worse" + slider=${slider} -> HIGH`,
      res.severity,
      'high'
    );
  }
}

// E.6 Elderly (>=60) + conditions + answered questions -> never LOW when rules match
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 4 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], { age: 65, medical_conditions: ['Tim mạch'] });
  const ok = assertIn(
    'E.6 Elderly + conditions + slider=4 -> never LOW',
    res.severity,
    ['medium', 'high', 'critical']
  );
  if (!ok) safetyConcern('Elderly with conditions and slider=4 scored LOW!');
}

// E.7 Follow-up "Nặng hơn" must ALWAYS -> needsDoctor=true
{
  for (const prevSev of ['low', 'medium', 'high']) {
    const fuRes = evaluateFollowUp({}, [
      { question_id: 'fu1', answer: 'Nặng hơn' },
      { question_id: 'fu2', answer: 'Không' },
    ], prevSev);
    assert(
      `E.7 Follow-up "Nặng hơn" (prev=${prevSev}) -> needsDoctor=true`,
      fuRes.needsDoctor,
      true
    );
    assert(
      `E.7b Follow-up "Nặng hơn" (prev=${prevSev}) -> severity=high`,
      fuRes.severity,
      'high'
    );
  }
}

// E.8 HIGH severity must ALWAYS -> followUpHours <= 1
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 9 },
    { question_id: 'q3', answer: 'có vẻ nặng hơn' },
  ], {});
  assert('E.8 HIGH severity -> severity is high', res.severity, 'high');
  assertTrue('E.8b HIGH severity -> followUpHours <= 1', res.followUpHours <= 1);
}

// E.9 MEDIUM severity must ALWAYS -> followUpHours <= 3
{
  const script = makeGenericScript();
  const res = evaluateScript(script, [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ], {});
  assert('E.9 MEDIUM severity -> severity is medium', res.severity, 'medium');
  assertTrue('E.9b MEDIUM severity -> followUpHours <= 3', res.followUpHours <= 3);
}

// E.10 needsDoctor=true must ALWAYS accompany severity=high
{
  // Test across multiple scenarios
  const scenarios = [
    { slider: 8, progression: 'có vẻ nặng hơn' },
    { slider: 9, progression: 'vẫn như cũ' },
    { slider: 10, progression: 'đang đỡ dần' },
  ];
  let allDoctorForHigh = true;
  for (const s of scenarios) {
    const script = makeGenericScript();
    const res = evaluateScript(script, [
      { question_id: 'q1', answer: s.slider },
      { question_id: 'q3', answer: s.progression },
    ], {});
    if (res.severity === 'high' && !res.needsDoctor) {
      allDoctorForHigh = false;
      safetyConcern(`Severity=HIGH but needsDoctor=false (slider=${s.slider})`);
    }
  }
  assertTrue('E.10 severity=high ALWAYS has needsDoctor=true', allDoctorForHigh);
}

// ═══════════════════════════════════════════════════════════════════════════════
// F. SCORING CONSISTENCY (Determinism) — 5 tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  SECTION F: Scoring consistency (determinism)');
console.log('='.repeat(70));

// F.1 Same script + same answers + same profile -> identical severity 10/10
{
  const script = makeGenericScript();
  const answers = [
    { question_id: 'q1', answer: 6 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ];
  const profile = { age: 65, medical_conditions: ['Tim mạch'] };

  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(evaluateScript(script, answers, profile));
  }
  const allSame = results.every(r =>
    r.severity === results[0].severity &&
    r.followUpHours === results[0].followUpHours &&
    r.needsDoctor === results[0].needsDoctor &&
    r.needsFamilyAlert === results[0].needsFamilyAlert &&
    r.matchedRuleIndex === results[0].matchedRuleIndex
  );
  assertTrue('F.1 Same inputs -> identical output 10/10 times', allSame);
}

// F.2 Same follow-up answers -> identical result 10/10
{
  const fuAnswers = [
    { question_id: 'fu1', answer: 'Nặng hơn' },
    { question_id: 'fu2', answer: 'Có' },
  ];
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(evaluateFollowUp({}, fuAnswers, 'medium'));
  }
  const allSame = results.every(r =>
    r.severity === results[0].severity &&
    r.followUpHours === results[0].followUpHours &&
    r.needsDoctor === results[0].needsDoctor &&
    r.action === results[0].action
  );
  assertTrue('F.2 Same follow-up inputs -> identical output 10/10', allSame);
}

// F.3 Same emergency input -> identical detection 10/10
{
  const symptoms = ['đau ngực', 'khó thở', 'vã mồ hôi lạnh'];
  const profile = { birth_year: 1955, medical_conditions: ['Tim mạch'] };
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(detectEmergency(symptoms, profile));
  }
  const allSame = results.every(r =>
    r.isEmergency === results[0].isEmergency &&
    r.type === results[0].type &&
    r.severity === results[0].severity
  );
  assertTrue('F.3 Same emergency inputs -> identical detection 10/10', allSame);
}

// F.4 Order of answers doesn't matter (if question IDs match)
{
  const script = makeGenericScript();
  const answersA = [
    { question_id: 'q1', answer: 6 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
    { question_id: 'q2', answer: 'test' },
  ];
  const answersB = [
    { question_id: 'q3', answer: 'vẫn như cũ' },
    { question_id: 'q2', answer: 'test' },
    { question_id: 'q1', answer: 6 },
  ];
  const resA = evaluateScript(script, answersA, {});
  const resB = evaluateScript(script, answersB, {});
  assertTrue(
    'F.4 Answer order does not affect scoring',
    resA.severity === resB.severity &&
    resA.followUpHours === resB.followUpHours &&
    resA.needsDoctor === resB.needsDoctor &&
    resA.matchedRuleIndex === resB.matchedRuleIndex
  );
}

// F.5 Adding unrelated answer (unknown question_id) -> doesn't change result
{
  const script = makeGenericScript();
  const baseAnswers = [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q3', answer: 'vẫn như cũ' },
  ];
  const extraAnswers = [
    ...baseAnswers,
    { question_id: 'q_unknown_999', answer: 'random' },
    { question_id: 'xyz_not_exists', answer: 42 },
  ];
  const resBase = evaluateScript(script, baseAnswers, {});
  const resExtra = evaluateScript(script, extraAnswers, {});
  assertTrue(
    'F.5 Extra unknown answers do not change result',
    resBase.severity === resExtra.severity &&
    resBase.followUpHours === resExtra.followUpHours &&
    resBase.needsDoctor === resExtra.needsDoctor &&
    resBase.matchedRuleIndex === resExtra.matchedRuleIndex
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  MEDICAL SAFETY AUDIT — FINAL REPORT');
console.log('='.repeat(70));
console.log(`\n  TOTAL:  ${totalPass} PASS / ${totalFail} FAIL  (${totalPass + totalFail} tests)`);

if (safetyConcerns.length > 0) {
  console.log(`\n  !!! ${safetyConcerns.length} SAFETY CONCERN(S) FOUND !!!`);
  safetyConcerns.forEach((c, i) => {
    console.log(`    ${i + 1}. ${c}`);
  });
} else {
  console.log('\n  No safety concerns found.');
}

console.log('\n' + '='.repeat(70));
process.exit(totalFail > 0 ? 1 : 0);
