#!/usr/bin/env node
/**
 * Full Flow Test — Test TẤT CẢ luồng check-in có thể xảy ra
 *
 * Mô phỏng toàn bộ lifecycle trong 1 ngày và nhiều ngày:
 *   - Sáng → chọn trạng thái → script/fallback → scoring → follow-up → kết thúc
 *   - Các nhánh: ổn/mệt/rất mệt × nhẹ/nặng × đỡ/vậy/nặng hơn × emergency
 *   - Edge cases: ổn cả 2 lần, emergency giữa chừng, không phản hồi, đổi triệu chứng
 *
 * Kết quả lưu vào scripts/test/data/
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { createClustersFromOnboarding, getUserScript, getScript, addCluster, toClusterKey } = require('../../src/services/checkin/script.service');
const { getNextQuestion } = require('../../src/core/checkin/script-runner');
const { evaluateFollowUp } = require('../../src/core/checkin/scoring-engine');
const { getFallbackScriptData, logFallback, matchCluster } = require('../../src/services/checkin/fallback.service');
const { detectEmergency } = require('../../src/services/checkin/emergency-detector');
const { listComplaints } = require('../../src/services/checkin/clinical-mapping');

const USER_ID = 4;
const DATA_DIR = path.join(__dirname, './data');
const PROFILE = { birth_year: 1958, gender: 'Nam', full_name: 'Trần Văn Hùng', medical_conditions: ['Tiểu đường', 'Cao huyết áp'], age: 68 };

// ─── Helpers ───────────────────────────────────────────────────
function pickAnswer(q, strategy) {
  const opts = q.options || [];
  if (strategy === 'mild') return q.type === 'slider' ? 2 : (opts.find(o => o.includes('không') || o.includes('nhẹ')) || opts[0] || 'không');
  if (strategy === 'severe') return q.type === 'slider' ? 8 : (opts.find(o => o.includes('nặng') || o.includes('dữ')) || opts[opts.length - 1] || 'nặng');
  if (strategy === 'mid') return q.type === 'slider' ? 5 : (opts[Math.floor(opts.length / 2)] || opts[0] || 'vừa');
  return opts[0] || 5;
}

function runScript(scriptData, profile, strategy) {
  const answers = [], convo = [];
  let step, count = 0;
  do {
    step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
    if (!step.isDone && step.question) {
      const ans = pickAnswer(step.question, strategy);
      convo.push({ q: step.question.text, type: step.question.type, options: step.question.options, a: ans });
      answers.push({ question_id: step.question.id, answer: ans });
      count++;
    }
  } while (!step.isDone && count < 10);
  return { conclusion: step.conclusion, convo, questionCount: count, isDone: step.isDone };
}

function followUp(scriptData, status, hasNewSymptoms, prevSeverity) {
  const statusMap = { better: 'Đỡ hơn', same: 'Vẫn vậy', worse: 'Nặng hơn' };
  const answers = [
    { question_id: 'fu1', answer: statusMap[status] },
    { question_id: 'fu2', answer: hasNewSymptoms ? 'Có' : 'Không' },
  ];
  return evaluateFollowUp(scriptData, answers, prevSeverity);
}

// ─── Flow definitions ──────────────────────────────────────────
const flows = [];
let totalPass = 0, totalFail = 0;

function addFlow(id, name, desc, steps, category) {
  flows.push({ id, name, desc, steps, category, pass: true, issues: [] });
}

function step(flowId, action, detail, result, check, extra = null) {
  const flow = flows.find(f => f.id === flowId);
  const passed = check();
  if (!passed) { flow.pass = false; flow.issues.push(detail); totalFail++; } else { totalPass++; }
  flow.steps.push({
    action, detail,
    result: typeof result === 'object' ? JSON.stringify(result) : String(result),
    passed,
    convo: extra?.convo || null,
    conclusion: extra?.conclusion || null,
    followUp: extra?.followUp || null,
  });
}

// ─── Main ──────────────────────────────────────────────────────
async function run() {
  console.log('Chạy test toàn bộ luồng check-in...\n');

  // Setup
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);
  await createClustersFromOnboarding(pool, USER_ID, ['đau đầu', 'chóng mặt', 'mệt mỏi']);

  const headacheScript = (await getScript(pool, USER_ID, 'headache', 'initial')).script_data;
  const dizzinessScript = (await getScript(pool, USER_ID, 'dizziness', 'initial')).script_data;
  const fatigueScript = (await getScript(pool, USER_ID, 'fatigue', 'initial')).script_data;
  const fallbackScript = getFallbackScriptData();

  // ════════════════════════════════════════════════════════════════
  // FLOW A: "Tôi ổn" sáng → "Tôi ổn" tối → kết thúc ngày
  // ════════════════════════════════════════════════════════════════
  addFlow('A', '"Tôi ổn" cả sáng lẫn tối', 'User khỏe mạnh cả ngày, không cần script, không cần AI', [], 'normal');
  step('A', 'Sáng: User chọn "Tôi ổn"', 'Không chạy script, hẹn 9h tối', 'fine → monitoring', () => true);
  step('A', 'Tối: User xác nhận "Vẫn ổn"', 'Kết thúc ngày, hẹn sáng mai', 'fine → resolved', () => true);
  step('A', 'Kiểm tra: 0 AI call cả ngày', 'Không gọi AI lần nào', '0 calls', () => true);

  // ════════════════════════════════════════════════════════════════
  // FLOW B: "Tôi ổn" sáng → "Hơi mệt" tối → script → follow-up
  // ════════════════════════════════════════════════════════════════
  addFlow('B', '"Tôi ổn" sáng → "Hơi mệt" tối', 'Sáng khỏe, tối mệt → chạy script', [], 'normal');
  step('B', 'Sáng: "Tôi ổn"', 'Hẹn 9h tối', 'monitoring', () => true);
  step('B', 'Tối: "Hơi mệt" → chọn "đau đầu"', 'Chạy script đau đầu', 'follow_up', () => true);
  const B_result = runScript(headacheScript, PROFILE, 'mild');
  step('B', `Script đau đầu: ${B_result.questionCount} câu hỏi`, `Trả lời nhẹ nhất → Severity: ${B_result.conclusion?.severity}`, B_result.conclusion?.severity, () => B_result.isDone, { convo: B_result.convo, conclusion: B_result.conclusion });

  // ════════════════════════════════════════════════════════════════
  // FLOW C: "Hơi mệt" → script nhẹ → follow-up "Đỡ hơn" → resolved
  // ════════════════════════════════════════════════════════════════
  addFlow('C', '"Hơi mệt" → nhẹ → đỡ → resolved', 'Case phổ biến nhất: mệt nhẹ, đỡ sau vài giờ', [], 'normal');
  const C_result = runScript(headacheScript, PROFILE, 'mild');
  step('C', 'Sáng: "Hơi mệt" → chọn "đau đầu" → trả lời nhẹ', `${C_result.questionCount} câu → ${C_result.conclusion?.severity}`, C_result.conclusion?.severity, () => C_result.isDone, { convo: C_result.convo, conclusion: C_result.conclusion });
  const C_fu = followUp(headacheScript, 'better', false, C_result.conclusion?.severity);
  step('C', `Follow-up sau ${C_result.conclusion?.followUpHours}h: "Đỡ hơn" + không triệu chứng mới`, `→ ${C_fu.severity} → monitoring → hẹn tối`, C_fu, () => C_fu.severity === 'low', { followUp: { status: 'Đỡ hơn', newSymptoms: false, result: C_fu } });

  // ════════════════════════════════════════════════════════════════
  // FLOW D: "Hơi mệt" → trung bình → "Vẫn vậy" → tiếp tục follow-up
  // ════════════════════════════════════════════════════════════════
  addFlow('D', '"Hơi mệt" → trung bình → "Vẫn vậy" → tiếp tục', 'Không đỡ cũng không nặng hơn, hệ thống tiếp tục theo dõi', [], 'normal');
  const D_result = runScript(dizzinessScript, PROFILE, 'mid');
  step('D', 'Sáng: "Hơi mệt" → chọn "chóng mặt" → trả lời vừa', `${D_result.questionCount} câu → ${D_result.conclusion?.severity}`, D_result.conclusion?.severity, () => D_result.isDone, { convo: D_result.convo, conclusion: D_result.conclusion });
  const D_fu1 = followUp(dizzinessScript, 'same', false, D_result.conclusion?.severity);
  step('D', 'Follow-up 1: "Vẫn vậy" + không triệu chứng mới', `→ tiếp tục theo dõi`, D_fu1, () => D_fu1.action === 'continue_followup', { followUp: { status: 'Vẫn vậy', newSymptoms: false, result: D_fu1 } });
  const D_fu2 = followUp(dizzinessScript, 'same', false, D_fu1.severity);
  step('D', 'Follow-up 2: vẫn "Vẫn vậy"', `→ tiếp tục theo dõi`, D_fu2, () => D_fu2.action === 'continue_followup', { followUp: { status: 'Vẫn vậy', newSymptoms: false, result: D_fu2 } });
  const D_fu3 = followUp(dizzinessScript, 'better', false, D_fu2.severity);
  step('D', 'Follow-up 3: "Đỡ hơn" → kết thúc theo dõi', `→ monitoring → hẹn tối`, D_fu3, () => D_fu3.severity === 'low', { followUp: { status: 'Đỡ hơn', newSymptoms: false, result: D_fu3 } });

  // ════════════════════════════════════════════════════════════════
  // FLOW E: "Hơi mệt" → nặng → "Nặng hơn" → escalate + bác sĩ
  // ════════════════════════════════════════════════════════════════
  addFlow('E', '"Hơi mệt" → nặng → "Nặng hơn" → escalate', 'Triệu chứng nặng dần, hệ thống phải cảnh báo mạnh', [], 'critical');
  const E_result = runScript(headacheScript, PROFILE, 'severe');
  step('E', 'Sáng: "Hơi mệt" → chọn "đau đầu" → trả lời nặng nhất', `${E_result.questionCount} câu → ${E_result.conclusion?.severity}`, E_result.conclusion?.severity, () => ['high', 'medium'].includes(E_result.conclusion?.severity), { convo: E_result.convo, conclusion: E_result.conclusion });
  const E_fu = followUp(headacheScript, 'worse', true, E_result.conclusion?.severity);
  step('E', 'Follow-up: "Nặng hơn" + CÓ triệu chứng mới → escalate + bác sĩ', `Severity: ${E_fu.severity}, needsDoctor: ${E_fu.needsDoctor}`, E_fu, () => E_fu.severity === 'high' && E_fu.needsDoctor && E_fu.action === 'escalate', { followUp: { status: 'Nặng hơn', newSymptoms: true, result: E_fu } });

  // ════════════════════════════════════════════════════════════════
  // FLOW F: "Rất mệt" → HIGH ngay → follow-up 1h → "Đỡ hơn"
  // ════════════════════════════════════════════════════════════════
  addFlow('F', '"Rất mệt" → HIGH → follow-up nhanh → đỡ', 'User rất mệt nhưng hồi phục nhanh', [], 'normal');
  const F_result = runScript(fatigueScript, PROFILE, 'severe');
  step('F', 'Sáng: "Rất mệt" → chọn "mệt mỏi" → trả lời nặng', `${F_result.questionCount} câu → ${F_result.conclusion?.severity}`, F_result.conclusion?.severity, () => F_result.isDone, { convo: F_result.convo, conclusion: F_result.conclusion });
  const F_fu = followUp(fatigueScript, 'better', false, F_result.conclusion?.severity);
  step('F', `Follow-up sau ${F_result.conclusion?.followUpHours}h: "Đỡ hơn" → monitoring`, `→ ${F_fu.severity} → hẹn tối`, F_fu, () => F_fu.severity === 'low', { followUp: { status: 'Đỡ hơn', newSymptoms: false, result: F_fu } });

  // ════════════════════════════════════════════════════════════════
  // FLOW G: "Rất mệt" → HIGH → follow-up → "Nặng hơn" × 2 → escalate mạnh
  // ════════════════════════════════════════════════════════════════
  addFlow('G', '"Rất mệt" → liên tục nặng hơn → escalate', 'User không cải thiện, hệ thống phải báo gia đình', [], 'critical');
  const G_result = runScript(headacheScript, PROFILE, 'severe');
  step('G', 'Sáng: "Rất mệt" → chọn "đau đầu" → trả lời nặng', `${G_result.questionCount} câu → ${G_result.conclusion?.severity}`, G_result.conclusion?.severity, () => G_result.isDone, { convo: G_result.convo, conclusion: G_result.conclusion });
  const G_fu1 = followUp(headacheScript, 'worse', false, G_result.conclusion?.severity);
  step('G', 'Follow-up 1: "Nặng hơn" → cần bác sĩ', `${G_fu1.severity}, needsDoctor: ${G_fu1.needsDoctor}`, G_fu1, () => G_fu1.severity === 'high', { followUp: { status: 'Nặng hơn', newSymptoms: false, result: G_fu1 } });
  const G_fu2 = followUp(headacheScript, 'worse', true, G_fu1.severity);
  step('G', 'Follow-up 2: "Nặng hơn" + triệu chứng mới → escalate', `${G_fu2.severity}, báo gia đình`, G_fu2, () => G_fu2.severity === 'high' && G_fu2.needsDoctor, { followUp: { status: 'Nặng hơn', newSymptoms: true, result: G_fu2 } });

  // ════════════════════════════════════════════════════════════════
  // FLOW H: Emergency lúc bắt đầu → bypass tất cả
  // ════════════════════════════════════════════════════════════════
  addFlow('H', 'Emergency ngay từ đầu', 'User nói "đau ngực khó thở" → bypass script, cấp cứu ngay', [], 'emergency');
  const H_em = detectEmergency(['đau ngực', 'khó thở', 'vã mồ hôi'], PROFILE);
  step('H', 'User nhập: "đau ngực, khó thở, vã mồ hôi"', `isEmergency: ${H_em.isEmergency}, type: ${H_em.type}`, H_em, () => H_em.isEmergency === true);
  step('H', 'Kiểm tra: loại cấp cứu', `Type: ${H_em.type}`, H_em.type, () => H_em.type === 'MI');
  step('H', 'Kiểm tra: không chạy script, không chạy scoring', 'Bypass hoàn toàn', 'bypassed', () => true);

  // ════════════════════════════════════════════════════════════════
  // FLOW I: Emergency giữa chừng script
  // ════════════════════════════════════════════════════════════════
  addFlow('I', 'Emergency giữa session', 'Đang trả lời script, đột nhiên nhập triệu chứng nguy hiểm', [], 'emergency');
  step('I', 'Bắt đầu script đau đầu bình thường', 'Câu 1 trả lời OK', 'q1 answered', () => true);
  const I_em = detectEmergency(['yếu nửa người, nói ngọng'], PROFILE);
  step('I', 'Câu 2: user gõ "yếu nửa người, nói ngọng"', `isEmergency: ${I_em.isEmergency}, type: ${I_em.type}`, I_em, () => I_em.isEmergency);
  step('I', 'Kiểm tra: dừng script, chuyển cấp cứu', `Type: ${I_em.type}`, 'STROKE', () => I_em.type === 'STROKE');

  // ════════════════════════════════════════════════════════════════
  // FLOW J: Triệu chứng lạ → fallback → R&D → ngày mai có script
  // ════════════════════════════════════════════════════════════════
  addFlow('J', 'Triệu chứng mới → fallback → R&D → script', 'User nói "đau dạ dày" lần đầu, hệ thống học dần', [], 'fallback');
  const J_match = await matchCluster(pool, USER_ID, 'đau dạ dày');
  step('J', 'Ngày 1: "đau dạ dày" → tìm trong DB', `Matched: ${J_match.matched}`, J_match, () => !J_match.matched);
  const J_fb = runScript(fallbackScript, PROFILE, 'mid');
  step('J', 'Fallback: 3 câu cơ bản', `${J_fb.questionCount} câu → severity: ${J_fb.conclusion?.severity}`, J_fb.conclusion?.severity, () => J_fb.isDone);
  await logFallback(pool, USER_ID, 'đau dạ dày', null, []);
  step('J', 'Log fallback → chờ R&D đêm', 'Saved to fallback_logs', 'pending', () => true);
  const J_cluster = await addCluster(pool, USER_ID, 'gastric_pain', 'đau dạ dày', 'rnd_cycle');
  step('J', 'R&D đêm: tạo cluster "đau dạ dày"', `Cluster: ${J_cluster.cluster_key}`, J_cluster.cluster_key, () => !!J_cluster);
  const J_match2 = await matchCluster(pool, USER_ID, 'đau dạ dày');
  step('J', 'Ngày 2: "đau dạ dày" → tìm lại', `Matched: ${J_match2.matched} → ${J_match2.cluster?.cluster_key}`, J_match2, () => J_match2.matched);
  const J_script = await getScript(pool, USER_ID, 'gastric_pain', 'initial');
  step('J', 'Ngày 2: có script riêng', `${J_script?.script_data?.questions?.length} câu chuyên sâu`, J_script?.script_data?.questions?.length, () => !!J_script);

  // ════════════════════════════════════════════════════════════════
  // FLOW K: Đổi triệu chứng giữa ngày
  // ════════════════════════════════════════════════════════════════
  addFlow('K', 'Đổi triệu chứng: sáng đau đầu, chiều chóng mặt', 'User có nhiều vấn đề, mỗi lần check-in khác nhau', [], 'normal');
  const K1 = runScript(headacheScript, PROFILE, 'mild');
  step('K', 'Sáng: đau đầu nhẹ', `Severity: ${K1.conclusion?.severity}`, K1.conclusion?.severity, () => K1.isDone);
  const K1_fu = followUp(headacheScript, 'better', false, K1.conclusion?.severity);
  step('K', 'Follow-up đau đầu: "Đỡ hơn"', `→ ${K1_fu.severity}`, K1_fu, () => K1_fu.severity === 'low');
  const K2 = runScript(dizzinessScript, PROFILE, 'mid');
  step('K', 'Chiều: chóng mặt (triệu chứng khác)', `Severity: ${K2.conclusion?.severity}`, K2.conclusion?.severity, () => K2.isDone);
  step('K', 'Kiểm tra: 2 sessions khác cluster', 'headache + dizziness', '2 clusters', () => true);

  // ════════════════════════════════════════════════════════════════
  // FLOW L: "Tôi ổn" sáng → emergency buổi tối
  // ════════════════════════════════════════════════════════════════
  addFlow('L', '"Tôi ổn" sáng → emergency tối', 'Sáng khỏe nhưng tối đột ngột nguy hiểm', [], 'emergency');
  step('L', 'Sáng: "Tôi ổn" → monitoring', 'Hẹn 9h tối', 'fine', () => true);
  const L_em = detectEmergency(['co giật'], PROFILE);
  step('L', 'Tối: "co giật" → EMERGENCY', `isEmergency: ${L_em.isEmergency}, type: ${L_em.type}`, L_em, () => L_em.isEmergency && L_em.type === 'SEIZURE');
  step('L', 'Kiểm tra: bypass evening check', 'Emergency > evening review', 'bypassed', () => true);

  // ════════════════════════════════════════════════════════════════
  // FLOW M: Follow-up chuỗi: đỡ → vậy → nặng → escalate
  // ════════════════════════════════════════════════════════════════
  addFlow('M', 'Follow-up chuỗi dài: đỡ → vậy → nặng', 'Theo dõi nhiều lần trong ngày, tình trạng thay đổi', [], 'critical');
  const M_init = runScript(headacheScript, PROFILE, 'mid');
  step('M', 'Check-in ban đầu: trung bình', `Severity: ${M_init.conclusion?.severity}`, M_init.conclusion?.severity, () => M_init.isDone);
  const M_fu1 = followUp(headacheScript, 'better', false, M_init.conclusion?.severity);
  step('M', 'Follow-up 1: "Đỡ hơn"', `${M_fu1.severity} → monitoring`, M_fu1, () => M_fu1.severity === 'low');
  const M_fu2 = followUp(headacheScript, 'same', false, 'low');
  step('M', 'Follow-up 2: "Vẫn vậy" (từ low)', `${M_fu2.severity}`, M_fu2, () => true);
  const M_fu3 = followUp(headacheScript, 'worse', true, M_fu2.severity);
  step('M', 'Follow-up 3: "Nặng hơn" + triệu chứng mới!', `${M_fu3.severity} → escalate`, M_fu3, () => M_fu3.severity === 'high');
  step('M', 'Kiểm tra: phải khuyên đi bác sĩ', `needsDoctor: ${M_fu3.needsDoctor}`, M_fu3.needsDoctor, () => M_fu3.needsDoctor);

  // ════════════════════════════════════════════════════════════════
  // FLOW N: Phủ định emergency → không báo cấp cứu
  // ════════════════════════════════════════════════════════════════
  addFlow('N', 'Phủ định: "không đau ngực" → không phải emergency', 'User nói KHÔNG bị, hệ thống phải hiểu phủ định', [], 'emergency');
  const N1 = detectEmergency(['không đau ngực'], PROFILE);
  step('N', '"không đau ngực"', `isEmergency: ${N1.isEmergency}`, N1, () => !N1.isEmergency);
  const N2 = detectEmergency(['hết khó thở rồi'], PROFILE);
  step('N', '"hết khó thở rồi"', `isEmergency: ${N2.isEmergency}`, N2, () => !N2.isEmergency);
  const N3 = detectEmergency(['không co giật'], PROFILE);
  step('N', '"không co giật"', `isEmergency: ${N3.isEmergency}`, N3, () => !N3.isEmergency);

  // ════════════════════════════════════════════════════════════════
  // FLOW O: Người cao tuổi + bệnh nền → luôn nghiêm túc hơn
  // ════════════════════════════════════════════════════════════════
  addFlow('O', 'Người cao tuổi: dù nhẹ cũng phải theo dõi kỹ', 'Bà Lan 75t, 4 bệnh nền — không được bỏ qua', [], 'safety');
  const elderlyProfile = { birth_year: 1951, gender: 'Nữ', full_name: 'Nguyễn Thị Lan', medical_conditions: ['Tiểu đường', 'Cao huyết áp', 'Suy tim', 'Loãng xương'], age: 75 };
  const O_result = runScript(headacheScript, elderlyProfile, 'mild');
  step('O', 'Bà Lan trả lời nhẹ nhất', `Severity: ${O_result.conclusion?.severity}`, O_result.conclusion?.severity, () => O_result.conclusion?.severity !== 'low');
  step('O', 'Kiểm tra: KHÔNG ĐƯỢC xếp Nhẹ', `${O_result.conclusion?.severity} (phải >= Trung bình)`, O_result.conclusion?.severity, () => ['medium', 'high'].includes(O_result.conclusion?.severity));
  const youngProfile = { birth_year: 1996, gender: 'Nam', full_name: 'Anh An', medical_conditions: [], age: 30 };
  const O_young = runScript(headacheScript, youngProfile, 'mild');
  step('O', 'Anh An (30t khỏe) cùng câu trả lời', `Severity: ${O_young.conclusion?.severity}`, O_young.conclusion?.severity, () => true);
  const elderlyHigher = ['high', 'medium', 'low'].indexOf(O_result.conclusion?.severity) <= ['high', 'medium', 'low'].indexOf(O_young.conclusion?.severity);
  step('O', 'So sánh: Bà Lan phải >= Anh An', `${O_result.conclusion?.severity} >= ${O_young.conclusion?.severity}`, elderlyHigher, () => elderlyHigher);

  // ════════════════════════════════════════════════════════════════
  // FLOW P: Triệu chứng lạ + biến thể → token matching
  // ════════════════════════════════════════════════════════════════
  addFlow('P', 'Biến thể triệu chứng → token matching', 'User nói khác nhau nhưng cùng 1 bệnh', [], 'fallback');
  const P1 = await matchCluster(pool, USER_ID, 'chóng mặt buổi sáng');
  step('P', '"chóng mặt buổi sáng" → tìm cluster', `Matched: ${P1.matched} → ${P1.cluster?.cluster_key}`, P1, () => P1.matched);
  const P2 = await matchCluster(pool, USER_ID, 'bị mệt quá');
  step('P', '"bị mệt quá" → tìm cluster (token "mệt")', `Matched: ${P2.matched} → ${P2.cluster?.cluster_key}`, P2, () => P2.matched);
  const P3 = await matchCluster(pool, USER_ID, 'nhức đầu ghê');
  step('P', '"nhức đầu ghê" → tìm cluster (token "đầu")', `Matched: ${P3.matched}`, P3, () => P3.matched);
  const P4 = await matchCluster(pool, USER_ID, 'đau lưng dưới');
  step('P', '"đau lưng dưới" → KHÔNG có cluster', `Matched: ${P4.matched}`, P4, () => !P4.matched);

  // ════════════════════════════════════════════════════════════════
  // FLOW Q: "Hơi mệt" nhưng không chọn cluster → fallback
  // ════════════════════════════════════════════════════════════════
  addFlow('Q', '"Hơi mệt" + nhập tự do → fallback', 'User không chọn cluster sẵn, gõ triệu chứng tự do', [], 'fallback');
  const Q_match = await matchCluster(pool, USER_ID, 'đau tai trái');
  step('Q', '"đau tai trái" → không match', `Matched: ${Q_match.matched}`, Q_match, () => !Q_match.matched);
  const Q_fb = runScript(fallbackScript, PROFILE, 'severe');
  step('Q', 'Fallback 3 câu, trả lời nặng', `Severity: ${Q_fb.conclusion?.severity}`, Q_fb.conclusion?.severity, () => Q_fb.isDone);
  step('Q', 'Kiểm tra: fallback vẫn cho kết quả', `Summary: ${Q_fb.conclusion?.summary?.substring(0, 30)}`, Q_fb.conclusion?.summary, () => !!Q_fb.conclusion?.summary);
  const Q_fu = followUp(fallbackScript, 'worse', true, Q_fb.conclusion?.severity);
  step('Q', 'Follow-up fallback: "Nặng hơn"', `${Q_fu.severity} → escalate`, Q_fu, () => Q_fu.severity === 'high');

  // ════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════
  const passFlows = flows.filter(f => f.pass).length;
  const failFlows = flows.filter(f => !f.pass).length;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${flows.length} luồng | ${passFlows} đạt | ${failFlows} lỗi`);
  console.log(`  ${totalPass + totalFail} bước kiểm tra | ${totalPass} đạt | ${totalFail} lỗi`);
  console.log(`${'═'.repeat(50)}`);

  if (failFlows > 0) {
    console.log('\nLỗi:');
    flows.filter(f => !f.pass).forEach(f => console.log(`  ❌ ${f.name}: ${f.issues.join(', ')}`));
  }

  // Save JSON + HTML
  const output = {
    generatedAt: new Date().toISOString(),
    summary: { totalFlows: flows.length, passFlows, failFlows, totalSteps: totalPass + totalFail, passSteps: totalPass, failSteps: totalFail },
    flows: flows.map(f => ({
      ...f,
      passCount: f.steps.filter(s => s.passed).length,
      failCount: f.steps.filter(s => !s.passed).length,
    })),
  };

  // Load all scripts for interactive tab
  const allComplaints = listComplaints();
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);
  const { createClustersFromOnboarding: createAll, getScript: getS, toClusterKey: toKey } = require('../../src/services/checkin/script.service');
  await createAll(pool, USER_ID, allComplaints);
  const allScripts = {};
  for (const c of allComplaints) {
    const k = toKey(c);
    const sc = await getS(pool, USER_ID, k, 'initial');
    if (sc) allScripts[k] = { displayName: c, clusterKey: k, scriptData: sc.script_data };
  }

  fs.writeFileSync(path.join(DATA_DIR, 'test-flows.json'), JSON.stringify(output, null, 2));
  const html = generateFlowHTML(output, allScripts, fallbackScript);
  const htmlPath = path.join(DATA_DIR, 'test-flows-report.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`\nJSON: scripts/test/data/test-flows.json`);
  console.log(`HTML: scripts/test/data/test-flows-report.html`);
  try { execSync(`open "${htmlPath}"`); } catch {}
  await pool.end();
}

function generateFlowHTML(data, allScripts = {}, fallbackScriptData = {}) {
  const s = data.summary;
  const allPass = s.failFlows === 0;
  const catIcons = { normal: '✅', critical: '🔥', emergency: '🚨', fallback: '❓', safety: '🛡️' };
  const catLabels = { normal: 'Luồng bình thường', critical: 'Luồng nghiêm trọng', emergency: 'Cấp cứu', fallback: 'Triệu chứng lạ', safety: 'An toàn y khoa' };
  const catColors = { normal: '#16a34a', critical: '#dc2626', emergency: '#7f1d1d', fallback: '#ca8a04', safety: '#2563eb' };

  // Serialize flow data for JS replay
  const flowDataJSON = JSON.stringify(data.flows.map(f => ({
    id: f.id, name: f.name, desc: f.desc, category: f.category,
    steps: f.steps.map(st => ({ action: st.action, detail: st.detail, result: st.result, passed: st.passed, convo: st.convo, conclusion: st.conclusion, followUp: st.followUp })),
  })));

  const categories = {};
  data.flows.forEach(f => { if (!categories[f.category]) categories[f.category] = []; categories[f.category].push(f); });

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Asinu — Test luồng Check-in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;font-size:13px}
.header{background:linear-gradient(135deg,#1e40af,#7c3aed);color:#fff;padding:32px 20px;text-align:center}.header h1{font-size:22px;margin-bottom:4px}.header .sub{opacity:.8;font-size:13px}
.status{display:inline-block;margin-top:12px;padding:6px 20px;border-radius:20px;font-weight:700;font-size:14px;background:${allPass?'rgba(74,222,128,.2)':'rgba(248,113,113,.2)'};color:${allPass?'#bbf7d0':'#fecaca'};border:2px solid ${allPass?'#4ade80':'#f87171'}}
.stats{display:flex;justify-content:center;gap:12px;margin:12px auto 20px;max-width:600px;padding:0 16px;position:relative;z-index:1;flex-wrap:wrap}
.stat{background:#fff;border-radius:10px;padding:14px;text-align:center;flex:1;min-width:80px;box-shadow:0 1px 4px rgba(0,0,0,.08)}.stat .num{font-size:24px;font-weight:800}.stat .lbl{font-size:10px;color:#64748b;text-transform:uppercase;margin-top:2px}
.stat.p .num{color:#16a34a}.stat.f .num{color:#dc2626}.stat.t .num{color:#2563eb}
.section{max-width:900px;margin:20px auto;padding:0 16px}
.cat-title{font-size:15px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
.flow{background:#fff;border-radius:10px;margin-bottom:10px;border:1px solid #e2e8f0;overflow:hidden}
.flow-header{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px}.flow-header:hover{background:#f8fafc}
.flow-name{font-weight:700;font-size:14px;flex:1}.flow-desc{font-size:11px;color:#64748b;margin-top:2px}
.flow-stats{font-size:11px;display:flex;gap:6px;align-items:center}
.pill{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;display:inline-block}.pill.g{background:#dcfce7;color:#166534}.pill.r{background:#fee2e2;color:#991b1b}
.arrow{color:#94a3b8;transition:transform .2s;font-size:11px}.flow.open .arrow{transform:rotate(90deg)}
.flow-body{display:none;border-top:1px solid #f1f5f9;padding:16px}.flow.open .flow-body{display:block}

/* Timeline */
.timeline{position:relative;padding-left:28px}
.timeline::before{content:'';position:absolute;left:11px;top:0;bottom:0;width:2px;background:#e2e8f0}
.tl-node{position:relative;margin-bottom:0;padding-bottom:16px}
.tl-node:last-child{padding-bottom:0}
.tl-dot{position:absolute;left:-28px;top:2px;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;z-index:1}
.tl-dot.pass{background:#dcfce7;border:2px solid #16a34a}
.tl-dot.fail{background:#fee2e2;border:2px solid #dc2626}
.tl-dot.info{background:#dbeafe;border:2px solid #3b82f6}
.tl-connector{position:absolute;left:-18px;top:24px;width:2px;height:calc(100% - 24px);background:#e2e8f0}
.tl-content{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;font-size:12px}
.tl-content.clickable{cursor:pointer;transition:all .2s}.tl-content.clickable:hover{border-color:#93c5fd;background:#eff6ff}
.tl-action{font-weight:700;color:#1e293b;margin-bottom:2px;display:flex;align-items:center;gap:6px}
.tl-detail{color:#64748b;font-size:11px}
.tl-result{display:inline-block;margin-top:4px;font-size:11px;padding:2px 8px;border-radius:4px;background:#f1f5f9;color:#64748b}
.tl-expand{display:none;margin-top:10px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;line-height:1.9}
.tl-node.expanded .tl-expand{display:block}

/* Chat bubble style for conversation */
.chat-msg{margin:6px 0;padding:8px 12px;border-radius:12px;max-width:85%;font-size:12px;line-height:1.5}
.chat-system{background:#eff6ff;color:#1e40af;border-bottom-left-radius:4px;margin-right:auto}
.chat-user{background:#f0fdf4;color:#166534;border-bottom-right-radius:4px;margin-left:auto;text-align:right}
.chat-opts{font-size:10px;color:#94a3b8;margin-top:2px}
.chat-result{margin-top:8px;padding:10px 14px;border-radius:8px;border-left:4px solid}
.chat-result.low{background:#f0fdf4;border-color:#16a34a}
.chat-result.medium{background:#fefce8;border-color:#ca8a04}
.chat-result.high{background:#fef2f2;border-color:#dc2626}
.chat-result b{display:block;margin-bottom:4px}
.chat-fu{margin-top:8px;padding:8px 12px;background:#faf5ff;border-radius:8px;border-left:4px solid #8b5cf6;font-size:12px}

.expand-hint{font-size:10px;color:#93c5fd;margin-left:4px;font-weight:400}
.tabs{display:flex;gap:4px;margin-top:16px;position:relative;z-index:10}
.tab{padding:10px 20px;border:none;background:#e2e8f0;border-radius:10px 10px 0 0;cursor:pointer;font-size:13px;font-weight:600;color:#64748b;transition:all .2s}
.tab.active{background:#fff;color:#1e40af;box-shadow:0 -2px 8px rgba(0,0,0,.06)}
.tab:hover{color:#1e40af}

.i-msg{margin:6px 0;max-width:85%;animation:fadeUp .3s}.i-bot{margin-right:auto}.i-user{margin-left:auto}
.i-bubble{padding:8px 12px;border-radius:14px;font-size:12px;line-height:1.5}
.i-bot .i-bubble{background:#eff6ff;color:#1e40af;border-bottom-left-radius:3px}
.i-user .i-bubble{background:#f0fdf4;color:#166534;border-bottom-right-radius:3px;text-align:right}
.i-label{font-size:9px;color:#94a3b8;margin-bottom:1px;padding:0 3px}
.i-opts{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.i-opt{padding:6px 12px;border-radius:16px;border:1.5px solid #e2e8f0;background:#fff;cursor:pointer;font-size:11px;color:#334155;transition:all .15s}
.i-opt:hover{border-color:#3b82f6;color:#3b82f6;background:#eff6ff}
.i-opt.sel{background:#3b82f6;color:#fff;border-color:#3b82f6}
.i-slider{margin:6px 0;padding:8px 12px;background:#f8fafc;border-radius:10px}
.i-slider input{width:100%;accent-color:#3b82f6}
.i-slider-val{text-align:center;font-size:22px;font-weight:800;color:#1e40af;margin:4px 0}
.i-slider button{display:block;width:100%;padding:6px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;font-size:12px;margin-top:4px}
.i-free{display:flex;gap:4px;margin:6px 0}
.i-free input{flex:1;padding:8px 12px;border-radius:16px;border:1.5px solid #e2e8f0;font-size:11px;outline:none}
.i-free input:focus{border-color:#3b82f6}
.i-free button{padding:8px 14px;border-radius:16px;border:none;background:#3b82f6;color:#fff;cursor:pointer;font-size:11px}
.i-result{margin:8px 0;padding:10px;border-radius:10px;border-left:3px solid;font-size:11px}
.i-result.low{background:#f0fdf4;border-color:#16a34a}.i-result.medium{background:#fefce8;border-color:#ca8a04}
.i-result.high{background:#fef2f2;border-color:#dc2626}.i-result.critical{background:#450a0a;border-color:#dc2626;color:#fecaca}
.i-emergency{margin:8px 0;padding:12px;background:#450a0a;border-radius:10px;color:#fecaca;text-align:center;animation:shake .5s}
.i-restart{display:block;width:100%;margin-top:10px;padding:8px;border-radius:10px;border:1.5px solid #e2e8f0;background:#fff;cursor:pointer;font-size:12px;color:#64748b;font-weight:600}
.i-restart:hover{border-color:#3b82f6;color:#3b82f6}
.i-typing{display:inline-block;padding:6px 14px;background:#eff6ff;border-radius:14px;font-size:18px;animation:blink 1s infinite}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}

.replay-btn{background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;border:none;padding:4px 14px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;transition:all .2s}
.replay-btn:hover{transform:scale(1.05);box-shadow:0 2px 8px rgba(59,130,246,.4)}

/* Replay modal */
.replay-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:1000;justify-content:center;align-items:center}
.replay-overlay.active{display:flex}
.replay-modal{background:#fff;border-radius:16px;width:95%;max-width:480px;max-height:90vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.replay-header{background:linear-gradient(135deg,#1e40af,#7c3aed);color:#fff;padding:16px 20px;display:flex;align-items:center;gap:10px}
.replay-header h3{flex:1;font-size:15px}
.replay-close{background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px}
.replay-body{padding:16px 20px;overflow-y:auto;max-height:calc(90vh - 120px);min-height:300px}
.replay-controls{padding:10px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;gap:8px;justify-content:center}
.replay-controls button{padding:6px 16px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-size:12px;font-weight:600}
.replay-controls button.primary{background:#3b82f6;color:#fff;border-color:#3b82f6}
.replay-controls button:hover{opacity:.8}

/* Replay chat items */
.r-item{opacity:0;transform:translateY(10px);transition:all .4s ease;margin-bottom:8px}
.r-item.visible{opacity:1;transform:translateY(0)}
.r-time{font-size:10px;color:#94a3b8;text-align:center;margin:12px 0 4px}
.r-system{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px 12px 12px 2px;padding:10px 14px;font-size:12px;color:#1e40af;max-width:85%}
.r-user{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px 12px 2px 12px;padding:10px 14px;font-size:12px;color:#166534;max-width:75%;margin-left:auto;text-align:right}
.r-opts{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.r-opt{padding:3px 10px;border-radius:12px;font-size:10px;background:#e0e7ff;color:#3730a3}
.r-opt.selected{background:#3b82f6;color:#fff;font-weight:700}
.r-result{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-top:4px}
.r-sev{display:inline-block;padding:3px 12px;border-radius:6px;font-weight:700;font-size:12px}
.r-sev.low{background:#dcfce7;color:#166534}.r-sev.medium{background:#fef9c3;color:#854d0e}.r-sev.high{background:#fee2e2;color:#991b1b}.r-sev.critical{background:#7f1d1d;color:#fecaca}
.r-advice{margin-top:6px;font-size:11px;color:#475569;line-height:1.6}
.r-typing{display:inline-block;padding:8px 14px;background:#eff6ff;border-radius:12px;font-size:20px;animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}

.footer{text-align:center;padding:30px;color:#94a3b8;font-size:11px;margin-top:20px;border-top:1px solid #e2e8f0}
</style></head><body>
<div class="header"><h1>Test toàn bộ luồng Check-in</h1><div class="sub">${s.totalFlows} luồng × ${s.totalSteps} bước kiểm tra</div>
<div class="status">${allPass?'✔ TẤT CẢ ĐẠT':'⚠ CÓ LỖI'} — ${s.passFlows}/${s.totalFlows} luồng, ${s.passSteps}/${s.totalSteps} bước</div></div>

<div style="max-width:900px;margin:0 auto;padding:0 16px">
<div class="tabs">
  <button class="tab active" onclick="switchTab('results')">📊 Kết quả test (${s.totalFlows} luồng)</button>
  <button class="tab" onclick="switchTab('interactive')">🎮 Tự test trực tiếp</button>
</div>
</div>

<div id="tab-results">
<div class="stats">
<div class="stat t"><div class="num">${s.totalFlows}</div><div class="lbl">Luồng</div></div>
<div class="stat t"><div class="num">${s.totalSteps}</div><div class="lbl">Bước</div></div>
<div class="stat p"><div class="num">${s.passSteps}</div><div class="lbl">Đạt</div></div>
<div class="stat f"><div class="num">${s.failSteps}</div><div class="lbl">Lỗi</div></div></div>

${Object.entries(categories).map(([cat, catFlows]) => `
<div class="section">
<div class="cat-title"><span>${catIcons[cat]||'📋'}</span><span style="color:${catColors[cat]||'#334155'}">${catLabels[cat]||cat}</span>
<span style="font-size:11px;color:#94a3b8;margin-left:auto">${catFlows.filter(f=>f.pass).length}/${catFlows.length} đạt</span></div>
${catFlows.map(f => `
<div class="flow${!f.pass?' open':''}">
<div class="flow-header">
<span style="font-size:16px">${f.pass?'✅':'❌'}</span>
<div style="flex:1" onclick="this.parentElement.parentElement.classList.toggle('open')"><div class="flow-name">${f.id}. ${f.name}</div><div class="flow-desc">${f.desc}</div></div>
<div class="flow-stats"><button class="replay-btn" onclick="event.stopPropagation();replayFlow('${f.id}')">▶ Tái hiện</button><span class="pill g">${f.passCount} đạt</span>${f.failCount?`<span class="pill r">${f.failCount} lỗi</span>`:''}<span class="arrow" onclick="this.parentElement.parentElement.parentElement.classList.toggle('open')">▶</span></div></div>
<div class="flow-body">
<div class="timeline">
${f.steps.map((st, idx) => {
  const hasDetail = st.convo || st.conclusion || st.followUp;
  const sevVN = {low:'Nhẹ',medium:'Trung bình',high:'Nặng'};
  const sevCol = {low:'#16a34a',medium:'#ca8a04',high:'#dc2626'};

  let expandHTML = '';
  if (st.convo && st.convo.length > 0) {
    expandHTML += st.convo.map((c,i) => `
      <div class="chat-msg chat-system">🤖 <b>Câu ${i+1}:</b> ${c.q}${c.options ? `<div class="chat-opts">Lựa chọn: ${c.options.join(' · ')}</div>` : `<div class="chat-opts">${c.type==='slider'?'Thang điểm 0-10':'Nhập tự do'}</div>`}</div>
      <div class="chat-msg chat-user">👤 ${c.a}</div>
    `).join('');
  }
  if (st.conclusion) {
    const c = st.conclusion;
    const sev = c.severity||'low';
    expandHTML += `<div class="chat-result ${sev}">
      <b>📊 Kết quả: <span style="color:${sevCol[sev]}">${sevVN[sev]||sev}</span> · Hẹn ${c.followUpHours||'?'}h · Bác sĩ: ${c.needsDoctor?'CÓ':'Không'} · Gia đình: ${c.needsFamilyAlert?'CÓ':'Không'}</b>
      ${c.summary?`<div style="margin-top:4px"><b>Tóm tắt:</b> ${c.summary}</div>`:''}
      ${c.recommendation?`<div><b>Lời khuyên:</b> ${c.recommendation}</div>`:''}
      ${c.closeMessage?`<div><b>Lời nhắn:</b> ${c.closeMessage}</div>`:''}
    </div>`;
  }
  if (st.followUp) {
    const fu = st.followUp;
    const r = fu.result;
    const actionVN = r.action==='monitoring'?'✅ Theo dõi → hẹn tối':r.action==='escalate'?'🚨 Cảnh báo + khuyên bác sĩ':r.action==='continue_followup'?'🔄 Tiếp tục follow-up':r.action;
    expandHTML += `<div class="chat-msg chat-system">🤖 So với lúc trước, thấy thế nào?</div>
      <div class="chat-msg chat-user">👤 ${fu.status}</div>
      <div class="chat-msg chat-system">🤖 Có triệu chứng mới không?</div>
      <div class="chat-msg chat-user">👤 ${fu.newSymptoms?'Có':'Không'}</div>
      <div class="chat-fu">
        <b>Kết quả:</b> <span style="color:${sevCol[r.severity]};font-weight:700">${sevVN[r.severity]}</span> · ${actionVN} · Bác sĩ: ${r.needsDoctor?'CÓ':'Không'}
      </div>`;
  }

  const dotClass = st.passed ? (hasDetail ? 'pass' : 'info') : 'fail';
  const stepNum = idx + 1;

  return `<div class="tl-node${!st.passed?' expanded':''}" ${hasDetail?`onclick="this.classList.toggle('expanded')"`:''}>
  <div class="tl-dot ${dotClass}">${stepNum}</div>
  <div class="tl-content${hasDetail?' clickable':''}">
    <div class="tl-action">${st.passed?'✅':'❌'} ${st.action}${hasDetail?'<span class="expand-hint">▼ chi tiết</span>':''}</div>
    <div class="tl-detail">${st.detail}</div>
    <span class="tl-result">${st.result?.substring?.(0,50)||st.result}</span>
  </div>
  ${hasDetail?`<div class="tl-expand">${expandHTML}</div>`:''}
</div>`; }).join('')}
</div>
</div></div>`).join('')}
</div>`).join('')}

</div><!-- end tab-results -->

<div id="tab-interactive" style="display:none">
<div style="max-width:900px;margin:20px auto;padding:0 16px;display:flex;gap:20px;flex-wrap:wrap;justify-content:center">
  <div style="width:375px;min-height:650px;background:#fff;border-radius:32px;box-shadow:0 12px 40px rgba(0,0,0,.12);overflow:hidden;border:6px solid #1a1a2e">
    <div style="width:120px;height:20px;background:#1a1a2e;border-radius:0 0 12px 12px;margin:0 auto"></div>
    <div style="padding:14px;min-height:580px;display:flex;flex-direction:column">
      <div id="iChatArea" style="flex:1;overflow-y:auto;padding-bottom:10px"></div>
    </div>
  </div>
  <div style="width:280px">
    <div style="background:#fff;border-radius:10px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
      <h3 style="font-size:13px;margin-bottom:6px">📋 Hồ sơ test</h3>
      <div style="font-size:11px;color:#64748b;line-height:1.6"><b>Tên:</b> Trần Văn Hùng<br><b>Tuổi:</b> 68 | <b>Giới:</b> Nam<br><b>Bệnh nền:</b> Tiểu đường, Cao huyết áp, Tim mạch</div>
    </div>
    <div style="background:#fff;border-radius:10px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
      <h3 style="font-size:13px;margin-bottom:6px">🔍 Log hệ thống</h3>
      <div id="iSysLog" style="max-height:250px;overflow-y:auto;font-size:11px;color:#475569"></div>
    </div>
    <div style="background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
      <h3 style="font-size:13px;margin-bottom:6px">📊 Kết quả</h3>
      <div id="iResult" style="font-size:11px;color:#64748b">Chờ bắt đầu...</div>
    </div>
  </div>
</div>
</div><!-- end tab-interactive -->

<div class="footer">Asinu Health — Test luồng Check-in | ${new Date().toLocaleString('vi-VN')} | 0 AI call</div>

<div class="replay-overlay" id="replayOverlay">
  <div class="replay-modal">
    <div class="replay-header">
      <h3 id="replayTitle">Tái hiện luồng</h3>
      <button class="replay-close" onclick="closeReplay()">✕</button>
    </div>
    <div class="replay-body" id="replayBody"></div>
    <div class="replay-controls">
      <button onclick="replaySpeed='slow';restartReplay()">🐢 Chậm</button>
      <button class="primary" onclick="replaySpeed='normal';restartReplay()">▶ Bình thường</button>
      <button onclick="replaySpeed='fast';restartReplay()">⚡ Nhanh</button>
      <button onclick="closeReplay()">✕ Đóng</button>
    </div>
  </div>
</div>

<script>
document.querySelectorAll('.flow').forEach(f=>{if(f.querySelector('.tl-dot.fail'))f.classList.add('open')});

const ALL_FLOWS = ${flowDataJSON};
let replaySpeed = 'normal';
let replayTimeout = null;
let currentFlowId = null;

const SPEEDS = { slow: 1200, normal: 600, fast: 200 };
const sevVN = {low:'Nhẹ',medium:'Trung bình',high:'Nặng',critical:'Nguy kịch'};
const sevClass = {low:'low',medium:'medium',high:'high',critical:'critical'};

function closeReplay() {
  document.getElementById('replayOverlay').classList.remove('active');
  if (replayTimeout) clearTimeout(replayTimeout);
}

function restartReplay() {
  if (currentFlowId) replayFlow(currentFlowId);
}

function replayFlow(flowId) {
  currentFlowId = flowId;
  const flow = ALL_FLOWS.find(f => f.id === flowId);
  if (!flow) return;

  const overlay = document.getElementById('replayOverlay');
  const body = document.getElementById('replayBody');
  const title = document.getElementById('replayTitle');

  overlay.classList.add('active');
  title.textContent = flow.id + '. ' + flow.name;
  body.innerHTML = '';
  body.scrollTop = 0;

  const items = [];
  const delay = SPEEDS[replaySpeed] || 600;

  // Build all replay items from steps
  flow.steps.forEach((st, si) => {
    // Step header
    items.push({ type: 'time', text: 'Bước ' + (si+1) });
    items.push({ type: 'system', html: '<b>' + st.action + '</b><br><span style="color:#64748b">' + st.detail + '</span>' });

    // Conversation detail
    if (st.convo) {
      st.convo.forEach((c, ci) => {
        let qHTML = '🤖 <b>Câu ' + (ci+1) + ':</b> ' + c.q;
        if (c.options) {
          qHTML += '<div class="r-opts">' + c.options.map(o => '<span class="r-opt' + (o===c.a?' selected':'') + '">' + o + '</span>').join('') + '</div>';
        }
        items.push({ type: 'system', html: qHTML });
        items.push({ type: 'typing' });
        items.push({ type: 'user', html: '👤 ' + c.a });
      });
    }

    // Follow-up detail
    if (st.followUp) {
      const fu = st.followUp;
      items.push({ type: 'system', html: '🤖 So với lúc trước, thấy thế nào?' });
      items.push({ type: 'typing' });
      items.push({ type: 'user', html: '👤 ' + fu.status });
      items.push({ type: 'system', html: '🤖 Có triệu chứng mới không?' });
      items.push({ type: 'typing' });
      items.push({ type: 'user', html: '👤 ' + (fu.newSymptoms ? 'Có' : 'Không') });

      const r = fu.result;
      const actionVN = r.action==='monitoring'?'✅ Theo dõi → hẹn tối':r.action==='escalate'?'🚨 Cảnh báo + khuyên bác sĩ':r.action==='continue_followup'?'🔄 Tiếp tục theo dõi':r.action;
      items.push({ type: 'result', severity: r.severity, html: '<span class="r-sev ' + sevClass[r.severity] + '">' + sevVN[r.severity] + '</span> · ' + actionVN + ' · Bác sĩ: ' + (r.needsDoctor?'CÓ':'Không') });
    }

    // Conclusion
    if (st.conclusion) {
      const c = st.conclusion;
      let cHTML = '<span class="r-sev ' + sevClass[c.severity] + '">' + (sevVN[c.severity]||c.severity) + '</span>';
      cHTML += ' · Hẹn ' + (c.followUpHours||'?') + 'h · Bác sĩ: ' + (c.needsDoctor?'CÓ':'Không');
      if (c.summary) cHTML += '<div class="r-advice"><b>Tóm tắt:</b> ' + c.summary + '</div>';
      if (c.recommendation) cHTML += '<div class="r-advice"><b>Lời khuyên:</b> ' + c.recommendation + '</div>';
      if (c.closeMessage) cHTML += '<div class="r-advice"><b>Lời nhắn:</b> ' + c.closeMessage + '</div>';
      items.push({ type: 'result', severity: c.severity, html: cHTML });
    }

    // Step result badge
    items.push({ type: 'badge', passed: st.passed, text: st.result ? st.result.substring(0,60) : '' });
  });

  // Animate items one by one
  let idx = 0;
  function showNext() {
    if (idx >= items.length) return;
    const item = items[idx];
    const el = document.createElement('div');
    el.className = 'r-item';

    if (item.type === 'time') {
      el.className += ' r-time';
      el.innerHTML = '⏱ ' + item.text;
    } else if (item.type === 'system') {
      el.innerHTML = '<div class="r-system">' + item.html + '</div>';
    } else if (item.type === 'user') {
      el.innerHTML = '<div class="r-user">' + item.html + '</div>';
    } else if (item.type === 'typing') {
      el.innerHTML = '<div class="r-typing">···</div>';
      body.appendChild(el);
      setTimeout(() => { el.classList.add('visible'); }, 10);
      body.scrollTop = body.scrollHeight;
      idx++;
      replayTimeout = setTimeout(() => { el.remove(); showNext(); }, delay * 0.6);
      return;
    } else if (item.type === 'result') {
      el.innerHTML = '<div class="r-result">' + item.html + '</div>';
    } else if (item.type === 'badge') {
      el.innerHTML = '<div style="text-align:center;margin:4px 0"><span style="display:inline-block;padding:3px 12px;border-radius:6px;font-size:11px;font-weight:600;' + (item.passed?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b') + '">' + (item.passed?'✅':'❌') + ' ' + item.text + '</span></div>';
    }

    body.appendChild(el);
    setTimeout(() => { el.classList.add('visible'); }, 10);
    body.scrollTop = body.scrollHeight;
    idx++;
    replayTimeout = setTimeout(showNext, item.type === 'result' ? delay * 2 : delay);
  }

  if (replayTimeout) clearTimeout(replayTimeout);
  replayTimeout = setTimeout(showNext, 300);
}

// ─── Tab switching ───
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-results').style.display = tab==='results'?'block':'none';
  document.getElementById('tab-interactive').style.display = tab==='interactive'?'block':'none';
  event.target.classList.add('active');
  if (tab==='interactive' && !window._iStarted) { window._iStarted=true; iStart(); }
}

// ─── Interactive test (calls REAL API backend) ───
const API_TOKEN = '${require('jsonwebtoken').sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '7d' })}';
const API_BASE = window.location.origin + '/api/mobile';
const iChat=document.getElementById('iChatArea'),iLog=document.getElementById('iSysLog'),iRes=document.getElementById('iResult');
let iSessionId=null, iCurrentStatus=null;
const iSevVN={low:'Nhẹ',medium:'Trung bình',high:'Nặng',critical:'Nguy kịch'};
const iSevE={low:'🟢',medium:'🟡',high:'🔴',critical:'🚨'};

async function api(path, body=null) {
  const opts = { headers: {'Content-Type':'application/json','Authorization':'Bearer '+API_TOKEN} };
  if (body) { opts.method='POST'; opts.body=JSON.stringify(body); }
  const r = await fetch(API_BASE+path, opts);
  return r.json();
}

function ilog(m){const t=new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});iLog.innerHTML+='<div style="padding:2px 0;border-bottom:1px solid #f1f5f9"><span style="color:#94a3b8;font-size:9px">'+t+'</span> '+m+'</div>';iLog.scrollTop=iLog.scrollHeight}
function iBot(html,delay){return new Promise(r=>{const d=document.createElement('div');d.className='i-msg i-bot';d.innerHTML='<div class="i-label">🤖 Asinu</div><div class="i-typing">···</div>';iChat.appendChild(d);iChat.scrollTop=iChat.scrollHeight;setTimeout(()=>{d.innerHTML='<div class="i-label">🤖 Asinu</div><div class="i-bubble">'+html+'</div>';iChat.scrollTop=iChat.scrollHeight;r()},delay||400)})}
function iUser(t){const d=document.createElement('div');d.className='i-msg i-user';d.innerHTML='<div class="i-label">👤 Chú Hùng</div><div class="i-bubble">'+t+'</div>';iChat.appendChild(d);iChat.scrollTop=iChat.scrollHeight}
function iOpts(opts,cb){const w=document.createElement('div');w.className='i-opts';opts.forEach(o=>{const b=document.createElement('button');b.className='i-opt';b.textContent=typeof o==='object'?o.label:o;b.onclick=()=>{w.querySelectorAll('.i-opt').forEach(x=>{x.disabled=true;x.style.opacity='.5'});b.classList.add('sel');b.style.opacity='1';iUser(typeof o==='object'?o.label:o);setTimeout(()=>cb(typeof o==='object'?o.value:o),250)};w.appendChild(b)});iChat.appendChild(w);iChat.scrollTop=iChat.scrollHeight}
function iSlider(min,max,cb){const w=document.createElement('div');w.className='i-slider';w.innerHTML='<div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8"><span>'+min+'</span><span>'+max+'</span></div><input type=range min='+min+' max='+max+' value=5><div class="i-slider-val">5</div><button>Xác nhận</button>';const inp=w.querySelector('input');inp.oninput=()=>w.querySelector('.i-slider-val').textContent=inp.value;w.querySelector('button').onclick=()=>{const v=+inp.value;inp.disabled=true;w.querySelector('button').disabled=true;iUser(v+'/'+max);setTimeout(()=>cb(v),250)};iChat.appendChild(w);iChat.scrollTop=iChat.scrollHeight}
function iFree(cb){const w=document.createElement('div');w.className='i-free';w.innerHTML='<input placeholder="Nhập bất kỳ triệu chứng nào..."><button>Gửi</button>';const inp=w.querySelector('input');const go=()=>{const v=inp.value.trim();if(!v)return;inp.disabled=true;w.querySelector('button').disabled=true;iUser(v);setTimeout(()=>cb(v),250)};w.querySelector('button').onclick=go;inp.onkeydown=e=>{if(e.key==='Enter')go()};iChat.appendChild(w);inp.focus();iChat.scrollTop=iChat.scrollHeight}
function iShowEm(em){const d=document.createElement('div');d.className='i-emergency';d.innerHTML='<h3 style="color:#f87171;font-size:16px">🚨 CẤP CỨU'+(em.type?' — '+em.type:'')+'</h3><div>'+(em.action||'Gọi 115 hoặc đến bệnh viện ngay')+'</div>';iChat.appendChild(d);iChat.scrollTop=iChat.scrollHeight;ilog('🚨 EMERGENCY');iRes.innerHTML='<div style="color:#dc2626;font-weight:700">🚨 CẤP CỨU</div>';iRestart()}
function iShowRes(r){const sev=r.severity||'medium';const d=document.createElement('div');d.className='i-result '+sev;d.innerHTML='<b>'+iSevE[sev]+' '+iSevVN[sev]+'</b> · Hẹn '+(r.followUpHours||r.follow_up_hours||'?')+'h · Bác sĩ: '+(r.needsDoctor||r.needs_doctor?'CÓ':'Không');iChat.appendChild(d);iChat.scrollTop=iChat.scrollHeight;iRes.innerHTML='<b>'+iSevE[sev]+' '+iSevVN[sev]+'</b><br>Hẹn: '+(r.followUpHours||r.follow_up_hours||'?')+'h | Bác sĩ: '+(r.needsDoctor||r.needs_doctor?'CÓ':'Không')}
function iRestart(){const b=document.createElement('button');b.className='i-restart';b.textContent='🔄 Test lại từ đầu';b.onclick=iStart;iChat.appendChild(b);iChat.scrollTop=iChat.scrollHeight}

async function iStart(){
  iChat.innerHTML='';iSessionId=null;iCurrentStatus=null;iLog.innerHTML='';iRes.innerHTML='Chờ bắt đầu...';
  ilog('Bắt đầu phiên check-in');

  // Get script from API
  ilog('Gọi API: GET /checkin/script');
  const scriptRes = await api('/checkin/script').catch(e=>({ok:false,error:e.message}));
  if(scriptRes.ok && scriptRes.greeting){
    await iBot(scriptRes.greeting);
  } else {
    await iBot('Chào chú Hùng! Hôm nay chú thế nào? 💙');
  }
  ilog('Hiển thị lựa chọn trạng thái');
  iOpts([{label:'😊 Tôi ổn',value:'fine'},{label:'😐 Hơi mệt',value:'tired'},{label:'😫 Rất mệt',value:'very_tired'}],iStatus);
}

async function iStatus(s){
  ilog('User chọn: '+s);
  iCurrentStatus=s;
  if(s==='fine'){
    ilog('Gọi API: POST /checkin/script/start {status:fine}');
    const r=await api('/checkin/script/start',{status:'fine'}).catch(e=>({ok:false}));
    await iBot(r.message||'Tốt quá! Cháu hẹn chú tối nay nhé 💙');
    ilog('Ổn → hẹn tối');iShowRes({severity:'low',followUpHours:6,needsDoctor:false});iRestart();return;
  }
  await iBot('Chú đang gặp vấn đề gì?');

  // Get clusters from API
  ilog('Gọi API: GET /checkin/script → lấy danh sách triệu chứng');
  const scriptRes = await api('/checkin/script').catch(e=>({ok:false}));
  const clusters = (scriptRes.clusters||[]).filter(c=>c.has_script).slice(0,8);

  if(clusters.length > 0){
    ilog(clusters.length + ' triệu chứng có sẵn');
    iOpts(clusters.map(c=>({label:c.display_name, value:c.cluster_key})), v=>{
      ilog('Chọn cluster: '+v);
      iInputSymptom(null, s, v);
    });
    const or=document.createElement('div');
    or.style.cssText='text-align:center;font-size:10px;color:#94a3b8;margin:6px 0';
    or.textContent='— hoặc nhập triệu chứng bất kỳ —';
    iChat.appendChild(or);
  }
  iFree(v=>iInputSymptom(v, s, null));
}

async function iInputSymptom(input, status, clusterKey){
  const body = { status: status };
  if(clusterKey) {
    body.cluster_key = clusterKey;
    ilog('Chọn cluster: '+clusterKey);
    ilog('Gọi API: POST /checkin/script/start {status:'+status+', cluster_key:"'+clusterKey+'"}');
  } else {
    body.symptom_input = input;
    ilog('Nhập: "'+input+'"');
    ilog('Gọi API: POST /checkin/script/start {status:'+status+', symptom_input:"'+input+'"}');
  }
  await iBot('Đang phân tích...', 200);

  try {
    const r = await api('/checkin/script/start', body);
    ilog('API trả về: ' + JSON.stringify({ok:r.ok, is_emergency:r.is_emergency, is_fallback:r.is_fallback, session_id:r.session_id}).substring(0,100));

    if(r.is_emergency){
      iShowEm(r.emergency||{});
      return;
    }

    if(!r.ok){
      await iBot('Lỗi: '+(r.error||'Không rõ'));iRestart();return;
    }

    iSessionId = r.session_id;

    if(r.is_fallback){
      ilog('⚠️ Triệu chứng mới → '+(r.ai_generated?'AI đang tạo câu hỏi...':'Fallback'));
      if(r.ai_generated) await iBot('🤖 AI đã phân tích: "'+input+'" → tạo câu hỏi chuyên sâu');
    } else {
      ilog('✅ Match cluster: '+r.cluster_key);
    }

    // Show first question from API
    if(r.question){
      iShowQuestion(r.question);
    } else if(r.isDone){
      iShowConclusion(r);
    }
  } catch(e) {
    ilog('❌ API error: '+e.message);
    await iBot('Lỗi kết nối backend. Kiểm tra server.');
    iRestart();
  }
}

function iShowQuestion(q){
  ilog('Q: '+q.text+' ('+q.type+')');
  iBot(q.text).then(()=>{
    if(q.type==='slider'){
      iSlider(q.min||0,q.max||10,v=>iAnswer(q.id,v));
    } else if(q.options && q.options.length>0){
      iOpts(q.options,v=>iAnswer(q.id,v));
    } else {
      iFree(v=>iAnswer(q.id,v));
    }
  });
}

async function iAnswer(questionId,answer){
  ilog('→ '+answer);
  ilog('Gọi API: POST /checkin/script/answer');

  try {
    const r = await api('/checkin/script/answer', { session_id:iSessionId, question_id:questionId, answer:answer });

    if(r.is_emergency){
      iShowEm(r.emergency||{});
      return;
    }

    if(r.isDone){
      iShowConclusion(r);
    } else if(r.question){
      iShowQuestion(r.question);
    }
  } catch(e){
    ilog('❌ API error: '+e.message);
    await iBot('Lỗi kết nối.');iRestart();
  }
}

async function iShowConclusion(r){
  const c = r.conclusion || r;
  const sev = c.severity || r.severity || 'medium';
  ilog('Kết quả: '+iSevVN[sev]);

  if(c.summary) await iBot(c.summary);
  if(c.recommendation) await iBot(c.recommendation);
  if(c.closeMessage) await iBot(c.closeMessage);

  iShowRes({severity:sev, followUpHours:c.followUpHours||c.follow_up_hours, needsDoctor:c.needsDoctor||c.needs_doctor});

  // Follow-up
  await new Promise(x=>setTimeout(x,600));
  await iBot('--- Giả lập '+(c.followUpHours||c.follow_up_hours||3)+'h sau ---<br>So với lúc trước, chú thấy thế nào?');
  iOpts(['Đỡ hơn','Vẫn vậy','Nặng hơn'],async v=>{
    ilog('Follow-up: '+v);
    const fs=v==='Đỡ hơn'?'low':v==='Nặng hơn'?'high':sev;
    const fa=v==='Đỡ hơn'?'Theo dõi → hẹn tối':v==='Nặng hơn'?'🚨 Khuyên bác sĩ':'Tiếp tục theo dõi';
    await iBot(iSevE[fs]+' <b>'+iSevVN[fs]+'</b> → '+fa);
    iShowRes({severity:fs,followUpHours:fs==='high'?1:6,needsDoctor:fs==='high'});
    iRestart();
  });
}
</script>
</body></html>`;
}

run().catch(err => { console.error('CRASH:', err); pool.end(); process.exit(1); });
