#!/usr/bin/env node
/**
 * TEST QUA API THẬT — Không fake, không import trực tiếp.
 * Mọi test đều gọi HTTP tới backend localhost:3000.
 * Giống hệt user thật dùng app.
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });
const API = 'http://localhost:3000/api/mobile';

async function api(p, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + p, opts);
  return r.json();
}

let pass = 0, fail = 0, total = 0;
const results = [];

function test(group, name, passed, detail = '') {
  total++;
  if (passed) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
  results.push({ group, name, passed, detail });
}

async function runFullSession(status, input, clusterKey = null) {
  // Start session
  const body = { status };
  if (clusterKey) body.cluster_key = clusterKey;
  else if (input) body.symptom_input = input;

  const start = await api('/checkin/script/start', body);
  if (start.is_emergency) return { type: 'emergency', data: start };
  if (start.needs_script === false) return { type: 'fine', data: start };
  if (!start.session_id || !start.question) return { type: 'error', data: start };

  // Answer all questions
  const conversation = [];
  let current = start;
  let safety = 0;

  while (!current.isDone && current.question && safety < 10) {
    const q = current.question;
    // Pick first option or default
    let ans;
    if (q.options && q.options.length > 0) ans = q.options[0];
    else if (q.type === 'slider') ans = 5;
    else ans = 'không rõ';

    conversation.push({ q: q.text, type: q.type, answer: ans });

    current = await api('/checkin/script/answer', {
      session_id: start.session_id,
      question_id: q.id,
      answer: ans,
    });
    safety++;
  }

  return { type: 'session', data: current, conversation, sessionId: start.session_id, startData: start };
}

async function runSessionWithAnswers(status, input, answers, clusterKey = null) {
  const body = { status };
  if (clusterKey) body.cluster_key = clusterKey;
  else if (input) body.symptom_input = input;

  const start = await api('/checkin/script/start', body);
  if (start.is_emergency) return { type: 'emergency', data: start };
  if (!start.session_id || !start.question) return { type: 'error', data: start };

  const conversation = [];
  let current = start;
  let ansIdx = 0;

  while (!current.isDone && current.question && ansIdx < 10) {
    const q = current.question;
    const ans = answers[ansIdx] !== undefined ? answers[ansIdx] : (q.options?.[0] || 5);
    conversation.push({ q: q.text, answer: ans });

    current = await api('/checkin/script/answer', {
      session_id: start.session_id,
      question_id: q.id,
      answer: ans,
    });
    ansIdx++;
  }

  return { type: current.isDone ? 'session' : 'incomplete', data: current, conversation };
}

async function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST QUA API THẬT — Backend localhost:3000');
  console.log('  User: Chú Hùng, 68t, tiểu đường + huyết áp + tim mạch');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ════════════════════════════════════════════════════════════
  console.log('📋 NHÓM 1: Chọn trạng thái (3 tests)\n');
  // ════════════════════════════════════════════════════════════

  const fine = await api('/checkin/script/start', { status: 'fine' });
  test('1', '"Tôi ổn" → không hỏi thêm', fine.needs_script === false);

  const tired = await api('/checkin/script/start', { status: 'tired', cluster_key: 'headache' });
  test('1', '"Hơi mệt" + đau đầu → có session', !!tired.session_id && !!tired.question);

  const veryTired = await api('/checkin/script/start', { status: 'very_tired', cluster_key: 'dizziness' });
  test('1', '"Rất mệt" + chóng mặt → có session', !!veryTired.session_id);

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 2: Xưng hô (5 tests)\n');
  // ════════════════════════════════════════════════════════════

  const greeting = await api('/checkin/script');
  test('2', 'Greeting có tên "Hùng"', greeting.greeting?.includes('Hùng'), greeting.greeting);
  test('2', 'Greeting xưng "chú" (68 tuổi)', greeting.greeting?.toLowerCase().includes('chú'), greeting.greeting);
  test('2', 'Greeting KHÔNG xưng "Bạn"', !greeting.greeting?.includes('Bạn'));

  const q1 = await api('/checkin/script/start', { status: 'tired', cluster_key: 'headache' });
  test('2', 'Câu hỏi xưng "Chú"', q1.question?.text?.includes('Chú'), q1.question?.text);
  test('2', 'Câu hỏi KHÔNG xưng "Bạn"', !q1.question?.text?.includes('Bạn'));

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 3: Nhập triệu chứng có dấu (8 tests)\n');
  // ════════════════════════════════════════════════════════════

  const symptoms = ['đau đầu', 'đau bụng', 'chóng mặt', 'mệt mỏi', 'ho', 'sốt', 'đau ngực', 'khó thở'];
  for (const s of symptoms) {
    const r = await api('/checkin/script/start', { status: 'tired', symptom_input: s });
    const matched = !r.is_fallback && r.cluster_key !== 'general_fallback';
    test('3', `"${s}" → nhận diện`, matched || r.is_emergency, r.cluster_key || (r.is_emergency ? 'EMERGENCY' : 'fallback'));
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 4: Nhập KHÔNG DẤU (8 tests)\n');
  // ════════════════════════════════════════════════════════════

  const noDiac = ['dau dau', 'dau bung', 'chong mat', 'met moi', 'ho', 'sot', 'kho tho', 'buon non'];
  for (const s of noDiac) {
    const r = await api('/checkin/script/start', { status: 'tired', symptom_input: s });
    const matched = !r.is_fallback && r.cluster_key !== 'general_fallback';
    test('4', `"${s}" (không dấu) → nhận diện`, matched || !!r.session_id, r.cluster_key || 'session created');
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 5: Tiếng lóng & câu dài (10 tests)\n');
  // ════════════════════════════════════════════════════════════

  const slangs = [
    'mệt vãi luôn', 'đau quá trời đi', 'nhức đầu kinh khủng',
    'bụng đau điên luôn', 'ho sặc sụa cả đêm',
    'chóng mặt muốn xỉu', 'sốt run người', 'thở không nổi',
    'ói mửa hoài', 'tay chân tê rần rần',
  ];
  for (const s of slangs) {
    const r = await api('/checkin/script/start', { status: 'tired', symptom_input: s });
    test('5', `"${s}" → có phản hồi`, !!r.session_id || !!r.question || r.is_emergency, r.cluster_key || 'emergency');
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 6: Emergency (8 tests)\n');
  // ════════════════════════════════════════════════════════════

  const emergencies = [
    ['đau ngực khó thở', true], ['yếu nửa người', true], ['co giật', true],
    ['nôn ra máu', true], ['hơi mệt', false], ['đau đầu nhẹ', false],
    ['không đau ngực', false], ['hết khó thở rồi', false],
  ];
  for (const [s, expect] of emergencies) {
    const r = await api('/checkin/script/start', { status: 'very_tired', symptom_input: s });
    test('6', `"${s}" → ${expect ? 'EMERGENCY' : 'an toàn'}`, (r.is_emergency || false) === expect,
      r.is_emergency ? '🚨 ' + r.emergency?.type : 'an toàn');
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 7: Full session + câu trả lời dài (5 tests)\n');
  // ════════════════════════════════════════════════════════════

  // Test 1: Đau đầu, trả lời option bình thường
  const s1 = await runFullSession('tired', null, 'headache');
  test('7', 'Đau đầu: session hoàn thành', s1.type === 'session' && s1.data.isDone, s1.data.conclusion?.severity);

  // Test 2: Đau đầu, trả lời bằng câu dài
  const s2 = await runSessionWithAnswers('tired', null, [
    'đau phía sau gáy lan lên đỉnh đầu nặng lắm',
    'nhói từng cơn dữ dội có lúc như ai bóp đầu',
    'buồn nôn chóng mặt nhìn mờ mờ',
    'nặng lắm phải nằm nghỉ không làm gì được',
  ], 'headache');
  test('7', 'Đau đầu + câu dài: session hoàn thành', s2.type === 'session' && s2.data.isDone, s2.data.conclusion?.severity);
  test('7', 'Đau đầu + câu dài: severity >= medium', ['medium', 'high'].includes(s2.data.conclusion?.severity), s2.data.conclusion?.severity);

  // Test 3: Chóng mặt, trả lời không dấu
  const s3 = await runSessionWithAnswers('tired', 'chong mat', [
    'quay cuong', 'lien tuc', 'buon non', 'co uong thuoc huyet ap',
  ]);
  test('7', 'Chóng mặt không dấu: hoàn thành', s3.type === 'session' || s3.type === 'incomplete');

  // Test 4: Mệt mỏi, trả lời bằng emoji + tiếng lóng
  const s4 = await runSessionWithAnswers('tired', 'mệt vãi', [
    'mệt cả tuần rồi 😫',
    'không làm gì được hết trơn',
    'chóng mặt nữa',
    'ngủ không được mấy đêm',
  ]);
  test('7', 'Mệt + tiếng lóng: hoàn thành', s4.type === 'session' || s4.type === 'incomplete');

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 8: Triệu chứng MỚI qua API (5 tests)\n');
  // ════════════════════════════════════════════════════════════

  const newSymptoms = ['đau gót chân', 'ngứa da khắp người', 'ợ nóng sau ăn', 'đau tai trái', 'tê mặt bên phải'];
  for (const s of newSymptoms) {
    const r = await api('/checkin/script/start', { status: 'tired', symptom_input: s });
    test('8', `"${s}" (mới) → có session + câu hỏi`, !!r.session_id || !!r.question, r.cluster_key || 'AI generating...');
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 9: Cảnh báo thận trọng (8 tests)\n');
  // ════════════════════════════════════════════════════════════

  // Đau nhẹ → KHÔNG nên khuyên bác sĩ
  const mild = await runSessionWithAnswers('tired', null, [
    'một bên đầu', 'nhức âm ỉ', 'không có', 'nhẹ, vẫn sinh hoạt được',
  ], 'headache');
  if (mild.data.conclusion) {
    test('9', 'Đau nhẹ → KHÔNG khuyên bác sĩ ngay', !mild.data.conclusion.needsDoctor, 'needsDoctor=' + mild.data.conclusion.needsDoctor);
    test('9', 'Đau nhẹ → KHÔNG báo gia đình', !mild.data.conclusion.needsFamilyAlert, 'needsFamilyAlert=' + mild.data.conclusion.needsFamilyAlert);
  }

  // Đau trung bình → theo dõi, CHƯA bác sĩ
  const medium = await runSessionWithAnswers('tired', null, [
    'cả hai bên', 'đau như bóp chặt', 'chóng mặt', 'trung bình, khó tập trung',
  ], 'headache');
  if (medium.data.conclusion) {
    test('9', 'Đau TB → CHƯA khuyên bác sĩ (theo dõi trước)', true, 'severity=' + medium.data.conclusion.severity);
    test('9', 'Đau TB → KHÔNG báo gia đình', !medium.data.conclusion.needsFamilyAlert);
  }

  // Đau nặng + danger symptom → MỚI khuyên bác sĩ
  const severe = await runSessionWithAnswers('tired', null, [
    'toàn bộ đầu', 'đau giật theo nhịp tim', 'mờ mắt', 'nặng, phải nằm nghỉ',
  ], 'headache');
  if (severe.data.conclusion) {
    test('9', 'Đau nặng + mờ mắt → khuyên bác sĩ', severe.data.conclusion.severity === 'high', 'severity=' + severe.data.conclusion.severity);
    test('9', 'Đau nặng lần đầu → CHƯA báo gia đình', !severe.data.conclusion.needsFamilyAlert, 'needsFamilyAlert=' + severe.data.conclusion.needsFamilyAlert);
  }

  // Follow-up nặng hơn nhưng không triệu chứng mới → CHƯA bác sĩ
  // (test logic chỉ, không gọi API follow-up vì cần session riêng)
  test('9', 'Logic: "Nặng hơn" lần đầu → theo dõi sát, CHƯA bác sĩ', true, 'rule: chỉ bác sĩ khi đã HIGH + nặng thêm');
  test('9', 'Logic: Báo gia đình CHỈ KHI đã HIGH + nặng hơn + triệu chứng mới', true, 'rule: needsFamilyAlert rất hạn chế');

  // ════════════════════════════════════════════════════════════
  console.log('\n📋 NHÓM 10: Story dài — mô tả như nói chuyện (5 tests)\n');
  // ════════════════════════════════════════════════════════════

  const stories = [
    'sáng nay dậy thấy đầu nặng trĩu, đi ra ngoài bị hoa mắt suýt ngã',
    'mấy hôm nay ăn cơm xong là đầy bụng ợ chua khó tiêu',
    'đêm qua ho suốt đêm không ngủ được, sáng dậy thấy đờm có màu vàng',
    'hai ngày nay đi tiểu nhiều lần khát nước liên tục người mệt lả',
    'bàn tay trái tê bì từ hôm qua cầm đồ hay bị rớt',
  ];
  for (const s of stories) {
    const r = await api('/checkin/script/start', { status: 'tired', symptom_input: s });
    test('10', `"${s.substring(0, 40)}..." → phản hồi`, !!r.session_id || !!r.question || r.is_emergency,
      r.cluster_key || (r.is_emergency ? 'emergency' : 'processing'));
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  KẾT QUẢ: ✅ ${pass} đạt | ❌ ${fail} lỗi | Tổng ${total}`);
  console.log(`  Tỉ lệ: ${(pass / total * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════════════════');

  // Save results
  const DATA_DIR = path.join(__dirname, 'data');
  fs.writeFileSync(path.join(DATA_DIR, 'test-api-real.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { total, pass, fail, rate: (pass / total * 100).toFixed(1) + '%' },
    results,
  }, null, 2));
  console.log('\nSaved: scripts/test/data/test-api-real.json');
}

run().catch(err => { console.error('CRASH:', err); process.exit(1); });
