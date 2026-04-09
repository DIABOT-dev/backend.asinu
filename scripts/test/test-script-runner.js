'use strict';
require('dotenv').config();

const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');

let passed = 0;
let failed = 0;
const results = [];

function assert(label, condition) {
  if (condition) {
    passed++;
    results.push(`  PASS: ${label}`);
  } else {
    failed++;
    results.push(`  FAIL: ${label}`);
  }
}

// ─── Test data ─────────────────────────────────────────────────────────────

const testScript = {
  greeting: "Test greeting",
  questions: [
    { id: "q1", text: "{Honorific} đau mức nào?", type: "slider", min: 0, max: 10 },
    { id: "q2", text: "Triệu chứng kèm?", type: "multi_choice", options: ["buồn nôn", "sốt", "không có"], skip_if: { field: "q1", op: "lt", value: 3 } },
    { id: "q3", text: "Từ khi nào?", type: "single_choice", options: ["vừa mới", "vài giờ", "từ sáng"] },
    { id: "q4", text: "Ghi chú thêm?", type: "free_text" },
  ],
  scoring_rules: [
    { conditions: [{ field: "q1", op: "gte", value: 7 }], combine: "and", severity: "high", follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
    { conditions: [{ field: "q1", op: "gte", value: 4 }], combine: "and", severity: "medium", follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
    { conditions: [], combine: "and", severity: "low", follow_up_hours: 6, needs_doctor: false, needs_family_alert: false },
  ],
  condition_modifiers: [],
  conclusion_templates: {
    low: { summary: "Nhẹ", recommendation: "Nghỉ ngơi", close_message: "{selfRef} hỏi lại sau" },
    medium: { summary: "Trung bình", recommendation: "Theo dõi", close_message: "Hẹn 3h" },
    high: { summary: "Nặng", recommendation: "Đi khám", close_message: "Hẹn 1h" },
  },
  followup_questions: [
    { id: "fu1", text: "Thế nào rồi?", type: "single_choice", options: ["Đỡ hơn", "Vẫn vậy", "Nặng hơn"] },
  ],
};

const profile = { birth_year: 1958, gender: 'Nam', full_name: 'Trần Văn Hùng' };

// ═══════════════════════════════════════════════════════════════════════════
// A. getNextQuestion() - basic flow
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== A. getNextQuestion() - basic flow ===');

// Empty answers → first question
const a1 = getNextQuestion(testScript, []);
assert('Empty answers → isDone=false', a1.isDone === false);
assert('Empty answers → currentStep=0', a1.currentStep === 0);
assert('Empty answers → returns first question (q1)', a1.question && a1.question.id === 'q1');

// 1 answer → second question (but q1=5 so q2 not skipped)
const a2 = getNextQuestion(testScript, [{ question_id: 'q1', answer: 5 }]);
assert('1 answer → currentStep=1', a2.currentStep === 1);
assert('1 answer → returns second question (q2)', a2.question && a2.question.id === 'q2');

// All questions answered → isDone=true with conclusion
const allAnswers = [
  { question_id: 'q1', answer: 8 },
  { question_id: 'q2', answer: 'sốt' },
  { question_id: 'q3', answer: 'vừa mới' },
  { question_id: 'q4', answer: 'đau nhiều' },
];
const a3 = getNextQuestion(testScript, allAnswers);
assert('All answered → isDone=true', a3.isDone === true);
assert('Conclusion has severity', a3.conclusion && typeof a3.conclusion.severity === 'string');
assert('Conclusion has followUpHours', a3.conclusion && typeof a3.conclusion.followUpHours === 'number');
assert('Conclusion has needsDoctor', a3.conclusion && typeof a3.conclusion.needsDoctor === 'boolean');
assert('Conclusion has summary', a3.conclusion && typeof a3.conclusion.summary === 'string');
assert('Conclusion has recommendation', a3.conclusion && typeof a3.conclusion.recommendation === 'string');
assert('Conclusion has closeMessage', a3.conclusion && typeof a3.conclusion.closeMessage === 'string');

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// B. Question types
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== B. Question types ===');

// slider
const b1 = getNextQuestion(testScript, []);
assert('slider: type=slider', b1.question.type === 'slider');
assert('slider: has min', b1.question.min === 0);
assert('slider: has max', b1.question.max === 10);

// multi_choice (q2)
const b2 = getNextQuestion(testScript, [{ question_id: 'q1', answer: 5 }]);
assert('multi_choice: type=multi_choice', b2.question.type === 'multi_choice');
assert('multi_choice: has options array', Array.isArray(b2.question.options) && b2.question.options.length === 3);

// single_choice (q3)
const b3 = getNextQuestion(testScript, [
  { question_id: 'q1', answer: 5 },
  { question_id: 'q2', answer: 'sốt' },
]);
assert('single_choice: type=single_choice', b3.question.type === 'single_choice');
assert('single_choice: has options array', Array.isArray(b3.question.options) && b3.question.options.length === 3);

// free_text (q4)
const b4 = getNextQuestion(testScript, [
  { question_id: 'q1', answer: 5 },
  { question_id: 'q2', answer: 'sốt' },
  { question_id: 'q3', answer: 'vừa mới' },
]);
assert('free_text: type=free_text', b4.question.type === 'free_text');

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// C. Skip logic
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== C. Skip logic ===');

// skip_if field/op/value: q1 < 3 → q2 skipped, should jump to q3
const c1 = getNextQuestion(testScript, [{ question_id: 'q1', answer: 2 }]);
assert('skip_if (q1<3): q2 skipped, next is q3', c1.question && c1.question.id === 'q3');

// skip_if condition NOT met: q1=5 >= 3 → q2 NOT skipped
const c2 = getNextQuestion(testScript, [{ question_id: 'q1', answer: 5 }]);
assert('skip_if condition not met: q2 NOT skipped', c2.question && c2.question.id === 'q2');

// skip_if with "any": skip if ANY condition true
const scriptWithAny = JSON.parse(JSON.stringify(testScript));
scriptWithAny.questions[1].skip_if = {
  any: [
    { field: "q1", op: "lt", value: 3 },
    { field: "q1", op: "gt", value: 9 },
  ],
};
const c3a = getNextQuestion(scriptWithAny, [{ question_id: 'q1', answer: 2 }]);
assert('skip_if any: first condition true → skipped', c3a.question && c3a.question.id === 'q3');
const c3b = getNextQuestion(scriptWithAny, [{ question_id: 'q1', answer: 10 }]);
assert('skip_if any: second condition true → skipped', c3b.question && c3b.question.id === 'q3');
const c3c = getNextQuestion(scriptWithAny, [{ question_id: 'q1', answer: 5 }]);
assert('skip_if any: no condition true → NOT skipped', c3c.question && c3c.question.id === 'q2');

// skip_if with "all": skip if ALL conditions true
const scriptWithAll = JSON.parse(JSON.stringify(testScript));
scriptWithAll.questions[1].skip_if = {
  all: [
    { field: "q1", op: "lt", value: 5 },
    { field: "q1", op: "gt", value: 1 },
  ],
};
const c4a = getNextQuestion(scriptWithAll, [{ question_id: 'q1', answer: 3 }]);
assert('skip_if all: both true (3<5 && 3>1) → skipped', c4a.question && c4a.question.id === 'q3');
const c4b = getNextQuestion(scriptWithAll, [{ question_id: 'q1', answer: 6 }]);
assert('skip_if all: one false (6 not <5) → NOT skipped', c4b.question && c4b.question.id === 'q2');

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// D. Text personalization
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== D. Text personalization ===');

// Test {Honorific} in q1 text
const d1 = getNextQuestion(testScript, [], { profile });
assert('{Honorific} → "Chú"', d1.question.text.startsWith('Chú'));
assert('{Honorific} replaced correctly', d1.question.text === 'Chú đau mức nào?');

// Test {selfRef} in conclusion close_message (low severity)
const lowAnswers = [
  { question_id: 'q1', answer: 1 },
  { question_id: 'q2', answer: null, skipped: true },
  { question_id: 'q3', answer: 'vừa mới' },
  { question_id: 'q4', answer: 'ok' },
];
const d2 = getNextQuestion(testScript, lowAnswers, { profile });
assert('{selfRef} → "cháu"', d2.conclusion && d2.conclusion.closeMessage.includes('cháu'));

// Test {honorific} (lowercase)
const honorificScript = JSON.parse(JSON.stringify(testScript));
honorificScript.questions[0].text = '{honorific} có khỏe không?';
const d3 = getNextQuestion(honorificScript, [], { profile });
assert('{honorific} → "chú"', d3.question.text === 'chú có khỏe không?');

// Test {callName}
const callNameScript = JSON.parse(JSON.stringify(testScript));
callNameScript.questions[0].text = 'Chào {callName}!';
const d4 = getNextQuestion(callNameScript, [], { profile });
assert('{callName} → "chú Hùng"', d4.question.text === 'Chào chú Hùng!');

// Test {CallName} (capitalized)
const callNameCapScript = JSON.parse(JSON.stringify(testScript));
callNameCapScript.questions[0].text = '{CallName} ơi!';
const d5 = getNextQuestion(callNameCapScript, [], { profile });
assert('{CallName} → "Chú Hùng"', d5.question.text === 'Chú Hùng ơi!');

// Missing profile → defaults (no profile passed)
const d6 = getNextQuestion(testScript, []);
// Without profile, honorific defaults to "bạn", Honorific to "Bạn"
assert('Missing profile → uses default honorific', d6.question.text === 'Bạn đau mức nào?');

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// E. Follow-up session
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== E. Follow-up session ===');

// followup uses followup_questions
const e1 = getNextQuestion(testScript, [], { sessionType: 'followup' });
assert('followup: returns fu1 question', e1.question && e1.question.id === 'fu1');
assert('followup: totalSteps=1', e1.totalSteps === 1);

// followup conclusion
const e2 = getNextQuestion(testScript, [{ question_id: 'fu1', answer: 'Đỡ hơn' }], { sessionType: 'followup', previousSeverity: 'medium' });
assert('followup: isDone=true after all answered', e2.isDone === true);
assert('followup conclusion has severity', e2.conclusion && typeof e2.conclusion.severity === 'string');
assert('followup conclusion has action', e2.conclusion && typeof e2.conclusion.action === 'string');

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// F. validateScript()
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== F. validateScript() ===');

// Valid script
const f1 = validateScript(testScript);
assert('Valid script → valid=true', f1.valid === true);
assert('Valid script → errors empty', f1.errors.length === 0);

// Missing questions
const f2 = validateScript({ scoring_rules: [], conclusion_templates: {} });
assert('Missing questions → error', f2.valid === false && f2.errors.some(e => e.includes('questions')));

// Missing question id
const f3 = validateScript({ questions: [{ text: 'x', type: 'free_text' }], scoring_rules: [], conclusion_templates: {} });
assert('Missing question id → error', f3.valid === false && f3.errors.some(e => e.includes('id')));

// Missing question text
const f4 = validateScript({ questions: [{ id: 'q1', type: 'free_text' }], scoring_rules: [], conclusion_templates: {} });
assert('Missing question text → error', f4.valid === false && f4.errors.some(e => e.includes('text')));

// Missing question type
const f5 = validateScript({ questions: [{ id: 'q1', text: 'x' }], scoring_rules: [], conclusion_templates: {} });
assert('Missing question type → error', f5.valid === false && f5.errors.some(e => e.includes('type')));

// single_choice without options
const f6 = validateScript({ questions: [{ id: 'q1', text: 'x', type: 'single_choice' }], scoring_rules: [], conclusion_templates: {} });
assert('single_choice without options → error', f6.valid === false && f6.errors.some(e => e.includes('options')));

// slider without min/max
const f7 = validateScript({ questions: [{ id: 'q1', text: 'x', type: 'slider' }], scoring_rules: [], conclusion_templates: {} });
assert('slider without min/max → error', f7.valid === false && f7.errors.some(e => e.includes('min') || e.includes('max')));

// Missing scoring_rules
const f8 = validateScript({ questions: [{ id: 'q1', text: 'x', type: 'free_text' }], conclusion_templates: {} });
assert('Missing scoring_rules → error', f8.valid === false && f8.errors.some(e => e.includes('scoring_rules')));

// Missing conclusion_templates
const f9 = validateScript({ questions: [{ id: 'q1', text: 'x', type: 'free_text' }], scoring_rules: [] });
assert('Missing conclusion_templates → error', f9.valid === false && f9.errors.some(e => e.includes('conclusion_templates')));

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// G. Edge cases
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== G. Edge cases ===');

// Script with 0 questions → isDone immediately
const emptyScript = JSON.parse(JSON.stringify(testScript));
emptyScript.questions = [];
const g1 = getNextQuestion(emptyScript, []);
assert('0 questions → isDone=true immediately', g1.isDone === true);

// Answer with null value → handled (doesn't crash)
let g2error = false;
try {
  getNextQuestion(testScript, [{ question_id: 'q1', answer: null }]);
} catch (e) {
  g2error = true;
}
assert('Answer with null value → no crash', !g2error);

// Extra answers beyond question count → isDone
const extraAnswers = [
  { question_id: 'q1', answer: 5 },
  { question_id: 'q2', answer: 'sốt' },
  { question_id: 'q3', answer: 'vừa mới' },
  { question_id: 'q4', answer: 'ok' },
  { question_id: 'q5', answer: 'extra' },
];
const g3 = getNextQuestion(testScript, extraAnswers);
assert('Extra answers → isDone=true', g3.isDone === true);

results.forEach(r => console.log(r));
results.length = 0;

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════');
console.log(`TOTAL: ${passed + failed} tests | PASSED: ${passed} | FAILED: ${failed}`);
console.log('═══════════════════════════════════════');
if (failed > 0) {
  process.exit(1);
}
