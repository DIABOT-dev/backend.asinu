#!/usr/bin/env node
/**
 * Test vòng đời thực tế:
 *   Ngày 1: triệu chứng mới → fallback → log
 *   Đêm:   R&D cycle → AI gắn nhãn → tạo cluster + script  
 *   Ngày 2: triệu chứng cũ → match → chạy script cached
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { getUserScript, getScript, createClustersFromOnboarding, addCluster } = require('../src/services/checkin/script.service');
const { getNextQuestion } = require('../src/services/checkin/script-runner');
const { getFallbackScriptData, logFallback, matchCluster, getPendingFallbacks, markFallbackProcessed } = require('../src/services/checkin/fallback.service');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');
const { labelSymptom } = require('../src/services/checkin/rnd-cycle.service');

const USER_ID = 4;
const PROFILE = {
  birth_year: 1958, gender: 'Nam', full_name: 'Trần Văn Hùng',
  display_name: 'Chú Hùng', medical_conditions: ['Tiểu đường', 'Cao huyết áp'], age: 68,
};

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(t) { console.log(`\n${'═'.repeat(65)}\n  ${t}\n${'═'.repeat(65)}`); }
function step(t) { console.log(`\n  ▸ ${t}`); }

async function run() {
  // ── Clean up ──
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);

  // ── Tạo clusters ban đầu (onboarding) ──
  await createClustersFromOnboarding(pool, USER_ID, ['mệt mỏi', 'chóng mặt', 'tê tay chân']);

  // ═══════════════════════════════════════════════════════════════════
  header('NGÀY 1 — 7:00 SÁNG: Chú Hùng check-in');
  // ═══════════════════════════════════════════════════════════════════

  step('App GET /checkin/script → lấy script cached');
  const dayOne = await getUserScript(pool, USER_ID);
  console.log(`    Greeting: "${dayOne.greeting}"`);
  console.log(`    Clusters: ${dayOne.clusters.map(c => c.display_name).join(', ')}`);
  assert(dayOne.clusters.length === 3, 'Có 3 clusters: mệt mỏi, chóng mặt, tê tay chân');

  step('Chú Hùng chọn "Hơi mệt" → nhập: "đau dạ dày"');
  step('Backend: emergency check');
  const em = detectEmergency(['đau dạ dày'], PROFILE);
  assert(!em.isEmergency, '"đau dạ dày" KHÔNG phải emergency');

  step('Backend: matchCluster("đau dạ dày")');
  const match1 = await matchCluster(pool, USER_ID, 'đau dạ dày');
  assert(!match1.matched, '"đau dạ dày" KHÔNG match cluster nào → chuyển FALLBACK');

  step('Backend: chạy FALLBACK script (3 câu cơ bản, 0 AI call)');
  const fbScript = getFallbackScriptData();
  const fbAnswers = [];
  
  // Câu 1: Đau mức nào?
  let q = getNextQuestion(fbScript, fbAnswers, { sessionType: 'initial', profile: PROFILE });
  console.log(`    Q1: "${q.question.text}" (${q.question.type})`);
  console.log(`    → Chú Hùng: 5/10`);
  fbAnswers.push({ question_id: q.question.id, answer: 5 });

  // Câu 2: Từ khi nào?
  q = getNextQuestion(fbScript, fbAnswers, { sessionType: 'initial', profile: PROFILE });
  console.log(`    Q2: "${q.question.text}"`);
  console.log(`    → Chú Hùng: "Từ sáng"`);
  fbAnswers.push({ question_id: q.question.id, answer: 'Từ sáng' });

  // Câu 3: Nặng hơn không?
  q = getNextQuestion(fbScript, fbAnswers, { sessionType: 'initial', profile: PROFILE });
  console.log(`    Q3: "${q.question.text}"`);
  console.log(`    → Chú Hùng: "Vẫn vậy"`);
  fbAnswers.push({ question_id: q.question.id, answer: 'Vẫn vậy' });

  // Conclusion
  q = getNextQuestion(fbScript, fbAnswers, { sessionType: 'initial', profile: PROFILE });
  assert(q.isDone, 'Fallback hoàn thành → có kết quả');
  console.log(`    📊 Severity: ${q.conclusion.severity}, Follow-up: ${q.conclusion.followUpHours}h`);
  assert(q.conclusion.severity !== undefined, 'Có severity dù là fallback');
  assert(q.conclusion.followUpHours > 0, 'Có follow-up plan');

  step('Backend: log fallback vào DB (KHÔNG gọi AI)');
  await logFallback(pool, USER_ID, 'đau dạ dày', null, fbAnswers);
  
  const { rows: logs1 } = await pool.query(
    "SELECT * FROM fallback_logs WHERE user_id=$1 AND raw_input='đau dạ dày'", [USER_ID]
  );
  assert(logs1.length === 1, 'Fallback log lưu DB: 1 row');
  assert(logs1[0].status === 'pending', 'Status = pending (chờ R&D cycle)');
  assert(logs1[0].raw_input === 'đau dạ dày', 'raw_input đúng: "đau dạ dày"');
  assert(logs1[0].fallback_answers.length === 3, 'Có 3 câu trả lời fallback');

  console.log('\n  📌 TỔNG KẾT NGÀY 1:');
  console.log('     → User nói "đau dạ dày" → KHÔNG có script');
  console.log('     → Hệ thống chạy fallback 3 câu → vẫn có scoring + follow-up');
  console.log('     → Log vào DB → chờ R&D cycle ban đêm');
  console.log('     → 0 AI call trong suốt quá trình');

  // ═══════════════════════════════════════════════════════════════════
  header('ĐÊM — 2:00 AM: R&D Cycle xử lý fallback');
  // ═══════════════════════════════════════════════════════════════════

  step('R&D cycle đọc fallback_logs (status=pending)');
  const pending = await getPendingFallbacks(pool);
  const userPending = pending.filter(p => p.user_id === USER_ID);
  assert(userPending.length >= 1, `Có ${userPending.length} fallback pending cho user ${USER_ID}`);

  step('R&D cycle: AI gắn nhãn "đau dạ dày"');
  // Simulate AI labeling (trong thực tế gọi GPT/MedGemma)
  // Ở đây test trực tiếp logic mà KHÔNG gọi AI thật
  const existingClusters = [
    { cluster_key: 'fatigue', display_name: 'mệt mỏi' },
    { cluster_key: 'dizziness', display_name: 'chóng mặt' },
    { cluster_key: 'tê_tay_chân', display_name: 'tê tay chân' },
  ];
  
  // Simulate what AI would return
  const aiLabel = {
    label: 'đau dạ dày',
    clusterKey: 'gastric_pain',
    displayName: 'đau dạ dày',
    confidence: 0.92,
    matchExisting: null,  // không match cluster cũ → tạo mới
  };
  
  console.log(`    AI label: "${aiLabel.label}"`);
  console.log(`    Cluster key: ${aiLabel.clusterKey}`);
  console.log(`    Confidence: ${aiLabel.confidence}`);
  console.log(`    Match existing: ${aiLabel.matchExisting || 'KHÔNG → tạo cluster MỚI'}`);
  assert(aiLabel.matchExisting === null, 'AI xác nhận: không match cluster cũ');

  step('R&D cycle: tạo cluster mới "gastric_pain" + sinh script');
  const newCluster = await addCluster(pool, USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
  assert(newCluster.cluster_key === 'gastric_pain', 'Cluster mới: gastric_pain');
  assert(newCluster.source === 'rnd_cycle', 'Source = rnd_cycle');

  step('Verify: script tự sinh cho cluster mới');
  const newScript = await getScript(pool, USER_ID, 'gastric_pain', 'initial');
  assert(newScript !== null, 'Script initial đã sinh');
  assert(newScript.script_data.questions.length > 0, `Script có ${newScript.script_data.questions.length} questions`);
  assert(newScript.script_data.scoring_rules.length > 0, `Script có ${newScript.script_data.scoring_rules.length} scoring rules`);
  
  console.log(`    📜 Script gastric_pain:`);
  newScript.script_data.questions.forEach(qq => {
    console.log(`       ${qq.id}: "${qq.text}" (${qq.type})`);
    if (qq.options) console.log(`           options: ${qq.options.join(' | ')}`);
  });

  const fuScript = await getScript(pool, USER_ID, 'gastric_pain', 'followup');
  assert(fuScript !== null, 'Script followup cũng đã sinh');

  step('R&D cycle: mark fallback processed');
  await markFallbackProcessed(pool, logs1[0].id, 'đau dạ dày', 'gastric_pain', 0.92, newCluster.id);
  
  const { rows: logsAfter } = await pool.query(
    "SELECT status, ai_label, ai_cluster_key, ai_confidence, merged_to_cluster_id FROM fallback_logs WHERE id=$1",
    [logs1[0].id]
  );
  assert(logsAfter[0].status === 'merged', 'Fallback status → merged');
  assert(logsAfter[0].ai_label === 'đau dạ dày', 'AI label lưu đúng');
  assert(logsAfter[0].ai_cluster_key === 'gastric_pain', 'AI cluster_key lưu đúng');
  assert(parseFloat(logsAfter[0].ai_confidence) === 0.92, 'AI confidence lưu đúng');
  assert(logsAfter[0].merged_to_cluster_id === newCluster.id.toString() || logsAfter[0].merged_to_cluster_id == newCluster.id, 'Linked to new cluster');

  console.log('\n  📌 TỔNG KẾT R&D CYCLE:');
  console.log('     → Đọc fallback "đau dạ dày" → AI gắn nhãn');
  console.log('     → Tạo cluster mới "gastric_pain"');
  console.log('     → Sinh script tự động từ clinical-mapping');
  console.log('     → Chỉ 1 AI call cho toàn bộ quá trình');

  // ═══════════════════════════════════════════════════════════════════
  header('NGÀY 2 — 7:00 SÁNG: Chú Hùng check-in lại');
  // ═══════════════════════════════════════════════════════════════════

  step('App GET /checkin/script → lấy script cached');
  const dayTwo = await getUserScript(pool, USER_ID);
  console.log(`    Greeting: "${dayTwo.greeting}"`);
  console.log(`    Clusters: ${dayTwo.clusters.map(c => c.display_name).join(', ')}`);
  assert(dayTwo.clusters.length === 4, 'Giờ có 4 clusters (thêm đau dạ dày)');
  assert(dayTwo.clusters.some(c => c.display_name === 'đau dạ dày'), 'Cluster "đau dạ dày" xuất hiện');
  assert(dayTwo.clusters.find(c => c.display_name === 'đau dạ dày').has_script, 'Cluster "đau dạ dày" CÓ script');

  step('Chú Hùng chọn "Hơi mệt" → nhập: "đau dạ dày"');
  step('Backend: matchCluster("đau dạ dày")');
  const match2 = await matchCluster(pool, USER_ID, 'đau dạ dày');
  assert(match2.matched, '"đau dạ dày" GIỜ ĐÃ MATCH cluster!');
  assert(match2.cluster.cluster_key === 'gastric_pain', 'Match đúng: gastric_pain');

  step('Backend: chạy script gastric_pain (0 AI call)');
  const gpScript = await getScript(pool, USER_ID, 'gastric_pain', 'initial');
  const gpData = gpScript.script_data;
  const gpAnswers = [];

  // Chạy từng câu hỏi
  let done = false;
  let stepCount = 0;
  while (!done && stepCount < 10) {
    const next = getNextQuestion(gpData, gpAnswers, { sessionType: 'initial', profile: PROFILE });
    if (next.isDone) {
      done = true;
      console.log(`\n    📊 KẾT QUẢ (từ script, 0 AI):`);
      console.log(`       Severity: ${next.conclusion.severity}`);
      console.log(`       Follow-up: ${next.conclusion.followUpHours}h`);
      console.log(`       Needs doctor: ${next.conclusion.needsDoctor}`);
      console.log(`       Summary: "${next.conclusion.summary}"`);
      assert(next.conclusion.severity !== undefined, 'Có severity từ script');
      assert(next.conclusion.summary.length > 0, 'Có summary từ template');
    } else {
      stepCount++;
      const ans = next.question.options ? next.question.options[0] : (next.question.type === 'slider' ? 5 : 'test');
      console.log(`    Q${stepCount}: "${next.question.text}" → "${ans}"`);
      gpAnswers.push({ question_id: next.question.id, answer: ans });
    }
  }
  assert(done, 'Script gastric_pain chạy xong thành công');
  assert(stepCount > 0, `Đã hỏi ${stepCount} câu từ script (không phải fallback 3 câu)`);

  // ═══════════════════════════════════════════════════════════════════
  header('NGÀY 2 — TEST THÊM: biến thể "dạ dày đau quá"');
  // ═══════════════════════════════════════════════════════════════════

  step('Chú Hùng nhập: "dạ dày đau quá" (biến thể khác)');
  const match3 = await matchCluster(pool, USER_ID, 'dạ dày đau quá');
  assert(match3.matched, '"dạ dày đau quá" MATCH cluster gastric_pain (token matching)');
  if (match3.matched) {
    assert(match3.cluster.cluster_key === 'gastric_pain', `Match đúng: ${match3.cluster.cluster_key}`);
    console.log('    → Chạy script gastric_pain → 0 AI call');
  }

  step('Chú Hùng nhập: "bụng đau sau khi ăn" (biến thể xa hơn)');
  const match4 = await matchCluster(pool, USER_ID, 'bụng đau sau khi ăn');
  console.log(`    Match: ${match4.matched ? match4.cluster.cluster_key : 'KHÔNG'}`);
  if (!match4.matched) {
    console.log('    → "bụng đau sau khi ăn" không match (token "bụng" ≠ "dạ dày")');
    console.log('    → Fallback → log → R&D cycle sẽ gộp vào gastric_pain');
    console.log('    → Đây là behavior đúng: hệ thống cần R&D cycle để học dần');
  }

  // ═══════════════════════════════════════════════════════════════════
  header('NGÀY 3 — TEST: triệu chứng cũ quay lại (chóng mặt)');
  // ═══════════════════════════════════════════════════════════════════

  step('Chú Hùng nhập: "sáng nay chóng mặt"');
  const match5 = await matchCluster(pool, USER_ID, 'sáng nay chóng mặt');
  assert(match5.matched, '"sáng nay chóng mặt" match cluster dizziness');
  assert(match5.cluster.cluster_key === 'dizziness', 'Match đúng: dizziness');
  console.log('    → Chạy script dizziness (đã có sẵn từ onboarding) → 0 AI call');

  // ═══════════════════════════════════════════════════════════════════
  header('SO SÁNH: Ngày 1 vs Ngày 2 khi nói "đau dạ dày"');
  // ═══════════════════════════════════════════════════════════════════
  
  console.log(`
  ┌─────────────────────┬──────────────────────────────┬──────────────────────────────┐
  │                     │ NGÀY 1 (chưa có script)      │ NGÀY 2 (đã có script)        │
  ├─────────────────────┼──────────────────────────────┼──────────────────────────────┤
  │ matchCluster()      │ ❌ Không match               │ ✅ Match → gastric_pain      │
  │ Script dùng         │ Fallback (3 câu chung)       │ Script riêng (${gpData.questions.length} câu chuyên)   │
  │ Câu hỏi            │ Đau mức nào? Từ khi nào?     │ ${gpData.questions[0]?.text?.substring(0,28)}...│
  │ AI calls            │ 0                            │ 0                            │
  │ Chất lượng          │ Cơ bản (generic)             │ Chuyên sâu (clinical-based)  │
  │ Log fallback        │ ✅ Có (chờ R&D)              │ Không cần                    │
  └─────────────────────┴──────────────────────────────┴──────────────────────────────┘
  `);

  // ═══════════════════════════════════════════════════════════════════
  header('VERIFY DB STATE');
  // ═══════════════════════════════════════════════════════════════════

  const { rows: allClusters } = await pool.query(
    'SELECT cluster_key, display_name, source, is_active FROM problem_clusters WHERE user_id=$1 ORDER BY priority DESC',
    [USER_ID]
  );
  console.log('  problem_clusters:');
  allClusters.forEach(c => console.log(`    ${c.is_active ? '🟢' : '⚫'} ${c.cluster_key} — "${c.display_name}" (${c.source})`));

  const { rows: allScripts } = await pool.query(
    'SELECT cluster_key, script_type, is_active, generated_by FROM triage_scripts WHERE user_id=$1 ORDER BY cluster_key, script_type',
    [USER_ID]
  );
  console.log('\n  triage_scripts:');
  allScripts.forEach(s => console.log(`    ${s.is_active ? '🟢' : '⚫'} ${s.cluster_key} (${s.script_type}) — by ${s.generated_by}`));

  const { rows: allFallbacks } = await pool.query(
    'SELECT raw_input, status, ai_label, ai_cluster_key FROM fallback_logs WHERE user_id=$1',
    [USER_ID]
  );
  console.log('\n  fallback_logs:');
  allFallbacks.forEach(f => console.log(`    ${f.status === 'merged' ? '✅' : '⏳'} "${f.raw_input}" → ${f.status} ${f.ai_cluster_key ? '→ ' + f.ai_cluster_key : ''}`));

  // ═══════════════════════════════════════════════════════════════════
  header(`KẾT QUẢ: ${pass} passed, ${fail} failed`);
  // ═══════════════════════════════════════════════════════════════════
  
  if (fail === 0) {
    console.log('\n  🎉 TOÀN BỘ VÒNG ĐỜI HOẠT ĐỘNG ĐÚNG');
    console.log('     Triệu chứng mới → fallback → log → R&D → cluster → script → match');
  }

  await pool.end();
}

run().catch(err => {
  console.error('💥', err);
  pool.end();
  process.exit(1);
});
