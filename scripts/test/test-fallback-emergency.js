'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const {
  getFallbackScriptData,
  logFallback,
  matchCluster,
  getPendingFallbacks,
  markFallbackProcessed,
} = require('../src/services/checkin/fallback.service');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');
const { getNextQuestion } = require('../src/services/checkin/script-runner');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

async function testMatchCluster() {
  console.log('\n=== A. matchCluster() ===');

  // Exact matches
  const r1 = await matchCluster(pool, 4, 'chóng mặt');
  assert('A1 "chóng mặt" matches dizziness', r1.matched === true);

  const r2 = await matchCluster(pool, 4, 'mệt mỏi');
  assert('A2 "mệt mỏi" matches fatigue', r2.matched === true);

  const r3 = await matchCluster(pool, 4, 'tê tay chân');
  assert('A3 "tê tay chân" matches tê_tay_chân', r3.matched === true);

  // Partial matches
  const r4 = await matchCluster(pool, 4, 'chóng mặt buổi sáng');
  assert('A4 "chóng mặt buổi sáng" partial matches dizziness', r4.matched === true);

  const r5 = await matchCluster(pool, 4, 'bị mệt quá');
  assert('A5 "bị mệt quá" partial matches fatigue', r5.matched === true);

  // No match
  const r6 = await matchCluster(pool, 4, 'đau bụng');
  assert('A6 "đau bụng" no match', r6.matched === false);

  const r7 = await matchCluster(pool, 4, 'đau sau tai');
  assert('A7 "đau sau tai" no match', r7.matched === false);

  const r8 = await matchCluster(pool, 4, 'sốt cao');
  assert('A8 "sốt cao" no match', r8.matched === false);

  // Edge cases
  const r9 = await matchCluster(pool, 4, '');
  assert('A9 empty string no match, no crash', r9.matched === false);

  const r10 = await matchCluster(pool, 4, null);
  assert('A10 null no match, no crash', r10.matched === false);
}

function testGetFallbackScriptData() {
  console.log('\n=== B. getFallbackScriptData() ===');

  const script = getFallbackScriptData();

  assert('B1 returns valid script with questions', Array.isArray(script.questions));
  assert('B2 has 3 questions', script.questions.length === 3);
  assert('B3 Q1 type is slider', script.questions[0].type === 'slider');
  assert('B4 Q2 type is single_choice', script.questions[1].type === 'single_choice');
  assert('B5 Q3 type is single_choice', script.questions[2].type === 'single_choice');
  assert('B6 has scoring_rules (>=3)', Array.isArray(script.scoring_rules) && script.scoring_rules.length >= 3);
  assert('B7 has conclusion_templates', script.conclusion_templates && typeof script.conclusion_templates === 'object');
  assert('B8 has followup_questions', Array.isArray(script.followup_questions) && script.followup_questions.length > 0);
}

function testFallbackScriptExecution() {
  console.log('\n=== C. Fallback script execution ===');
  const script = getFallbackScriptData();

  // Helper to run full script
  function runScript(answerValues) {
    const answers = [];
    for (let i = 0; i < answerValues.length; i++) {
      const step = getNextQuestion(script, answers);
      if (step.isDone) break;
      answers.push({ question_id: step.question.id, answer: answerValues[i] });
    }
    const final = getNextQuestion(script, answers);
    return final;
  }

  // HIGH severity: [8, "Vừa mới", "Nặng hơn"]
  const high = runScript([8, 'Vừa mới', 'Nặng hơn']);
  assert('C1 HIGH: isDone', high.isDone === true);
  assert('C2 HIGH: severity is high', high.conclusion && high.conclusion.severity === 'high');

  // LOW severity: [3, "Vài ngày", "Đang đỡ"]
  const low = runScript([3, 'Vài ngày', 'Đang đỡ']);
  assert('C3 LOW: isDone', low.isDone === true);
  assert('C4 LOW: severity is low', low.conclusion && low.conclusion.severity === 'low');

  // MEDIUM severity: [5, "Từ sáng", "Vẫn vậy"]
  const med = runScript([5, 'Từ sáng', 'Vẫn vậy']);
  assert('C5 MEDIUM: isDone', med.isDone === true);
  assert('C6 MEDIUM: severity is medium', med.conclusion && med.conclusion.severity === 'medium');
}

async function testLogAndGetPending() {
  console.log('\n=== D. logFallback() + getPendingFallbacks() ===');

  // Clean up old test data
  await pool.query("DELETE FROM fallback_logs WHERE user_id = 4 AND raw_input IN ('đau bụng', 'đau sau tai khi nhai', 'nhức răng')");

  await logFallback(pool, 4, 'đau bụng');
  const { rows: r1 } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'đau bụng' ORDER BY created_at DESC LIMIT 1");
  assert('D1 "đau bụng" logged', r1.length > 0);
  assert('D2 status is pending', r1[0] && r1[0].status === 'pending');

  await logFallback(pool, 4, 'đau sau tai khi nhai');
  const { rows: r2 } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'đau sau tai khi nhai' ORDER BY created_at DESC LIMIT 1");
  assert('D3 "đau sau tai khi nhai" logged', r2.length > 0);

  await logFallback(pool, 4, 'nhức răng');
  const { rows: r3 } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'nhức răng' ORDER BY created_at DESC LIMIT 1");
  assert('D4 "nhức răng" logged', r3.length > 0);

  const pending = await getPendingFallbacks(pool);
  const userPending = pending.filter(p => p.user_id === 4 && ['đau bụng', 'đau sau tai khi nhai', 'nhức răng'].includes(p.raw_input));
  assert('D5 getPendingFallbacks returns all 3', userPending.length === 3);

  // Verify Vietnamese diacritics stored correctly
  assert('D6 Vietnamese diacritics stored correctly', r1[0] && r1[0].raw_input === 'đau bụng');
  assert('D7 Diacritics for "đau sau tai khi nhai"', r2[0] && r2[0].raw_input === 'đau sau tai khi nhai');
}

async function testMarkProcessed() {
  console.log('\n=== E. markFallbackProcessed() ===');

  // Get the 3 test rows
  const { rows } = await pool.query(
    "SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input IN ('đau bụng', 'đau sau tai khi nhai', 'nhức răng') ORDER BY created_at ASC"
  );

  if (rows.length < 3) {
    assert('E0 prerequisite: need 3 rows', false);
    return;
  }

  // Mark first as processed
  await markFallbackProcessed(pool, rows[0].id, 'abdominal_pain', 'abdominal_pain', 0.85);
  const { rows: r1 } = await pool.query('SELECT * FROM fallback_logs WHERE id = $1', [rows[0].id]);
  assert('E1 first status = processed', r1[0] && r1[0].status === 'processed');
  assert('E2 first ai_label set', r1[0] && r1[0].ai_label === 'abdominal_pain');

  // Mark second as merged (need a cluster id - get one from user 4)
  const { rows: clusters } = await pool.query(
    "SELECT id FROM problem_clusters WHERE user_id = 4 AND is_active = TRUE LIMIT 1"
  );
  const mergedClusterId = clusters.length > 0 ? clusters[0].id : null;

  if (mergedClusterId) {
    await markFallbackProcessed(pool, rows[1].id, 'ear_pain', 'ear_pain', 0.72, mergedClusterId);
    const { rows: r2 } = await pool.query('SELECT * FROM fallback_logs WHERE id = $1', [rows[1].id]);
    assert('E3 second status = merged', r2[0] && r2[0].status === 'merged');
    assert('E4 merged_to_cluster_id set', r2[0] && r2[0].merged_to_cluster_id !== null);
  } else {
    assert('E3 second status = merged (no cluster available, skip)', false);
    assert('E4 merged_to_cluster_id set (no cluster available, skip)', false);
  }

  // Check pending count
  const pending = await getPendingFallbacks(pool);
  const userPending = pending.filter(p => p.user_id === 4 && ['đau bụng', 'đau sau tai khi nhai', 'nhức răng'].includes(p.raw_input));
  assert('E5 only 1 pending left', userPending.length === 1);
}

function testEmergencyDetection() {
  console.log('\n=== F. Emergency detection ===');

  const r1 = detectEmergency(['đau ngực', 'khó thở']);
  assert('F1 MI: "đau ngực" + "khó thở"', r1.isEmergency === true && r1.type === 'MI');

  const r2 = detectEmergency(['yếu nửa người']);
  assert('F2 STROKE: "yếu nửa người"', r2.isEmergency === true && r2.type === 'STROKE');

  const r3 = detectEmergency(['co giật']);
  assert('F3 SEIZURE: "co giật"', r3.isEmergency === true && r3.type === 'SEIZURE');

  const r4 = detectEmergency(['sốt cao', 'cứng cổ']);
  assert('F4 MENINGITIS: "sốt cao" + "cứng cổ"', r4.isEmergency === true && r4.type === 'MENINGITIS');

  const r5 = detectEmergency(['nôn ra máu']);
  assert('F5 HEMORRHAGE: "nôn ra máu"', r5.isEmergency === true && r5.type === 'INTERNAL_HEMORRHAGE');

  const r6 = detectEmergency(['khó thở', 'sưng mặt']);
  assert('F6 ANAPHYLAXIS: "khó thở" + "sưng mặt"', r6.isEmergency === true && r6.type === 'ANAPHYLAXIS');

  // NOT emergency
  const r7 = detectEmergency(['hơi mệt']);
  assert('F7 "hơi mệt" NOT emergency', r7.isEmergency === false);

  const r8 = detectEmergency(['đau đầu nhẹ']);
  assert('F8 "đau đầu nhẹ" NOT emergency', r8.isEmergency === false);

  const r9 = detectEmergency(['chóng mặt']);
  assert('F9 "chóng mặt" NOT emergency', r9.isEmergency === false);

  const r10 = detectEmergency([]);
  assert('F10 empty array NOT emergency', r10.isEmergency === false);

  // Negation
  const r11 = detectEmergency(['không đau ngực']);
  assert('F11 "không đau ngực" negation handling', r11.isEmergency === false);
}

function testEmergencyFallbackIntegration() {
  console.log('\n=== G. Emergency + Fallback integration ===');

  // Emergency input should NOT go to fallback
  const emergencyInput = ['đau ngực', 'khó thở'];
  const emergencyResult = detectEmergency(emergencyInput);
  assert('G1 emergency input detected', emergencyResult.isEmergency === true);
  // If emergency, we do NOT proceed to fallback
  const shouldFallback1 = !emergencyResult.isEmergency;
  assert('G2 emergency does NOT go to fallback', shouldFallback1 === false);

  // Unknown, non-emergency input SHOULD go to fallback
  const unknownInput = ['đau bụng nhẹ'];
  const unknownResult = detectEmergency(unknownInput);
  assert('G3 unknown non-emergency detected', unknownResult.isEmergency === false);
  const shouldFallback2 = !unknownResult.isEmergency;
  assert('G4 unknown goes to fallback', shouldFallback2 === true);

  // Sequence test: check emergency first, then fallback
  const testSequence = (symptoms) => {
    const emer = detectEmergency(symptoms);
    if (emer.isEmergency) return { path: 'emergency', result: emer };
    return { path: 'fallback', result: getFallbackScriptData() };
  };

  const seq1 = testSequence(['co giật']);
  assert('G5 sequence: co giật -> emergency path', seq1.path === 'emergency');

  const seq2 = testSequence(['đau lưng nhẹ']);
  assert('G6 sequence: đau lưng nhẹ -> fallback path', seq2.path === 'fallback');
}

async function testEdgeCases() {
  console.log('\n=== H. Edge cases ===');

  // logFallback with null checkinId
  try {
    await logFallback(pool, 4, 'test_null_checkin', null, []);
    const { rows } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'test_null_checkin' ORDER BY created_at DESC LIMIT 1");
    assert('H1 logFallback with null checkinId works', rows.length > 0);
  } catch (e) {
    assert('H1 logFallback with null checkinId works', false);
  }

  // logFallback with empty fallbackAnswers
  try {
    await logFallback(pool, 4, 'test_empty_answers', null, []);
    const { rows } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'test_empty_answers' ORDER BY created_at DESC LIMIT 1");
    assert('H2 logFallback with empty fallbackAnswers works', rows.length > 0);
  } catch (e) {
    assert('H2 logFallback with empty fallbackAnswers works', false);
  }

  // matchCluster for user with NO clusters (user_id=2)
  const r3 = await matchCluster(pool, 2, 'chóng mặt');
  assert('H3 matchCluster user with no clusters returns false', r3.matched === false);

  // Multiple logs for same symptom (no dedup)
  await logFallback(pool, 4, 'test_dedup', null, []);
  await logFallback(pool, 4, 'test_dedup', null, []);
  const { rows: dedup } = await pool.query("SELECT * FROM fallback_logs WHERE user_id = 4 AND raw_input = 'test_dedup'");
  assert('H4 multiple logs same symptom all saved', dedup.length >= 2);
}

async function cleanup() {
  console.log('\n=== Cleanup ===');
  await pool.query(
    "DELETE FROM fallback_logs WHERE user_id = 4 AND raw_input IN ('đau bụng', 'đau sau tai khi nhai', 'nhức răng', 'test_null_checkin', 'test_empty_answers', 'test_dedup')"
  );
  console.log('  Cleaned up test data.');
}

async function main() {
  try {
    await testMatchCluster();
    testGetFallbackScriptData();
    testFallbackScriptExecution();
    await testLogAndGetPending();
    await testMarkProcessed();
    testEmergencyDetection();
    testEmergencyFallbackIntegration();
    await testEdgeCases();
    await cleanup();
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(50));
  results.forEach(r => console.log(r));
  console.log('='.repeat(50));

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main();
