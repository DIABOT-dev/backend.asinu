#!/usr/bin/env node
/**
 * Multi-Symptom & Combo Detector Test
 *
 * Tests:
 *   1. parseSymptoms with various formats
 *   2. detectCombo with all 8 dangerous combos
 *   3. analyzeMultiSymptom with real DB data (user 4)
 *   4. aggregateSeverity with mixed results
 *   5. Full flow: multi-symptom input -> combo detected -> scripts identified
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { detectCombo, DANGER_COMBOS } = require(path.join(ROOT, 'src/core/checkin/combo-detector'));
const { parseSymptoms, analyzeMultiSymptom, aggregateSeverity } = require(path.join(ROOT, 'src/services/checkin/multi-symptom.service'));

const USER_ID = 4;
const PROFILE = {
  birth_year: 1958,
  gender: 'Nam',
  full_name: 'Trần Văn Hùng',
  display_name: 'Chú Hùng',
  medical_conditions: ['Tiểu đường', 'Cao huyết áp', 'Tim mạch'],
  age: 68,
};

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

function assertDeep(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        got:      ${JSON.stringify(actual)}`);
  }
}

function header(text) { console.log(`\n${'='.repeat(60)}\n  ${text}\n${'='.repeat(60)}`); }
function subheader(text) { console.log(`\n  --- ${text} ---`); }

// ═══════════════════════════════════════════════════════════════
//  1. parseSymptoms
// ═══════════════════════════════════════════════════════════════

header('1. parseSymptoms — splitting multi-symptom input');

assertDeep('comma separated',
  parseSymptoms('đau đầu, chóng mặt, buồn nôn'),
  ['đau đầu', 'chóng mặt', 'buồn nôn']
);

assertDeep('plus separated',
  parseSymptoms('đau đầu + chóng mặt'),
  ['đau đầu', 'chóng mặt']
);

assertDeep('và connector',
  parseSymptoms('đau đầu và chóng mặt'),
  ['đau đầu', 'chóng mặt']
);

assertDeep('kèm connector',
  parseSymptoms('sốt kèm đau họng'),
  ['sốt', 'đau họng']
);

assertDeep('với connector',
  parseSymptoms('ho với sốt'),
  ['ho', 'sốt']
);

assertDeep('mixed connectors',
  parseSymptoms('đau đầu, chóng mặt và buồn nôn'),
  ['đau đầu', 'chóng mặt', 'buồn nôn']
);

assertDeep('single symptom (no split)',
  parseSymptoms('đau đầu'),
  ['đau đầu']
);

assertDeep('empty string',
  parseSymptoms(''),
  []
);

assertDeep('null input',
  parseSymptoms(null),
  []
);

assertDeep('extra whitespace',
  parseSymptoms('  đau đầu ,  chóng mặt  '),
  ['đau đầu', 'chóng mặt']
);

// ═══════════════════════════════════════════════════════════════
//  2. detectCombo — all 8 dangerous combos
// ═══════════════════════════════════════════════════════════════

header('2. detectCombo — all 8 dangerous combos');

subheader('stroke_risk: đau đầu + mờ mắt');
{
  const r = detectCombo(['đau đầu', 'mờ mắt'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo id = stroke_risk', r.combos[0]?.id, 'stroke_risk');
  assert('severity = critical', r.highestSeverity, 'critical');
}

subheader('appendicitis_risk: đau bụng + sốt');
{
  const r = detectCombo(['đau bụng', 'sốt cao'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo id = appendicitis_risk', r.combos.some(c => c.id === 'appendicitis_risk'), true);
  assert('severity >= high', ['high', 'critical'].includes(r.highestSeverity), true);
}

subheader('dehydration_risk: tiêu chảy + nôn + sốt');
{
  const r = detectCombo(['tiêu chảy', 'buồn nôn', 'sốt'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo includes dehydration_risk', r.combos.some(c => c.id === 'dehydration_risk'), true);
}

subheader('hypertension_crisis: đau đầu + chóng mặt + buồn nôn');
{
  const r = detectCombo(['nhức đầu', 'chóng mặt', 'nôn'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo includes hypertension_crisis', r.combos.some(c => c.id === 'hypertension_crisis'), true);
}

subheader('respiratory_infection: ho + sốt + đau họng');
{
  const r = detectCombo(['ho', 'sốt', 'đau họng'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo includes respiratory_infection', r.combos.some(c => c.id === 'respiratory_infection'), true);
}

subheader('diabetic_warning: mệt mỏi + chóng mặt + khát nước');
{
  const r = detectCombo(['mệt mỏi', 'chóng mặt', 'khát nước'], {});
  assert('isCombo = true (all 3 match)', r.isCombo, true);
  assert('combo includes diabetic_warning', r.combos.some(c => c.id === 'diabetic_warning'), true);
}

subheader('diabetic_warning with diabetes profile: 2 of 3 groups');
{
  const r = detectCombo(['mệt', 'chóng mặt'], { medical_conditions: ['Tiểu đường'] });
  assert('isCombo = true (2/3 with diabetes)', r.isCombo, true);
  assert('combo includes diabetic_warning', r.combos.some(c => c.id === 'diabetic_warning'), true);
}

subheader('diabetic_warning WITHOUT diabetes profile: 2 of 3 groups should NOT match');
{
  const r = detectCombo(['mệt', 'chóng mặt'], {});
  // Without diabetes, need all 3 groups. 2/3 should only match headache_dizziness if applicable, not diabetic_warning
  assert('diabetic_warning NOT matched without diabetes', r.combos.some(c => c.id === 'diabetic_warning'), false);
}

subheader('headache_dizziness: đau đầu + chóng mặt');
{
  const r = detectCombo(['đau đầu', 'chóng mặt'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo includes headache_dizziness', r.combos.some(c => c.id === 'headache_dizziness'), true);
  assert('has extraQuestions', r.combos.find(c => c.id === 'headache_dizziness')?.extraQuestions?.length > 0, true);
}

subheader('fatigue_weight_loss: mệt mỏi + sụt cân');
{
  const r = detectCombo(['mệt mỏi', 'sụt cân'], {});
  assert('isCombo = true', r.isCombo, true);
  assert('combo includes fatigue_weight_loss', r.combos.some(c => c.id === 'fatigue_weight_loss'), true);
}

subheader('No combo: unrelated symptoms');
{
  const r = detectCombo(['đau lưng', 'ngứa'], {});
  assert('isCombo = false', r.isCombo, false);
  assert('combos empty', r.combos.length, 0);
  assert('severity = low', r.highestSeverity, 'low');
}

subheader('Sorting: critical > high > medium');
{
  // đau đầu + mờ mắt (critical: stroke_risk) + chóng mặt (medium: headache_dizziness)
  const r = detectCombo(['đau đầu', 'mờ mắt', 'chóng mặt'], {});
  assert('first combo is critical', r.combos[0]?.severity, 'critical');
  assert('highestSeverity = critical', r.highestSeverity, 'critical');
}

// ═══════════════════════════════════════════════════════════════
//  3. analyzeMultiSymptom with real DB data (user 4)
// ═══════════════════════════════════════════════════════════════

async function testAnalyzeMultiSymptom() {
  header('3. analyzeMultiSymptom — real DB data (user 4)');

  subheader('Multi-symptom with cluster match');
  {
    const r = await analyzeMultiSymptom(pool, USER_ID, ['chóng mặt', 'đau đầu'], PROFILE);
    assert('isEmergency = false', r.isEmergency, false);
    console.log(`    matched clusters: ${r.matched.map(m => m.cluster.cluster_key).join(', ') || '(none)'}`);
    console.log(`    unmatched: ${r.unmatched.join(', ') || '(none)'}`);
    console.log(`    combos: ${r.combos.map(c => c.id).join(', ') || '(none)'}`);
    assert('has combo (headache_dizziness)', r.combos.some(c => c.id === 'headache_dizziness'), true);
  }

  subheader('Emergency symptom in multi-input');
  {
    const r = await analyzeMultiSymptom(pool, USER_ID, ['đau đầu', 'yếu nửa người'], PROFILE);
    assert('isEmergency = true', r.isEmergency, true);
    assert('emergency type = STROKE', r.emergency?.type, 'STROKE');
  }

  subheader('All unmatched symptoms');
  {
    const r = await analyzeMultiSymptom(pool, USER_ID, ['ngứa tay', 'đau mông'], PROFILE);
    assert('isEmergency = false', r.isEmergency, false);
    console.log(`    matched: ${r.matched.length}, unmatched: ${r.unmatched.length}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  4. aggregateSeverity
// ═══════════════════════════════════════════════════════════════

header('4. aggregateSeverity — mixed results');

subheader('Two medium results');
{
  const r = aggregateSeverity([
    { severity: 'medium', followUpHours: 3, needsDoctor: false, needsFamilyAlert: false },
    { severity: 'medium', followUpHours: 3, needsDoctor: false, needsFamilyAlert: false },
  ], []);
  assert('severity = medium', r.severity, 'medium');
  assert('followUpHours = 3', r.followUpHours, 3);
  assert('needsDoctor = false', r.needsDoctor, false);
}

subheader('Mixed: medium script + high combo');
{
  const r = aggregateSeverity(
    [{ severity: 'medium', followUpHours: 3, needsDoctor: false, needsFamilyAlert: false }],
    [{ severity: 'high', followUpHours: 1, needsDoctor: true, needsFamilyAlert: true }]
  );
  assert('severity = high (combo wins)', r.severity, 'high');
  assert('followUpHours = 1 (min)', r.followUpHours, 1);
  assert('needsDoctor = true (any)', r.needsDoctor, true);
  assert('needsFamilyAlert = true (any)', r.needsFamilyAlert, true);
}

subheader('Empty results');
{
  const r = aggregateSeverity([], []);
  assert('severity = low', r.severity, 'low');
  assert('followUpHours = 6', r.followUpHours, 6);
}

subheader('Critical combo overrides everything');
{
  const r = aggregateSeverity(
    [
      { severity: 'low', followUpHours: 6, needsDoctor: false, needsFamilyAlert: false },
      { severity: 'medium', followUpHours: 3, needsDoctor: false, needsFamilyAlert: false },
    ],
    [{ severity: 'critical', followUpHours: 0.5, needsDoctor: true, needsFamilyAlert: true }]
  );
  assert('severity = critical', r.severity, 'critical');
  assert('followUpHours = 0.5', r.followUpHours, 0.5);
  assert('needsDoctor = true', r.needsDoctor, true);
  assert('needsFamilyAlert = true', r.needsFamilyAlert, true);
}

subheader('ANY needsDoctor/needsFamilyAlert propagates');
{
  const r = aggregateSeverity([
    { severity: 'low', followUpHours: 6, needsDoctor: false, needsFamilyAlert: false },
    { severity: 'medium', followUpHours: 3, needsDoctor: true, needsFamilyAlert: false },
    { severity: 'low', followUpHours: 6, needsDoctor: false, needsFamilyAlert: true },
  ], []);
  assert('needsDoctor = true (any)', r.needsDoctor, true);
  assert('needsFamilyAlert = true (any)', r.needsFamilyAlert, true);
  assert('followUpHours = MIN = 3', r.followUpHours, 3);
}

// ═══════════════════════════════════════════════════════════════
//  5. Full flow: multi-symptom input -> combo -> scripts
// ═══════════════════════════════════════════════════════════════

async function testFullFlow() {
  header('5. Full flow: multi-symptom input -> combo -> scripts identified');

  subheader('Flow: "đau đầu, chóng mặt và buồn nôn"');
  {
    const raw = 'đau đầu, chóng mặt và buồn nôn';
    const symptoms = parseSymptoms(raw);
    console.log(`    parsed: ${JSON.stringify(symptoms)}`);
    assert('parsed 3 symptoms', symptoms.length, 3);

    const analysis = await analyzeMultiSymptom(pool, USER_ID, symptoms, PROFILE);
    assert('isEmergency = false', analysis.isEmergency, false);

    console.log(`    combos found: ${analysis.combos.map(c => `${c.id} (${c.severity})`).join(', ') || '(none)'}`);
    assert('has hypertension_crisis combo', analysis.combos.some(c => c.id === 'hypertension_crisis'), true);

    console.log(`    matched clusters: ${analysis.matched.map(m => m.cluster.cluster_key).join(', ') || '(none)'}`);
    console.log(`    unmatched: ${analysis.unmatched.join(', ') || '(none)'}`);

    // Simulate script results + aggregate
    const mockScriptResults = analysis.matched.map(m => ({
      severity: 'medium',
      followUpHours: 3,
      needsDoctor: false,
      needsFamilyAlert: false,
    }));

    const aggregated = aggregateSeverity(mockScriptResults, analysis.combos);
    console.log(`    aggregated severity: ${aggregated.severity}`);
    console.log(`    aggregated followUpHours: ${aggregated.followUpHours}`);
    console.log(`    aggregated needsDoctor: ${aggregated.needsDoctor}`);
    console.log(`    aggregated needsFamilyAlert: ${aggregated.needsFamilyAlert}`);
    assert('aggregated severity >= high (combo)', ['high', 'critical'].includes(aggregated.severity), true);
  }

  subheader('Flow: "ho, sốt kèm đau họng" (respiratory infection combo)');
  {
    const raw = 'ho, sốt kèm đau họng';
    const symptoms = parseSymptoms(raw);
    console.log(`    parsed: ${JSON.stringify(symptoms)}`);
    assert('parsed 3 symptoms', symptoms.length, 3);

    const analysis = await analyzeMultiSymptom(pool, USER_ID, symptoms, PROFILE);
    assert('has respiratory_infection combo', analysis.combos.some(c => c.id === 'respiratory_infection'), true);
  }

  subheader('Flow: "mệt + chóng mặt" with diabetes profile (lowered threshold)');
  {
    const raw = 'mệt + chóng mặt';
    const symptoms = parseSymptoms(raw);
    const analysis = await analyzeMultiSymptom(pool, USER_ID, symptoms, PROFILE);
    assert('has diabetic_warning combo (2/3 threshold)', analysis.combos.some(c => c.id === 'diabetic_warning'), true);
  }

  subheader('Flow: single symptom "đau đầu" should NOT trigger multi-symptom path');
  {
    const raw = 'đau đầu';
    const symptoms = parseSymptoms(raw);
    assert('single symptom', symptoms.length, 1);
    // Single symptom: combo detector still runs but likely won't match (needs 2+ groups)
    const comboResult = detectCombo(symptoms, {});
    assert('no combo for single symptom', comboResult.isCombo, false);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Run all tests
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('\n  Multi-Symptom & Combo Detector Test Suite');
  console.log('  ' + '='.repeat(50));

  try {
    // Tests 1, 2, 4 are synchronous (already ran above)

    // Test 3: analyzeMultiSymptom (async, needs DB)
    await testAnalyzeMultiSymptom();

    // Test 5: Full flow (async, needs DB)
    await testFullFlow();
  } catch (err) {
    console.error('\n  ERROR:', err.message);
    console.error(err.stack);
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  TOTAL: ${totalPass + totalFail} tests — ${totalPass} passed, ${totalFail} failed`);
  console.log('='.repeat(60));

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

main();
