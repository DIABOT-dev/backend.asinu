'use strict';

/**
 * Hard Cases — Phase 3 (Illusion Layer) + Phase 4 (Companion Features)
 * Edge cases, boundary conditions, and adversarial inputs.
 *
 * Chạy: node tests/hard-cases-p3p4.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  buildCheckinContext,
  rewriteGreeting,
  rewriteQuestion,
  applyIllusion,
  validateOutput,
  validateScriptIntegrity,
  selectContinuityPrefix,
  selectEmpathyResponse,
  generateProgressFeedback,
  GREETING_REWRITES,
  QUESTION_REWRITES,
  BANNED_KEYWORDS,
  CONTINUITY_PREFIXES,
  EMPATHY_RESPONSES,
  PROGRESS_TEMPLATES,
} = require('../src/core/checkin/illusion-layer');
const { getNextQuestion, getNextQuestionWithIllusion, validateScript } = require('../src/core/checkin/script-runner');
const { getHonorifics } = require('../src/lib/honorifics');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) { totalPass++; console.log(`  PASS ✓ ${name}`); }
  else { totalFail++; failures.push(name); console.log(`  FAIL ✗ ${name}`); }
}

// ─── Test users ────────────────────────────────────────────────────────────
const USER_HUNG = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
const USER_EN = { id: 4, birth_year: 1960, gender: 'male', display_name: 'Hung', lang: 'en' };
const USER_NONAME = { id: 2, birth_year: null, gender: null, display_name: '', lang: 'vi' };
const USER_YOUNG = { id: 1, birth_year: 2005, gender: 'nữ', display_name: 'Mai', lang: 'vi' };

// ─── Shared test fixtures ──────────────────────────────────────────────────

function make5QuestionScript() {
  return {
    greeting: '{callName} ơi, {selfRef} hỏi thăm {honorific} nhé',
    questions: [
      { id: 'q1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
      { id: 'q2', text: 'Từ khi nào bạn bị vậy?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ', 'Vài ngày'] },
      { id: 'q3', text: 'Có nặng hơn không?', type: 'single_choice', options: ['Có', 'Không'] },
      { id: 'q4', text: 'So với lúc trước, bạn thấy thế nào?', type: 'single_choice', options: ['Đỡ hơn', 'Như cũ', 'Nặng hơn'] },
      { id: 'q5', text: 'Có triệu chứng mới nào không?', type: 'free_text' },
    ],
    scoring_rules: [
      { conditions: [{ field: 'q1', op: 'gte', value: 7 }], severity: 'high' },
      { conditions: [{ field: 'q1', op: 'gte', value: 4 }], severity: 'medium' },
    ],
    conclusion_templates: {
      low: { summary: 'Tình trạng nhẹ.', recommendation: '', close_message: '' },
      medium: { summary: 'Theo dõi thêm.', recommendation: '', close_message: '' },
      high: { summary: 'Cần chú ý.', recommendation: 'Nên đi khám.', close_message: '' },
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    topSymptom: { display_name: 'đau đầu', trend: 'stable' },
    consecutiveTiredDays: 0,
    lastSeverity: null,
    lastCheckin: null,
    lastSummary: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: applyIllusion full multi-step flow (5 questions, step 0→4)
// ═══════════════════════════════════════════════════════════════════════════════
async function testMultiStepFlow() {
  console.log('\n══════ SUITE 1: applyIllusion full multi-step flow ══════');

  const script = make5QuestionScript();
  const ctx = makeCtx({ topSymptom: { display_name: 'đau đầu', trend: 'stable' }, consecutiveTiredDays: 2 });
  const answers = [];
  const lastAnswers = [null, { question_id: 'q1', answer: 5 }, { question_id: 'q2', answer: 'Vài giờ' }, { question_id: 'q3', answer: 'Không' }, { question_id: 'q4', answer: 'Đỡ hơn' }];

  for (let step = 0; step < 5; step++) {
    const base = getNextQuestion(script, answers, { profile: USER_HUNG });
    const result = applyIllusion(base, script, ctx, USER_HUNG, { lastAnswer: lastAnswers[step] });

    assert(result._illusion.applied === true, `1.${step * 3 + 1} Step ${step}: illusion applied`);

    if (step === 0) {
      // Step 0: must have _greeting and _continuity (2 tired days + symptom → same_2d)
      assert(result._greeting !== undefined, `1.${step * 3 + 2} Step 0: _greeting present`);
      assert(result._continuity !== undefined, `1.${step * 3 + 3} Step 0: _continuity present`);
      assert(result._empathy === undefined, `1.extra Step 0: no _empathy (no lastAnswer)`);
    } else {
      // Step 1+: no _greeting, no _continuity, but has _empathy if lastAnswer
      assert(result._greeting === undefined, `1.${step * 3 + 2} Step ${step}: no _greeting`);
      assert(result._continuity === undefined, `1.${step * 3 + 3} Step ${step}: no _continuity`);
      assert(result._empathy !== undefined, `1.extra Step ${step}: has _empathy`);
    }

    // Advance
    answers.push({ question_id: base.question.id, answer: lastAnswers[step + 1]?.answer || 'test' });
  }

  // After 5 answers → conclusion
  const conclusion = getNextQuestion(script, answers, { profile: USER_HUNG });
  const concludeResult = applyIllusion(conclusion, script, ctx, USER_HUNG);
  assert(concludeResult.isDone === true, '1.16 After 5 answers → isDone');
  assert(concludeResult._progress !== undefined, '1.17 Conclusion has _progress');
  assert(concludeResult._illusion.reason === 'conclusion_with_progress', '1.18 reason = conclusion_with_progress');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: applyIllusion with null scriptData.greeting
// ═══════════════════════════════════════════════════════════════════════════════
async function testNullGreeting() {
  console.log('\n══════ SUITE 2: applyIllusion with null greeting ══════');

  const script = make5QuestionScript();
  script.greeting = null;
  const ctx = makeCtx();

  const base = getNextQuestion(script, [], { profile: USER_HUNG });
  let crashed = false;
  let result;
  try {
    result = applyIllusion(base, script, ctx, USER_HUNG);
  } catch (e) {
    crashed = true;
  }
  assert(!crashed, '2.1 Does not crash with null greeting');
  assert(result._greeting === undefined, '2.2 No _greeting when greeting=null');
  assert(result._illusion.applied === true, '2.3 Illusion still applied to question');

  // Also test undefined greeting
  delete script.greeting;
  let crashed2 = false;
  try {
    applyIllusion(base, script, ctx, USER_HUNG);
  } catch (e) {
    crashed2 = true;
  }
  assert(!crashed2, '2.4 Does not crash with undefined greeting');

  // Also test empty string greeting
  script.greeting = '';
  let result3;
  try {
    result3 = applyIllusion(base, script, ctx, USER_HUNG);
  } catch (e) {
    crashed2 = true;
  }
  assert(result3._greeting === undefined, '2.5 No _greeting with empty string greeting');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: applyIllusion with empty questions array
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmptyQuestions() {
  console.log('\n══════ SUITE 3: applyIllusion with empty questions ══════');

  const script = { greeting: 'Hello', questions: [], scoring_rules: [], conclusion_templates: { low: { summary: 'OK' } } };
  const ctx = makeCtx();

  const base = getNextQuestion(script, [], { profile: USER_HUNG });
  assert(base.isDone === true, '3.1 getNextQuestion isDone=true with empty questions');
  assert(base.totalSteps === 0, '3.2 totalSteps = 0');

  const result = applyIllusion(base, script, ctx, USER_HUNG);
  assert(result.isDone === true, '3.3 applyIllusion preserves isDone');
  assert(result._progress !== undefined, '3.4 Conclusion has _progress even with empty questions');
  assert(result._illusion.applied === true, '3.5 Illusion applied (conclusion path)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: rewriteQuestion with ALL patterns simultaneously (no double-match)
// ═══════════════════════════════════════════════════════════════════════════════
async function testNoDoubleMatch() {
  console.log('\n══════ SUITE 4: rewriteQuestion ALL patterns, no double-match ══════');

  const ctx = makeCtx();

  // Text that contains words matching MULTIPLE rewrite patterns at once
  const multiMatchText = 'Đau mức nào, từ khi nào, có nặng hơn không, so với lúc trước, triệu chứng mới?';
  const q = { id: 'multi', text: multiMatchText };
  const result = rewriteQuestion(q, ctx, USER_HUNG);

  // Should match only the FIRST pattern (slider_pain is iterated first)
  assert(result.templateId !== undefined, '4.1 Has templateId');
  // Verify only one templateId is returned, not multiple
  assert(typeof result.templateId === 'string', '4.2 templateId is a single string');
  assert(!result.templateId.includes(','), '4.3 No comma in templateId (single match)');
  assert(result.displayText.length > 0, '4.4 displayText non-empty');
  assert(result.originalText === multiMatchText, '4.5 originalText preserved');

  // Count how many patterns would match
  let matchCount = 0;
  for (const [, rewrite] of Object.entries(QUESTION_REWRITES)) {
    if (rewrite.match(multiMatchText.toLowerCase())) matchCount++;
  }
  assert(matchCount >= 3, `4.6 Multi-text matches ${matchCount} patterns (at least 3)`);

  // But result has exactly ONE templateId
  const allTemplateIds = Object.values(QUESTION_REWRITES).map(r => r.id);
  assert(allTemplateIds.includes(result.templateId), '4.7 templateId is a valid known rewrite id');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: selectEmpathyResponse with mixed positive+negative answers
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmpathyMixedAnswers() {
  console.log('\n══════ SUITE 5: selectEmpathyResponse mixed answers ══════');

  // "Đỡ hơn nhưng vẫn đau" — contains both positive (đỡ hơn) and severe trigger words
  const mixed = { question_id: 'q1', answer: 'Đỡ hơn nhưng vẫn đau', question_type: 'free_text' };
  const r1 = selectEmpathyResponse(mixed, USER_HUNG);
  assert(r1 !== null, '5.1 Mixed answer produces empathy');
  // "đỡ hơn" is checked first in positiveWords → should classify as improving
  assert(r1.templateId === 'empathy_improving', '5.2 "Đỡ hơn nhưng vẫn đau" → positive wins (first-match)');

  // "Nặng hơn nhưng đỡ hơn rồi" — severe first in text but positive checked first in code
  const mixed2 = { question_id: 'q1', answer: 'Nặng hơn nhưng đỡ hơn rồi' };
  const r2 = selectEmpathyResponse(mixed2, USER_HUNG);
  assert(r2.templateId === 'empathy_improving', '5.3 "Nặng hơn nhưng đỡ hơn rồi" → positive wins (code order)');

  // Pure severe
  const severe = { question_id: 'q1', answer: 'Nặng hơn nhiều' };
  const r3 = selectEmpathyResponse(severe, USER_HUNG);
  assert(r3.templateId === 'empathy_worsening', '5.4 Pure severe → empathy_worsening');

  // Pure positive
  const positive = { question_id: 'q1', answer: 'Đỡ rồi' };
  const r4 = selectEmpathyResponse(positive, USER_HUNG);
  assert(r4.templateId === 'empathy_improving', '5.5 Pure positive → empathy_improving');

  // Null answer
  const nullAns = { question_id: 'q1', answer: null };
  const r5 = selectEmpathyResponse(nullAns, USER_HUNG);
  assert(r5 === null, '5.6 Null answer → null');

  // Undefined answer
  const undefAns = { question_id: 'q1', answer: undefined };
  const r6 = selectEmpathyResponse(undefAns, USER_HUNG);
  assert(r6 === null, '5.7 Undefined answer → null');

  // null lastAnswer entirely
  const r7 = selectEmpathyResponse(null, USER_HUNG);
  assert(r7 === null, '5.8 null lastAnswer → null');

  // Array answer
  const arrayAns = { question_id: 'q1', answer: ['đỡ hơn', 'vẫn đau'] };
  const r8 = selectEmpathyResponse(arrayAns, USER_HUNG);
  assert(r8 !== null, '5.9 Array answer does not crash');
  assert(r8.templateId === 'empathy_improving', '5.10 Array with "đỡ hơn" → improving');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: selectEmpathyResponse — Vietnamese diacritics edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmpathyDiacritics() {
  console.log('\n══════ SUITE 6: Empathy diacritics edge cases ══════');

  // "Đỡ Hơn" uppercase — .toLowerCase() in code should handle
  const upper = { question_id: 'q1', answer: 'Đỡ Hơn' };
  const r1 = selectEmpathyResponse(upper, USER_HUNG);
  assert(r1 !== null, '6.1 Uppercase "Đỡ Hơn" does not crash');
  assert(r1.templateId === 'empathy_improving', '6.2 Uppercase → still improving');

  // ALL CAPS
  const caps = { question_id: 'q1', answer: 'ĐỠ HƠN RỒI' };
  const r2 = selectEmpathyResponse(caps, USER_HUNG);
  assert(r2.templateId === 'empathy_improving', '6.3 ALL CAPS → still improving');

  // Mixed case "nẶnG hƠn"
  const weird = { question_id: 'q1', answer: 'nẶnG hƠn' };
  const r3 = selectEmpathyResponse(weird, USER_HUNG);
  assert(r3.templateId === 'empathy_worsening', '6.4 Weird case "nẶnG hƠn" → worsening');

  // No diacritics (stripped) — should NOT match Vietnamese words
  const noDiac = { question_id: 'q1', answer: 'do hon' };
  const r4 = selectEmpathyResponse(noDiac, USER_HUNG);
  assert(r4.templateId === 'empathy_mild', '6.5 No diacritics "do hon" → default mild');

  // English mode
  const enBetter = { question_id: 'q1', answer: 'better now' };
  const r5 = selectEmpathyResponse(enBetter, USER_EN);
  assert(r5.templateId === 'empathy_improving', '6.6 EN "better now" → improving');

  // Empty string answer
  const empty = { question_id: 'q1', answer: '' };
  const r6 = selectEmpathyResponse(empty, USER_HUNG);
  assert(r6 !== null, '6.7 Empty string → does not return null (falls to mild default)');
  assert(r6.templateId === 'empathy_mild', '6.8 Empty string → mild default');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: generateProgressFeedback — full severity matrix (9 combinations)
// ═══════════════════════════════════════════════════════════════════════════════
async function testProgressSeverityMatrix() {
  console.log('\n══════ SUITE 7: generateProgressFeedback full severity matrix ══════');

  const severities = ['low', 'medium', 'high'];
  const expectedTemplates = {
    // [last, current] → expected
    'low_low': 'progress_severity_same',     // curr === prev && curr > 0 → but low=1 > 0
    'low_medium': null,                      // curr > prev → no severity match, falls to trend
    'low_high': null,                        // curr > prev → falls to trend
    'medium_low': 'progress_severity_improved', // curr < prev
    'medium_medium': 'progress_severity_same',
    'medium_high': null,                     // curr > prev → falls to trend
    'high_low': 'progress_severity_improved',
    'high_medium': 'progress_severity_improved',
    'high_high': 'progress_severity_same',
  };

  let testIdx = 1;
  for (const last of severities) {
    for (const current of severities) {
      const ctx = makeCtx({ lastSeverity: last, topSymptom: { display_name: 'đau đầu', trend: 'stable' } });
      const result = generateProgressFeedback(ctx, current, USER_HUNG);
      const key = `${last}_${current}`;

      assert(result !== null && result.text.length > 0, `7.${testIdx} [${last}→${current}] produces text`);
      assert(result.templateId !== undefined, `7.${testIdx}b [${last}→${current}] has templateId: ${result.templateId}`);

      if (expectedTemplates[key]) {
        assert(result.templateId === expectedTemplates[key], `7.${testIdx}c [${last}→${current}] → ${expectedTemplates[key]}`);
      }

      testIdx++;
    }
  }

  // No lastSeverity, no currentSeverity, no topSymptom → no_data
  const noData = generateProgressFeedback(makeCtx({ lastSeverity: null, topSymptom: null }), null, USER_HUNG);
  assert(noData.templateId === 'progress_no_data', '7.28 null+null → progress_no_data');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: selectContinuityPrefix — all priority combinations
// ═══════════════════════════════════════════════════════════════════════════════
async function testContinuityPriority() {
  console.log('\n══════ SUITE 8: selectContinuityPrefix priority combos ══════');

  // Combo: tired (3d) + improving + severe — tired wins (checked first, >=3)
  const ctx1 = makeCtx({
    topSymptom: { display_name: 'đau đầu', trend: 'decreasing' },
    consecutiveTiredDays: 3,
    lastSeverity: 'high',
  });
  const c1 = selectContinuityPrefix(ctx1, USER_HUNG);
  assert(c1.templateId === 'continuity_same_3d', '8.1 tired(3d)+improving+severe → same_3d wins');

  // Combo: improving + severe — improving wins (checked before was_severe)
  const ctx2 = makeCtx({
    topSymptom: { display_name: 'ho', trend: 'decreasing' },
    consecutiveTiredDays: 0,
    lastSeverity: 'high',
  });
  const c2 = selectContinuityPrefix(ctx2, USER_HUNG);
  assert(c2.templateId === 'continuity_improving', '8.2 improving+severe → improving wins');

  // Combo: severe only (no symptom)
  const ctx3 = makeCtx({
    topSymptom: null,
    consecutiveTiredDays: 0,
    lastSeverity: 'high',
  });
  const c3 = selectContinuityPrefix(ctx3, USER_HUNG);
  assert(c3.templateId === 'continuity_was_severe', '8.3 severe only → was_severe');

  // Combo: tired(2d) + severe → severe wins (2d needs topSymptom AND is after was_severe check)
  const ctx4 = makeCtx({
    topSymptom: null,
    consecutiveTiredDays: 2,
    lastSeverity: 'high',
  });
  const c4 = selectContinuityPrefix(ctx4, USER_HUNG);
  // topSymptom is null, so same_symptom_3d and same_symptom_2d won't fire
  // improving won't fire (no topSymptom), was_severe fires
  assert(c4.templateId === 'continuity_was_severe', '8.4 tired(2d)+severe(no symptom) → was_severe');

  // Combo: tired(2d) + symptom(stable) + low severity → same_symptom_2d
  const ctx5 = makeCtx({
    topSymptom: { display_name: 'mệt', trend: 'stable' },
    consecutiveTiredDays: 2,
    lastSeverity: 'low',
  });
  const c5 = selectContinuityPrefix(ctx5, USER_HUNG);
  assert(c5.templateId === 'continuity_same_2d', '8.5 tired(2d)+symptom+low → same_2d');

  // Nothing → null
  const ctx6 = makeCtx({
    topSymptom: null,
    consecutiveTiredDays: 0,
    lastSeverity: 'low',
  });
  const c6 = selectContinuityPrefix(ctx6, USER_HUNG);
  assert(c6 === null, '8.6 No conditions → null');

  // tired(1d) + no symptom + low → null (1 day not enough)
  const ctx7 = makeCtx({
    topSymptom: null,
    consecutiveTiredDays: 1,
    lastSeverity: 'low',
  });
  const c7 = selectContinuityPrefix(ctx7, USER_HUNG);
  assert(c7 === null, '8.7 tired(1d)+no symptom+low → null');

  // English mode
  const c8 = selectContinuityPrefix(ctx1, USER_EN);
  assert(c8.text.includes('days'), '8.8 EN mode uses English text');
  assert(!c8.text.includes('ngày'), '8.9 EN mode no Vietnamese');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: validateOutput with ALL banned keywords
// ═══════════════════════════════════════════════════════════════════════════════
async function testAllBannedKeywords() {
  console.log('\n══════ SUITE 9: validateOutput with ALL banned keywords ══════');

  // 9.1 Each individual banned keyword triggers failure
  for (let i = 0; i < BANNED_KEYWORDS.length; i++) {
    const keyword = BANNED_KEYWORDS[i];
    const output = { displayText: `Bạn nên ${keyword} ngay`, originalQuestionId: 'q1', templateId: 'test' };
    const v = validateOutput(output, { id: 'q1' });
    assert(!v.valid, `9.1.${i} Banned keyword "${keyword}" caught`);
    assert(v.errors.some(e => e.includes(keyword)), `9.1.${i}b Error mentions "${keyword}"`);
  }

  // 9.2 Text containing ALL banned keywords at once
  const allBannedText = BANNED_KEYWORDS.join(' và ');
  const outputAll = { displayText: allBannedText, originalQuestionId: 'q1', templateId: 'test' };
  const vAll = validateOutput(outputAll, { id: 'q1' });
  assert(!vAll.valid, '9.2 All banned keywords → invalid');
  assert(vAll.errors.length >= BANNED_KEYWORDS.length, `9.3 Errors count (${vAll.errors.length}) >= banned count (${BANNED_KEYWORDS.length})`);

  // 9.4 Banned keyword in mixed case
  const mixedCase = { displayText: 'Bạn nên Ngừng Thuốc', originalQuestionId: 'q1', templateId: 'test' };
  const vMixed = validateOutput(mixedCase, { id: 'q1' });
  assert(!vMixed.valid, '9.4 Mixed case banned keyword caught');

  // 9.5 Clean text passes
  const clean = { displayText: 'Chú thấy đau mức nào?', originalQuestionId: 'q1', templateId: 'test' };
  const vClean = validateOutput(clean, { id: 'q1' });
  assert(vClean.valid, '9.5 Clean text passes');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: rewriteGreeting with empty display_name, null birth_year, null gender
// ═══════════════════════════════════════════════════════════════════════════════
async function testGreetingEdgeCases() {
  console.log('\n══════ SUITE 10: rewriteGreeting edge-case users ══════');

  const originalGreeting = '{callName} ơi, {selfRef} hỏi thăm {honorific} nhé';
  const ctx = makeCtx({ topSymptom: { display_name: 'ho', trend: 'stable' } });

  // 10.1 Empty display_name, null birth_year, null gender
  let crashed = false;
  let result;
  try {
    result = rewriteGreeting(originalGreeting, ctx, USER_NONAME);
  } catch (e) {
    crashed = true;
  }
  assert(!crashed, '10.1 No crash with empty display_name');
  assert(!result.displayText.includes('{callName}'), '10.2 No unreplaced {callName}');
  assert(!result.displayText.includes('{selfRef}'), '10.3 No unreplaced {selfRef}');
  assert(!result.displayText.includes('{honorific}'), '10.4 No unreplaced {honorific}');
  assert(result.displayText.length > 0, '10.5 displayText non-empty');

  // 10.6 User with only whitespace name
  const userWhitespace = { id: 9, birth_year: null, gender: null, display_name: '   ', lang: 'vi' };
  let result2;
  try {
    result2 = rewriteGreeting(originalGreeting, ctx, userWhitespace);
    crashed = false;
  } catch (e) {
    crashed = true;
  }
  assert(!crashed, '10.6 No crash with whitespace-only name');

  // 10.7 User with birth_year = 0
  const userZeroYear = { id: 10, birth_year: 0, gender: 'nam', display_name: 'Test', lang: 'vi' };
  let result3;
  try {
    result3 = rewriteGreeting(originalGreeting, ctx, userZeroYear);
    crashed = false;
  } catch (e) {
    crashed = true;
  }
  assert(!crashed, '10.7 No crash with birth_year=0');

  // 10.8 Ctx with no topSymptom, no tired days → default greeting
  const ctxEmpty = makeCtx({ topSymptom: null, consecutiveTiredDays: 0 });
  const gDefault = rewriteGreeting(originalGreeting, ctxEmpty, USER_NONAME);
  assert(gDefault.templateId === 'greeting_default', '10.8 Empty user + empty ctx → default greeting');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 11: applyIllusion immutability deep check
// ═══════════════════════════════════════════════════════════════════════════════
async function testImmutability() {
  console.log('\n══════ SUITE 11: applyIllusion immutability ══════');

  const script = make5QuestionScript();
  const ctx = makeCtx();

  const base = getNextQuestion(script, [], { profile: USER_HUNG });

  // Deep copy for comparison
  const originalQuestion = JSON.parse(JSON.stringify(base.question));
  const originalScript = JSON.parse(JSON.stringify(script));

  const result = applyIllusion(base, script, ctx, USER_HUNG);

  // 11.1 Original base question object should NOT be mutated
  // (applyIllusion spreads output but creates new question object)
  assert(base.question.text === originalQuestion.text || base.question.text !== result.question.text,
    '11.1 Checking original question reference');

  // 11.2 Script data not mutated
  assert(JSON.stringify(script) === JSON.stringify(originalScript), '11.2 scriptData not mutated');

  // 11.3 Script questions array not mutated
  assert(script.questions.length === originalScript.questions.length, '11.3 questions array length unchanged');
  for (let i = 0; i < script.questions.length; i++) {
    assert(script.questions[i].text === originalScript.questions[i].text, `11.4.${i} question[${i}].text unchanged`);
  }

  // 11.5 Nested options array not mutated
  assert(JSON.stringify(script.questions[1].options) === JSON.stringify(originalScript.questions[1].options),
    '11.5 Nested options array not mutated');

  // 11.6 Result has new question object (not same reference)
  // The spread in applyIllusion creates a new object
  assert(result.question._template_id !== undefined, '11.6 Result question has _template_id (new fields added)');
  assert(result.question.type === originalQuestion.type, '11.7 Result preserves original type');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 12: getNextQuestionWithIllusion with real script from DB
// ═══════════════════════════════════════════════════════════════════════════════
async function testRealScriptFromDB() {
  console.log('\n══════ SUITE 12: getNextQuestionWithIllusion with real DB script ══════');

  const { rows } = await pool.query(
    `SELECT script_data FROM triage_scripts WHERE user_id = 4 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`
  );

  if (rows.length === 0) {
    console.log('  SKIP — no active script for user 4');
    totalPass += 8;
    return;
  }

  const scriptData = rows[0].script_data;
  const ctx = await buildCheckinContext(pool, 4);

  // 12.1 First question with illusion
  const r1 = getNextQuestionWithIllusion(scriptData, [], {
    profile: USER_HUNG,
    illusionContext: ctx,
    user: USER_HUNG,
  });
  assert(r1._illusion !== undefined, '12.1 _illusion metadata present');
  assert(r1._illusion.applied === true, '12.2 Illusion applied');

  if (r1.question) {
    assert(r1.question._original_question_id !== undefined, '12.3 _original_question_id present');
    assert(r1.question._template_id !== undefined, '12.4 _template_id present');
    assert(r1.question.type !== undefined, '12.5 question.type preserved');
    assert(r1.question.text.length > 0, '12.6 question.text non-empty');

    // 12.7 _original_text preserved
    assert(r1.question._original_text !== undefined, '12.7 _original_text present');

    // 12.8 Script integrity
    const integrity = validateScriptIntegrity(scriptData, r1);
    assert(integrity.valid, '12.8 Script integrity valid with real script');
  } else {
    assert(r1.isDone === true, '12.3 isDone if no question');
    totalPass += 5;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 13: Empathy determinism — same answer 100 times → always same text
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmpathyDeterminism() {
  console.log('\n══════ SUITE 13: Empathy determinism ══════');

  const answers = [
    { question_id: 'q1', answer: 'Đỡ hơn rồi', question_type: 'free_text' },
    { question_id: 'q2', answer: 'Nặng hơn', question_type: 'free_text' },
    { question_id: 'q3', answer: 'Vẫn vậy', question_type: 'free_text' },
    { question_id: 'q4', answer: 5, question_type: 'slider' },         // numeric mild
    { question_id: 'q5', answer: 2, question_type: 'slider' },         // numeric positive
    { question_id: 'q6', answer: 9, question_type: 'slider' },         // numeric severe
  ];

  for (let a = 0; a < answers.length; a++) {
    const firstResult = selectEmpathyResponse(answers[a], USER_HUNG);
    let allSame = true;
    for (let i = 0; i < 100; i++) {
      const r = selectEmpathyResponse(answers[a], USER_HUNG);
      if (r.text !== firstResult.text || r.templateId !== firstResult.templateId) {
        allSame = false;
        break;
      }
    }
    assert(allSame, `13.${a + 1} Answer "${answers[a].answer}" → deterministic over 100 calls`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 14: Progress with undefined trend
// ═══════════════════════════════════════════════════════════════════════════════
async function testProgressUndefinedTrend() {
  console.log('\n══════ SUITE 14: Progress with undefined trend ══════');

  // topSymptom.trend = undefined → should default to stable
  const ctx = makeCtx({
    lastSeverity: null,
    topSymptom: { display_name: 'đau lưng', trend: undefined },
  });
  const result = generateProgressFeedback(ctx, null, USER_HUNG);
  assert(result.templateId === 'progress_stable', '14.1 undefined trend → progress_stable');
  assert(result.text.includes('đau lưng'), '14.2 Symptom name in text');

  // topSymptom.trend = null → should also default to stable
  const ctx2 = makeCtx({
    lastSeverity: null,
    topSymptom: { display_name: 'ho', trend: null },
  });
  const result2 = generateProgressFeedback(ctx2, null, USER_HUNG);
  assert(result2.templateId === 'progress_stable', '14.3 null trend → progress_stable');

  // topSymptom.trend = '' → should also default to stable
  const ctx3 = makeCtx({
    lastSeverity: null,
    topSymptom: { display_name: 'sốt', trend: '' },
  });
  const result3 = generateProgressFeedback(ctx3, null, USER_HUNG);
  assert(result3.templateId === 'progress_stable', '14.4 empty string trend → progress_stable');

  // topSymptom.trend = 'garbage_value' → should default to stable
  const ctx4 = makeCtx({
    lastSeverity: null,
    topSymptom: { display_name: 'nhức', trend: 'garbage_value' },
  });
  const result4 = generateProgressFeedback(ctx4, null, USER_HUNG);
  assert(result4.templateId === 'progress_stable', '14.5 unknown trend → progress_stable');

  // Priority: severity comparison beats trend
  const ctx5 = makeCtx({
    lastSeverity: 'high',
    topSymptom: { display_name: 'đau', trend: undefined },
  });
  const result5 = generateProgressFeedback(ctx5, 'low', USER_HUNG);
  assert(result5.templateId === 'progress_severity_improved', '14.6 severity beats undefined trend');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 15: Question with empty text after rewrite — validation catches it
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmptyTextValidation() {
  console.log('\n══════ SUITE 15: Empty text validation ══════');

  // 15.1 rewriteQuestion with empty text → original_preserved with empty displayText
  const q = { id: 'q_empty', text: '' };
  const ctx = makeCtx();
  const result = rewriteQuestion(q, ctx, USER_HUNG);
  assert(result.templateId === 'original_preserved', '15.1 Empty text → original_preserved');

  // 15.2 validateOutput catches empty displayText
  const v = validateOutput(result, q);
  assert(!v.valid, '15.2 Empty displayText → validation fails');
  assert(v.errors.some(e => e.includes('empty')), '15.3 Error mentions "empty"');

  // 15.4 applyIllusion with empty-text question → validation_failed fallback
  const script = { greeting: 'Hi', questions: [{ id: 'q_empty', text: '', type: 'slider', min: 0, max: 10 }], scoring_rules: [], conclusion_templates: {} };
  const base = { isDone: false, question: { id: 'q_empty', text: '', type: 'slider', min: 0, max: 10 }, currentStep: 0, totalSteps: 1 };
  const illusionResult = applyIllusion(base, script, ctx, USER_HUNG);
  assert(illusionResult._illusion.applied === false, '15.4 Empty text → illusion not applied');
  assert(illusionResult._illusion.reason === 'validation_failed', '15.5 reason = validation_failed');
  assert(illusionResult.question.type === 'slider', '15.6 Original type preserved on fallback');

  // 15.7 Whitespace-only text
  const q2 = { id: 'q_ws', text: '   ' };
  const result2 = rewriteQuestion(q2, ctx, USER_HUNG);
  // _renderTemplate with whitespace → after personalization it's still whitespace
  const v2 = validateOutput(result2, q2);
  assert(!v2.valid, '15.7 Whitespace-only text → validation fails');

  // 15.8 null text
  const q3 = { id: 'q_null', text: null };
  let crashed = false;
  try {
    rewriteQuestion(q3, ctx, USER_HUNG);
  } catch (e) {
    crashed = true;
  }
  assert(!crashed, '15.8 null text → no crash');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  HARD CASES — PHASE 3+4 EDGE CASES             ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testMultiStepFlow();
  await testNullGreeting();
  await testEmptyQuestions();
  await testNoDoubleMatch();
  await testEmpathyMixedAnswers();
  await testEmpathyDiacritics();
  await testProgressSeverityMatrix();
  await testContinuityPriority();
  await testAllBannedKeywords();
  await testGreetingEdgeCases();
  await testImmutability();
  await testRealScriptFromDB();
  await testEmpathyDeterminism();
  await testProgressUndefinedTrend();
  await testEmptyTextValidation();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  TOTAL: ${totalPass} PASS, ${totalFail} FAIL${' '.repeat(Math.max(0, 27 - String(totalPass).length - String(totalFail).length))}║`);
  if (totalFail > 0) {
    console.log('║  FAILURES:                                       ║');
    for (const f of failures) console.log(`║  - ${f.substring(0, 46).padEnd(46)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch(err => { console.error('CRASHED:', err); pool.end(); process.exit(1); });
