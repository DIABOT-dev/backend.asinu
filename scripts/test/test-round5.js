#!/usr/bin/env node
/**
 * Round 5 — STRESS & EDGE CASE tests
 *
 * Sections:
 *   A. Duplicate / Idempotency (8 tests)
 *   B. Unicode / Vietnamese edge cases (10 tests)
 *   C. Concurrent-like scenarios (5 tests)
 *   D. Boundary / null tests (12 tests)
 *   E. Emergency detection robustness (10 tests)
 *   F. Data integrity after full cycle (5 tests)
 *
 * Total: 50 tests
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── imports ───────────────────────────────────────────────────────────────
const {
  createClustersFromOnboarding,
  getUserScript,
  getScript,
  addCluster,
  toClusterKey,
} = require('../src/services/checkin/script.service');

const {
  getNextQuestion,
  validateScript,
} = require('../src/services/checkin/script-runner');

const {
  evaluateScript,
  evaluateFollowUp,
} = require('../src/services/checkin/scoring-engine');

const {
  getFallbackScriptData,
  logFallback,
  matchCluster,
  getPendingFallbacks,
  markFallbackProcessed,
} = require('../src/services/checkin/fallback.service');

const { detectEmergency } = require('../src/services/checkin/emergency-detector');

const {
  listComplaints,
  resolveComplaint,
} = require('../src/services/checkin/clinical-mapping');

// ─── constants ─────────────────────────────────────────────────────────────
const USER_ID = 4;
const PROFILE = {
  birth_year: 1958,
  gender: 'Nam',
  full_name: 'Tran Van Hung',
  display_name: 'Chu Hung',
  medical_conditions: ['Tieu duong', 'Cao huyet ap', 'Tim mach'],
  age: 68,
};

// ─── helpers ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const sectionStats = {};
let currentSection = '';

function section(name) {
  currentSection = name;
  sectionStats[name] = { passed: 0, failed: 0 };
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}`);
  console.log(`${'='.repeat(70)}`);
}

function test(label, ok, detail) {
  if (ok) {
    passed++;
    sectionStats[currentSection].passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    sectionStats[currentSection].failed++;
    console.log(`  FAIL  ${label}`);
  }
  if (detail !== undefined) {
    console.log(`        => ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
  }
}

// ─── cleanup ───────────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n--- Cleaning up user_id=4 data ---');
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [USER_ID]);
  console.log('    Done.\n');
}

// ═══════════════════════════════════════════════════════════════════════════
//  A. Duplicate / Idempotency tests (8)
// ═══════════════════════════════════════════════════════════════════════════
async function sectionA() {
  section('A. Duplicate / Idempotency tests');

  // A1: createClustersFromOnboarding same symptoms twice -> no duplicate clusters
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['dau dau', 'chong mat']);
  await createClustersFromOnboarding(pool, USER_ID, ['dau dau', 'chong mat']);
  const { rows: a1 } = await pool.query(
    `SELECT * FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE`,
    [USER_ID]
  );
  // toClusterKey of 'dau dau' and 'chong mat' — these may not map to known keys
  // The UNIQUE(user_id, cluster_key) + ON CONFLICT ensures no duplicates
  const uniqueKeys = [...new Set(a1.map(r => r.cluster_key))];
  test('A1: Same symptoms twice -> no duplicate clusters',
    a1.length === uniqueKeys.length,
    `rows=${a1.length}, uniqueKeys=${uniqueKeys.length}`);

  // A2: overlapping symptoms -> 3 unique clusters
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['dau dau', 'chong mat']);
  await createClustersFromOnboarding(pool, USER_ID, ['chong mat', 'sot']);
  const { rows: a2 } = await pool.query(
    `SELECT * FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE`,
    [USER_ID]
  );
  const a2keys = [...new Set(a2.map(r => r.cluster_key))];
  test('A2: Overlapping ["dau dau","chong mat"] then ["chong mat","sot"] -> 3 unique',
    a2keys.length === 3,
    `uniqueKeys=${a2keys.length}: ${a2keys.join(', ')}`);

  // A3: addCluster same key twice -> no error, same cluster returned
  await cleanup();
  const c1 = await addCluster(pool, USER_ID, 'headache', 'Dau dau', 'test');
  const c2 = await addCluster(pool, USER_ID, 'headache', 'Dau dau', 'test');
  test('A3: addCluster same key twice -> no error, same cluster id',
    c1.id === c2.id,
    `id1=${c1.id}, id2=${c2.id}`);

  // A4: logFallback same symptom 5 times -> 5 rows (no dedup)
  await cleanup();
  for (let i = 0; i < 5; i++) {
    await logFallback(pool, USER_ID, 'trieu chung la', null, []);
  }
  const { rows: a4 } = await pool.query(
    `SELECT * FROM fallback_logs WHERE user_id = $1`, [USER_ID]
  );
  test('A4: logFallback same symptom 5 times -> 5 rows',
    a4.length === 5,
    `rows=${a4.length}`);

  // A5: getUserScript called 3 times -> same result each time
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['\u0111au \u0111\u1ea7u']);
  const r1 = await getUserScript(pool, USER_ID);
  const r2 = await getUserScript(pool, USER_ID);
  const r3 = await getUserScript(pool, USER_ID);
  const sameGreeting = r1.greeting === r2.greeting && r2.greeting === r3.greeting;
  const sameClusters = JSON.stringify(r1.clusters) === JSON.stringify(r2.clusters);
  test('A5: getUserScript 3 times -> same result (idempotent)',
    sameGreeting && sameClusters,
    `greetings match=${sameGreeting}, clusters match=${sameClusters}`);

  // A6: getScript same params 3 times -> same result
  // Use 'headache' key which is what toClusterKey('đau đầu') returns
  const s1 = await getScript(pool, USER_ID, 'headache', 'initial');
  const s2 = await getScript(pool, USER_ID, 'headache', 'initial');
  const s3 = await getScript(pool, USER_ID, 'headache', 'initial');
  const sameScript = s1 && s2 && s3 && s1.id === s2.id && s2.id === s3.id;
  test('A6: getScript same params 3 times -> same result',
    sameScript,
    `ids: ${s1?.id}, ${s2?.id}, ${s3?.id}`);

  // A7: Count clusters after duplicates -> correct number
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['dau dau', 'chong mat']);
  await createClustersFromOnboarding(pool, USER_ID, ['dau dau']); // duplicate
  const { rows: a7 } = await pool.query(
    `SELECT * FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE`, [USER_ID]
  );
  const a7keys = [...new Set(a7.map(r => r.cluster_key))];
  test('A7: Count clusters after duplicates -> correct number',
    a7.length === a7keys.length && a7keys.length === 2,
    `total=${a7.length}, unique=${a7keys.length}`);

  // A8: Count scripts after duplicates -> correct number (no orphans)
  const { rows: a8 } = await pool.query(
    `SELECT * FROM triage_scripts WHERE user_id = $1 AND is_active = TRUE`, [USER_ID]
  );
  // Each cluster should have 1 active initial + 1 active followup = 2 per cluster
  // But the unique index only allows 1 active per (user, cluster_key, script_type)
  const activeInitial = a8.filter(s => s.script_type === 'initial');
  const activeFollowup = a8.filter(s => s.script_type === 'followup');
  test('A8: Count scripts after duplicates -> no orphans',
    activeInitial.length === 2 && activeFollowup.length <= 2,
    `active initial=${activeInitial.length}, followup=${activeFollowup.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  B. Unicode / Vietnamese edge cases (10)
// ═══════════════════════════════════════════════════════════════════════════
async function sectionB() {
  section('B. Unicode / Vietnamese edge cases');
  await cleanup();

  // B1: Symptom with special chars
  const b1clusters = await createClustersFromOnboarding(pool, USER_ID, ['dau dau (migraine)']);
  test('B1: Symptom with special chars "dau dau (migraine)" -> cluster created',
    b1clusters.length === 1 && b1clusters[0].cluster_key,
    `key=${b1clusters[0]?.cluster_key}`);

  // B2: Symptom all uppercase vs lowercase -> same key
  await cleanup();
  const keyUpper = toClusterKey('DAU DAU');
  const keyLower = toClusterKey('dau dau');
  test('B2: "DAU DAU" maps to same key as "dau dau"',
    keyUpper === keyLower,
    `upper=${keyUpper}, lower=${keyLower}`);

  // B3: Extra spaces
  const keySpaces = toClusterKey('  dau  dau  ');
  // trim() handles leading/trailing, but internal spaces may differ
  test('B3: Extra spaces "  dau  dau  " -> handled (no crash)',
    typeof keySpaces === 'string' && keySpaces.length > 0,
    `key=${keySpaces}`);

  // B4: Symptom with numbers
  await cleanup();
  const b4clusters = await createClustersFromOnboarding(pool, USER_ID, ['dau dau 3 ngay']);
  test('B4: Symptom with numbers "dau dau 3 ngay" -> cluster created',
    b4clusters.length === 1 && b4clusters[0].cluster_key,
    `key=${b4clusters[0]?.cluster_key}`);

  // B5: matchCluster with diacritics vs without
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['chong mat']);
  const b5match = await matchCluster(pool, USER_ID, 'chong mat');
  test('B5: matchCluster "chong mat" vs stored cluster -> test behavior',
    typeof b5match === 'object' && 'matched' in b5match,
    `matched=${b5match.matched}, cluster=${b5match.cluster?.cluster_key}`);

  // B6: Empty string symptom -> no crash
  await cleanup();
  let b6ok = true;
  try {
    const b6clusters = await createClustersFromOnboarding(pool, USER_ID, ['']);
    // Even if it creates something, no crash is the main test
  } catch (e) {
    b6ok = false;
  }
  test('B6: Empty string symptom -> no crash', b6ok);

  // B7: Very long symptom (200 chars)
  await cleanup();
  const longSymptom = 'dau dau '.repeat(25).trim(); // ~200 chars
  let b7ok = true;
  try {
    await createClustersFromOnboarding(pool, USER_ID, [longSymptom]);
  } catch (e) {
    b7ok = false;
  }
  test('B7: Very long symptom (200 chars) -> no crash', b7ok);

  // B8: Symptom with emoji
  await cleanup();
  let b8ok = true;
  try {
    await createClustersFromOnboarding(pool, USER_ID, ['dau dau \u{1F62B}']);
  } catch (e) {
    b8ok = false;
  }
  test('B8: Symptom with emoji -> no crash', b8ok);

  // B9: Answer with Vietnamese to multi_choice
  const fallbackScript = getFallbackScriptData();
  const answers = [
    { question_id: 'fb1', answer: 5 },
    { question_id: 'fb2', answer: 'Vua moi' },
    { question_id: 'fb3', answer: 'Van vay' },
  ];
  let b9ok = true;
  try {
    const result = evaluateScript(fallbackScript, answers, PROFILE);
    b9ok = result && typeof result.severity === 'string';
  } catch (e) {
    b9ok = false;
  }
  test('B9: Vietnamese answer to scoring -> works', b9ok);

  // B10: Conclusion template with Vietnamese diacritics preserved
  await cleanup();
  await createClustersFromOnboarding(pool, USER_ID, ['\u0111au \u0111\u1ea7u']);
  const b10script = await getScript(pool, USER_ID, 'headache', 'initial');
  const templates = b10script?.script_data?.conclusion_templates;
  const hasVietnamese = templates?.low?.summary && templates.low.summary.length > 0;
  test('B10: Conclusion template with Vietnamese diacritics preserved',
    hasVietnamese,
    `summary preview: ${templates?.low?.summary?.substring(0, 60)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  C. Concurrent-like scenarios (5)
// ═══════════════════════════════════════════════════════════════════════════
async function sectionC() {
  section('C. Concurrent-like scenarios');

  // C1: Create cluster + immediately getScript -> script available
  await cleanup();
  await addCluster(pool, USER_ID, 'dizziness', 'Chong mat', 'test');
  const c1script = await getScript(pool, USER_ID, 'dizziness', 'initial');
  test('C1: Create cluster + immediately getScript -> available',
    c1script !== null && c1script.script_data,
    `script_id=${c1script?.id}`);

  // C2: Two different clusters in sequence -> both have scripts
  await cleanup();
  await addCluster(pool, USER_ID, 'headache', 'Dau dau', 'test');
  await addCluster(pool, USER_ID, 'fever', 'Sot', 'test');
  const c2a = await getScript(pool, USER_ID, 'headache', 'initial');
  const c2b = await getScript(pool, USER_ID, 'fever', 'initial');
  test('C2: Two clusters in sequence -> both have scripts',
    c2a !== null && c2b !== null,
    `headache=${c2a?.id}, fever=${c2b?.id}`);

  // C3: Start session -> answer -> start NEW session same day -> old session still in DB
  await cleanup();
  await addCluster(pool, USER_ID, 'headache', 'Dau dau', 'test');
  const c3script = await getScript(pool, USER_ID, 'headache', 'initial');
  // Insert session 1
  await pool.query(
    `INSERT INTO script_sessions (user_id, script_id, cluster_key, session_type, answers, current_step)
     VALUES ($1, $2, 'headache', 'initial', $3::jsonb, 1)`,
    [USER_ID, c3script.id, JSON.stringify([{ question_id: 'q1', answer: 3 }])]
  );
  // Insert session 2
  await pool.query(
    `INSERT INTO script_sessions (user_id, script_id, cluster_key, session_type, answers, current_step)
     VALUES ($1, $2, 'headache', 'initial', '[]'::jsonb, 0)`,
    [USER_ID, c3script.id]
  );
  const { rows: c3sessions } = await pool.query(
    `SELECT * FROM script_sessions WHERE user_id = $1 ORDER BY created_at`, [USER_ID]
  );
  test('C3: Two sessions same day -> both exist in DB',
    c3sessions.length === 2,
    `sessions=${c3sessions.length}`);

  // C4: Multiple fallback logs same user same day -> all saved
  await cleanup();
  await logFallback(pool, USER_ID, 'dau tai', null, []);
  await logFallback(pool, USER_ID, 'ngua da', null, []);
  await logFallback(pool, USER_ID, 'mat ngu', null, []);
  const { rows: c4 } = await pool.query(
    `SELECT * FROM fallback_logs WHERE user_id = $1`, [USER_ID]
  );
  test('C4: Multiple fallback logs same day -> all saved',
    c4.length === 3,
    `rows=${c4.length}`);

  // C5: getUserScript after adding 10 clusters -> returns all 10
  await cleanup();
  // Use proper Vietnamese with diacritics so each maps to a unique cluster key
  const symptoms10 = [
    '\u0111au \u0111\u1ea7u', 'ch\u00f3ng m\u1eb7t', 's\u1ed1t', 'ho', 'm\u1ec7t m\u1ecfi',
    '\u0111au b\u1ee5ng', '\u0111au l\u01b0ng', 'm\u1ea5t ng\u1ee7', '\u0111au kh\u1edbp', 'bu\u1ed3n n\u00f4n',
  ];
  await createClustersFromOnboarding(pool, USER_ID, symptoms10);
  const c5result = await getUserScript(pool, USER_ID);
  test('C5: getUserScript after 10 clusters -> returns all 10',
    c5result && c5result.clusters && c5result.clusters.length === 10,
    `clusters=${c5result?.clusters?.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  D. Boundary / null tests (12)
// ═══════════════════════════════════════════════════════════════════════════
async function sectionD() {
  section('D. Boundary / null tests');

  // D1: getNextQuestion with empty script (no questions) -> isDone immediately
  const emptyScript = {
    questions: [],
    scoring_rules: [],
    conclusion_templates: { low: { summary: 'OK', recommendation: '', close_message: '' } },
    condition_modifiers: [],
  };
  const d1 = getNextQuestion(emptyScript, [], { sessionType: 'initial', profile: PROFILE });
  test('D1: getNextQuestion with empty questions -> isDone immediately',
    d1.isDone === true,
    `isDone=${d1.isDone}`);

  // D2: evaluateScript with empty scoring_rules -> default LOW
  const d2script = {
    scoring_rules: [],
    condition_modifiers: [],
  };
  const d2 = evaluateScript(d2script, [{ question_id: 'q1', answer: 5 }], PROFILE);
  test('D2: evaluateScript with empty scoring_rules -> severity present',
    typeof d2.severity === 'string',
    `severity=${d2.severity}`);

  // D3: evaluateScript with null profile -> no crash
  let d3ok = true;
  try {
    evaluateScript(d2script, [{ question_id: 'q1', answer: 5 }], null);
  } catch (e) {
    d3ok = false;
  }
  test('D3: evaluateScript with null profile -> no crash', d3ok);

  // D4: evaluateFollowUp with null previousSeverity -> uses default
  const followupScript = getFallbackScriptData();
  let d4ok = true;
  let d4result;
  try {
    d4result = evaluateFollowUp(followupScript,
      [{ question_id: 'fu1', answer: 'Van vay' }, { question_id: 'fu2', answer: 'Khong' }],
      null
    );
    d4ok = d4result && typeof d4result.severity === 'string';
  } catch (e) {
    d4ok = false;
  }
  test('D4: evaluateFollowUp with null previousSeverity -> uses default',
    d4ok,
    `severity=${d4result?.severity}`);

  // D5: matchCluster for non-existent user_id=9999 -> returns false, no crash
  let d5ok = true;
  let d5result;
  try {
    d5result = await matchCluster(pool, 9999, 'dau dau');
    d5ok = d5result && d5result.matched === false;
  } catch (e) {
    d5ok = false;
  }
  test('D5: matchCluster for user_id=9999 -> matched=false, no crash',
    d5ok,
    `matched=${d5result?.matched}`);

  // D6: getFallbackScriptData -> always returns valid script
  const d6 = getFallbackScriptData();
  const d6valid = d6 && d6.questions && d6.scoring_rules && d6.conclusion_templates;
  test('D6: getFallbackScriptData -> returns valid script',
    !!d6valid,
    `questions=${d6.questions?.length}, rules=${d6.scoring_rules?.length}`);

  // D7: validateScript with minimal valid script -> passes
  const minScript = {
    questions: [
      { id: 'q1', text: 'Test?', type: 'free_text' },
    ],
    scoring_rules: [{ conditions: [], combine: 'and', severity: 'low' }],
    conclusion_templates: { low: { summary: 'ok' } },
  };
  const d7 = validateScript(minScript);
  test('D7: validateScript with minimal valid script -> passes',
    d7.valid === true,
    `valid=${d7.valid}, errors=${d7.errors}`);

  // D8: validateScript with completely empty object -> fails with errors
  const d8 = validateScript({});
  test('D8: validateScript with empty object -> fails with errors',
    d8.valid === false && d8.errors.length > 0,
    `valid=${d8.valid}, errors=${d8.errors.length}: ${d8.errors.join('; ')}`);

  // D9: Slider answer 0 (falsy but valid) -> scored correctly, not treated as missing
  const sliderScript = {
    scoring_rules: [
      { conditions: [{ field: 'q1', op: 'lt', value: 4 }], combine: 'and', severity: 'low' },
      { conditions: [{ field: 'q1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium' },
    ],
    condition_modifiers: [],
  };
  const d9 = evaluateScript(sliderScript, [{ question_id: 'q1', answer: 0 }], {});
  test('D9: Slider answer 0 (falsy) -> scored correctly as low (0 < 4)',
    d9.severity === 'low' && d9.matchedRuleIndex === 0,
    `severity=${d9.severity}, matchedRule=${d9.matchedRuleIndex}`);

  // D10: Answer boolean false -> handled
  let d10ok = true;
  try {
    const d10 = evaluateScript(sliderScript, [{ question_id: 'q1', answer: false }], {});
    d10ok = typeof d10.severity === 'string';
  } catch (e) {
    d10ok = false;
  }
  test('D10: Answer boolean false -> handled (no crash)', d10ok);

  // D11: Question with skip_if referencing non-existent field -> skip not triggered
  const skipScript = {
    questions: [
      { id: 'q1', text: 'First?', type: 'free_text' },
      {
        id: 'q2', text: 'Second?', type: 'free_text',
        skip_if: { field: 'nonexistent_field', op: 'eq', value: 'something' },
      },
    ],
    scoring_rules: [{ conditions: [], combine: 'and', severity: 'low' }],
    conclusion_templates: { low: { summary: 'ok' } },
    condition_modifiers: [],
  };
  const d11 = getNextQuestion(skipScript,
    [{ question_id: 'q1', answer: 'test' }],
    { sessionType: 'initial', profile: {} }
  );
  test('D11: skip_if referencing non-existent field -> not triggered (q2 shown)',
    d11.isDone === false && d11.question?.id === 'q2',
    `isDone=${d11.isDone}, questionId=${d11.question?.id}`);

  // D12: Script with 1 question -> works, concludes after 1 answer
  const oneQScript = {
    questions: [
      { id: 'q1', text: 'Only question?', type: 'free_text' },
    ],
    scoring_rules: [
      { conditions: [{ field: 'q1', op: 'eq', value: 'yes' }], combine: 'and', severity: 'low' },
    ],
    conclusion_templates: { low: { summary: 'done', recommendation: '', close_message: '' } },
    condition_modifiers: [],
  };
  const d12q = getNextQuestion(oneQScript, [], { sessionType: 'initial', profile: {} });
  test('D12a: Script with 1 question -> first call returns question',
    d12q.isDone === false && d12q.question?.id === 'q1',
    `isDone=${d12q.isDone}`);
  const d12done = getNextQuestion(oneQScript,
    [{ question_id: 'q1', answer: 'yes' }],
    { sessionType: 'initial', profile: {} }
  );
  test('D12b: After 1 answer -> concludes',
    d12done.isDone === true && d12done.conclusion,
    `isDone=${d12done.isDone}, severity=${d12done.conclusion?.severity}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  E. Emergency detection robustness (10)
// ═══════════════════════════════════════════════════════════════════════════
function sectionE() {
  section('E. Emergency detection robustness');

  // E1: "dau nguc" alone -> check if emergency (should be sub-critical for high-risk)
  const e1 = detectEmergency(['dau nguc'], PROFILE);
  test('E1: "dau nguc" alone -> detected (high risk patient)',
    e1.severity !== 'low',
    `isEmergency=${e1.isEmergency}, type=${e1.type}, severity=${e1.severity}`);

  // E2: "dau nguc" + "kho tho" -> MI emergency
  const e2 = detectEmergency(['dau nguc', 'kho tho'], PROFILE);
  test('E2: "dau nguc" + "kho tho" -> MI emergency',
    e2.isEmergency === true && e2.type === 'MI',
    `isEmergency=${e2.isEmergency}, type=${e2.type}`);

  // E3: "yeu nua nguoi" + "noi ngong" -> STROKE
  const e3 = detectEmergency(['yeu nua nguoi', 'noi ngong'], PROFILE);
  test('E3: "yeu nua nguoi" + "noi ngong" -> STROKE',
    e3.isEmergency === true && e3.type === 'STROKE',
    `isEmergency=${e3.isEmergency}, type=${e3.type}`);

  // E4: "co giat" -> SEIZURE
  const e4 = detectEmergency(['co giat'], PROFILE);
  test('E4: "co giat" -> SEIZURE',
    e4.isEmergency === true && e4.type === 'SEIZURE',
    `isEmergency=${e4.isEmergency}, type=${e4.type}`);

  // E5: "khong dau nguc" (negation) -> NOT emergency
  const e5 = detectEmergency(['khong dau nguc'], {});
  test('E5: "khong dau nguc" (negation) -> NOT emergency',
    e5.isEmergency === false,
    `isEmergency=${e5.isEmergency}, type=${e5.type}, severity=${e5.severity}`);

  // E6: "het kho tho roi" (past tense negation) -> NOT emergency
  const e6 = detectEmergency(['het kho tho roi'], {});
  test('E6: "het kho tho roi" (past negation) -> NOT emergency',
    e6.isEmergency === false,
    `isEmergency=${e6.isEmergency}, type=${e6.type}, severity=${e6.severity}`);

  // E7: "dau nguc nhe" -> check behavior (still detected as chest pain keyword)
  const e7 = detectEmergency(['dau nguc nhe'], {});
  test('E7: "dau nguc nhe" -> check behavior',
    typeof e7.isEmergency === 'boolean',
    `isEmergency=${e7.isEmergency}, type=${e7.type}, severity=${e7.severity}`);

  // E8: "hoi met dau dau" -> NOT emergency
  const e8 = detectEmergency(['hoi met dau dau'], {});
  test('E8: "hoi met dau dau" -> NOT emergency',
    e8.isEmergency === false,
    `isEmergency=${e8.isEmergency}, type=${e8.type}`);

  // E9: Empty array -> NOT emergency, no crash
  const e9 = detectEmergency([], {});
  test('E9: Empty array -> NOT emergency, no crash',
    e9.isEmergency === false,
    `isEmergency=${e9.isEmergency}`);

  // E10: Very long text with emergency keyword buried
  const longText = 'hom nay toi cam thay hoi met, dau dau nhe, an uong binh thuong, '
    + 'nhung co mot luc toi bi co giat, sau do thi binh thuong tro lai, '
    + 'toi van sinh hoat duoc, khong co gi dac biet.';
  const e10 = detectEmergency([longText], {});
  test('E10: Long text with "co giat" buried -> still detected',
    e10.isEmergency === true && e10.type === 'SEIZURE',
    `isEmergency=${e10.isEmergency}, type=${e10.type}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  F. Data integrity after full cycle (5)
// ═══════════════════════════════════════════════════════════════════════════
async function sectionF() {
  section('F. Data integrity after full cycle');
  await cleanup();

  // F1: Create 5 clusters -> verify 5 rows in problem_clusters
  // Use proper Vietnamese diacritics for unique cluster keys
  const symptoms5 = ['\u0111au \u0111\u1ea7u', 'ch\u00f3ng m\u1eb7t', 's\u1ed1t', 'ho', 'm\u1ec7t m\u1ecfi'];
  await createClustersFromOnboarding(pool, USER_ID, symptoms5);
  const { rows: f1 } = await pool.query(
    `SELECT * FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE`, [USER_ID]
  );
  test('F1: Create 5 clusters -> 5 rows in problem_clusters',
    f1.length === 5,
    `rows=${f1.length}`);

  // F2: Each cluster has exactly 2 scripts (initial + followup)
  const { rows: f2 } = await pool.query(
    `SELECT cluster_key, script_type FROM triage_scripts
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY cluster_key, script_type`, [USER_ID]
  );
  const f2map = {};
  for (const row of f2) {
    if (!f2map[row.cluster_key]) f2map[row.cluster_key] = [];
    f2map[row.cluster_key].push(row.script_type);
  }
  const allHaveTwo = Object.values(f2map).every(types =>
    types.length === 2 && types.includes('initial') && types.includes('followup')
  );
  test('F2: Each cluster has exactly 2 scripts (initial + followup)',
    allHaveTwo,
    `clusters with scripts: ${Object.keys(f2map).length}, breakdown: ${JSON.stringify(f2map)}`);

  // F3: Log 3 fallbacks -> verify 3 rows with status=pending
  await logFallback(pool, USER_ID, 'trieu chung A', null, []);
  await logFallback(pool, USER_ID, 'trieu chung B', null, []);
  await logFallback(pool, USER_ID, 'trieu chung C', null, []);
  const { rows: f3 } = await pool.query(
    `SELECT * FROM fallback_logs WHERE user_id = $1 AND status = 'pending'`, [USER_ID]
  );
  test('F3: Log 3 fallbacks -> 3 rows with status=pending',
    f3.length === 3,
    `pending=${f3.length}`);

  // F4: Mark 1 as processed -> verify count pending=2
  await markFallbackProcessed(pool, f3[0].id, 'test_label', 'test_key', 0.95);
  const { rows: f4 } = await pool.query(
    `SELECT * FROM fallback_logs WHERE user_id = $1 AND status = 'pending'`, [USER_ID]
  );
  test('F4: Mark 1 as processed -> pending count = 2',
    f4.length === 2,
    `pending=${f4.length}`);

  // F5: Deactivate cluster -> scripts still exist but cluster inactive
  const clusterToDeactivate = f1[0];
  await pool.query(
    `UPDATE problem_clusters SET is_active = FALSE WHERE id = $1`,
    [clusterToDeactivate.id]
  );
  const { rows: f5cluster } = await pool.query(
    `SELECT * FROM problem_clusters WHERE id = $1`, [clusterToDeactivate.id]
  );
  const { rows: f5scripts } = await pool.query(
    `SELECT * FROM triage_scripts WHERE cluster_id = $1`, [clusterToDeactivate.id]
  );
  test('F5: Deactivate cluster -> cluster inactive, scripts still exist',
    f5cluster[0].is_active === false && f5scripts.length > 0,
    `cluster_active=${f5cluster[0]?.is_active}, scripts_count=${f5scripts.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║          ROUND 5 — STRESS & EDGE CASE TESTS                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    sectionE();
    await sectionF();
  } catch (err) {
    console.error('\n\nFATAL ERROR:', err);
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  ROUND 5 SUMMARY');
  console.log('='.repeat(70));
  for (const [name, stats] of Object.entries(sectionStats)) {
    const total = stats.passed + stats.failed;
    const status = stats.failed === 0 ? 'ALL PASS' : `${stats.failed} FAILED`;
    console.log(`  ${name}: ${stats.passed}/${total} passed  [${status}]`);
  }
  console.log('-'.repeat(70));
  const total = passed + failed;
  console.log(`  TOTAL: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  >>> ALL TESTS PASSED <<<');
  } else {
    console.log(`  >>> ${failed} TEST(S) FAILED <<<`);
  }
  console.log('='.repeat(70));

  await cleanup();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main();
