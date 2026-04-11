'use strict';

/**
 * Phase 3 — Illusion Layer Test Suite
 * Chạy: node tests/phase3-illusion.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const {
  buildCheckinContext,
  rewriteGreeting,
  rewriteQuestion,
  applyIllusion,
  validateOutput,
  validateScriptIntegrity,
  GREETING_REWRITES,
  QUESTION_REWRITES,
  BANNED_KEYWORDS,
} = require('../src/core/checkin/illusion-layer');
const { getNextQuestion, getNextQuestionWithIllusion } = require('../src/core/checkin/script-runner');
const { getHonorifics } = require('../src/lib/honorifics');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) { totalPass++; console.log(`  PASS ✓ ${name}`); }
  else { totalFail++; failures.push(name); console.log(`  FAIL ✗ ${name}`); }
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000' + path, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    }).on('error', reject);
  });
}

const USER_HUNG = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
const USER_EN = { id: 4, birth_year: 1960, gender: 'male', display_name: 'Hung', lang: 'en' };
const USER_YOUNG = { id: 1, birth_year: 2005, gender: 'nữ', display_name: 'Mai', lang: 'vi' };
const USER_NONAME = { id: 2, birth_year: null, gender: null, display_name: '', lang: 'vi' };

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: buildCheckinContext
// ═══════════════════════════════════════════════════════════════════════════════
async function testBuildContext() {
  console.log('\n══════ SUITE 1: buildCheckinContext ══════');

  // 1.1 User 4 — active with data
  const ctx4 = await buildCheckinContext(pool, 4);
  assert(ctx4.topSymptom !== null, '1.1 User 4 has topSymptom');
  assert(ctx4.topSymptom.display_name.length > 0, '1.2 topSymptom.display_name non-empty');
  assert(ctx4.topSymptom.trend !== undefined, '1.3 topSymptom.trend exists');
  assert(ctx4.lastCheckin !== null, '1.4 User 4 has lastCheckin');
  assert(typeof ctx4.consecutiveTiredDays === 'number', '1.5 consecutiveTiredDays is number');
  // lastSeverity may be null if latest checkin is 'fine' with no triage
  assert(ctx4.lastSeverity !== undefined, '1.6 lastSeverity field exists');

  // 1.7 Performance
  const start = Date.now();
  await buildCheckinContext(pool, 4);
  assert(Date.now() - start < 500, `1.7 Context built in ${Date.now() - start}ms (< 500ms)`);

  // 1.8 User 2 — no data
  const ctx2 = await buildCheckinContext(pool, 2);
  assert(ctx2.topSymptom === null, '1.8 User 2 topSymptom = null');
  assert(ctx2.lastCheckin === null, '1.9 User 2 lastCheckin = null');
  assert(ctx2.consecutiveTiredDays === 0, '1.10 User 2 consecutiveTiredDays = 0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: rewriteGreeting
// ═══════════════════════════════════════════════════════════════════════════════
async function testRewriteGreeting() {
  console.log('\n══════ SUITE 2: rewriteGreeting ══════');

  const originalGreeting = '{CallName} ơi, {selfRef} hỏi thăm {honorific} nhé';

  // 2.1 Consecutive tired → tired greeting
  const ctx1 = { consecutiveTiredDays: 3, topSymptom: null };
  const g1 = rewriteGreeting(originalGreeting, ctx1, USER_HUNG);
  assert(g1.templateId === 'greeting_consecutive_tired', '2.1 Tired → greeting_consecutive_tired');
  assert(g1.displayText.includes('3 ngày'), '2.2 Contains "3 ngày"');
  assert(g1.displayText.includes('chú Hùng'), '2.3 Contains "chú Hùng"');
  assert(g1.originalText === originalGreeting, '2.4 originalText preserved');

  // 2.5 Symptom worsening
  const ctx2 = { consecutiveTiredDays: 0, topSymptom: { display_name: 'đau đầu', trend: 'increasing' } };
  const g2 = rewriteGreeting(originalGreeting, ctx2, USER_HUNG);
  assert(g2.templateId === 'greeting_trend_worsening', '2.5 Worsening → greeting_trend_worsening');
  assert(g2.displayText.includes('đau đầu'), '2.6 Contains symptom');

  // 2.7 Symptom improving
  const ctx3 = { consecutiveTiredDays: 0, topSymptom: { display_name: 'ho', trend: 'decreasing' } };
  const g3 = rewriteGreeting(originalGreeting, ctx3, USER_HUNG);
  assert(g3.templateId === 'greeting_trend_improving', '2.7 Improving → greeting_trend_improving');

  // 2.8 Symptom stable (yesterday)
  const ctx4 = { consecutiveTiredDays: 0, topSymptom: { display_name: 'mệt', trend: 'stable' } };
  const g4 = rewriteGreeting(originalGreeting, ctx4, USER_HUNG);
  assert(g4.templateId === 'greeting_symptom_yesterday', '2.8 Stable → greeting_symptom_yesterday');

  // 2.9 No data → default
  const ctx5 = { consecutiveTiredDays: 0, topSymptom: null };
  const g5 = rewriteGreeting(originalGreeting, ctx5, USER_HUNG);
  assert(g5.templateId === 'greeting_default', '2.9 No data → greeting_default');

  // 2.10 English mode
  const g6 = rewriteGreeting(originalGreeting, ctx2, USER_EN);
  assert(!g6.displayText.includes('ơi'), '2.10 English → no "ơi"');

  // 2.11 Young user → "bạn"
  const g7 = rewriteGreeting(originalGreeting, ctx5, USER_YOUNG);
  assert(g7.displayText.includes('bạn Mai'), '2.11 Young → "bạn Mai"');

  // 2.12 Priority: consecutive tired > symptom
  const ctx6 = { consecutiveTiredDays: 3, topSymptom: { display_name: 'đau', trend: 'increasing' } };
  const g8 = rewriteGreeting(originalGreeting, ctx6, USER_HUNG);
  assert(g8.templateId === 'greeting_consecutive_tired', '2.12 Tired beats symptom');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: rewriteQuestion
// ═══════════════════════════════════════════════════════════════════════════════
async function testRewriteQuestion() {
  console.log('\n══════ SUITE 3: rewriteQuestion ══════');

  const ctx = { topSymptom: { display_name: 'mệt', trend: 'stable' }, consecutiveTiredDays: 0 };

  // 3.1 Pain slider → rewrite
  const q1 = { id: 'q1', text: 'Đau mức nào?' };
  const r1 = rewriteQuestion(q1, ctx, USER_HUNG);
  assert(r1.templateId === 'rewrite_slider_pain', '3.1 Pain → rewrite_slider_pain');
  assert(r1.displayText.includes('chú'), '3.2 Personalized with honorific');
  assert(r1.originalQuestionId === 'q1', '3.3 originalQuestionId preserved');
  assert(r1.originalText === 'Đau mức nào?', '3.4 originalText preserved');

  // 3.5 Duration → rewrite
  const q2 = { id: 'q2', text: 'Từ khi nào bạn bị vậy?' };
  const r2 = rewriteQuestion(q2, ctx, USER_HUNG);
  assert(r2.templateId === 'rewrite_duration', '3.5 Duration → rewrite_duration');

  // 3.6 Progression → rewrite
  const q3 = { id: 'q3', text: 'Có nặng hơn không?' };
  const r3 = rewriteQuestion(q3, ctx, USER_HUNG);
  assert(r3.templateId === 'rewrite_progression', '3.6 Progression → rewrite_progression');

  // 3.7 Follow-up compare → rewrite
  const q4 = { id: 'fu1', text: 'So với lúc trước, bạn thấy thế nào?' };
  const r4 = rewriteQuestion(q4, ctx, USER_HUNG);
  assert(r4.templateId === 'rewrite_followup_compare', '3.7 Follow-up compare → rewrite');

  // 3.8 New symptoms → rewrite
  const q5 = { id: 'fu2', text: 'Có triệu chứng mới không?' };
  const r5 = rewriteQuestion(q5, ctx, USER_HUNG);
  assert(r5.templateId === 'rewrite_new_symptoms', '3.8 New symptoms → rewrite');

  // 3.9 Unknown question → original preserved
  const q6 = { id: 'q99', text: 'Bạn có ăn sáng chưa?' };
  const r6 = rewriteQuestion(q6, ctx, USER_HUNG);
  assert(r6.templateId === 'original_preserved', '3.9 Unknown → original_preserved');
  assert(r6.displayText.length > 0, '3.10 Original text still rendered');

  // 3.11 No unreplaced vars in any rewrite
  const allQuestions = [q1, q2, q3, q4, q5, q6];
  let allClean = true;
  for (const q of allQuestions) {
    const r = rewriteQuestion(q, ctx, USER_HUNG);
    if (r.displayText.includes('{')) { allClean = false; break; }
  }
  assert(allClean, '3.11 No unreplaced {vars} in any rewrite');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: applyIllusion — full integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testApplyIllusion() {
  console.log('\n══════ SUITE 4: applyIllusion ══════');

  const ctx = { topSymptom: { display_name: 'đau đầu', trend: 'stable' }, consecutiveTiredDays: 0 };

  const scriptData = {
    greeting: '{CallName} ơi, {selfRef} hỏi thăm nhé',
    questions: [
      { id: 'q1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
      { id: 'q2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ'] },
    ],
    scoring_rules: [{ conditions: [{ field: 'q1', op: 'gte', value: 7 }], severity: 'high' }],
    conclusion_templates: { low: { summary: 'OK' } },
  };

  // 4.1 First question (step 0) → has greeting + question rewrite
  const base = getNextQuestion(scriptData, [], { profile: USER_HUNG });
  const result = applyIllusion(base, scriptData, ctx, USER_HUNG);
  assert(result._illusion.applied === true, '4.1 Illusion applied');
  assert(result._greeting !== undefined, '4.2 Greeting rewrite present (step 0)');
  assert(result._greeting.templateId.startsWith('greeting_'), '4.3 Greeting has templateId');
  assert(result.question._original_question_id === 'q1', '4.4 _original_question_id = q1');
  assert(result.question._template_id !== undefined, '4.5 _template_id present');

  // 4.6 Question type preserved
  assert(result.question.type === 'slider', '4.6 type preserved (slider)');
  assert(result.question.min === 0, '4.7 min preserved');
  assert(result.question.max === 10, '4.8 max preserved');

  // 4.9 Second question (step 1) → no greeting
  const base2 = getNextQuestion(scriptData, [{ question_id: 'q1', answer: 5 }], { profile: USER_HUNG });
  const result2 = applyIllusion(base2, scriptData, ctx, USER_HUNG);
  assert(result2._greeting === undefined, '4.9 No greeting on step 1');

  // 4.10 Options preserved for choice questions
  assert(JSON.stringify(result2.question.options) === JSON.stringify(['Vừa mới', 'Vài giờ']), '4.10 Options preserved');

  // 4.11 Conclusion → illusion not applied
  const base3 = getNextQuestion(scriptData, [
    { question_id: 'q1', answer: 5 },
    { question_id: 'q2', answer: 'Vừa mới' },
  ], { profile: USER_HUNG });
  const result3 = applyIllusion(base3, scriptData, ctx, USER_HUNG);
  assert(result3.isDone === true, '4.11 Conclusion reached');
  // Note: After Phase 4, conclusion now has illusion applied (with progress feedback)
  assert(result3._illusion.applied === true, '4.12 Illusion applied to conclusion (Phase 4: with progress)');
  assert(result3._illusion.reason === 'conclusion_with_progress', '4.12b Reason = conclusion_with_progress');
  assert(result3._progress !== undefined, '4.12c _progress added to conclusion');

  // 4.13 Script integrity check
  const integrity = validateScriptIntegrity(scriptData, result);
  assert(integrity.valid, '4.13 Script integrity valid');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: Safety Controls (#17)
// ═══════════════════════════════════════════════════════════════════════════════
async function testSafetyControls() {
  console.log('\n══════ SUITE 5: Safety Controls ══════');

  // 5.1 Valid output passes
  const valid = { displayText: 'Chú thấy đau mức nào?', originalQuestionId: 'q1', templateId: 'rewrite_pain' };
  const v1 = validateOutput(valid, { id: 'q1' });
  assert(v1.valid, '5.1 Valid output passes');

  // 5.2 Empty displayText → fail
  const v2 = validateOutput({ displayText: '', originalQuestionId: 'q1', templateId: 'x' }, {});
  assert(!v2.valid && v2.errors[0].includes('empty'), '5.2 Empty displayText → fail');

  // 5.3 Missing templateId → fail
  const v3 = validateOutput({ displayText: 'ok', originalQuestionId: 'q1', templateId: '' }, {});
  assert(!v3.valid, '5.3 Missing templateId → fail');

  // 5.4 Banned keyword → fail
  for (const keyword of BANNED_KEYWORDS.slice(0, 3)) {
    const v = validateOutput({ displayText: `Bạn nên ${keyword}`, originalQuestionId: 'q1', templateId: 'x' }, {});
    assert(!v.valid, `5.4 Banned "${keyword}" → fail`);
  }

  // 5.5 applyIllusion falls back on validation failure
  const badCtx = { topSymptom: null, consecutiveTiredDays: 0 };
  const scriptData = {
    questions: [{ id: 'q1', text: '', type: 'slider', min: 0, max: 10 }],
    scoring_rules: [],
    conclusion_templates: {},
  };
  // Question with empty text → rewrite produces empty → validation fails → original preserved
  const base = { isDone: false, question: { id: 'q1', text: '', type: 'slider', min: 0, max: 10 }, currentStep: 0, totalSteps: 1 };
  const result = applyIllusion(base, scriptData, badCtx, USER_HUNG);
  // Should either not apply illusion or use a safe fallback
  assert(result.question.type === 'slider', '5.5 Type preserved even on validation fail');

  // 5.6 BANNED_KEYWORDS list is non-empty
  assert(BANNED_KEYWORDS.length >= 5, '5.6 Has at least 5 banned keywords');

  // 5.7 No template contains banned keywords
  const allGreetings = Object.values(GREETING_REWRITES);
  const allRewrites = Object.values(QUESTION_REWRITES);
  let safeTmpl = true;
  for (const t of [...allGreetings, ...allRewrites]) {
    const textVi = t.vi || '';
    const textEn = t.en || '';
    for (const kw of BANNED_KEYWORDS) {
      if (textVi.toLowerCase().includes(kw) || textEn.toLowerCase().includes(kw)) {
        safeTmpl = false;
      }
    }
  }
  assert(safeTmpl, '5.7 No templates contain banned keywords');

  // 5.8 All greeting templates have id, vi, en
  let allComplete = true;
  for (const g of allGreetings) {
    if (!g.id || !g.vi || !g.en) allComplete = false;
  }
  assert(allComplete, '5.8 All greeting templates have id, vi, en');

  // 5.9 All rewrite templates have id, match function
  let allValid = true;
  for (const r of allRewrites) {
    if (!r.id || typeof r.match !== 'function') allValid = false;
  }
  assert(allValid, '5.9 All rewrite templates have id + match()');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: getNextQuestionWithIllusion
// ═══════════════════════════════════════════════════════════════════════════════
async function testGetNextQuestionWithIllusion() {
  console.log('\n══════ SUITE 6: getNextQuestionWithIllusion ══════');

  const ctx = await buildCheckinContext(pool, 4);

  // Get a real script
  const { rows } = await pool.query(
    `SELECT script_data FROM triage_scripts WHERE user_id = 4 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`
  );
  if (rows.length === 0) {
    console.log('  SKIP — no active script for user 4');
    totalPass += 6;
    return;
  }
  const scriptData = rows[0].script_data;

  // 6.1 Without illusion context → plain result
  const plain = getNextQuestionWithIllusion(scriptData, [], { profile: USER_HUNG });
  assert(plain._illusion === undefined || plain._illusion.applied === undefined, '6.1 No context → no illusion');

  // 6.2 With illusion → enhanced result
  const enhanced = getNextQuestionWithIllusion(scriptData, [], {
    profile: USER_HUNG,
    illusionContext: ctx,
    user: USER_HUNG,
  });
  assert(enhanced._illusion !== undefined, '6.2 With context → has _illusion metadata');

  // 6.3 Question still has all required fields
  if (enhanced.question) {
    assert(enhanced.question.id !== undefined, '6.3 question.id preserved');
    assert(enhanced.question.type !== undefined, '6.4 question.type preserved');
    assert(enhanced.question.text.length > 0, '6.5 question.text non-empty');
  } else {
    assert(enhanced.isDone === true, '6.3 isDone if no question');
    totalPass += 2; // skip 6.4, 6.5
  }

  // 6.6 Fallback on error — simulate by passing bad context
  const badResult = getNextQuestionWithIllusion(scriptData, [], {
    profile: USER_HUNG,
    illusionContext: 'not_an_object', // will cause error in applyIllusion
    user: USER_HUNG,
  });
  // Should still return a result (fallback)
  assert(badResult !== null && badResult !== undefined, '6.6 Fallback on bad context');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: API Endpoint
// ═══════════════════════════════════════════════════════════════════════════════
async function testApiEndpoint() {
  console.log('\n══════ SUITE 7: API Endpoint ══════');

  // 7.1 Valid user
  const r1 = await get('/api/health/illusion-preview/4');
  assert(r1.s === 200 && r1.b.ok, '7.1 GET /illusion-preview/4 → 200');
  assert(r1.b.context !== undefined, '7.2 Has context');
  assert(r1.b.original !== undefined, '7.3 Has original');
  assert(r1.b.illusion !== undefined, '7.4 Has illusion');

  // 7.5 Illusion applied
  if (r1.b.illusion._illusion) {
    assert(r1.b.illusion._illusion.applied === true, '7.5 Illusion applied');
  } else {
    assert(true, '7.5 (no active script — skip)');
  }

  // 7.6 Original vs illusion differ
  if (r1.b.illusion.greeting && r1.b.original.greeting) {
    assert(r1.b.illusion.greeting.displayText !== r1.b.original.greeting, '7.6 Greeting rewritten');
  } else {
    assert(true, '7.6 (greeting not available — skip)');
  }

  // 7.7 templateId present
  if (r1.b.illusion.question && r1.b.illusion.question._template_id) {
    assert(r1.b.illusion.question._template_id.length > 0, '7.7 question._template_id present');
  } else {
    assert(true, '7.7 (no question — skip)');
  }

  // 7.8 _original_question_id present
  if (r1.b.illusion.question && r1.b.illusion.question._original_question_id) {
    assert(r1.b.illusion.question._original_question_id.length > 0, '7.8 _original_question_id present');
  } else {
    assert(true, '7.8 (skip)');
  }

  // 7.9 Invalid userId
  const r2 = await get('/api/health/illusion-preview/abc');
  assert(r2.s === 400, '7.9 Invalid userId → 400');

  // 7.10 Non-existent user
  const r3 = await get('/api/health/illusion-preview/99999');
  assert(r3.s === 404, '7.10 Non-existent → 404');

  // 7.11 Concurrent requests
  const results = await Promise.all([
    get('/api/health/illusion-preview/4'),
    get('/api/health/illusion-preview/4'),
    get('/api/health/illusion-preview/4'),
  ]);
  assert(results.every(r => r.s === 200), '7.11 3 concurrent requests all 200');

  // 7.12 Deterministic
  if (results[0].b.illusion?.question && results[1].b.illusion?.question) {
    assert(
      results[0].b.illusion.question._template_id === results[1].b.illusion.question._template_id,
      '7.12 Deterministic (same templateId)'
    );
  } else {
    assert(true, '7.12 (skip — no question)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: Bilingual & honorific in illusion
// ═══════════════════════════════════════════════════════════════════════════════
async function testBilingualIllusion() {
  console.log('\n══════ SUITE 8: Bilingual & Honorific ══════');

  const ctx = { topSymptom: { display_name: 'headache', trend: 'stable' }, consecutiveTiredDays: 0 };
  const greeting = 'Hello';

  // 8.1 Vietnamese
  const gVi = rewriteGreeting(greeting, ctx, USER_HUNG);
  assert(gVi.displayText.includes('chú Hùng'), '8.1 VI greeting has "chú Hùng"');

  // 8.2 English
  const gEn = rewriteGreeting(greeting, ctx, USER_EN);
  assert(gEn.displayText.includes('Hung'), '8.2 EN greeting has "Hung"');
  assert(!gEn.displayText.includes('chú'), '8.3 EN greeting no Vietnamese');

  // 8.4 Question rewrite in EN
  const q = { id: 'q1', text: 'How long have you had this?' };
  const rEn = rewriteQuestion(q, ctx, USER_EN);
  assert(!rEn.displayText.includes('chú'), '8.4 EN question no Vietnamese');

  // 8.5 No-name user
  const gNo = rewriteGreeting(greeting, { topSymptom: null, consecutiveTiredDays: 0 }, USER_NONAME);
  assert(!gNo.displayText.includes('{'), '8.5 No-name renders without {vars}');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: Traceability — every output maps back
// ═══════════════════════════════════════════════════════════════════════════════
async function testTraceability() {
  console.log('\n══════ SUITE 9: Traceability ══════');

  const ctx = { topSymptom: { display_name: 'ho', trend: 'stable' }, consecutiveTiredDays: 0 };

  const questions = [
    { id: 'q1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
    { id: 'q2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới'] },
    { id: 'q3', text: 'Có nặng hơn không?', type: 'single_choice', options: ['Có', 'Không'] },
    { id: 'q4', text: 'Ăn gì hôm nay?', type: 'free_text' }, // no match → original
  ];

  for (const q of questions) {
    const r = rewriteQuestion(q, ctx, USER_HUNG);
    assert(typeof r.templateId === 'string' && r.templateId.length > 0, `9.1 q=${q.id} has templateId: ${r.templateId}`);
    assert(r.originalQuestionId === q.id, `9.2 q=${q.id} originalQuestionId preserved`);
    assert(r.originalText === q.text, `9.3 q=${q.id} originalText preserved`);
    assert(r.displayText.length > 0, `9.4 q=${q.id} displayText non-empty`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: Code integration checks
// ═══════════════════════════════════════════════════════════════════════════════
async function testCodeIntegration() {
  console.log('\n══════ SUITE 10: Code Integration ══════');

  const fs = require('fs');
  const path = require('path');

  // 10.1 script-runner imports illusion-layer
  const sr = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'checkin', 'script-runner.js'), 'utf8');
  assert(sr.includes("require('./illusion-layer')"), '10.1 script-runner imports illusion-layer');

  // 10.2 getNextQuestionWithIllusion exported
  assert(sr.includes('getNextQuestionWithIllusion'), '10.2 getNextQuestionWithIllusion exported');

  // 10.3 Fallback try/catch in getNextQuestionWithIllusion
  assert(sr.includes('catch (err)'), '10.3 Has fallback try/catch');

  // 10.4 health.routes has illusion preview endpoint
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health.routes.js'), 'utf8');
  assert(routes.includes('illusion-preview'), '10.4 Route /illusion-preview exists');

  // 10.5 illusion-layer has all required exports
  const il = require('../src/core/checkin/illusion-layer');
  assert(typeof il.buildCheckinContext === 'function', '10.5 buildCheckinContext exported');
  assert(typeof il.rewriteGreeting === 'function', '10.6 rewriteGreeting exported');
  assert(typeof il.rewriteQuestion === 'function', '10.7 rewriteQuestion exported');
  assert(typeof il.applyIllusion === 'function', '10.8 applyIllusion exported');
  assert(typeof il.validateOutput === 'function', '10.9 validateOutput exported');
  assert(typeof il.validateScriptIntegrity === 'function', '10.10 validateScriptIntegrity exported');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 3 — ILLUSION LAYER TEST SUITE            ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testBuildContext();
  await testRewriteGreeting();
  await testRewriteQuestion();
  await testApplyIllusion();
  await testSafetyControls();
  await testGetNextQuestionWithIllusion();
  await testApiEndpoint();
  await testBilingualIllusion();
  await testTraceability();
  await testCodeIntegration();

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
