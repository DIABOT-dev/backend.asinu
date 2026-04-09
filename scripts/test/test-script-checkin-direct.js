#!/usr/bin/env node
/**
 * Direct integration test for Script-Driven Check-in System
 * Chạy trực tiếp — không cần start server.
 *
 * Usage: node scripts/test-script-checkin-direct.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Import all modules
const { createClustersFromOnboarding, getUserScript, getScript } = require('../src/services/checkin/script.service');
const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');
const { evaluateScript, evaluateFollowUp } = require('../src/services/checkin/scoring-engine');
const { getFallbackScriptData, logFallback, matchCluster } = require('../src/services/checkin/fallback.service');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');

const TEST_USER_ID = 4; // Chú Hùng

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Script-Driven Check-in System — Integration Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Clean up previous test data ──────────────────────────────
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);

  // ─── Test 1: Create clusters from onboarding ─────────────────
  console.log('📋 Test 1: Tạo problem clusters từ onboarding symptoms');
  const symptoms = ['mệt mỏi', 'chóng mặt', 'tê tay chân'];
  const clusters = await createClustersFromOnboarding(pool, TEST_USER_ID, symptoms);

  assert(clusters.length === 3, `Created ${clusters.length} clusters (expected 3)`);
  assert(clusters[0].cluster_key === 'fatigue', `Cluster 1: ${clusters[0].cluster_key} = fatigue`);
  assert(clusters[1].cluster_key === 'dizziness', `Cluster 2: ${clusters[1].cluster_key} = dizziness`);
  assert(clusters[0].source === 'onboarding', 'Source = onboarding');
  assert(clusters[0].priority > clusters[2].priority, 'First symptom has higher priority');
  console.log('');

  // ─── Test 2: Scripts generated automatically ──────────────────
  console.log('📜 Test 2: Scripts tự động sinh từ clinical-mapping');
  const { rows: scripts } = await pool.query(
    'SELECT * FROM triage_scripts WHERE user_id = $1 AND is_active = TRUE ORDER BY cluster_key',
    [TEST_USER_ID]
  );

  assert(scripts.length >= 3, `${scripts.length} scripts created (>= 3 expected: initial + followup)`);

  const dizzinessScript = scripts.find(s => s.cluster_key === 'dizziness' && s.script_type === 'initial');
  assert(!!dizzinessScript, 'Dizziness initial script exists');

  if (dizzinessScript) {
    const sd = dizzinessScript.script_data;
    assert(sd.questions && sd.questions.length > 0, `Has ${sd.questions.length} questions`);
    assert(sd.scoring_rules && sd.scoring_rules.length > 0, `Has ${sd.scoring_rules.length} scoring rules`);
    assert(sd.conclusion_templates && sd.conclusion_templates.low, 'Has conclusion templates');
    assert(sd.followup_questions && sd.followup_questions.length > 0, 'Has follow-up questions');
    assert(sd.fallback_questions && sd.fallback_questions.length > 0, 'Has fallback questions');

    // Validate script structure
    const { valid, errors } = validateScript(sd);
    assert(valid, `Script validation: ${valid ? 'PASS' : errors.join(', ')}`);
  }
  console.log('');

  // ─── Test 3: Get user script (API simulation) ────────────────
  console.log('🔍 Test 3: getUserScript() — lấy script cached');
  const userScript = await getUserScript(pool, TEST_USER_ID);

  assert(userScript !== null, 'getUserScript returned data');
  assert(userScript.greeting && userScript.greeting.includes('Hùng'), `Greeting: "${userScript.greeting}"`);
  assert(userScript.initial_options.length === 3, '3 initial options (ổn/mệt/rất mệt)');
  assert(userScript.clusters.length === 3, `${userScript.clusters.length} cluster entries`);
  assert(userScript.profile.medical_conditions.length > 0, 'Profile has medical conditions');
  console.log('');

  // ─── Test 4: Script Runner — step by step ────────────────────
  console.log('▶️  Test 4: Script Runner — chạy script step-by-step (0 AI)');
  const scriptData = dizzinessScript.script_data;
  const profile = {
    birth_year: 1958,
    gender: 'Nam',
    full_name: 'Chú Hùng',
    medical_conditions: ['Tiểu đường', 'Cao huyết áp', 'Tim mạch'],
    age: 68,
  };

  // Step 1: Get first question
  let answers = [];
  let step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });

  assert(!step.isDone, 'Step 1: not done yet');
  assert(step.question && step.question.id, `Step 1: question id = ${step.question.id}`);
  assert(step.question.text.length > 0, `Step 1: "${step.question.text.substring(0, 50)}..."`);
  assert(step.currentStep === 0, 'currentStep = 0');
  console.log(`  📝 Q: "${step.question.text}"`);
  console.log(`     Type: ${step.question.type}, Options: ${JSON.stringify(step.question.options || []).substring(0, 80)}`);

  // Answer step 1
  const firstQType = step.question.type;
  let firstAnswer;
  if (firstQType === 'slider') {
    firstAnswer = 6; // Medium severity
  } else if (step.question.options && step.question.options.length > 0) {
    firstAnswer = step.question.options[0];
  } else {
    firstAnswer = 'chóng mặt nhẹ';
  }

  answers.push({ question_id: step.question.id, answer: firstAnswer });
  console.log(`  → Answer: ${firstAnswer}`);

  // Step 2
  step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
  if (!step.isDone) {
    console.log(`  📝 Q: "${step.question.text}"`);
    const ans2 = step.question.options ? step.question.options[0] : 'từ sáng';
    answers.push({ question_id: step.question.id, answer: ans2 });
    console.log(`  → Answer: ${ans2}`);
  }

  // Step 3
  step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
  if (!step.isDone) {
    console.log(`  📝 Q: "${step.question.text}"`);
    const ans3 = step.question.options ? step.question.options[1] : 'vẫn như cũ';
    answers.push({ question_id: step.question.id, answer: ans3 });
    console.log(`  → Answer: ${ans3}`);
  }

  // Step 4
  step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
  if (!step.isDone) {
    console.log(`  📝 Q: "${step.question.text}"`);
    const ans4 = step.question.options ? step.question.options[0] : 'đang đỡ';
    answers.push({ question_id: step.question.id, answer: ans4 });
    console.log(`  → Answer: ${ans4}`);
  }

  // Keep answering until done (max 8 questions)
  for (let i = 0; i < 4; i++) {
    step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
    if (step.isDone) break;
    console.log(`  📝 Q: "${step.question.text}"`);
    const ans = step.question.options ? step.question.options[0] : 'ok';
    answers.push({ question_id: step.question.id, answer: ans });
    console.log(`  → Answer: ${ans}`);
  }

  // Should be done now
  step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
  assert(step.isDone, 'Script completed (isDone = true)');
  if (step.isDone) {
    const c = step.conclusion;
    assert(['low', 'medium', 'high', 'critical'].includes(c.severity), `Severity: ${c.severity}`);
    assert(typeof c.followUpHours === 'number', `Follow-up: ${c.followUpHours}h`);
    assert(typeof c.needsDoctor === 'boolean', `Needs doctor: ${c.needsDoctor}`);
    assert(c.summary && c.summary.length > 0, `Summary: "${c.summary.substring(0, 60)}..."`);
    assert(c.recommendation && c.recommendation.length > 0, `Recommendation: "${c.recommendation.substring(0, 60)}..."`);
    assert(c.closeMessage && c.closeMessage.length > 0, `Close msg: "${c.closeMessage.substring(0, 60)}..."`);
    console.log('');
    console.log(`  📊 RESULT: severity=${c.severity}, followUp=${c.followUpHours}h, doctor=${c.needsDoctor}, familyAlert=${c.needsFamilyAlert}`);
  }
  console.log('');

  // ─── Test 5: Scoring Engine — HIGH severity ──────────────────
  console.log('🔥 Test 5: Scoring Engine — test HIGH severity');
  const highAnswers = [
    { question_id: scriptData.questions[0].id, answer: scriptData.questions[0].type === 'slider' ? 8 : 'nặng, phải nằm nghỉ' },
  ];
  // Add a progression = worse answer if exists
  const progressionQ = scriptData.questions.find(q => q.options && q.options.includes('có vẻ nặng hơn'));
  if (progressionQ) {
    highAnswers.push({ question_id: progressionQ.id, answer: 'có vẻ nặng hơn' });
  }
  const highResult = evaluateScript(scriptData, highAnswers, profile);

  assert(highResult.severity === 'high', `HIGH severity: ${highResult.severity}`);
  assert(highResult.needsDoctor === true, `Needs doctor: ${highResult.needsDoctor}`);
  assert(highResult.followUpHours <= 1, `Follow-up <= 1h: ${highResult.followUpHours}h`);
  console.log(`  📊 severity=${highResult.severity}, doctor=${highResult.needsDoctor}, familyAlert=${highResult.needsFamilyAlert}`);
  console.log('');

  // ─── Test 6: Scoring Engine — LOW severity ───────────────────
  console.log('😌 Test 6: Scoring Engine — test LOW severity');
  const lowAnswers = [
    { question_id: scriptData.questions[0].id, answer: scriptData.questions[0].type === 'slider' ? 2 : 'nhẹ, vẫn sinh hoạt được' },
  ];
  const lowResult = evaluateScript(scriptData, lowAnswers, { medical_conditions: [] });

  assert(lowResult.severity === 'low', `LOW severity: ${lowResult.severity}`);
  assert(lowResult.needsDoctor === false, `No doctor needed: ${lowResult.needsDoctor}`);
  assert(lowResult.followUpHours >= 6, `Follow-up >= 6h: ${lowResult.followUpHours}h`);
  console.log('');

  // ─── Test 7: Condition modifier (tiểu đường bump) ────────────
  console.log('⚕️  Test 7: Condition modifier — tiểu đường bumps severity');
  // Find progression question in this script
  const modProgQ = scriptData.questions.find(q => q.options && q.options.includes('có vẻ nặng hơn'));
  const modSliderQ = scriptData.questions.find(q => q.type === 'slider');
  let diabetesAnswers;
  if (modSliderQ) {
    // Script has slider → use slider value 5
    diabetesAnswers = [{ question_id: modSliderQ.id, answer: 5 }];
  } else if (modProgQ) {
    // Script has progression → use "vẫn như cũ" (triggers diabetes modifier)
    diabetesAnswers = [{ question_id: modProgQ.id, answer: 'vẫn như cũ' }];
  } else {
    // No suitable question → test with generic answers
    diabetesAnswers = [{ question_id: scriptData.questions[0].id, answer: scriptData.questions[0].options?.[0] || 'test' }];
  }
  const diabetesProfile = { ...profile, medical_conditions: ['Tiểu đường'], age: 68 };
  const diabetesResult = evaluateScript(scriptData, diabetesAnswers, diabetesProfile);

  // With diabetes + elderly + conditions → should bump severity
  const diabetesBumped = diabetesResult.severity !== 'low' || diabetesResult.modifiersApplied.length > 0;
  assert(diabetesBumped, `Diabetes modifier → ${diabetesResult.severity} (modifiers: ${diabetesResult.modifiersApplied.join(', ') || 'elderly+conditions'})`);
  console.log(`  📊 severity=${diabetesResult.severity}, modifiers=[${diabetesResult.modifiersApplied}]`);
  console.log('');

  // ─── Test 8: Follow-up evaluation ────────────────────────────
  console.log('🔄 Test 8: Follow-up scoring');
  const fuBetter = evaluateFollowUp(scriptData, [
    { question_id: 'fu1', answer: 'Đỡ hơn' },
    { question_id: 'fu2', answer: 'Không' },
  ], 'medium');
  assert(fuBetter.severity === 'low', `Better → low: ${fuBetter.severity}`);
  assert(fuBetter.action === 'monitoring', `Action: ${fuBetter.action}`);

  const fuWorse = evaluateFollowUp(scriptData, [
    { question_id: 'fu1', answer: 'Nặng hơn' },
    { question_id: 'fu2', answer: 'Có' },
  ], 'medium');
  assert(fuWorse.severity === 'high', `Worse → high: ${fuWorse.severity}`);
  assert(fuWorse.action === 'escalate', `Action: ${fuWorse.action}`);
  assert(fuWorse.needsDoctor === true, 'Needs doctor when worse');
  console.log('');

  // ─── Test 9: Fallback — unknown symptom ──────────────────────
  console.log('❓ Test 9: Fallback — triệu chứng lạ');
  const fbScript = getFallbackScriptData();
  assert(fbScript.questions.length === 3, `Fallback has ${fbScript.questions.length} questions`);
  assert(fbScript.scoring_rules.length >= 3, `Fallback has ${fbScript.scoring_rules.length} scoring rules`);

  // Test cluster matching
  const match1 = await matchCluster(pool, TEST_USER_ID, 'chóng mặt buổi sáng');
  assert(match1.matched === true, `"chóng mặt buổi sáng" → matched cluster: ${match1.cluster?.cluster_key}`);

  const match2 = await matchCluster(pool, TEST_USER_ID, 'đau sau tai');
  assert(match2.matched === false, '"đau sau tai" → no match (fallback needed)');

  // Log fallback
  await logFallback(pool, TEST_USER_ID, 'đau sau tai khi nhai', null);
  const { rows: fbLogs } = await pool.query(
    'SELECT * FROM fallback_logs WHERE user_id = $1 AND status = $2',
    [TEST_USER_ID, 'pending']
  );
  assert(fbLogs.length > 0, `Fallback logged: ${fbLogs.length} pending`);
  console.log('');

  // ─── Test 10: Emergency detection still works ────────────────
  console.log('🚨 Test 10: Emergency detection (unchanged, keyword-based)');
  const em1 = detectEmergency(['đau ngực', 'khó thở'], profile);
  assert(em1.isEmergency === true, `"đau ngực + khó thở" → EMERGENCY`);

  const em2 = detectEmergency(['hơi mệt'], profile);
  assert(em2.isEmergency === false, '"hơi mệt" → NOT emergency');
  console.log('');

  // ─── Test 11: Script session in DB ───────────────────────────
  console.log('💾 Test 11: Save script session to DB');
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO script_sessions
       (user_id, script_id, cluster_key, session_type, answers, current_step,
        is_completed, severity, needs_doctor, follow_up_hours,
        conclusion_summary, conclusion_recommendation, completed_at)
     VALUES ($1, $2, $3, 'initial', $4::jsonb, $5,
             TRUE, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      TEST_USER_ID, dizzinessScript.id, 'dizziness',
      JSON.stringify(answers), answers.length,
      step.conclusion?.severity || 'medium',
      step.conclusion?.needsDoctor || false,
      step.conclusion?.followUpHours || 3,
      step.conclusion?.summary || 'Test summary',
      step.conclusion?.recommendation || 'Test recommendation',
    ]
  );
  assert(sessionRows.length === 1, `Session saved: id=${sessionRows[0].id}`);
  assert(sessionRows[0].severity !== null, `Severity saved: ${sessionRows[0].severity}`);
  assert(sessionRows[0].is_completed === true, 'Session marked completed');
  console.log('');

  // ─── Summary ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed — check output above.');
  } else {
    console.log('\n🎉 All tests passed! Script check-in system working correctly.');
  }

  console.log('\n📊 DB State:');
  const { rows: clusterCount } = await pool.query('SELECT COUNT(*) FROM problem_clusters WHERE user_id = $1', [TEST_USER_ID]);
  const { rows: scriptCount } = await pool.query('SELECT COUNT(*) FROM triage_scripts WHERE user_id = $1 AND is_active = TRUE', [TEST_USER_ID]);
  const { rows: sessionCount } = await pool.query('SELECT COUNT(*) FROM script_sessions WHERE user_id = $1', [TEST_USER_ID]);
  const { rows: fbCount } = await pool.query('SELECT COUNT(*) FROM fallback_logs WHERE user_id = $1', [TEST_USER_ID]);
  console.log(`  problem_clusters: ${clusterCount[0].count}`);
  console.log(`  triage_scripts:   ${scriptCount[0].count}`);
  console.log(`  script_sessions:  ${sessionCount[0].count}`);
  console.log(`  fallback_logs:    ${fbCount[0].count}`);

  await pool.end();
}

run().catch(err => {
  console.error('💥 Test crashed:', err);
  pool.end();
  process.exit(1);
});
