'use strict';
require('dotenv').config();

const {
  evaluateScript,
  evaluateFollowUp,
  evaluateCondition,
  evaluateRule,
  applyModifiers,
} = require('../src/services/checkin/scoring-engine');

let totalPass = 0;
let totalFail = 0;

function assert(label, actual, expected) {
  const pass = actual === expected;
  if (pass) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    console.log(`  FAIL  ${label}  (expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)})`);
  }
}

// Helper: build a Map from object
function mkMap(obj) {
  return new Map(Object.entries(obj));
}

// ─── A. evaluateCondition() ───────────────────────────────────────────────────
console.log('\n=== A. evaluateCondition() - all operators ===');

assert('eq: 5 eq 5 -> true',
  evaluateCondition({ field: 'q1', op: 'eq', value: 5 }, mkMap({ q1: 5 })), true);
assert('eq: 5 eq 6 -> false',
  evaluateCondition({ field: 'q1', op: 'eq', value: 6 }, mkMap({ q1: 5 })), false);
assert('neq: 5 neq 6 -> true',
  evaluateCondition({ field: 'q1', op: 'neq', value: 6 }, mkMap({ q1: 5 })), true);
assert('gt: 6 gt 5 -> true',
  evaluateCondition({ field: 'q1', op: 'gt', value: 5 }, mkMap({ q1: 6 })), true);
assert('gt: 5 gt 5 -> false',
  evaluateCondition({ field: 'q1', op: 'gt', value: 5 }, mkMap({ q1: 5 })), false);
assert('gte: 5 gte 5 -> true',
  evaluateCondition({ field: 'q1', op: 'gte', value: 5 }, mkMap({ q1: 5 })), true);
assert('gte: 4 gte 5 -> false',
  evaluateCondition({ field: 'q1', op: 'gte', value: 5 }, mkMap({ q1: 4 })), false);
assert('lt: 4 lt 5 -> true',
  evaluateCondition({ field: 'q1', op: 'lt', value: 5 }, mkMap({ q1: 4 })), true);
assert('lt: 5 lt 5 -> false',
  evaluateCondition({ field: 'q1', op: 'lt', value: 5 }, mkMap({ q1: 5 })), false);
assert('lte: 5 lte 5 -> true',
  evaluateCondition({ field: 'q1', op: 'lte', value: 5 }, mkMap({ q1: 5 })), true);
assert('lte: 6 lte 5 -> false',
  evaluateCondition({ field: 'q1', op: 'lte', value: 5 }, mkMap({ q1: 6 })), false);
assert('contains: "dau dau du doi" contains "dau dau" -> true',
  evaluateCondition({ field: 'q1', op: 'contains', value: 'đau đầu' }, mkMap({ q1: 'đau đầu dữ dội' })), true);
assert('contains: "met" contains "dau" -> false',
  evaluateCondition({ field: 'q1', op: 'contains', value: 'đau' }, mkMap({ q1: 'mệt' })), false);
assert('in: "a" in ["a","b"] -> true',
  evaluateCondition({ field: 'q1', op: 'in', value: ['a', 'b'] }, mkMap({ q1: 'a' })), true);
assert('in: "c" in ["a","b"] -> false',
  evaluateCondition({ field: 'q1', op: 'in', value: ['a', 'b'] }, mkMap({ q1: 'c' })), false);
assert('not_in: "c" not_in ["a","b"] -> true',
  evaluateCondition({ field: 'q1', op: 'not_in', value: ['a', 'b'] }, mkMap({ q1: 'c' })), true);
assert('unknown operator -> false',
  evaluateCondition({ field: 'q1', op: 'banana', value: 5 }, mkMap({ q1: 5 })), false);
assert('missing field -> false',
  evaluateCondition({ field: 'q_missing', op: 'eq', value: 5 }, mkMap({ q1: 5 })), false);

// ─── B. evaluateRule() ────────────────────────────────────────────────────────
console.log('\n=== B. evaluateRule() - combine logic ===');

assert('AND with 2 true conditions -> true',
  evaluateRule({
    conditions: [
      { field: 'q1', op: 'gte', value: 5 },
      { field: 'q2', op: 'eq', value: 'yes' },
    ],
    combine: 'and',
  }, mkMap({ q1: 7, q2: 'yes' })), true);

assert('AND with 1 false condition -> false',
  evaluateRule({
    conditions: [
      { field: 'q1', op: 'gte', value: 5 },
      { field: 'q2', op: 'eq', value: 'yes' },
    ],
    combine: 'and',
  }, mkMap({ q1: 7, q2: 'no' })), false);

assert('OR with 1 true condition -> true',
  evaluateRule({
    conditions: [
      { field: 'q1', op: 'gte', value: 5 },
      { field: 'q2', op: 'eq', value: 'yes' },
    ],
    combine: 'or',
  }, mkMap({ q1: 3, q2: 'yes' })), true);

assert('OR with all false -> false',
  evaluateRule({
    conditions: [
      { field: 'q1', op: 'gte', value: 5 },
      { field: 'q2', op: 'eq', value: 'yes' },
    ],
    combine: 'or',
  }, mkMap({ q1: 3, q2: 'no' })), false);

assert('Empty conditions -> false',
  evaluateRule({ conditions: [] }, mkMap({ q1: 5 })), false);

// ─── C. evaluateScript() ─────────────────────────────────────────────────────
console.log('\n=== C. evaluateScript() - full scoring ===');

const scriptData = {
  scoring_rules: [
    {
      severity: 'high',
      conditions: [{ field: 'q1', op: 'gte', value: 7 }],
      needs_doctor: true,
      needs_family_alert: true,
    },
    {
      severity: 'medium',
      conditions: [{ field: 'q1', op: 'gte', value: 4 }],
      needs_doctor: false,
    },
    {
      severity: 'low',
      conditions: [{ field: 'q1', op: 'lt', value: 4 }],
    },
  ],
};

let res;

res = evaluateScript(scriptData, [{ question_id: 'q1', answer: 8 }]);
assert('slider 8 -> HIGH', res.severity, 'high');

res = evaluateScript(scriptData, [{ question_id: 'q1', answer: 5 }]);
assert('slider 5 -> MEDIUM', res.severity, 'medium');

res = evaluateScript(scriptData, [{ question_id: 'q1', answer: 2 }]);
assert('slider 2 -> LOW', res.severity, 'low');

res = evaluateScript({ scoring_rules: [
  { severity: 'high', conditions: [{ field: 'q1', op: 'eq', value: 999 }] },
] }, [{ question_id: 'q1', answer: 1 }]);
assert('no rules match -> default LOW', res.severity, 'low');

// First-match-wins test: order matters
const scriptOrdered = {
  scoring_rules: [
    {
      severity: 'medium',
      conditions: [{ field: 'q1', op: 'gte', value: 5 }],
    },
    {
      severity: 'high',
      conditions: [{ field: 'q1', op: 'gte', value: 5 }],
    },
  ],
};
res = evaluateScript(scriptOrdered, [{ question_id: 'q1', answer: 7 }]);
assert('first match wins (medium before high)', res.severity, 'medium');
assert('first match wins: matchedRuleIndex=0', res.matchedRuleIndex, 0);

// ─── D. applyModifiers() ─────────────────────────────────────────────────────
console.log('\n=== D. applyModifiers() ===');

const modifiers = [
  {
    user_condition: 'tiểu đường',
    action: 'bump_severity',
    to: 'high',
    extra_conditions: [{ field: 'q1', op: 'gte', value: 3 }],
  },
  {
    user_condition: 'tim mạch',
    action: 'bump_severity',
    to: 'high',
    extra_conditions: [{ field: 'q1', op: 'gte', value: 3 }],
  },
];

let modRes;

modRes = applyModifiers('medium', modifiers, mkMap({ q1: 5 }), ['tiểu đường']);
assert('tieu duong + slider 5 -> bump to HIGH', modRes.severity, 'high');

modRes = applyModifiers('medium', modifiers, mkMap({ q1: 4 }), ['tim mạch']);
assert('tim mach + slider 4 -> bump to HIGH', modRes.severity, 'high');

modRes = applyModifiers('medium', modifiers, mkMap({ q1: 5 }), ['cảm cúm']);
assert('cam cum (not in modifiers) -> no bump', modRes.severity, 'medium');

modRes = applyModifiers('high', [
  { user_condition: 'tiểu đường', action: 'bump_severity', to: 'medium' },
], mkMap({ q1: 5 }), ['tiểu đường']);
assert('modifier cant downgrade high->medium', modRes.severity, 'high');

// ─── E. evaluateFollowUp() ───────────────────────────────────────────────────
console.log('\n=== E. evaluateFollowUp() ===');

let fuRes;

fuRes = evaluateFollowUp({}, [
  { question_id: 'fu1', answer: 'Đỡ hơn' },
  { question_id: 'fu2', answer: 'Không' },
], 'medium');
assert('Do hon + Khong -> low', fuRes.severity, 'low');
assert('Do hon + Khong -> monitoring', fuRes.action, 'monitoring');

fuRes = evaluateFollowUp({}, [
  { question_id: 'fu1', answer: 'Nặng hơn' },
  { question_id: 'fu2', answer: 'Có' },
], 'medium');
assert('Nang hon + Co -> high', fuRes.severity, 'high');
assert('Nang hon + Co -> escalate', fuRes.action, 'escalate');

fuRes = evaluateFollowUp({}, [
  { question_id: 'fu1', answer: 'Vẫn vậy' },
  { question_id: 'fu2', answer: 'Không' },
], 'medium');
assert('Van vay + Khong -> same severity (medium)', fuRes.severity, 'medium');
assert('Van vay + Khong -> continue_followup', fuRes.action, 'continue_followup');

fuRes = evaluateFollowUp({}, [
  { question_id: 'fu1', answer: 'Đỡ hơn' },
  { question_id: 'fu2', answer: 'Có, triệu chứng mới' },
], 'medium');
assert('Do hon + Co (new symptoms) -> high', fuRes.severity, 'high');
assert('Do hon + Co (new symptoms) -> escalate', fuRes.action, 'escalate');

fuRes = evaluateFollowUp({}, [
  { question_id: 'fu1', answer: 'Vẫn vậy' },
  { question_id: 'fu2', answer: 'Không' },
], 'high');
assert('previousSeverity=high + Van vay -> high', fuRes.severity, 'high');
assert('previousSeverity=high + Van vay -> continue', fuRes.action, 'continue_followup');

// ─── F. Edge cases ───────────────────────────────────────────────────────────
console.log('\n=== F. Edge cases ===');

res = evaluateScript(scriptData, []);
assert('empty answers -> default LOW', res.severity, 'low');

res = evaluateScript(scriptData, [{ question_id: 'q1', answer: null }]);
assert('null answer -> default LOW (condition fails)', res.severity, 'low');

// String answer to numeric operator
res = evaluateCondition({ field: 'q1', op: 'gte', value: 5 }, mkMap({ q1: '7' }));
assert('string "7" gte 5 -> true (Number coercion)', res, true);

res = evaluateScript(scriptData, [{ question_id: 'q1', answer: 100 }]);
assert('very large slider (100) -> HIGH (gte 7)', res.severity, 'high');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════');
console.log(`TOTAL:  ${totalPass} PASS / ${totalFail} FAIL  (${totalPass + totalFail} tests)`);
console.log('════════════════════════════════════════\n');

process.exit(totalFail > 0 ? 1 : 0);
