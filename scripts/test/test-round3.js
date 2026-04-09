'use strict';

/**
 * Round 3 — Scoring accuracy tests across all severity levels, profiles, and modifiers.
 */

const { evaluateScript, evaluateFollowUp, applyModifiers } = require('../src/services/checkin/scoring-engine');
const { getNextQuestion } = require('../src/services/checkin/script-runner');

// ─── Test infrastructure ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(testName, actual, expected, extraInfo) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    const msg = `  ✗ ${testName}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    console.log(msg);
    if (extraInfo) console.log(`    ${extraInfo}`);
    failures.push(testName);
  }
}

// ─── Script A — Slider-based ──────────────────────────────────────────────────

const scriptA = {
  questions: [{ id: 's1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 }],
  scoring_rules: [
    { conditions: [{ field: 's1', op: 'gte', value: 7 }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
    { conditions: [{ field: 's1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium', follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
    { conditions: [{ field: 's1', op: 'lt', value: 4 }], combine: 'and', severity: 'low', follow_up_hours: 6, needs_doctor: false, needs_family_alert: false },
  ],
  condition_modifiers: [
    { user_condition: 'tiểu đường', extra_conditions: [{ field: 's1', op: 'gte', value: 5 }], action: 'bump_severity', to: 'high' },
    { user_condition: 'tim mạch', extra_conditions: [{ field: 's1', op: 'gte', value: 3 }], action: 'bump_severity', to: 'high' },
  ],
  conclusion_templates: {
    low: { summary: 'Nhẹ', recommendation: 'R', close_message: 'C' },
    medium: { summary: 'TB', recommendation: 'R', close_message: 'C' },
    high: { summary: 'Nặng', recommendation: 'R', close_message: 'C' },
  },
  followup_questions: [
    { id: 'fu1', text: 'T?', type: 'single_choice', options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'] },
    { id: 'fu2', text: 'M?', type: 'single_choice', options: ['Không', 'Có'] },
  ],
};

// ─── Script B — Multi-rule with OR logic ──────────────────────────────────────

const scriptB = {
  questions: [
    { id: 'm1', text: 'Q', type: 'slider', min: 0, max: 10 },
    { id: 'm2', text: 'Q', type: 'single_choice', options: ['có', 'không'] },
  ],
  scoring_rules: [
    { conditions: [{ field: 'm1', op: 'gte', value: 7 }, { field: 'm2', op: 'eq', value: 'có' }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
    { conditions: [{ field: 'm1', op: 'gte', value: 7 }], combine: 'or', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: false },
    { conditions: [{ field: 'm1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium', follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
  ],
  condition_modifiers: [],
  conclusion_templates: {
    low: { summary: 'L', recommendation: 'R', close_message: 'C' },
    medium: { summary: 'M', recommendation: 'R', close_message: 'C' },
    high: { summary: 'H', recommendation: 'R', close_message: 'C' },
  },
  followup_questions: [
    { id: 'fu1', text: 'T?', type: 'single_choice', options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'] },
  ],
};

// Helper to build answers array
function ans(questionId, value) {
  return { question_id: questionId, answer: value };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Slider scoring boundary tests (20 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ A. Slider Scoring Boundary Tests ═══\n');

// LOW range: 0,1,2,3
for (const score of [0, 1, 2, 3]) {
  const r = evaluateScript(scriptA, [ans('s1', score)]);
  assert(`Score ${score} → LOW`, r.severity, 'low');
}

// MEDIUM range: 4,5,6
for (const score of [4, 5, 6]) {
  const r = evaluateScript(scriptA, [ans('s1', score)]);
  assert(`Score ${score} → MEDIUM`, r.severity, 'medium');
}

// HIGH range: 7,8,9,10
for (const score of [7, 8, 9, 10]) {
  const r = evaluateScript(scriptA, [ans('s1', score)]);
  assert(`Score ${score} → HIGH`, r.severity, 'high');
}

// Boundary tests
{
  const r4 = evaluateScript(scriptA, [ans('s1', 4)]);
  assert('Score exactly 4 → MEDIUM (boundary gte 4)', r4.severity, 'medium');

  const r7 = evaluateScript(scriptA, [ans('s1', 7)]);
  assert('Score exactly 7 → HIGH (boundary gte 7)', r7.severity, 'high');

  const r3 = evaluateScript(scriptA, [ans('s1', 3)]);
  assert('Score exactly 3 → LOW (boundary lt 4)', r3.severity, 'low');

  // Verify matchedRuleIndex
  assert('Score 7 matchedRuleIndex → 0 (first rule)', r7.matchedRuleIndex, 0);
  assert('Score 4 matchedRuleIndex → 1 (second rule)', r4.matchedRuleIndex, 1);
  assert('Score 3 matchedRuleIndex → 2 (third rule)', r3.matchedRuleIndex, 2);

  // Verify follow-up hours
  assert('Score 7 followUpHours → 1', r7.followUpHours, 1);
  assert('Score 4 followUpHours → 3', r4.followUpHours, 3);
  assert('Score 3 followUpHours → 6', r3.followUpHours, 6);
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. Profile modifier combinations (15 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ B. Profile Modifier Combinations ═══\n');

{
  // No conditions + score 5 → MEDIUM
  const r1 = evaluateScript(scriptA, [ans('s1', 5)], {});
  assert('No conditions + score 5 → MEDIUM', r1.severity, 'medium');

  // Tiểu đường + score 5 → HIGH (modifier bumps: s1 >= 5)
  const r2 = evaluateScript(scriptA, [ans('s1', 5)], { medical_conditions: ['tiểu đường'] });
  assert('Tiểu đường + score 5 → HIGH (modifier bumps)', r2.severity, 'high');

  // Tiểu đường + score 4 → MEDIUM (below modifier threshold of 5)
  const r3 = evaluateScript(scriptA, [ans('s1', 4)], { medical_conditions: ['tiểu đường'] });
  assert('Tiểu đường + score 4 → MEDIUM (below modifier threshold)', r3.severity, 'medium');

  // Tim mạch + score 3 → HIGH (modifier bumps: s1 >= 3)
  const r4 = evaluateScript(scriptA, [ans('s1', 3)], { medical_conditions: ['tim mạch'] });
  assert('Tim mạch + score 3 → HIGH (modifier bumps)', r4.severity, 'high');

  // Tim mạch + score 2 → LOW (below modifier threshold of 3)
  const r5 = evaluateScript(scriptA, [ans('s1', 2)], { medical_conditions: ['tim mạch'] });
  assert('Tim mạch + score 2 → LOW (below modifier threshold)', r5.severity, 'low');

  // Both conditions + score 5 → HIGH
  const r6 = evaluateScript(scriptA, [ans('s1', 5)], { medical_conditions: ['tiểu đường', 'tim mạch'] });
  assert('Both conditions + score 5 → HIGH', r6.severity, 'high');

  // Age 68 + conditions + MEDIUM base (score 5) → HIGH (elderly bump)
  const r7 = evaluateScript(scriptA, [ans('s1', 4)], { medical_conditions: ['viêm khớp'], age: 68 });
  assert('Age 68 + conditions + MEDIUM → HIGH (elderly bump)', r7.severity, 'high');

  // Age 68 + conditions + LOW + no rules matched + has answers → MEDIUM (safety bump)
  // To get matchedRuleIndex=-1 with LOW, we need no rule to match. But scriptA has a rule for lt 4.
  // So we use a script with no matching rules.
  const scriptNoMatch = {
    ...scriptA,
    scoring_rules: [
      { conditions: [{ field: 's1', op: 'gte', value: 99 }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
    ],
  };
  const r8 = evaluateScript(scriptNoMatch, [ans('s1', 2)], { medical_conditions: ['tiểu đường'], age: 68 });
  assert('Age 68 + conditions + LOW (no rules matched) → MEDIUM (safety bump)', r8.severity, 'medium');
  assert('Safety bump modifiersApplied contains elderly note', r8.modifiersApplied.length > 0, true);

  // Age 45 + conditions + MEDIUM → stays MEDIUM (not elderly)
  const r9 = evaluateScript(scriptA, [ans('s1', 4)], { medical_conditions: ['viêm khớp'], age: 45 });
  assert('Age 45 + conditions + MEDIUM → stays MEDIUM (not elderly)', r9.severity, 'medium');

  // Age 68 + no conditions + MEDIUM → stays MEDIUM (no conditions)
  const r10 = evaluateScript(scriptA, [ans('s1', 4)], { medical_conditions: [], age: 68 });
  assert('Age 68 + no conditions + MEDIUM → stays MEDIUM', r10.severity, 'medium');

  // Verify needsDoctor set by modifier bump
  assert('Tiểu đường bumped → needsDoctor=true', r2.needsDoctor, true);
  assert('Tim mạch bumped → needsDoctor=true', r4.needsDoctor, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. Follow-up scoring (15 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ C. Follow-up Scoring ═══\n');

{
  // previousSeverity=low: "Đỡ hơn"+"Không" → low/monitoring
  const c1 = evaluateFollowUp(scriptA, [ans('fu1', 'Đỡ hơn'), ans('fu2', 'Không')], 'low');
  assert('prev=low: Đỡ hơn+Không → low', c1.severity, 'low');
  assert('prev=low: Đỡ hơn+Không → monitoring', c1.action, 'monitoring');

  // previousSeverity=low: "Nặng hơn"+"Có" → high/escalate
  const c2 = evaluateFollowUp(scriptA, [ans('fu1', 'Nặng hơn'), ans('fu2', 'Có')], 'low');
  assert('prev=low: Nặng hơn+Có → high', c2.severity, 'high');
  assert('prev=low: Nặng hơn+Có → escalate', c2.action, 'escalate');

  // previousSeverity=medium: "Đỡ hơn"+"Không" → low/monitoring
  const c3 = evaluateFollowUp(scriptA, [ans('fu1', 'Đỡ hơn'), ans('fu2', 'Không')], 'medium');
  assert('prev=medium: Đỡ hơn+Không → low', c3.severity, 'low');
  assert('prev=medium: Đỡ hơn+Không → monitoring', c3.action, 'monitoring');

  // previousSeverity=medium: "Vẫn vậy"+"Không" → medium/continue
  const c4 = evaluateFollowUp(scriptA, [ans('fu1', 'Vẫn vậy'), ans('fu2', 'Không')], 'medium');
  assert('prev=medium: Vẫn vậy+Không → medium', c4.severity, 'medium');
  assert('prev=medium: Vẫn vậy+Không → continue_followup', c4.action, 'continue_followup');

  // previousSeverity=medium: "Nặng hơn"+"Không" → high/escalate
  const c5 = evaluateFollowUp(scriptA, [ans('fu1', 'Nặng hơn'), ans('fu2', 'Không')], 'medium');
  assert('prev=medium: Nặng hơn+Không → high', c5.severity, 'high');
  assert('prev=medium: Nặng hơn+Không → escalate', c5.action, 'escalate');

  // previousSeverity=high: "Đỡ hơn"+"Không" → low/monitoring
  const c6 = evaluateFollowUp(scriptA, [ans('fu1', 'Đỡ hơn'), ans('fu2', 'Không')], 'high');
  assert('prev=high: Đỡ hơn+Không → low', c6.severity, 'low');
  assert('prev=high: Đỡ hơn+Không → monitoring', c6.action, 'monitoring');

  // previousSeverity=high: "Vẫn vậy"+"Không" → high/continue
  const c7 = evaluateFollowUp(scriptA, [ans('fu1', 'Vẫn vậy'), ans('fu2', 'Không')], 'high');
  assert('prev=high: Vẫn vậy+Không → high', c7.severity, 'high');
  assert('prev=high: Vẫn vậy+Không → continue_followup', c7.action, 'continue_followup');

  // previousSeverity=high: "Nặng hơn"+"Có" → high/escalate+needsDoctor
  const c8 = evaluateFollowUp(scriptA, [ans('fu1', 'Nặng hơn'), ans('fu2', 'Có')], 'high');
  assert('prev=high: Nặng hơn+Có → high', c8.severity, 'high');
  assert('prev=high: Nặng hơn+Có → escalate', c8.action, 'escalate');
  assert('prev=high: Nặng hơn+Có → needsDoctor', c8.needsDoctor, true);

  // "Đỡ hơn" + "Có" (better but new symptoms) → high/escalate
  const c9 = evaluateFollowUp(scriptA, [ans('fu1', 'Đỡ hơn'), ans('fu2', 'Có')], 'medium');
  assert('Đỡ hơn+Có (new symptoms) → high/escalate', c9.severity, 'high');
  assert('Đỡ hơn+Có → escalate action', c9.action, 'escalate');

  // Vietnamese variant: "đỡ rồi" → should match better (contains 'đỡ')
  const c10 = evaluateFollowUp(scriptA, [ans('fu1', 'đỡ rồi'), ans('fu2', 'Không')], 'medium');
  assert('Vietnamese variant "đỡ rồi" → low/monitoring', c10.severity, 'low');
  assert('Vietnamese variant "đỡ rồi" → monitoring', c10.action, 'monitoring');
}

// ═══════════════════════════════════════════════════════════════════════════════
// D. Multi-rule scripts (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ D. Multi-rule Scripts (Script B) ═══\n');

{
  // m1=8, m2='có' → HIGH (AND rule matches first)
  const d1 = evaluateScript(scriptB, [ans('m1', 8), ans('m2', 'có')]);
  assert('m1=8, m2=có → HIGH', d1.severity, 'high');
  assert('m1=8, m2=có → matchedRuleIndex=0 (AND rule first)', d1.matchedRuleIndex, 0);
  assert('m1=8, m2=có → needsFamilyAlert=true', d1.needsFamilyAlert, true);

  // m1=8, m2='không' → HIGH (OR rule matches: m1>=7 alone is enough)
  const d2 = evaluateScript(scriptB, [ans('m1', 8), ans('m2', 'không')]);
  assert('m1=8, m2=không → HIGH (OR rule)', d2.severity, 'high');
  assert('m1=8, m2=không → matchedRuleIndex=1 (OR rule)', d2.matchedRuleIndex, 1);
  assert('m1=8, m2=không → needsFamilyAlert=false (OR rule)', d2.needsFamilyAlert, false);

  // m1=5, m2='có' → MEDIUM
  const d3 = evaluateScript(scriptB, [ans('m1', 5), ans('m2', 'có')]);
  assert('m1=5, m2=có → MEDIUM', d3.severity, 'medium');
  assert('m1=5, m2=có → matchedRuleIndex=2', d3.matchedRuleIndex, 2);

  // m1=3, m2='không' → LOW (no rule matches)
  const d4 = evaluateScript(scriptB, [ans('m1', 3), ans('m2', 'không')]);
  assert('m1=3, m2=không → LOW (no rule matches)', d4.severity, 'low');
  assert('m1=3, m2=không → matchedRuleIndex=-1', d4.matchedRuleIndex, -1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// E. Edge cases (5 tests)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ E. Edge Cases ═══\n');

{
  // Empty answers → severity=low, matchedRuleIndex=-1
  const e1 = evaluateScript(scriptA, []);
  assert('Empty answers → low', e1.severity, 'low');
  assert('Empty answers → matchedRuleIndex=-1', e1.matchedRuleIndex, -1);

  // String "7" to numeric gte → should coerce and match HIGH
  const e2 = evaluateScript(scriptA, [ans('s1', '7')]);
  assert('String "7" coerces to numeric → HIGH', e2.severity, 'high');

  // Score 100 → still matches HIGH (gte 7)
  const e3 = evaluateScript(scriptA, [ans('s1', 100)]);
  assert('Score 100 → HIGH', e3.severity, 'high');

  // Negative score -1 → matches LOW (lt 4)
  const e4 = evaluateScript(scriptA, [ans('s1', -1)]);
  assert('Score -1 → LOW', e4.severity, 'low');

  // Null profile → no crash
  let noCrash = true;
  try {
    evaluateScript(scriptA, [ans('s1', 5)], null);
  } catch (e) {
    noCrash = false;
  }
  assert('Null profile → no crash', noCrash, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════');
console.log(`  ROUND 3 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('═══════════════════════════════════════════════');

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  - ${f}`));
}

process.exit(failed > 0 ? 1 : 0);
