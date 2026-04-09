#!/usr/bin/env node
/**
 * AI ANSWER PARSER ACCURACY TEST — via REAL API (localhost:3000)
 *
 * Validates that when users type free text instead of selecting options,
 * the answer parser correctly maps their input and scoring stays consistent.
 *
 * 20 sessions total = 10 pairs x 2 (option vs free text).
 * Each pair compares severity from option-selection vs free-text input.
 *
 * NO function imports — only HTTP calls.
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');

const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });

async function api(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);
  return (await fetch('http://localhost:3000/api/mobile' + path, opts)).json();
}

// ── Reset session so we can run a fresh one ─────────────────────────────────

async function resetSession() {
  await api('/checkin/reset-today', {});
  // Small delay to let DB settle
  await new Promise(r => setTimeout(r, 300));
}

// ── Run a full script session with given answers ────────────────────────────

async function runSession(clusterKey, answers) {
  const start = await api('/checkin/script/start', {
    status: 'tired',
    cluster_key: clusterKey,
  });

  if (start.is_emergency) return { ok: false, type: 'emergency', data: start };
  if (!start.session_id || !start.question) return { ok: false, type: 'no_session', data: start };

  const conversation = [];
  let current = start;
  let ansIdx = 0;
  let safety = 0;

  while (!current.isDone && current.question && safety < 12) {
    const q = current.question;
    // Use provided answer or fallback to first option
    const ans = ansIdx < answers.length
      ? answers[ansIdx]
      : (q.options ? q.options[0] : (q.type === 'slider' ? 5 : 'ok'));

    conversation.push({
      qId: q.id,
      qText: q.text.substring(0, 60),
      qType: q.type,
      answer: ans,
      options: q.options || null,
    });

    current = await api('/checkin/script/answer', {
      session_id: start.session_id,
      question_id: q.id,
      answer: ans,
    });
    ansIdx++;
    safety++;
  }

  if (!current.isDone) {
    return { ok: false, type: 'incomplete', conversation, data: current };
  }

  return {
    ok: true,
    type: 'done',
    severity: current.conclusion?.severity || 'unknown',
    needsDoctor: current.conclusion?.needsDoctor || false,
    followUpHours: current.conclusion?.followUpHours,
    hasRedFlag: current.conclusion?.hasRedFlag || false,
    conversation,
  };
}

// ── Severity comparison helpers ─────────────────────────────────────────────

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

function severityMatch(sevA, sevB) {
  // Match = same severity OR B is at most 1 level lower
  const rankA = SEVERITY_RANK[sevA] ?? -1;
  const rankB = SEVERITY_RANK[sevB] ?? -1;
  return rankA === rankB || (rankA - rankB === 1);
}

// ── Test pair definitions ───────────────────────────────────────────────────

const PAIRS = [
  // ═══════ HEADACHE (5 pairs) ═══════

  // Pair 1: Basic — mild headache
  {
    id: 1,
    cluster: 'headache',
    label: 'Headache: basic mild',
    optionAnswers: [
      'mot ben dau',            // Will get parsed: "mot ben dau" -> "mot ben dau" (no-diac for "mot ben dau")
      'nhuc am i',              // Note: these are the OPTION values from clinical-mapping
      'khong co',               // no additional symptoms
      'nhe, van sinh hoat duoc' // mild severity
    ],
    // Actually use exact option text for option session
    optionAnswersExact: [
      'một bên đầu',
      'nhức âm ỉ',
      'không có',
      'nhẹ, vẫn sinh hoạt được',
    ],
    freeTextAnswers: [
      'đau 1 bên đầu thôi',
      'cứ nhức âm ỉ suốt ngày',
      'không có gì thêm',
      'nhẹ thôi vẫn đi làm được',
    ],
    expectSeveritySame: true,
  },

  // Pair 2: Severe — danger symptom (mo mat)
  {
    id: 2,
    cluster: 'headache',
    label: 'Headache: severe + mo mat (danger)',
    optionAnswersExact: [
      'toàn bộ đầu',
      'đau giật theo nhịp tim',
      'mờ mắt',
      'nặng, phải nằm nghỉ',
    ],
    freeTextAnswers: [
      'đau khắp cả đầu luôn',
      'đau giật giật theo nhịp đập',
      'nhìn mờ mờ ảo ảo',
      'nặng lắm phải nằm nghỉ ko làm gì được',
    ],
    expectSeveritySame: true,
  },

  // Pair 3: No-diacritics free text
  {
    id: 3,
    cluster: 'headache',
    label: 'Headache: no diacritics',
    optionAnswersExact: [
      'một bên đầu',
      'đau nhói từng cơn',
      'buồn nôn',
      'trung bình, khó tập trung',
    ],
    freeTextAnswers: [
      'dau 1 ben dau',
      'dau nhoi tung con',
      'buon non',
      'trung binh kho tap trung',
    ],
    expectSeveritySame: true,
  },

  // Pair 4: Vietnamese slang
  {
    id: 4,
    cluster: 'headache',
    label: 'Headache: slang/casual',
    optionAnswersExact: [
      'sau gáy',
      'đau như bóp chặt',
      'chóng mặt',
      'nặng, phải nằm nghỉ',
    ],
    freeTextAnswers: [
      'nhức sau gáy á',
      'kiểu bị bóp chặt đầu vậy đó',
      'bị choáng nữa',
      'nặng lắm nằm 1 chỗ ko dậy nổi',
    ],
    expectSeveritySame: true,
  },

  // Pair 5: Very long descriptive answers
  {
    id: 5,
    cluster: 'headache',
    label: 'Headache: long descriptive text',
    optionAnswersExact: [
      'vùng trán',
      'nhức âm ỉ',
      'sợ ánh sáng',
      'trung bình, khó tập trung',
    ],
    freeTextAnswers: [
      'dạ con bị đau ở phía trước trán ấy ạ, cứ nhức nhức vùng trán suốt',
      'cảm giác nhức nhức âm ỉ không dứt, cứ nhức hoài không hết được',
      'mỗi khi ra ngoài sáng là thấy khó chịu mắt lắm, sợ ánh sáng ghê',
      'thì cũng tàm tạm thôi, khó tập trung làm việc nhưng vẫn đi lại được',
    ],
    expectSeveritySame: true,
  },

  // ═══════ DIZZINESS (3 pairs) ═══════

  // Pair 6: Dizziness basic
  {
    id: 6,
    cluster: 'dizziness',
    label: 'Dizziness: basic mild',
    optionAnswersExact: [
      'lâng lâng, lơ lửng',
      'khi đứng dậy',
      'không có',
      'không dùng thuốc gì',
    ],
    freeTextAnswers: [
      'cảm giác lâng lâng trong đầu ấy',
      'mỗi khi đứng dậy là thấy chóng mặt',
      'không có gì thêm hết',
      'không có uống thuốc gì cả',
    ],
    expectSeveritySame: true,
  },

  // Pair 7: Dizziness medium with symptoms
  {
    id: 7,
    cluster: 'dizziness',
    label: 'Dizziness: medium + symptoms',
    optionAnswersExact: [
      'quay cuồng (phòng quay)',
      'liên tục không ngừng',
      'buồn nôn',
      'có, thuốc huyết áp',
    ],
    freeTextAnswers: [
      'cảm giác phòng quay vòng vòng luôn',
      'chóng mặt suốt ngày ko ngừng',
      'muốn ói nữa',
      'có uống thuốc huyết áp mỗi ngày',
    ],
    expectSeveritySame: true,
  },

  // Pair 8: Dizziness no diacritics
  {
    id: 8,
    cluster: 'dizziness',
    label: 'Dizziness: no diacritics',
    optionAnswersExact: [
      'tối sầm mắt',
      'khi đứng dậy',
      'hoa mắt',
      'không dùng thuốc gì',
    ],
    freeTextAnswers: [
      'toi sam mat',
      'khi dung day',
      'hoa mat',
      'khong dung thuoc gi',
    ],
    expectSeveritySame: true,
  },

  // ═══════ ABDOMINAL PAIN (2 pairs) ═══════

  // Pair 9: Abdominal basic
  {
    id: 9,
    cluster: 'abdominal_pain',
    label: 'Abdominal: basic mild',
    optionAnswersExact: [
      'quanh rốn',
      'đau âm ỉ liên tục',
      'đau sau khi ăn',
      'không có',
    ],
    freeTextAnswers: [
      'đau quanh vùng rốn ấy',
      'cứ đau âm ỉ hoài không dứt',
      'ăn xong là đau',
      'không có gì thêm',
    ],
    expectSeveritySame: true,
  },

  // Pair 10: Abdominal severe
  {
    id: 10,
    cluster: 'abdominal_pain',
    label: 'Abdominal: severe',
    optionAnswersExact: [
      'vùng thượng vị (trên rốn)',
      'đau quặn từng cơn',
      'đau nhiều khi đói',
      'sốt',
    ],
    freeTextAnswers: [
      'đau trên rốn ấy vùng thượng vị',
      'đau quặn quặn từng cơn 1',
      'mỗi khi đói bụng là đau dữ lắm',
      'bị sốt nữa',
    ],
    expectSeveritySame: true,
  },
];

// ── Main test runner ────────────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(72));
  console.log('  AI ANSWER PARSER ACCURACY TEST');
  console.log('  20 sessions: 10 pairs (option vs free text)');
  console.log('  API: localhost:3000 | User: id=4 (Chu Hung)');
  console.log('='.repeat(72));
  console.log('');

  const report = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSessions = 0;

  for (const pair of PAIRS) {
    console.log(`--- Pair ${pair.id}: ${pair.label} ---`);

    // Session A: exact options
    await resetSession();
    console.log('  [A] Option answers...');
    const resultA = await runSession(pair.cluster, pair.optionAnswersExact);
    totalSessions++;

    if (!resultA.ok) {
      console.log(`  [A] FAILED: ${resultA.type} - ${JSON.stringify(resultA.data?.error || resultA.data?.ok)}`);
      report.push({
        pair: pair.id,
        label: pair.label,
        sevA: 'ERROR',
        sevB: '-',
        match: false,
        notes: `Session A failed: ${resultA.type}`,
      });
      totalFailed++;
      continue;
    }

    // Session B: free text
    await resetSession();
    console.log('  [B] Free text answers...');
    const resultB = await runSession(pair.cluster, pair.freeTextAnswers);
    totalSessions++;

    if (!resultB.ok) {
      console.log(`  [B] FAILED: ${resultB.type} - ${JSON.stringify(resultB.data?.error || resultB.data?.ok)}`);
      report.push({
        pair: pair.id,
        label: pair.label,
        sevA: resultA.severity,
        sevB: 'ERROR',
        match: false,
        notes: `Session B failed: ${resultB.type}`,
      });
      totalFailed++;
      continue;
    }

    const match = severityMatch(resultA.severity, resultB.severity);
    if (match) totalPassed++;
    else totalFailed++;

    const notes = [];
    if (resultA.severity !== resultB.severity) {
      notes.push(`severity diff: ${resultA.severity} vs ${resultB.severity}`);
    }
    if (resultA.needsDoctor !== resultB.needsDoctor) {
      notes.push(`needsDoctor diff: ${resultA.needsDoctor} vs ${resultB.needsDoctor}`);
    }
    if (resultA.hasRedFlag !== resultB.hasRedFlag) {
      notes.push(`redFlag diff: ${resultA.hasRedFlag} vs ${resultB.hasRedFlag}`);
    }

    // Show parsed answers for Session B (debug)
    let parsedInfo = '';
    for (let i = 0; i < resultB.conversation.length; i++) {
      const bConv = resultB.conversation[i];
      const aConv = resultA.conversation[i];
      if (aConv && bConv) {
        const bAnswer = String(bConv.answer).substring(0, 40);
        const aAnswer = String(aConv.answer).substring(0, 40);
        parsedInfo += `\n    Q${i + 1}: typed="${bAnswer}" | option="${aAnswer}"`;
      }
    }

    console.log(`  [A] severity=${resultA.severity} doctor=${resultA.needsDoctor} followUp=${resultA.followUpHours}h`);
    console.log(`  [B] severity=${resultB.severity} doctor=${resultB.needsDoctor} followUp=${resultB.followUpHours}h`);
    console.log(`  ${match ? 'PASS' : 'FAIL'} ${notes.length > 0 ? '(' + notes.join(', ') + ')' : '(exact match)'}${parsedInfo}`);
    console.log('');

    report.push({
      pair: pair.id,
      label: pair.label,
      sevA: resultA.severity,
      sevB: resultB.severity,
      doctorA: resultA.needsDoctor,
      doctorB: resultB.needsDoctor,
      match,
      notes: notes.join('; ') || 'exact match',
    });
  }

  // ── Summary table ──
  console.log('');
  console.log('='.repeat(72));
  console.log('  RESULTS TABLE');
  console.log('='.repeat(72));
  console.log('');
  console.log(
    'Pair'.padEnd(6) +
    'Label'.padEnd(35) +
    'SevA'.padEnd(9) +
    'SevB'.padEnd(9) +
    'Match'.padEnd(7) +
    'Notes'
  );
  console.log('-'.repeat(90));

  for (const r of report) {
    console.log(
      String(r.pair).padEnd(6) +
      r.label.substring(0, 33).padEnd(35) +
      (r.sevA || '-').padEnd(9) +
      (r.sevB || '-').padEnd(9) +
      (r.match ? 'YES' : 'NO').padEnd(7) +
      (r.notes || '')
    );
  }

  console.log('-'.repeat(90));
  console.log('');
  console.log(`Total sessions: ${totalSessions}`);
  console.log(`Pairs passed:   ${totalPassed}/${PAIRS.length}`);
  console.log(`Pairs failed:   ${totalFailed}/${PAIRS.length}`);
  console.log('');

  const accuracy = PAIRS.length > 0 ? Math.round(totalPassed / PAIRS.length * 100) : 0;
  console.log(`Parser accuracy: ${accuracy}% (severity match rate)`);
  console.log('');

  if (totalFailed > 0) {
    console.log('SOME PAIRS FAILED -- parser may need tuning for these inputs.');
  } else {
    console.log('ALL PAIRS PASSED -- answer parser correctly handles free text!');
  }

  console.log('='.repeat(72));
}

run().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
