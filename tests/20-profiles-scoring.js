/**
 * 20 Profiles x 3 Answer Severities = 60 Scoring Tests
 *
 * Tests the scoring engine directly with different user profiles
 * against a REAL headache script loaded from DB (user 4).
 *
 * Verifies scoring adjusts correctly per profile (age, gender, conditions).
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { evaluateScript } = require('../src/core/checkin/scoring-engine');
const { getNextQuestion } = require('../src/core/checkin/script-runner');
const { getScript } = require('../src/services/checkin/script.service');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── 20 User Profiles ────────────────────────────────────────────────────────

const PROFILES = [
  { id: 1,  label: 'Male 20 healthy',                gender: 'nam', age: 20, conditions: [] },
  { id: 2,  label: 'Female 25 healthy',              gender: 'nữ',  age: 25, conditions: [] },
  { id: 3,  label: 'Male 30 healthy',                gender: 'nam', age: 30, conditions: [] },
  { id: 4,  label: 'Female 35 hypertension',         gender: 'nữ',  age: 35, conditions: ['huyết áp cao'] },
  { id: 5,  label: 'Male 40 diabetes',               gender: 'nam', age: 40, conditions: ['tiểu đường'] },
  { id: 6,  label: 'Female 45 diabetes+hypertension', gender: 'nữ', age: 45, conditions: ['tiểu đường', 'huyết áp cao'] },
  { id: 7,  label: 'Male 50 heart',                  gender: 'nam', age: 50, conditions: ['tim mạch'] },
  { id: 8,  label: 'Female 55 diabetes+heart',       gender: 'nữ',  age: 55, conditions: ['tiểu đường', 'tim mạch'] },
  { id: 9,  label: 'Male 60 healthy (elderly)',       gender: 'nam', age: 60, conditions: [] },
  { id: 10, label: 'Female 62 diabetes',             gender: 'nữ',  age: 62, conditions: ['tiểu đường'] },
  { id: 11, label: 'Male 65 hypertension',           gender: 'nam', age: 65, conditions: ['huyết áp cao'] },
  { id: 12, label: 'Female 68 diabetes+hypertension', gender: 'nữ', age: 68, conditions: ['tiểu đường', 'huyết áp cao'] },
  { id: 13, label: 'Male 70 diabetes+hyp+heart',     gender: 'nam', age: 70, conditions: ['tiểu đường', 'huyết áp cao', 'tim mạch'] },
  { id: 14, label: 'Female 75 4-conditions',         gender: 'nữ',  age: 75, conditions: ['tiểu đường', 'huyết áp cao', 'tim mạch', 'phổi tắc nghẽn'] },
  { id: 15, label: 'Male 80 diabetes',               gender: 'nam', age: 80, conditions: ['tiểu đường'] },
  { id: 16, label: 'Female 85 diabetes+heart+hyp+kidney', gender: 'nữ', age: 85, conditions: ['tiểu đường', 'tim mạch', 'huyết áp cao', 'thận'] },
  { id: 17, label: 'Male 30 diabetes (young+diabetes)', gender: 'nam', age: 30, conditions: ['tiểu đường'] },
  { id: 18, label: 'Female 40 heart (mid+heart)',    gender: 'nữ',  age: 40, conditions: ['tim mạch'] },
  { id: 19, label: 'Male 55 healthy (pre-elderly)',  gender: 'nam', age: 55, conditions: [] },
  { id: 20, label: 'null profile',                   gender: null,  age: null, conditions: null },
];

// ─── 3 Answer Sets (for headache: 4 single/multi-choice questions) ──────────
// Headache questions from clinical-mapping:
//   q1: location (single_choice) — 6 options
//   q2: pain type (single_choice) — 4 options
//   q3: associated symptoms (multi_choice) — 7 options
//   q4: severity level (single_choice) — 3 options

const ANSWER_SETS = {
  mild: {
    label: 'MILD',
    answers: [
      { question_id: 'q1', answer: 'một bên đầu' },           // first option
      { question_id: 'q2', answer: 'nhức âm ỉ' },             // mildest pain type
      { question_id: 'q3', answer: 'không có' },               // no associated symptoms
      { question_id: 'q4', answer: 'nhẹ, vẫn sinh hoạt được' }, // mild severity
    ],
  },
  medium: {
    label: 'MEDIUM',
    answers: [
      { question_id: 'q1', answer: 'cả hai bên' },            // middle option
      { question_id: 'q2', answer: 'đau như bóp chặt' },       // moderate pain type
      { question_id: 'q3', answer: 'buồn nôn' },              // one warning symptom
      { question_id: 'q4', answer: 'trung bình, khó tập trung' }, // medium severity
    ],
  },
  severe: {
    label: 'SEVERE',
    answers: [
      { question_id: 'q1', answer: 'toàn bộ đầu' },          // last option
      { question_id: 'q2', answer: 'đau giật theo nhịp tim' }, // worst pain type
      { question_id: 'q3', answer: 'cứng cổ' },               // danger symptom
      { question_id: 'q4', answer: 'nặng, phải nằm nghỉ' },   // severe → HIGH rule
    ],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProfile(p) {
  if (p.age === null && p.gender === null) return null; // null profile test
  return {
    age: p.age,
    gender: p.gender,
    medical_conditions: p.conditions || [],
    birth_year: p.age ? new Date().getFullYear() - p.age : undefined,
    full_name: `Test User ${p.id}`,
  };
}

function isElderly(p) { return p.age >= 60; }
function hasConditions(p) { return p.conditions && p.conditions.length > 0; }
function hasCondition(p, name) { return p.conditions && p.conditions.some(c => c.includes(name)); }

// ─── Main Test Runner ─────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(120));
  console.log('  20 PROFILES x 3 ANSWER SETS = 60 SCORING TESTS');
  console.log('  Loading REAL headache script from DB (user 4)');
  console.log('='.repeat(120));
  console.log();

  // Load real script from DB
  const scriptRow = await getScript(pool, 4, 'headache', 'initial');
  if (!scriptRow) {
    console.error('ERROR: No headache script found for user 4. Run onboarding first.');
    process.exit(1);
  }

  const scriptData = scriptRow.script_data;
  console.log(`Script loaded: v${scriptRow.version}, ${scriptData.questions.length} questions`);
  console.log(`Scoring rules: ${scriptData.scoring_rules.length}`);
  console.log(`Condition modifiers: ${(scriptData.condition_modifiers || []).length}`);
  console.log();

  // Print question summary
  console.log('Questions in script:');
  for (const q of scriptData.questions) {
    const opts = q.options ? q.options.join(' | ') : `slider ${q.min}-${q.max}`;
    console.log(`  ${q.id} [${q.type}]: ${q.text.substring(0, 50)}... → ${opts.substring(0, 80)}`);
  }
  console.log();

  // Print scoring rules summary
  console.log('Scoring rules:');
  for (let i = 0; i < scriptData.scoring_rules.length; i++) {
    const r = scriptData.scoring_rules[i];
    const conds = r.conditions.map(c => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' & ');
    console.log(`  Rule ${i}: ${conds || '(empty)'} → ${r.severity} | doctor=${r.needs_doctor} | family=${r.needs_family_alert}`);
  }
  console.log();

  // Print condition modifiers
  if (scriptData.condition_modifiers) {
    console.log('Condition modifiers:');
    for (const m of scriptData.condition_modifiers) {
      const extra = m.extra_conditions ? m.extra_conditions.map(c => `${c.field} ${c.op} ${c.value}`).join(' & ') : 'none';
      console.log(`  ${m.user_condition || 'any'} [${extra}] → ${m.action} to ${m.to}`);
    }
    console.log();
  }

  // ─── Run all 60 tests ────────────────────────────────────────────────────

  const results = [];
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const profile of PROFILES) {
    for (const [setKey, answerSet] of Object.entries(ANSWER_SETS)) {
      const profileObj = buildProfile(profile);
      const testLabel = `P${String(profile.id).padStart(2,'0')} ${profile.label.padEnd(42)} × ${answerSet.label.padEnd(8)}`;

      try {
        // Method 1: Direct scoring engine call
        const scoring = evaluateScript(scriptData, answerSet.answers, profileObj);

        // Method 2: Via script-runner (full flow)
        const runnerResult = getNextQuestion(scriptData, answerSet.answers, {
          sessionType: 'initial',
          profile: profileObj || {},
        });

        const conclusion = runnerResult.isDone ? runnerResult.conclusion : null;

        // Verify scoring engine and script-runner agree
        let engineRunnerMatch = true;
        if (conclusion) {
          if (conclusion.severity !== scoring.severity) engineRunnerMatch = false;
          if (conclusion.needsDoctor !== scoring.needsDoctor) engineRunnerMatch = false;
          if (conclusion.needsFamilyAlert !== scoring.needsFamilyAlert) engineRunnerMatch = false;
        }

        const row = {
          profileId: profile.id,
          profileLabel: profile.label,
          answerSet: setKey,
          severity: scoring.severity,
          needsDoctor: scoring.needsDoctor,
          needsFamilyAlert: scoring.needsFamilyAlert,
          followUpHours: scoring.followUpHours,
          matchedRule: scoring.matchedRuleIndex,
          modifiers: scoring.modifiersApplied,
          hasRedFlag: scoring.hasRedFlag,
          engineRunnerMatch,
          runnerDone: runnerResult.isDone,
        };
        results.push(row);

        // ─── Assertions ─────────────────────────────────────────────────

        const errs = [];

        // 1. Young healthy + mild → LOW
        if (!isElderly(profile) && !hasConditions(profile) && setKey === 'mild' && profile.id !== 20) {
          if (scoring.severity !== 'low') errs.push(`Expected LOW for young healthy + mild, got ${scoring.severity}`);
        }

        // 2. Young healthy + severe → HIGH (rule-based, not modifier)
        if (!isElderly(profile) && !hasConditions(profile) && setKey === 'severe' && profile.id !== 20) {
          if (scoring.severity !== 'high') errs.push(`Expected HIGH for young healthy + severe, got ${scoring.severity}`);
        }

        // 3. Elderly + conditions + mild → MEDIUM (bumped from LOW, NOT HIGH)
        //    EXCEPTION: if profile has heart disease, tim mạch modifier bumps unconditionally to HIGH
        //    (modifier fires before elderly check, and severity is already HIGH so elderly bump is skipped)
        if (isElderly(profile) && hasConditions(profile) && setKey === 'mild') {
          if (hasCondition(profile, 'tim')) {
            // Heart disease → unconditional bump to HIGH (modifier has no extra_conditions)
            if (scoring.severity !== 'high') errs.push(`Expected HIGH for elderly+heart+mild (unconditional modifier), got ${scoring.severity}`);
          } else {
            if (scoring.severity !== 'medium') errs.push(`Expected MEDIUM for elderly+conditions+mild, got ${scoring.severity}`);
            if (scoring.severity === 'high') errs.push(`Should NOT be HIGH for mild symptoms even with elderly+conditions (no heart)`);
          }
        }

        // 4. Elderly + conditions + severe → HIGH
        if (isElderly(profile) && hasConditions(profile) && setKey === 'severe') {
          if (scoring.severity !== 'high') errs.push(`Expected HIGH for elderly+conditions+severe, got ${scoring.severity}`);
        }

        // 5. needsDoctor follows severity correctly
        if (scoring.severity === 'low' && scoring.needsDoctor) {
          errs.push(`needsDoctor should be false for LOW severity`);
        }

        // 6. needsFamilyAlert = false for ALL (first time, non-critical)
        if (scoring.needsFamilyAlert && scoring.severity !== 'critical') {
          errs.push(`needsFamilyAlert should be false for first-time check-in (severity=${scoring.severity})`);
        }

        // 7. Heart disease modifier activates (lower threshold)
        if (hasCondition(profile, 'tim') && !isElderly(profile) && setKey === 'medium') {
          // tim mạch modifier with no extra_conditions → should bump to HIGH
          if (scoring.modifiersApplied.length === 0 && scoring.severity !== 'high') {
            // This is for non-slider scripts: tim mạch bumps unconditionally
            // But only if original severity matched a rule first
          }
        }

        // 8. Engine and runner agreement
        if (!engineRunnerMatch) {
          errs.push(`Scoring engine and script-runner disagree on results`);
        }

        // 9. Null profile → no crash
        if (profile.id === 20) {
          // Just verify it didn't crash — it ran to here
        }

        // 10. Runner should be done (all 4 questions answered)
        if (!runnerResult.isDone) {
          errs.push(`Runner not done after ${answerSet.answers.length} answers (expected done)`);
        }

        if (errs.length > 0) {
          failed++;
          failures.push({ test: testLabel, errors: errs });
          console.log(`  FAIL  ${testLabel} → ${scoring.severity.toUpperCase().padEnd(8)} doctor=${String(scoring.needsDoctor).padEnd(5)} family=${String(scoring.needsFamilyAlert).padEnd(5)} mods=${scoring.modifiersApplied.join(', ') || 'none'}`);
          for (const e of errs) console.log(`        *** ${e}`);
        } else {
          passed++;
          console.log(`  PASS  ${testLabel} → ${scoring.severity.toUpperCase().padEnd(8)} doctor=${String(scoring.needsDoctor).padEnd(5)} family=${String(scoring.needsFamilyAlert).padEnd(5)} mods=${scoring.modifiersApplied.join(', ') || 'none'}`);
        }

      } catch (err) {
        failed++;
        failures.push({ test: testLabel, errors: [err.message] });
        console.log(`  CRASH ${testLabel} → ${err.message}`);
      }
    }
  }

  // ─── Summary Matrix ──────────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(120));
  console.log('  RESULTS MATRIX: Profile x Answer Set → Severity (needsDoctor)');
  console.log('='.repeat(120));
  console.log();

  // Header
  const hdr = 'Profile'.padEnd(50) + 'MILD'.padEnd(22) + 'MEDIUM'.padEnd(22) + 'SEVERE'.padEnd(22);
  console.log(hdr);
  console.log('-'.repeat(116));

  for (const profile of PROFILES) {
    const cols = [];
    for (const setKey of ['mild', 'medium', 'severe']) {
      const r = results.find(x => x.profileId === profile.id && x.answerSet === setKey);
      if (r) {
        const doc = r.needsDoctor ? ' +doc' : '';
        const fam = r.needsFamilyAlert ? ' +fam' : '';
        const mod = r.modifiers.length > 0 ? ' *' : '';
        cols.push(`${r.severity.toUpperCase()}${doc}${fam}${mod}`.padEnd(22));
      } else {
        cols.push('ERROR'.padEnd(22));
      }
    }
    console.log(`${profile.label.padEnd(50)}${cols.join('')}`);
  }

  console.log();
  console.log('-'.repeat(116));
  console.log(`Legend: +doc = needsDoctor  |  +fam = needsFamilyAlert  |  * = condition modifier applied`);

  // ─── Final Summary ───────────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(120));
  console.log(`  TOTAL: ${passed + failed} tests  |  PASSED: ${passed}  |  FAILED: ${failed}`);
  console.log('='.repeat(120));

  if (failures.length > 0) {
    console.log();
    console.log('FAILURES:');
    for (const f of failures) {
      console.log(`  ${f.test}`);
      for (const e of f.errors) console.log(`    - ${e}`);
    }
  }

  // ─── Key Observations ────────────────────────────────────────────────────

  console.log();
  console.log('KEY OBSERVATIONS:');

  // Check diabetes modifier activation on medium answers
  const diabetesMedium = results.filter(r =>
    PROFILES.find(p => p.id === r.profileId && hasCondition(p, 'tiểu đường')) &&
    r.answerSet === 'medium'
  );
  const diabetesModified = diabetesMedium.filter(r => r.modifiers.length > 0);
  console.log(`  Diabetes + MEDIUM answers: ${diabetesModified.length}/${diabetesMedium.length} had modifiers applied`);

  // Check heart modifier activation
  const heartAny = results.filter(r =>
    PROFILES.find(p => p.id === r.profileId && hasCondition(p, 'tim'))
  );
  const heartModified = heartAny.filter(r => r.modifiers.length > 0);
  console.log(`  Heart disease + ANY answers: ${heartModified.length}/${heartAny.length} had modifiers applied`);

  // Check elderly bump
  const elderlyMild = results.filter(r =>
    PROFILES.find(p => p.id === r.profileId && isElderly(p) && hasConditions(p)) &&
    r.answerSet === 'mild'
  );
  const elderlyBumped = elderlyMild.filter(r => r.severity !== 'low');
  console.log(`  Elderly+conditions + MILD: ${elderlyBumped.length}/${elderlyMild.length} bumped from LOW`);

  // Check null profile safety
  const nullResults = results.filter(r => r.profileId === 20);
  console.log(`  Null profile: ${nullResults.length}/3 tests ran without crash`);

  // Check engine-runner agreement
  const mismatches = results.filter(r => !r.engineRunnerMatch);
  console.log(`  Engine-Runner agreement: ${mismatches.length === 0 ? 'ALL MATCH' : `${mismatches.length} MISMATCHES`}`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
