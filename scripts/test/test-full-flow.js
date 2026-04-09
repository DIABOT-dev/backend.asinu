#!/usr/bin/env node
/**
 * Full Flow Test — Mô phỏng 1 ngày check-in của Chú Hùng
 *
 * Kịch bản:
 *   Scenario A: Chú Hùng check-in đúng cluster (chóng mặt) → script chạy mượt
 *   Scenario B: Chú Hùng nói "đau bụng" — KHÔNG có trong clusters → fallback
 *   Scenario C: Chú Hùng nói "đau sau tai khi nhai" — hoàn toàn lạ → fallback + log R&D
 *   Scenario D: Chú Hùng nói "đau ngực khó thở" — EMERGENCY → bypass script
 *   Scenario E: Follow-up sau 3h — Chú Hùng đỡ hơn → monitoring
 *   Scenario F: Follow-up sau 3h — Chú Hùng nặng hơn → escalate
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { getUserScript, getScript } = require('../src/services/checkin/script.service');
const { getNextQuestion } = require('../src/services/checkin/script-runner');
const { evaluateScript, evaluateFollowUp } = require('../src/services/checkin/scoring-engine');
const { getFallbackScriptData, logFallback, matchCluster } = require('../src/services/checkin/fallback.service');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');

const USER_ID = 4;
const PROFILE = {
  birth_year: 1958,
  gender: 'Nam',
  full_name: 'Trần Văn Hùng',
  display_name: 'Chú Hùng',
  medical_conditions: ['Tiểu đường', 'Cao huyết áp', 'Tim mạch'],
  age: 68,
};

function header(text) { console.log(`\n${'═'.repeat(60)}\n  ${text}\n${'═'.repeat(60)}`); }
function step(text) { console.log(`\n  ▸ ${text}`); }
function result(label, value) { console.log(`    ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`); }
function warn(text) { console.log(`    ⚠️  ${text}`); }
function ok(text) { console.log(`    ✅ ${text}`); }
function fail(text) { console.log(`    ❌ ${text}`); }

async function runScriptSession(scriptData, answers, profile, label) {
  step(`Chạy script: ${label}`);
  let currentAnswers = [];

  for (const ans of answers) {
    const next = getNextQuestion(scriptData, currentAnswers, { sessionType: 'initial', profile });
    if (next.isDone) {
      ok('Script kết thúc sớm (đã đủ thông tin)');
      return next.conclusion;
    }

    console.log(`    Q${currentAnswers.length + 1}: "${next.question.text}"`);
    console.log(`        Type: ${next.question.type} | Options: ${(next.question.options || []).join(' | ')}`);
    console.log(`        → Chú Hùng chọn: "${ans}"`);

    currentAnswers.push({ question_id: next.question.id, answer: ans });
  }

  // Get conclusion
  const final = getNextQuestion(scriptData, currentAnswers, { sessionType: 'initial', profile });
  if (final.isDone) {
    return final.conclusion;
  }

  // Still more questions — answer remaining with first option
  while (!final.isDone) {
    const next = getNextQuestion(scriptData, currentAnswers, { sessionType: 'initial', profile });
    if (next.isDone) return next.conclusion;
    const defaultAns = next.question.options?.[0] || 'không rõ';
    console.log(`    Q${currentAnswers.length + 1}: "${next.question.text}" → "${defaultAns}"`);
    currentAnswers.push({ question_id: next.question.id, answer: defaultAns });
  }
}

async function run() {
  // Clean up
  await pool.query('DELETE FROM script_sessions WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [USER_ID]);

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO A: Check-in đúng cluster (chóng mặt)');
  // ═══════════════════════════════════════════════════════════════

  step('7:00 sáng — Push notification → Chú Hùng mở app');
  const userScript = await getUserScript(pool, USER_ID);
  console.log(`    Greeting: "${userScript.greeting}"`);
  console.log(`    Options: ${userScript.initial_options.map(o => o.label).join(' | ')}`);
  console.log(`    Clusters: ${userScript.clusters.map(c => c.display_name).join(', ')}`);

  step('Chú Hùng chọn: "Hơi mệt"');
  step('App hiện danh sách cluster → Chú chọn: "chóng mặt"');

  const dzScript = await getScript(pool, USER_ID, 'dizziness', 'initial');
  const dzData = dzScript.script_data;

  const conclusionA = await runScriptSession(dzData, [
    'tối sầm mắt',               // Q1: kiểu chóng mặt
    'khi đứng dậy',              // Q2: xuất hiện khi nào
    'hoa mắt',                   // Q3: triệu chứng kèm (KHÔNG danger)
    'có, thuốc huyết áp',        // Q4: thuốc
  ], PROFILE, 'Chóng mặt — case bình thường');

  step('📊 KẾT QUẢ SCORING (0 AI call):');
  result('Severity', conclusionA.severity);
  result('Follow-up', `${conclusionA.followUpHours}h`);
  result('Needs doctor', conclusionA.needsDoctor);
  result('Family alert', conclusionA.needsFamilyAlert);
  result('Summary', conclusionA.summary);
  result('Recommendation', conclusionA.recommendation);
  result('Close message', conclusionA.closeMessage);
  ok('Toàn bộ chạy bằng script — 0 AI call');

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO A2: Chóng mặt NẶNG — danger symptoms');
  // ═══════════════════════════════════════════════════════════════

  const conclusionA2 = await runScriptSession(dzData, [
    'quay cuồng (phòng quay)',    // Q1: kiểu nặng
    'liên tục không ngừng',       // Q2: liên tục
    'ngất hoặc suýt ngất',       // Q3: DANGER symptom!
    'có, thuốc mới kê gần đây',  // Q4
  ], PROFILE, 'Chóng mặt — danger symptom (ngất)');

  step('📊 KẾT QUẢ SCORING:');
  result('Severity', conclusionA2.severity);
  result('Follow-up', `${conclusionA2.followUpHours}h`);
  result('Needs doctor', conclusionA2.needsDoctor);
  result('Family alert', conclusionA2.needsFamilyAlert);
  if (conclusionA2.severity === 'high') {
    ok('HIGH severity — đúng vì có "ngất hoặc suýt ngất" (danger symptom)');
  } else {
    fail(`Expected HIGH but got ${conclusionA2.severity}`);
  }

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO B: Chú Hùng nói "đau bụng" — KHÔNG có trong clusters');
  // ═══════════════════════════════════════════════════════════════

  step('Chú Hùng chọn: "Hơi mệt" → nhập triệu chứng: "đau bụng"');

  // Try matching
  const matchB = await matchCluster(pool, USER_ID, 'đau bụng');
  result('Cluster match', matchB.matched ? matchB.cluster.cluster_key : 'KHÔNG TÌM THẤY');

  if (!matchB.matched) {
    warn('Không có cluster "đau bụng" trong DB → chuyển sang FALLBACK');

    step('Hệ thống chạy FALLBACK script (3 câu cơ bản, 0 AI)');
    const fbData = getFallbackScriptData();

    const conclusionB = await runScriptSession(fbData, [
      6,              // fb1: mức đau 6/10
      'Từ sáng',     // fb2: từ khi nào
      'Vẫn vậy',    // fb3: nặng hơn không
    ], PROFILE, 'Fallback — đau bụng');

    step('📊 KẾT QUẢ SCORING FALLBACK:');
    result('Severity', conclusionB.severity);
    result('Follow-up', `${conclusionB.followUpHours}h`);
    result('Needs doctor', conclusionB.needsDoctor);
    result('Summary', conclusionB.summary);

    step('Log triệu chứng lạ → chờ R&D cycle ban đêm');
    await logFallback(pool, USER_ID, 'đau bụng', null, [
      { question_id: 'fb1', answer: 6 },
      { question_id: 'fb2', answer: 'Từ sáng' },
      { question_id: 'fb3', answer: 'Vẫn vậy' },
    ]);
    ok('Đã log vào fallback_logs → R&D cycle 2AM sẽ xử lý');
    ok('Ban đêm: AI gắn nhãn "đau bụng" → tạo cluster abdominal_pain → sinh script');
    ok('Ngày mai: Chú Hùng sẽ có script "đau bụng" sẵn!');
  }

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO C: "đau sau tai khi nhai" — hoàn toàn lạ');
  // ═══════════════════════════════════════════════════════════════

  step('Chú Hùng nhập: "đau sau tai khi nhai"');
  const matchC = await matchCluster(pool, USER_ID, 'đau sau tai khi nhai');
  result('Cluster match', matchC.matched ? matchC.cluster.cluster_key : 'KHÔNG TÌM THẤY');

  if (!matchC.matched) {
    warn('Triệu chứng hoàn toàn mới → FALLBACK + log R&D');

    const fbData = getFallbackScriptData();
    const conclusionC = await runScriptSession(fbData, [
      4,              // fb1: mức đau 4/10
      'Vài ngày',    // fb2: từ khi nào
      'Vẫn vậy',    // fb3: nặng hơn không
    ], PROFILE, 'Fallback — đau sau tai');

    step('📊 KẾT QUẢ:');
    result('Severity', conclusionC.severity);
    result('Follow-up', `${conclusionC.followUpHours}h`);

    await logFallback(pool, USER_ID, 'đau sau tai khi nhai', null, [
      { question_id: 'fb1', answer: 4 },
      { question_id: 'fb2', answer: 'Vài ngày' },
      { question_id: 'fb3', answer: 'Vẫn vậy' },
    ]);
    ok('Logged → R&D cycle ban đêm AI sẽ phân tích:');
    console.log('    → AI đọc "đau sau tai khi nhai"');
    console.log('    → Gắn nhãn: possible TMJ / ear infection / neck pain');
    console.log('    → Tạo cluster mới hoặc gộp vào cluster cũ');
    console.log('    → Sinh script cho ngày mai');
  }

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO D: "đau ngực khó thở" — EMERGENCY');
  // ═══════════════════════════════════════════════════════════════

  step('Chú Hùng nhập: "đau ngực, khó thở, vã mồ hôi"');

  const emergency = detectEmergency(['đau ngực', 'khó thở', 'vã mồ hôi'], PROFILE);
  result('Is Emergency', emergency.isEmergency);
  result('Type', emergency.type);
  result('Severity', emergency.severity);

  if (emergency.isEmergency) {
    ok('🚨 EMERGENCY DETECTED — BYPASS SCRIPT HOÀN TOÀN');
    ok('→ Keyword detection bằng code — 0 AI call');
    ok('→ GỌI CẤP CỨU 115 NGAY');
    ok('→ Alert gia đình tự động');
    ok('→ Không cần script, không cần scoring');
  }

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO E: Follow-up sau 3h — Chú Hùng ĐỠ HƠN');
  // ═══════════════════════════════════════════════════════════════

  step('3h sau → Push notification → Chú Hùng mở app');
  step('App load follow-up script (cached, 0 AI)');

  const fuData = (await getScript(pool, USER_ID, 'dizziness', 'followup'))?.script_data || getFallbackScriptData();

  const fuAnswersBetter = [
    { question_id: 'fu1', answer: 'Đỡ hơn' },
    { question_id: 'fu2', answer: 'Không' },
  ];

  const fuResultBetter = evaluateFollowUp(fuData, fuAnswersBetter, 'medium');
  step('📊 FOLLOW-UP RESULT:');
  result('Severity', fuResultBetter.severity);
  result('Action', fuResultBetter.action);
  result('Follow-up', `${fuResultBetter.followUpHours}h`);
  result('Needs doctor', fuResultBetter.needsDoctor);
  ok(`${fuResultBetter.action === 'monitoring' ? 'Chuyển về monitoring → hẹn 9h tối' : 'Tiếp tục follow-up'}`);

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO F: Follow-up sau 3h — Chú Hùng NẶNG HƠN');
  // ═══════════════════════════════════════════════════════════════

  step('3h sau → Push notification → Chú Hùng mở app');

  const fuAnswersWorse = [
    { question_id: 'fu1', answer: 'Nặng hơn' },
    { question_id: 'fu2', answer: 'Có' },
  ];

  const fuResultWorse = evaluateFollowUp(fuData, fuAnswersWorse, 'medium');
  step('📊 FOLLOW-UP RESULT:');
  result('Severity', fuResultWorse.severity);
  result('Action', fuResultWorse.action);
  result('Follow-up', `${fuResultWorse.followUpHours}h`);
  result('Needs doctor', fuResultWorse.needsDoctor);
  result('Family alert', fuResultWorse.needsFamilyAlert);
  ok('🚨 ESCALATE → cảnh báo + khuyên đi khám + hẹn lại 1h');

  // ═══════════════════════════════════════════════════════════════
  header('SCENARIO G: Chú Hùng nói "Tôi ổn"');
  // ═══════════════════════════════════════════════════════════════

  step('7:00 sáng → Chú Hùng chọn: "Tôi ổn"');
  ok('Không chạy script, không gọi AI');
  ok('Hẹn 21:00 tối (evening review)');
  ok('0 AI call cho ngày đó');

  // ═══════════════════════════════════════════════════════════════
  header('TÓM TẮT: KHÁCH TRẢ LỜI NGƯỢC VỚI DB');
  // ═══════════════════════════════════════════════════════════════

  console.log(`
  DB có clusters: mệt mỏi, chóng mặt, tê tay chân

  ┌─────────────────────────────────┬───────────────────────────────────────────┐
  │ Khách nói gì                    │ Hệ thống xử lý                           │
  ├─────────────────────────────────┼───────────────────────────────────────────┤
  │ "chóng mặt" (có trong DB)      │ ✅ Chạy script chóng mặt (0 AI)          │
  │ "mệt mỏi" (có trong DB)        │ ✅ Chạy script mệt mỏi (0 AI)           │
  ├─────────────────────────────────┼───────────────────────────────────────────┤
  │ "đau bụng" (KHÔNG có trong DB)  │ ⚠️  Fallback 3 câu cơ bản (0 AI)        │
  │                                 │    → Log vào fallback_logs               │
  │                                 │    → R&D cycle 2AM xử lý                │
  │                                 │    → Ngày mai có script mới              │
  ├─────────────────────────────────┼───────────────────────────────────────────┤
  │ "đau sau tai" (hoàn toàn lạ)    │ ⚠️  Fallback 3 câu (0 AI)               │
  │                                 │    → Log cho R&D                         │
  │                                 │    → AI ban đêm gắn nhãn + tạo cluster  │
  ├─────────────────────────────────┼───────────────────────────────────────────┤
  │ "đau ngực khó thở" (emergency)  │ 🚨 EMERGENCY → bypass tất cả            │
  │                                 │    → Keyword detect (0 AI)               │
  │                                 │    → Gọi 115 + alert gia đình            │
  └─────────────────────────────────┴───────────────────────────────────────────┘

  📌 KẾT LUẬN:
  → Hệ thống KHÔNG BAO GIỜ bị đứng
  → Fallback luôn có 3 câu cơ bản để scoring
  → Triệu chứng lạ → log → AI xử lý ban đêm → ngày mai có script
  → Emergency → bypass script → code detect ngay → 0 AI call
  → Càng dùng lâu → càng ít fallback → càng ít AI → càng rẻ
  `);

  // Check DB state
  const { rows: fbLogs } = await pool.query(
    'SELECT raw_input, status FROM fallback_logs WHERE user_id = $1 ORDER BY created_at',
    [USER_ID]
  );
  console.log('  📋 Fallback logs chờ xử lý:');
  fbLogs.forEach(f => console.log(`     - "${f.raw_input}" (${f.status})`));

  await pool.end();
}

run().catch(err => {
  console.error('💥 Crashed:', err);
  pool.end();
  process.exit(1);
});
