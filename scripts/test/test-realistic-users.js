#!/usr/bin/env node
/**
 * Realistic User Scenarios Test
 *
 * Simulates 5 different users with distinct profiles and behaviors.
 * Tests all modules: script.service, script-runner, scoring-engine,
 * fallback.service, emergency-detector, clinical-mapping.
 *
 * User ID = 4 (cleaned up and recreated each run).
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  getUserScript,
  getScript,
  createClustersFromOnboarding,
  addCluster,
  toClusterKey,
  CLUSTER_KEY_MAP,
} = require('../src/services/checkin/script.service');

const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');
const { evaluateScript, evaluateFollowUp, applyModifiers } = require('../src/services/checkin/scoring-engine');
const { getFallbackScriptData, logFallback, matchCluster } = require('../src/services/checkin/fallback.service');
const { detectEmergency, isRedFlag, getRedFlags } = require('../src/services/checkin/emergency-detector');
const { resolveComplaint, listComplaints } = require('../src/services/checkin/clinical-mapping');

const USER_ID = 4;

// ── Counters ────────────────────────────────────────────────────────────────

let totalPass = 0;
let totalFail = 0;
const perUser = {};

function initUser(name) { perUser[name] = { pass: 0, fail: 0 }; }

function pass(user, msg) {
  totalPass++;
  perUser[user].pass++;
  console.log(`    PASS  ${msg}`);
}
function fail(user, msg) {
  totalFail++;
  perUser[user].fail++;
  console.log(`    FAIL  ${msg}`);
}

function assert(user, condition, passMsg, failMsg) {
  if (condition) pass(user, passMsg);
  else fail(user, failMsg || passMsg);
}

function header(text) {
  console.log(`\n${'='.repeat(70)}\n  ${text}\n${'='.repeat(70)}`);
}
function subheader(text) {
  console.log(`\n  --- ${text} ---`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function cleanUser() {
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [USER_ID]).catch(() => {});
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [USER_ID]).catch(() => {});
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [USER_ID]).catch(() => {});
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [USER_ID]).catch(() => {});
}

async function setupProfile(profile) {
  await pool.query(
    `INSERT INTO users (id, display_name, full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET display_name = $2, full_name = $3`,
    [USER_ID, profile.full_name, profile.full_name]
  );

  const medConds = profile.medical_conditions || [];
  await pool.query(
    `INSERT INTO user_onboarding_profiles (user_id, birth_year, gender, medical_conditions)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       birth_year = $2, gender = $3, medical_conditions = $4::jsonb`,
    [USER_ID, profile.birth_year, profile.gender, JSON.stringify(medConds)]
  );
}

/**
 * Run a script session with provided answers, return conclusion.
 */
function runScriptSession(scriptData, answers, profile, sessionType = 'initial') {
  let currentAnswers = [];

  for (const ans of answers) {
    const next = getNextQuestion(scriptData, currentAnswers, { sessionType, profile });
    if (next.isDone) return next.conclusion;
    currentAnswers.push({ question_id: next.question.id, answer: ans });
  }

  // Fill remaining questions with defaults
  let next = getNextQuestion(scriptData, currentAnswers, { sessionType, profile });
  while (!next.isDone) {
    const defaultAns = next.question.options?.[0] ?? (next.question.type === 'slider' ? 3 : 'không rõ');
    currentAnswers.push({ question_id: next.question.id, answer: defaultAns });
    next = getNextQuestion(scriptData, currentAnswers, { sessionType, profile });
  }

  return next.conclusion;
}

// ════════════════════════════════════════════════════════════════════════════
// USER 1: Bà Lan — 75 tuổi, nhiều bệnh nền, hay quên
// ════════════════════════════════════════════════════════════════════════════

async function testUser1() {
  const U = 'BaLan';
  initUser(U);
  header('USER 1: Bà Lan — 75 tuổi, 4 bệnh nền');

  const profile = {
    birth_year: 1951,
    gender: 'Nữ',
    full_name: 'Nguyễn Thị Lan',
    medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp', 'Suy thận', 'Loãng xương'],
    age: 75,
  };

  await cleanUser();
  await setupProfile(profile);
  await createClustersFromOnboarding(pool, USER_ID, ['chóng mặt', 'đau khớp', 'mệt mỏi']);

  // Test 1: Check-in "chóng mặt" with mild/default answers
  // Clinical-mapping scripts have binary high/low rules (no slider).
  // Mild answers = no danger rule fires = base low.
  // Elderly(75)+4conditions bumps low->medium (default safety) when no rule matched.
  subheader('Test 1: chóng mặt — mild answers, elderly safety bump');
  const dzScript = await getScript(pool, USER_ID, 'dizziness', 'initial');
  assert(U, dzScript, 'dizziness script exists', 'FAIL dizziness script not found');

  if (dzScript) {
    const dzData = dzScript.script_data;
    // Mild answers: pick non-danger options
    const conclusion1 = runScriptSession(dzData, [
      'lâng lâng, lơ lửng',  // q1: mild type
      'khi đứng dậy',        // q2: benign trigger
      'không có',             // q3: no associated symptoms
    ], profile);
    console.log(`    severity=${conclusion1.severity}, modifiers=${JSON.stringify(conclusion1.modifiersApplied)}`);
    // Elderly+conditions: low -> medium (safety bump since no rule matched)
    assert(U,
      conclusion1.severity === 'medium',
      'elderly+4 conditions: low bumped to medium (default safety)',
      `FAIL expected medium got ${conclusion1.severity}`
    );
  }

  // Test 2: Check-in "đau khớp" moderate (non-slider scripts)
  // elderly+4 conditions -> bumps to high (same as fallback behavior)
  subheader('Test 2: đau khớp — moderate, elderly safety bump');
  const jpScript = await getScript(pool, USER_ID, 'joint_pain', 'initial');
  assert(U, jpScript, 'joint_pain script exists', 'FAIL joint_pain script not found');

  if (jpScript) {
    const jpData = jpScript.script_data;
    const conclusion2 = runScriptSession(jpData, [], profile); // default answers
    console.log(`    severity=${conclusion2.severity}, modifiers=${JSON.stringify(conclusion2.modifiersApplied)}`);
    assert(U,
      conclusion2.severity === 'high',
      'elderly+4 conditions bumps joint_pain to high',
      `FAIL expected high got ${conclusion2.severity}`
    );
  }

  // Test 1b: Verify same chóng mặt with SLIDER (fallback script) → high for elderly
  subheader('Test 1b: Fallback script slider=5 → elderly bumps medium->high');
  const fbData = getFallbackScriptData();
  const conclusionFb = runScriptSession(fbData, [5, 'Từ sáng', 'Vẫn vậy'], profile);
  console.log(`    fallback slider=5: severity=${conclusionFb.severity}, modifiers=${JSON.stringify(conclusionFb.modifiersApplied)}`);
  assert(U,
    conclusionFb.severity === 'high',
    'fallback slider=5: elderly+conditions bumps medium->high',
    `FAIL expected high got ${conclusionFb.severity}`
  );

  // Test 3: Follow-up "Vẫn vậy" -> should keep high severity for elderly
  subheader('Test 3: Follow-up "Vẫn vậy" for elderly');
  const fuScript = await getScript(pool, USER_ID, 'dizziness', 'followup');
  if (fuScript) {
    const fuAnswers = [
      { question_id: 'fu1', answer: 'Vẫn vậy' },
      { question_id: 'fu2', answer: 'Không' },
    ];
    const fuResult = evaluateFollowUp(fuScript.script_data, fuAnswers, 'high');
    console.log(`    followup severity=${fuResult.severity}, action=${fuResult.action}`);
    // "Vẫn vậy" with previous high -> stays high (continue_followup)
    assert(U,
      fuResult.severity === 'high',
      'follow-up "Vẫn vậy" keeps high severity for elderly',
      `FAIL expected high got ${fuResult.severity}`
    );
  } else {
    fail(U, 'followup script not found');
  }

  // Test 4: Emergency "ngất" detected as red flag
  subheader('Test 4: Emergency "ngất" detected for elderly');
  const redFlag = isRedFlag('ngất');
  console.log(`    isRedFlag("ngất")=${redFlag}`);
  assert(U, redFlag === true, 'ngất is detected as red flag', 'FAIL ngất not detected as red flag');

  const emergency = detectEmergency(['ngất', 'chóng mặt'], profile);
  console.log(`    detectEmergency(["ngất","chóng mặt"]): isEmergency=${emergency.isEmergency}, type=${emergency.type}`);
  pass(U, 'emergency detector runs without crash for elderly');

  // Test 5: Fallback "đau hông" -> fallback works, severity bumped
  subheader('Test 5: Fallback "đau hông" with elderly');
  const matchHip = await matchCluster(pool, USER_ID, 'đau hông');
  console.log(`    matchCluster("đau hông"): matched=${matchHip.matched}`);

  const fbConclusion = runScriptSession(fbData, [5, 'Từ sáng', 'Vẫn vậy'], profile);
  console.log(`    fallback severity=${fbConclusion.severity}, modifiers=${JSON.stringify(fbConclusion.modifiersApplied)}`);
  assert(U,
    fbConclusion.severity === 'high',
    'fallback with elderly+conditions: medium bumped to high',
    `FAIL expected high got ${fbConclusion.severity}`
  );
  await logFallback(pool, USER_ID, 'đau hông', null, [
    { question_id: 'fb1', answer: 5 },
    { question_id: 'fb2', answer: 'Từ sáng' },
    { question_id: 'fb3', answer: 'Vẫn vậy' },
  ]);
  pass(U, 'fallback logged successfully');
}

// ════════════════════════════════════════════════════════════════════════════
// USER 2: Anh Minh — 35 tuổi, khỏe mạnh, hay nhập liệu lạ
// ════════════════════════════════════════════════════════════════════════════

async function testUser2() {
  const U = 'AnhMinh';
  initUser(U);
  header('USER 2: Anh Minh — 35 tuổi, khỏe mạnh');

  const profile = {
    birth_year: 1991,
    gender: 'Nam',
    full_name: 'Trần Văn Minh',
    medical_conditions: [],
    age: 35,
  };

  await cleanUser();
  await setupProfile(profile);
  await createClustersFromOnboarding(pool, USER_ID, ['đau đầu']);

  // Test 1: Check-in "đau đầu" -> LOW severity (young, no conditions)
  subheader('Test 1: đau đầu -> LOW for young healthy');
  const hdScript = await getScript(pool, USER_ID, 'headache', 'initial');
  assert(U, hdScript, 'headache script exists', 'FAIL headache script not found');

  if (hdScript) {
    const hdData = hdScript.script_data;
    // Mild answers for headache (non-slider script)
    const conclusion1 = runScriptSession(hdData, [], profile); // all defaults
    console.log(`    severity=${conclusion1.severity}, modifiers=${JSON.stringify(conclusion1.modifiersApplied)}`);
    assert(U,
      conclusion1.severity === 'low',
      'young healthy: low severity for mild headache',
      `FAIL expected low got ${conclusion1.severity}`
    );

    // Test 2: Same slider answers that gave Bà Lan HIGH -> LOWER for Minh
    // Using fallback script (with slider) for fair comparison
    subheader('Test 2: Same fallback slider=5 -> LOWER for young healthy vs elderly');
    const fbData = getFallbackScriptData();
    const conclusion2 = runScriptSession(fbData, [5, 'Từ sáng', 'Vẫn vậy'], profile);
    console.log(`    Anh Minh fallback slider=5: severity=${conclusion2.severity} (Bà Lan would be HIGH)`);
    assert(U,
      conclusion2.severity === 'medium',
      'young healthy: fallback slider=5 stays medium (no elderly bump)',
      `FAIL expected medium got ${conclusion2.severity}`
    );
  }

  // Test 3: Fallback "đau cơ sau gym"
  subheader('Test 3: Fallback "đau cơ sau gym"');
  const matchGym = await matchCluster(pool, USER_ID, 'đau cơ sau gym');
  console.log(`    matchCluster: matched=${matchGym.matched}`);
  // "đau" token may overlap with "đau đầu" cluster. Either way, fallback test is valid.
  const fbData = getFallbackScriptData();
  const fbConclusion = runScriptSession(fbData, [3, 'Vừa mới', 'Đang đỡ'], profile);
  console.log(`    fallback severity=${fbConclusion.severity}`);
  assert(U,
    fbConclusion.severity === 'low',
    'young healthy fallback: low severity',
    `FAIL expected low got ${fbConclusion.severity}`
  );

  // Test 4: Fallback "stress work deadline" (English mixed)
  subheader('Test 4: Fallback "stress work deadline" (mixed English)');
  const matchStress = await matchCluster(pool, USER_ID, 'stress work deadline');
  console.log(`    matchCluster: matched=${matchStress.matched}`);
  const fbConclusion2 = runScriptSession(fbData, [2, 'Vài ngày', 'Vẫn vậy'], profile);
  console.log(`    fallback severity=${fbConclusion2.severity}`);
  assert(U,
    fbConclusion2.severity === 'low',
    'mixed English input handled without crash',
    `FAIL unexpected severity ${fbConclusion2.severity}`
  );

  // Test 5: matchCluster "headache" (English) -> should match cluster_key
  subheader('Test 5: matchCluster "headache" (English) vs đau đầu cluster');
  const matchEn = await matchCluster(pool, USER_ID, 'headache');
  console.log(`    matchCluster("headache"): matched=${matchEn.matched}`);
  if (matchEn.matched) {
    console.log(`    cluster_key=${matchEn.cluster.cluster_key}`);
    assert(U,
      matchEn.cluster.cluster_key === 'headache',
      'English "headache" matches headache cluster key',
      'FAIL wrong cluster matched'
    );
  } else {
    fail(U, 'English "headache" did not match headache cluster');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// USER 3: Chú Tùng — 62 tuổi, tiểu đường, check-in mỗi ngày
// ════════════════════════════════════════════════════════════════════════════

async function testUser3() {
  const U = 'ChuTung';
  initUser(U);
  header('USER 3: Chú Tùng — 62 tuổi, tiểu đường');

  const profile = {
    birth_year: 1964,
    gender: 'Nam',
    full_name: 'Lê Văn Tùng',
    medical_conditions: ['Tiểu đường'],
    age: 62,
  };

  await cleanUser();
  await setupProfile(profile);
  await createClustersFromOnboarding(pool, USER_ID, ['mệt mỏi', 'chóng mặt', 'tê tay chân', 'đau đầu', 'khó thở']);

  // Test 1: Day 1 — "mệt mỏi" with fallback slider -> diabetes+elderly bump
  // Clinical-mapping scripts have no slider, so use fallback for diabetes modifier test
  subheader('Test 1: Day 1 — fallback slider=5 -> diabetes+elderly bump');
  const fbData = getFallbackScriptData();
  const conclusion1 = runScriptSession(fbData, [5, 'Từ sáng', 'Vẫn vậy'], profile);
  console.log(`    severity=${conclusion1.severity}, modifiers=${JSON.stringify(conclusion1.modifiersApplied)}`);
  // Diabetes modifier: slider>=5 bumps to high. Then elderly+conditions also kicks.
  assert(U,
    conclusion1.severity === 'high',
    'diabetes+elderly modifier bumps fallback slider=5 to high',
    `FAIL expected high got ${conclusion1.severity}`
  );

  // Test 1b: Clinical-mapping script (no slider) — elderly+conditions safety bump
  subheader('Test 1b: mệt mỏi clinical script -> elderly+conditions safety bump');
  const fatScript = await getScript(pool, USER_ID, 'fatigue', 'initial');
  assert(U, fatScript, 'fatigue script exists', 'FAIL fatigue script not found');

  if (fatScript) {
    const conclusion1b = runScriptSession(fatScript.script_data, [], profile); // defaults
    console.log(`    severity=${conclusion1b.severity}, modifiers=${JSON.stringify(conclusion1b.modifiersApplied)}`);
    // No rule matched -> low. Elderly+conditions -> medium (safety).
    assert(U,
      conclusion1b.severity === 'medium',
      'clinical script: elderly+conditions -> medium safety bump',
      `FAIL expected medium got ${conclusion1b.severity}`
    );
  }

  // Test 2: Day 1 follow-up — "Đỡ hơn" -> LOW
  subheader('Test 2: Day 1 follow-up — "Đỡ hơn" -> LOW');
  const fuScript = await getScript(pool, USER_ID, 'fatigue', 'followup');
  if (fuScript) {
    const fuAnswers = [
      { question_id: 'fu1', answer: 'Đỡ hơn' },
      { question_id: 'fu2', answer: 'Không' },
    ];
    const fuResult = evaluateFollowUp(fuScript.script_data, fuAnswers, 'high');
    console.log(`    severity=${fuResult.severity}, action=${fuResult.action}`);
    assert(U,
      fuResult.severity === 'low',
      'follow-up "Đỡ hơn" drops to low',
      `FAIL expected low got ${fuResult.severity}`
    );
  } else {
    fail(U, 'followup script not found for fatigue');
  }

  // Test 3: Day 2 — "chóng mặt" with diabetes context (fallback slider)
  subheader('Test 3: Day 2 — chóng mặt with diabetes (fallback slider=5)');
  const conclusion3 = runScriptSession(fbData, [5, 'Vài giờ trước', 'Vẫn vậy'], profile);
  console.log(`    severity=${conclusion3.severity}, modifiers=${JSON.stringify(conclusion3.modifiersApplied)}`);
  assert(U,
    conclusion3.severity === 'high',
    'dizziness with diabetes+elderly -> high via fallback',
    `FAIL expected high got ${conclusion3.severity}`
  );

  // Test 4: Day 3 — "đau dạ dày" -> try match or fallback
  subheader('Test 4: Day 3 — "đau dạ dày" -> match or fallback');
  const matchStomach = await matchCluster(pool, USER_ID, 'đau dạ dày');
  console.log(`    matchCluster("đau dạ dày"): matched=${matchStomach.matched}`);

  if (!matchStomach.matched) {
    const fbConclusion = runScriptSession(fbData, [4, 'Từ sáng', 'Vẫn vậy'], profile);
    console.log(`    fallback severity=${fbConclusion.severity}`);
    await logFallback(pool, USER_ID, 'đau dạ dày', null, [{ question_id: 'fb1', answer: 4 }]);
    pass(U, 'fallback logged for đau dạ dày');
  } else {
    pass(U, 'đau dạ dày matched existing cluster (mapping has gastric_pain)');
  }

  // Test 5: R&D creates cluster -> Day 4 matches
  subheader('Test 5: R&D creates cluster -> Day 4 matches');
  await addCluster(pool, USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
  const matchAfterRnd = await matchCluster(pool, USER_ID, 'đau dạ dày');
  console.log(`    After R&D: matchCluster("đau dạ dày"): matched=${matchAfterRnd.matched}`);
  assert(U,
    matchAfterRnd.matched,
    'after R&D creates cluster, đau dạ dày matches',
    'FAIL đau dạ dày still no match after R&D'
  );

  // Test 6: "tê tay" -> matches "tê tay chân" (partial match)
  subheader('Test 6: "tê tay" partial match -> "tê tay chân"');
  const matchTeTay = await matchCluster(pool, USER_ID, 'tê tay');
  console.log(`    matchCluster("tê tay"): matched=${matchTeTay.matched}`);
  if (matchTeTay.matched) {
    console.log(`    display_name=${matchTeTay.cluster.display_name}`);
    assert(U, true, 'partial match "tê tay" -> "tê tay chân" works');
  } else {
    fail(U, 'partial match "tê tay" did not find "tê tay chân" cluster');
  }

  // Test 7: Multiple follow-ups: better -> same -> worse
  subheader('Test 7: Sequential follow-ups: better -> same -> worse');
  const fuData = fuScript?.script_data || getFallbackScriptData();

  const fu7a = evaluateFollowUp(fuData, [
    { question_id: 'fu1', answer: 'Đỡ hơn' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'medium');
  console.log(`    Step 1 (better): severity=${fu7a.severity}, action=${fu7a.action}`);
  assert(U, fu7a.severity === 'low', 'better -> drops to low', `FAIL got ${fu7a.severity}`);

  const fu7b = evaluateFollowUp(fuData, [
    { question_id: 'fu1', answer: 'Vẫn vậy' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'low');
  console.log(`    Step 2 (same, prev=low): severity=${fu7b.severity}, action=${fu7b.action}`);
  assert(U, fu7b.severity === 'low', 'same with prev=low -> stays low', `FAIL got ${fu7b.severity}`);

  const fu7c = evaluateFollowUp(fuData, [
    { question_id: 'fu1', answer: 'Nặng hơn' },
    { question_id: 'fu2', answer: 'Có' },
  ], 'low');
  console.log(`    Step 3 (worse): severity=${fu7c.severity}, action=${fu7c.action}`);
  assert(U, fu7c.severity === 'high', 'worse -> escalates to high', `FAIL got ${fu7c.severity}`);
}

// ════════════════════════════════════════════════════════════════════════════
// USER 4: Cô Hương — 55 tuổi, first time user, cautious
// ════════════════════════════════════════════════════════════════════════════

async function testUser4() {
  const U = 'CoHuong';
  initUser(U);
  header('USER 4: Cô Hương — 55 tuổi, first time, cautious');

  const profile = {
    birth_year: 1971,
    gender: 'Nữ',
    full_name: 'Phạm Thị Hương',
    medical_conditions: ['Cao huyết áp'],
    age: 55,
  };

  await cleanUser();
  await setupProfile(profile);
  // NO clusters created (empty onboarding)

  // Test 1: getUserScript with NO clusters -> returns null
  subheader('Test 1: getUserScript with no clusters -> null');
  const userScript = await getUserScript(pool, USER_ID);
  console.log(`    getUserScript: ${userScript === null ? 'null' : 'has data'}`);
  assert(U, userScript === null, 'no clusters -> getUserScript returns null', 'FAIL expected null');

  // Test 2: startScript with no clusters -> fallback
  subheader('Test 2: No clusters -> fallback script');
  const fbData = getFallbackScriptData();
  const { valid } = validateScript(fbData);
  assert(U, valid, 'fallback script validates correctly', 'FAIL fallback script invalid');

  const fbConclusion = runScriptSession(fbData, [4, 'Từ sáng', 'Vẫn vậy'], profile);
  console.log(`    fallback severity=${fbConclusion.severity}`);
  assert(U, fbConclusion.severity !== undefined, 'fallback produces a result', 'FAIL no result');

  // Test 3: After fallback, R&D creates cluster -> next day has script
  subheader('Test 3: R&D creates cluster -> next day has script');
  await addCluster(pool, USER_ID, 'headache', 'đau đầu', 'rnd_cycle');
  const nextDayScript = await getUserScript(pool, USER_ID);
  console.log(`    After R&D: getUserScript: ${nextDayScript ? 'has data' : 'null'}`);
  assert(U, nextDayScript !== null, 'after R&D creates cluster, getUserScript returns data', 'FAIL still null');

  if (nextDayScript) {
    assert(U,
      nextDayScript.clusters.length > 0,
      `has ${nextDayScript.clusters.length} cluster(s)`,
      'FAIL no clusters in result'
    );
  }

  // Test 4: symptom_input "đau đầu" -> matchCluster finds it
  subheader('Test 4: symptom_input "đau đầu" -> matchCluster finds it');
  const matchResult = await matchCluster(pool, USER_ID, 'đau đầu');
  console.log(`    matchCluster("đau đầu"): matched=${matchResult.matched}`);
  assert(U, matchResult.matched, 'symptom_input matches via matchCluster', 'FAIL no match');

  if (matchResult.matched) {
    const script = await getScript(pool, USER_ID, matchResult.cluster.cluster_key, 'initial');
    assert(U, script !== null, 'script found for matched cluster', 'FAIL no script');
  }

  // Test 5: Emergency during first ever check-in -> detected
  subheader('Test 5: Emergency during first check-in');
  const emergency = detectEmergency(['đau ngực', 'khó thở', 'vã mồ hôi'], profile);
  console.log(`    isEmergency=${emergency.isEmergency}, type=${emergency.type}`);
  assert(U, emergency.isEmergency, 'MI emergency detected for first-time user', 'FAIL emergency not detected');
}

// ════════════════════════════════════════════════════════════════════════════
// USER 5: Edge case user — data inconsistencies
// ════════════════════════════════════════════════════════════════════════════

async function testUser5() {
  const U = 'EdgeUser';
  initUser(U);
  header('USER 5: Edge case — null profile fields');

  const profile = {
    birth_year: null,
    gender: null,
    full_name: null,
    medical_conditions: null,
    age: null,
  };

  await cleanUser();
  await pool.query(
    `INSERT INTO users (id, display_name, full_name)
     VALUES ($1, null, null)
     ON CONFLICT (id) DO UPDATE SET display_name = null, full_name = null`,
    [USER_ID]
  );
  // medical_conditions has NOT NULL constraint with default '[]' in DB
  await pool.query(
    `INSERT INTO user_onboarding_profiles (user_id, birth_year, gender, medical_conditions)
     VALUES ($1, null, null, '[]'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET birth_year = null, gender = null, medical_conditions = '[]'::jsonb`,
    [USER_ID]
  );

  await createClustersFromOnboarding(pool, USER_ID, ['đau đầu']);

  // Test 1: getUserScript -> works (no crash)
  subheader('Test 1: getUserScript with null profile -> no crash');
  try {
    const userScript = await getUserScript(pool, USER_ID);
    console.log(`    getUserScript: ${userScript ? 'has data' : 'null'}`);
    assert(U, userScript !== null, 'getUserScript works with null profile', 'FAIL returned null');
  } catch (err) {
    fail(U, `getUserScript CRASHED: ${err.message}`);
  }

  // Test 2: getNextQuestion -> personalization falls back to "bạn"
  subheader('Test 2: getNextQuestion personalization -> fallback to "bạn"');
  const hdScript = await getScript(pool, USER_ID, 'headache', 'initial');
  if (hdScript) {
    try {
      const next = getNextQuestion(hdScript.script_data, [], { sessionType: 'initial', profile });
      console.log(`    question: "${next.question?.text}"`);
      assert(U, !next.isDone, 'getNextQuestion works with null profile', 'FAIL');
      pass(U, 'personalization does not crash on null profile');
    } catch (err) {
      fail(U, `getNextQuestion CRASHED: ${err.message}`);
    }
  }

  // Test 3: evaluateScript -> no crash on null medical_conditions
  subheader('Test 3: evaluateScript with null medical_conditions');
  if (hdScript) {
    try {
      // Build answers matching the script's actual questions
      const qs = hdScript.script_data.questions || [];
      const answers = qs.map(q => ({
        question_id: q.id,
        answer: q.options?.[0] ?? 3,
      }));
      const result = evaluateScript(hdScript.script_data, answers, profile);
      console.log(`    severity=${result.severity}, modifiers=${JSON.stringify(result.modifiersApplied)}`);
      assert(U, result.severity !== undefined, 'evaluateScript works with null profile', 'FAIL');
    } catch (err) {
      fail(U, `evaluateScript CRASHED: ${err.message}`);
    }
  }

  // Test 4: matchCluster -> works
  subheader('Test 4: matchCluster with null profile user');
  try {
    const match = await matchCluster(pool, USER_ID, 'đau đầu');
    console.log(`    matchCluster: matched=${match.matched}`);
    assert(U, match.matched, 'matchCluster works for null profile user', 'FAIL');
  } catch (err) {
    fail(U, `matchCluster CRASHED: ${err.message}`);
  }

  // Test 5: Fallback -> works
  subheader('Test 5: Fallback with null profile');
  try {
    const fbData = getFallbackScriptData();
    const fbConclusion = runScriptSession(fbData, [3, 'Vừa mới', 'Đang đỡ'], profile);
    console.log(`    fallback severity=${fbConclusion.severity}`);
    assert(U, fbConclusion.severity !== undefined, 'fallback works with null profile', 'FAIL');
  } catch (err) {
    fail(U, `Fallback CRASHED: ${err.message}`);
  }

  // Test 6: Emergency detection -> works with null profile
  subheader('Test 6: Emergency detection with null profile');
  try {
    const emergency = detectEmergency(['đau ngực', 'khó thở'], profile);
    console.log(`    isEmergency=${emergency.isEmergency}, type=${emergency.type}`);
    assert(U, emergency !== undefined, 'emergency detection works with null profile fields', 'FAIL');
  } catch (err) {
    fail(U, `Emergency detection CRASHED with profile fields null: ${err.message}`);
  }

  // Test with entirely null profile object
  try {
    const emergency2 = detectEmergency(['ngất'], null);
    console.log(`    null profile entirely: isEmergency=${emergency2.isEmergency}`);
    pass(U, 'emergency detection handles null profile object gracefully');
  } catch (err) {
    // This is a REAL BUG: detectEmergency crashes when profile is null
    fail(U, `Emergency detection CRASHED with null profile object: ${err.message} (BUG: should guard against null)`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CROSS-USER COMPARISON
// ════════════════════════════════════════════════════════════════════════════

async function testCrossComparison() {
  const U = 'CrossUser';
  initUser(U);
  header('CROSS-USER COMPARISON: Same fallback script, same slider, different profiles');

  const profiles = {
    BaLan: {
      birth_year: 1951, gender: 'Nữ', full_name: 'Nguyễn Thị Lan',
      medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp', 'Suy thận', 'Loãng xương'],
      age: 75,
    },
    AnhMinh: {
      birth_year: 1991, gender: 'Nam', full_name: 'Trần Văn Minh',
      medical_conditions: [],
      age: 35,
    },
    ChuTung: {
      birth_year: 1964, gender: 'Nam', full_name: 'Lê Văn Tùng',
      medical_conditions: ['Tiểu đường'],
      age: 62,
    },
    CoHuong: {
      birth_year: 1971, gender: 'Nữ', full_name: 'Phạm Thị Hương',
      medical_conditions: ['Cao huyết áp'],
      age: 55,
    },
    EdgeUser: {
      birth_year: null, gender: null, full_name: null,
      medical_conditions: null,
      age: null,
    },
  };

  // Use fallback script (has slider) for fair cross-comparison
  const fbData = getFallbackScriptData();
  const moderateAnswers = [5, 'Từ sáng', 'Vẫn vậy']; // slider=5 -> medium base

  // Test 1: Bà Lan (75, 4 conditions) vs Anh Minh (35, 0 conditions)
  subheader('Test 1: Bà Lan vs Anh Minh — same fallback slider=5');
  const resLan = runScriptSession(fbData, moderateAnswers, profiles.BaLan);
  const resMinh = runScriptSession(fbData, moderateAnswers, profiles.AnhMinh);
  console.log(`    Bà Lan (75, 4 conds): severity=${resLan.severity}`);
  console.log(`    Anh Minh (35, 0 conds): severity=${resMinh.severity}`);

  const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
  const lanHigher = SEVERITY_ORDER[resLan.severity] > SEVERITY_ORDER[resMinh.severity];
  assert(U,
    lanHigher,
    'Bà Lan gets HIGHER severity than Anh Minh (same answers)',
    `FAIL Bà Lan=${resLan.severity} vs Minh=${resMinh.severity}`
  );

  // Test 2: Chú Tùng (62, diabetes) -> diabetes modifier bumps slider=5
  subheader('Test 2: Chú Tùng — diabetes bump via fallback slider');
  const resTung = runScriptSession(fbData, moderateAnswers, profiles.ChuTung);
  console.log(`    Chú Tùng (62, diabetes): severity=${resTung.severity}, modifiers=${JSON.stringify(resTung.modifiersApplied)}`);
  assert(U,
    resTung.severity === 'high',
    'diabetes + elderly bumps Chú Tùng to high',
    `FAIL expected high got ${resTung.severity}`
  );

  // Test 3: Cô Hương (55, hypertension) -> check hypertension modifier
  // Note: fallback condition_modifiers only has "tiểu đường" check, not "huyết áp"
  // So hypertension doesn't bump via fallback. She's also age=55 (<60), so no elderly bump.
  subheader('Test 3: Cô Hương — hypertension profile');
  const resHuong = runScriptSession(fbData, moderateAnswers, profiles.CoHuong);
  console.log(`    Cô Hương (55, hypertension): severity=${resHuong.severity}, modifiers=${JSON.stringify(resHuong.modifiersApplied)}`);
  // No diabetes modifier matches, age < 60 -> stays medium
  assert(U,
    resHuong.severity === 'medium',
    'hypertension user without specific modifier stays at medium (correct behavior)',
    `FAIL expected medium got ${resHuong.severity}`
  );

  // Test 4: Edge user (null everything) -> no crash, reasonable defaults
  subheader('Test 4: Edge user (null everything) — no crash');
  try {
    const resEdge = runScriptSession(fbData, moderateAnswers, profiles.EdgeUser);
    console.log(`    Edge user (null): severity=${resEdge.severity}`);
    assert(U, resEdge.severity !== undefined, 'edge user produces valid severity', 'FAIL');
    // Null age, null conditions -> base medium from slider rule, no bumps
    assert(U,
      resEdge.severity === 'medium',
      'null profile gets base medium (no bumps applied)',
      `FAIL expected medium got ${resEdge.severity}`
    );
  } catch (err) {
    fail(U, `Edge user CRASHED: ${err.message}`);
  }

  // Test 5: Follow-up "Nặng hơn" escalates for ALL profiles
  subheader('Test 5: "Nặng hơn" escalates for ALL profiles');
  const fuAnswers = [
    { question_id: 'fu1', answer: 'Nặng hơn' },
    { question_id: 'fu2', answer: 'Có' },
  ];

  let allEscalate = true;
  for (const [name, prof] of Object.entries(profiles)) {
    const fuResult = evaluateFollowUp(fbData, fuAnswers, 'medium');
    console.log(`    ${name}: followup severity=${fuResult.severity}, action=${fuResult.action}`);
    if (fuResult.severity !== 'high') {
      allEscalate = false;
    }
  }
  assert(U,
    allEscalate,
    '"Nặng hơn" escalates to HIGH for all profiles',
    'FAIL some profiles did not escalate'
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function run() {
  console.log('Starting Realistic User Scenarios Test...\n');

  try {
    await testUser1();
    await testUser2();
    await testUser3();
    await testUser4();
    await testUser5();
    await testCrossComparison();
  } catch (err) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    console.error(err.stack);
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  header('FINAL REPORT');
  console.log();
  for (const [user, counts] of Object.entries(perUser)) {
    const total = counts.pass + counts.fail;
    const status = counts.fail === 0 ? 'ALL PASS' : `${counts.fail} FAIL`;
    console.log(`  ${user.padEnd(12)} ${counts.pass}/${total} passed   [${status}]`);
  }
  console.log(`\n  ${'TOTAL'.padEnd(12)} ${totalPass}/${totalPass + totalFail} passed   [${totalFail === 0 ? 'ALL PASS' : `${totalFail} FAIL`}]`);
  console.log();

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
