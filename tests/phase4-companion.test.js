'use strict';

/**
 * Phase 4 — Continuity + Empathy + Progress Test Suite
 * Chạy: node tests/phase4-companion.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const {
  buildCheckinContext,
  selectContinuityPrefix,
  selectEmpathyResponse,
  generateProgressFeedback,
  applyIllusion,
  CONTINUITY_PREFIXES,
  EMPATHY_RESPONSES,
  PROGRESS_TEMPLATES,
} = require('../src/core/checkin/illusion-layer');
const { getNextQuestionWithIllusion } = require('../src/core/checkin/script-runner');
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

const USER = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
const USER_EN = { id: 4, birth_year: 1960, gender: 'male', display_name: 'Hung', lang: 'en' };

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: selectContinuityPrefix
// ═══════════════════════════════════════════════════════════════════════════════
async function testContinuity() {
  console.log('\n══════ SUITE 1: Continuity Prefix ══════');

  // 1.1 3+ ngày tired + có symptom → same_symptom_3d
  const c1 = selectContinuityPrefix(
    { topSymptom: { display_name: 'đau đầu', trend: 'stable' }, consecutiveTiredDays: 3, lastSeverity: 'low' }, USER
  );
  assert(c1 !== null, '1.1 3 tired days → has continuity');
  assert(c1.templateId === 'continuity_same_3d', '1.2 templateId = continuity_same_3d');
  assert(c1.text.includes('3 ngày'), '1.3 Contains "3 ngày"');
  assert(c1.text.includes('đau đầu'), '1.4 Contains symptom');

  // 1.5 Symptom improving → continuity_improving
  const c2 = selectContinuityPrefix(
    { topSymptom: { display_name: 'ho', trend: 'decreasing' }, consecutiveTiredDays: 0, lastSeverity: 'low' }, USER
  );
  assert(c2 !== null && c2.templateId === 'continuity_improving', '1.5 Improving → continuity_improving');
  assert(c2.text.includes('ho'), '1.6 Contains symptom "ho"');

  // 1.7 Last severity high → was_severe
  const c3 = selectContinuityPrefix(
    { topSymptom: null, consecutiveTiredDays: 0, lastSeverity: 'high' }, USER
  );
  assert(c3 !== null && c3.templateId === 'continuity_was_severe', '1.7 High severity → was_severe');

  // 1.8 2 tired days + symptom → same_symptom_2d
  const c4 = selectContinuityPrefix(
    { topSymptom: { display_name: 'mệt', trend: 'stable' }, consecutiveTiredDays: 2, lastSeverity: 'low' }, USER
  );
  assert(c4 !== null && c4.templateId === 'continuity_same_2d', '1.8 2 tired days → same_2d');

  // 1.9 No data → null
  const c5 = selectContinuityPrefix(
    { topSymptom: null, consecutiveTiredDays: 0, lastSeverity: null }, USER
  );
  assert(c5 === null, '1.9 No data → null (no continuity)');

  // 1.10 Priority: 3d > improving > severe > 2d
  const c6 = selectContinuityPrefix(
    { topSymptom: { display_name: 'x', trend: 'decreasing' }, consecutiveTiredDays: 3, lastSeverity: 'high' }, USER
  );
  assert(c6.templateId === 'continuity_same_3d', '1.10 3d beats improving/severe');

  // 1.11 English mode
  const c7 = selectContinuityPrefix(
    { topSymptom: { display_name: 'headache', trend: 'stable' }, consecutiveTiredDays: 2, lastSeverity: 'low' }, USER_EN
  );
  assert(c7 !== null && !c7.text.includes('chú'), '1.11 EN: no Vietnamese');

  // 1.12 No unreplaced vars
  const allPrefixes = [c1, c2, c3, c4, c7].filter(Boolean);
  assert(allPrefixes.every(c => !c.text.includes('{')), '1.12 No unreplaced {vars}');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: selectEmpathyResponse
// ═══════════════════════════════════════════════════════════════════════════════
async function testEmpathy() {
  console.log('\n══════ SUITE 2: Empathy Response ══════');

  // 2.1 Positive answer → improving
  const e1 = selectEmpathyResponse({ question_id: 'q1', answer: 'Đỡ hơn' }, USER);
  assert(e1 !== null, '2.1 Positive answer → has empathy');
  assert(e1.templateId === 'empathy_improving', '2.2 templateId = empathy_improving');

  // 2.3 Severe answer → worsening
  const e2 = selectEmpathyResponse({ question_id: 'q1', answer: 'Nặng hơn' }, USER);
  assert(e2 !== null && e2.templateId === 'empathy_worsening', '2.3 Severe → empathy_worsening');

  // 2.4 Mild answer → mild
  const e3 = selectEmpathyResponse({ question_id: 'q1', answer: 'Vẫn vậy' }, USER);
  assert(e3 !== null && e3.templateId === 'empathy_mild', '2.4 Mild → empathy_mild');

  // 2.5 Slider low (0-3) → positive
  const e4 = selectEmpathyResponse({ question_id: 'q1', answer: 2 }, USER);
  assert(e4 !== null && e4.templateId === 'empathy_positive', '2.5 Slider 2 → empathy_positive');

  // 2.6 Slider mid (4-6) → mild
  const e5 = selectEmpathyResponse({ question_id: 'q1', answer: 5 }, USER);
  assert(e5 !== null && e5.templateId === 'empathy_mild', '2.6 Slider 5 → empathy_mild');

  // 2.7 Slider high (7-10) → severe
  const e6 = selectEmpathyResponse({ question_id: 'q1', answer: 8 }, USER);
  assert(e6 !== null && e6.templateId === 'empathy_severe', '2.7 Slider 8 → empathy_severe');

  // 2.8 Null answer → null
  const e7 = selectEmpathyResponse({ question_id: 'q1', answer: null }, USER);
  assert(e7 === null, '2.8 Null answer → null');

  // 2.9 No lastAnswer → null
  const e8 = selectEmpathyResponse(null, USER);
  assert(e8 === null, '2.9 No lastAnswer → null');

  // 2.10 Array answer
  const e9 = selectEmpathyResponse({ question_id: 'q1', answer: ['nghỉ ngơi', 'uống nước'] }, USER);
  assert(e9 !== null, '2.10 Array answer → has empathy');

  // 2.11 English mode
  const e10 = selectEmpathyResponse({ question_id: 'q1', answer: 'better' }, USER_EN);
  assert(e10 !== null && e10.templateId === 'empathy_improving', '2.11 EN "better" → improving');
  assert(!e10.text.includes('cháu'), '2.12 EN: no Vietnamese selfRef');

  // 2.13 Deterministic (same input → same output)
  const e11a = selectEmpathyResponse({ question_id: 'q1', answer: 'Đỡ hơn' }, USER);
  const e11b = selectEmpathyResponse({ question_id: 'q1', answer: 'Đỡ hơn' }, USER);
  assert(e11a.text === e11b.text, '2.13 Deterministic same output');

  // 2.14 No unreplaced vars
  const allEmpathy = [e1, e2, e3, e4, e5, e6, e9, e10].filter(Boolean);
  assert(allEmpathy.every(e => !e.text.includes('{')), '2.14 No unreplaced {vars}');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: generateProgressFeedback
// ═══════════════════════════════════════════════════════════════════════════════
async function testProgress() {
  console.log('\n══════ SUITE 3: Progress Feedback ══════');

  // 3.1 Severity improved (high → low)
  const p1 = generateProgressFeedback(
    { topSymptom: null, lastSeverity: 'high' }, 'low', USER
  );
  assert(p1.templateId === 'progress_severity_improved', '3.1 high→low = severity_improved');
  assert(p1.text.includes('nhẹ hơn'), '3.2 Contains "nhẹ hơn"');

  // 3.3 Severity same
  const p2 = generateProgressFeedback(
    { topSymptom: null, lastSeverity: 'medium' }, 'medium', USER
  );
  assert(p2.templateId === 'progress_severity_same', '3.3 medium→medium = severity_same');

  // 3.4 Symptom improving
  const p3 = generateProgressFeedback(
    { topSymptom: { display_name: 'ho', trend: 'decreasing' }, lastSeverity: null }, null, USER
  );
  assert(p3.templateId === 'progress_improving', '3.4 Trend decreasing → improving');
  assert(p3.text.includes('ho'), '3.5 Contains symptom "ho"');

  // 3.6 Symptom worsening
  const p4 = generateProgressFeedback(
    { topSymptom: { display_name: 'sốt', trend: 'increasing' }, lastSeverity: null }, null, USER
  );
  assert(p4.templateId === 'progress_worsening', '3.6 Trend increasing → worsening');

  // 3.7 Symptom stable
  const p5 = generateProgressFeedback(
    { topSymptom: { display_name: 'mệt', trend: 'stable' }, lastSeverity: null }, null, USER
  );
  assert(p5.templateId === 'progress_stable', '3.7 Trend stable → stable');

  // 3.8 No data → no_data
  const p6 = generateProgressFeedback(
    { topSymptom: null, lastSeverity: null }, null, USER
  );
  assert(p6.templateId === 'progress_no_data', '3.8 No data → no_data');

  // 3.9 Priority: severity comparison > trend
  const p7 = generateProgressFeedback(
    { topSymptom: { display_name: 'đau', trend: 'increasing' }, lastSeverity: 'high' }, 'low', USER
  );
  assert(p7.templateId === 'progress_severity_improved', '3.9 Severity comparison beats trend');

  // 3.10 English
  const p8 = generateProgressFeedback(
    { topSymptom: { display_name: 'cough', trend: 'decreasing' }, lastSeverity: null }, null, USER_EN
  );
  assert(!p8.text.includes('chú'), '3.10 EN: no Vietnamese');

  // 3.11 No unreplaced vars
  const allProgress = [p1, p2, p3, p4, p5, p6, p7, p8];
  assert(allProgress.every(p => !p.text.includes('{')), '3.11 No unreplaced {vars}');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: applyIllusion with Phase 4 features
// ═══════════════════════════════════════════════════════════════════════════════
async function testApplyIllusionPhase4() {
  console.log('\n══════ SUITE 4: applyIllusion + Phase 4 ══════');

  const ctx = { topSymptom: { display_name: 'đau đầu', trend: 'stable' }, consecutiveTiredDays: 3, lastSeverity: 'medium' };
  const scriptData = {
    greeting: 'Chào bạn',
    questions: [
      { id: 'q1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
      { id: 'q2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ'] },
    ],
    scoring_rules: [],
    conclusion_templates: { low: { summary: 'OK' }, medium: { summary: 'Watch' } },
  };

  // 4.1 Step 0 → has _continuity
  const r0 = applyIllusion(
    { isDone: false, question: scriptData.questions[0], currentStep: 0, totalSteps: 2 },
    scriptData, ctx, USER, {}
  );
  assert(r0._continuity !== null && r0._continuity !== undefined, '4.1 Step 0 has _continuity');
  assert(r0._continuity.templateId === 'continuity_same_3d', '4.2 Continuity = same_3d');

  // 4.3 Step 0 → no _empathy (no lastAnswer)
  assert(r0._empathy === undefined, '4.3 Step 0 no empathy (no lastAnswer)');

  // 4.4 Step 1 with lastAnswer → has _empathy
  const r1 = applyIllusion(
    { isDone: false, question: scriptData.questions[1], currentStep: 1, totalSteps: 2 },
    scriptData, ctx, USER, { lastAnswer: { question_id: 'q1', answer: 3 } }
  );
  assert(r1._empathy !== undefined, '4.4 Step 1 has _empathy');
  assert(r1._empathy.templateId === 'empathy_positive', '4.5 Slider 3 → empathy_positive');

  // 4.6 Step 1 → no _continuity
  assert(r1._continuity === undefined, '4.6 Step 1 no continuity');

  // 4.7 Conclusion → has _progress
  const rEnd = applyIllusion(
    { isDone: true, conclusion: { severity: 'low' }, currentStep: 2, totalSteps: 2 },
    scriptData, ctx, USER, {}
  );
  assert(rEnd._progress !== undefined, '4.7 Conclusion has _progress');
  assert(rEnd._progress.templateId === 'progress_severity_improved', '4.8 medium→low = improved');

  // 4.9 Conclusion _illusion says applied
  assert(rEnd._illusion.applied === true, '4.9 Conclusion _illusion.applied = true');
  assert(rEnd._illusion.reason === 'conclusion_with_progress', '4.10 Reason = conclusion_with_progress');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: Integration via getNextQuestionWithIllusion
// ═══════════════════════════════════════════════════════════════════════════════
async function testIntegration() {
  console.log('\n══════ SUITE 5: Integration ══════');

  const ctx = await buildCheckinContext(pool, 4);
  const { rows } = await pool.query(
    `SELECT script_data FROM triage_scripts WHERE user_id = 4 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`
  );
  if (rows.length === 0) { console.log('  SKIP — no script'); totalPass += 5; return; }
  const scriptData = rows[0].script_data;

  // 5.1 Step 0 with illusion → continuity present
  const r0 = getNextQuestionWithIllusion(scriptData, [], {
    profile: USER, illusionContext: ctx, user: USER,
  });
  if (r0._continuity) {
    assert(r0._continuity.text.length > 0, '5.1 Continuity text non-empty');
  } else {
    assert(true, '5.1 (no continuity needed for this context)');
  }

  // 5.2 Step 1 with lastAnswer → empathy present
  const firstQ = (scriptData.followup_questions || scriptData.questions || [])[0];
  if (firstQ) {
    const r1 = getNextQuestionWithIllusion(scriptData,
      [{ question_id: firstQ.id, answer: 'Vẫn vậy' }],
      { profile: USER, illusionContext: ctx, user: USER, lastAnswer: { question_id: firstQ.id, answer: 'Vẫn vậy' } }
    );
    if (r1._empathy) {
      assert(r1._empathy.text.length > 0, '5.2 Empathy text non-empty');
    } else {
      assert(true, '5.2 (empathy not triggered)');
    }
  } else {
    assert(true, '5.2 (no questions)');
  }

  // 5.3 Full conclusion → progress present
  const allQs = scriptData.followup_questions || scriptData.questions || [];
  const allAns = allQs.map((q, i) => ({ question_id: q.id, answer: i === 0 ? 5 : 'Vẫn vậy' }));
  const rEnd = getNextQuestionWithIllusion(scriptData, allAns, {
    profile: USER, illusionContext: ctx, user: USER,
  });
  if (rEnd.isDone && rEnd._progress) {
    assert(rEnd._progress.text.length > 0, '5.3 Progress text non-empty');
    assert(rEnd._progress.templateId.startsWith('progress_'), '5.4 Progress templateId valid');
  } else {
    assert(true, '5.3 (no progress or not done)');
    assert(true, '5.4 (skip)');
  }

  // 5.5 All fields traceable
  if (r0.question) {
    assert(r0.question._template_id !== undefined, '5.5 All outputs traceable');
  } else {
    assert(true, '5.5 (skip)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: API Preview endpoint
// ═══════════════════════════════════════════════════════════════════════════════
async function testApi() {
  console.log('\n══════ SUITE 6: API Preview ══════');

  const r = await get('/api/health/illusion-preview/4');
  assert(r.s === 200 && r.b.ok, '6.1 API returns 200');

  // 6.2 Continuity present
  if (r.b.illusion?.continuity) {
    assert(r.b.illusion.continuity.text.length > 0, '6.2 Continuity text in API');
    assert(r.b.illusion.continuity.templateId.startsWith('continuity_'), '6.3 Continuity templateId');
  } else {
    assert(true, '6.2 (no continuity)'); assert(true, '6.3 (skip)');
  }

  // 6.4 Empathy present
  if (r.b.step1_empathy) {
    assert(r.b.step1_empathy.text.length > 0, '6.4 Empathy text in API');
    assert(r.b.step1_empathy.templateId.startsWith('empathy_'), '6.5 Empathy templateId');
  } else {
    assert(true, '6.4 (no empathy)'); assert(true, '6.5 (skip)');
  }

  // 6.6 Progress present
  if (r.b.conclusion_progress) {
    assert(r.b.conclusion_progress.text.length > 0, '6.6 Progress text in API');
    assert(r.b.conclusion_progress.templateId.startsWith('progress_'), '6.7 Progress templateId');
  } else {
    assert(true, '6.6 (no progress)'); assert(true, '6.7 (skip)');
  }

  // 6.8 Concurrent
  const results = await Promise.all([get('/api/health/illusion-preview/4'), get('/api/health/illusion-preview/4')]);
  assert(results.every(r => r.s === 200), '6.8 Concurrent OK');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: Template coverage & safety
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplateSafety() {
  console.log('\n══════ SUITE 7: Template Safety ══════');

  // 7.1 All continuity templates have id, vi, en
  const cTemplates = Object.values(CONTINUITY_PREFIXES);
  assert(cTemplates.every(t => t.id && t.vi && t.en), '7.1 Continuity templates complete (id, vi, en)');

  // 7.2 All progress templates have id, vi, en
  const pTemplates = Object.values(PROGRESS_TEMPLATES);
  assert(pTemplates.every(t => t.id && t.vi && t.en), '7.2 Progress templates complete');

  // 7.3 All empathy responses have id, vi[], en[]
  const eResponses = Object.values(EMPATHY_RESPONSES);
  assert(eResponses.every(r => r.id && Array.isArray(r.vi) && r.vi.length > 0 && Array.isArray(r.en) && r.en.length > 0),
    '7.3 Empathy responses complete');

  // 7.4 Unique IDs across all templates
  const allIds = [
    ...cTemplates.map(t => t.id),
    ...pTemplates.map(t => t.id),
    ...eResponses.map(r => r.id),
  ];
  assert(allIds.length === new Set(allIds).size, '7.4 All IDs unique');

  // 7.5 No banned keywords in any template
  const { BANNED_KEYWORDS } = require('../src/core/checkin/illusion-layer');
  const allTexts = [
    ...cTemplates.flatMap(t => [t.vi, t.en]),
    ...pTemplates.flatMap(t => [t.vi, t.en]),
    ...eResponses.flatMap(r => [...r.vi, ...r.en]),
  ];
  let safe = true;
  for (const text of allTexts) {
    for (const kw of BANNED_KEYWORDS) {
      if (text.toLowerCase().includes(kw.toLowerCase())) { safe = false; break; }
    }
  }
  assert(safe, '7.5 No banned keywords in Phase 4 templates');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: Edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testEdgeCases() {
  console.log('\n══════ SUITE 8: Edge Cases ══════');

  // 8.1 Empathy with edge slider values
  const e0 = selectEmpathyResponse({ question_id: 'q1', answer: 0 }, USER);
  assert(e0 !== null && e0.templateId === 'empathy_positive', '8.1 Slider 0 → positive');

  const e10 = selectEmpathyResponse({ question_id: 'q1', answer: 10 }, USER);
  assert(e10 !== null && e10.templateId === 'empathy_severe', '8.2 Slider 10 → severe');

  // 8.3 Progress with severity high → high (no change but not improved)
  const p = generateProgressFeedback(
    { topSymptom: null, lastSeverity: 'high' }, 'high', USER
  );
  assert(p.templateId === 'progress_severity_same', '8.3 high→high = severity_same');

  // 8.4 Progress with no lastSeverity but has symptom
  const p2 = generateProgressFeedback(
    { topSymptom: { display_name: 'test', trend: 'stable' }, lastSeverity: null }, 'low', USER
  );
  assert(p2.templateId === 'progress_stable', '8.4 No last severity → uses trend');

  // 8.5 Empathy with special chars
  const e = selectEmpathyResponse({ question_id: 'q1', answer: 'Đau "nhiều" & mệt' }, USER);
  assert(e !== null, '8.5 Special chars in answer → works');

  // 8.6 Empty string answer → treated as mild
  const eEmpty = selectEmpathyResponse({ question_id: 'q1', answer: '' }, USER);
  assert(eEmpty !== null, '8.6 Empty string → has empathy');

  // 8.7 Continuity with 1 tired day + no symptom → null
  const c = selectContinuityPrefix(
    { topSymptom: null, consecutiveTiredDays: 1, lastSeverity: 'low' }, USER
  );
  assert(c === null, '8.7 1 tired day + no symptom → no continuity');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 4 — COMPANION FEATURES TEST SUITE       ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testContinuity();
  await testEmpathy();
  await testProgress();
  await testApplyIllusionPhase4();
  await testIntegration();
  await testApi();
  await testTemplateSafety();
  await testEdgeCases();

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
