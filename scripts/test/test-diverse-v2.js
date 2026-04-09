#!/usr/bin/env node
/**
 * Test đa dạng câu trả lời V2
 * - 14 triệu chứng × 5 profiles × 5 cách trả lời = 350 kịch bản
 * - Kết quả lưu JSON vào scripts/test/data/test-results.json
 * - Sinh HTML report vào scripts/test/data/test-report.html
 * - Tiêu chí đạt/không đạt chặt chẽ (an toàn y khoa)
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { createClustersFromOnboarding, getScript, toClusterKey } = require('../../src/services/checkin/script.service');
const { getNextQuestion } = require('../../src/core/checkin/script-runner');
const { evaluateFollowUp } = require('../../src/core/checkin/scoring-engine');
const { getFallbackScriptData, matchCluster } = require('../../src/services/checkin/fallback.service');
const { detectEmergency } = require('../../src/services/checkin/emergency-detector');
const { listComplaints } = require('../../src/services/checkin/clinical-mapping');

const USER_ID = 4;
const DATA_DIR = path.join(__dirname, './data');

// ─── Profiles ──────────────────────────────────────────────────
const PROFILES = {
  elderly_sick: {
    key: 'elderly_sick',
    name: 'Bà Lan', age: 75, desc: '75 tuổi, 4 bệnh nền',
    birth_year: 1951, gender: 'Nữ', full_name: 'Nguyễn Thị Lan',
    medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp', 'Suy tim', 'Loãng xương'],
  },
  elderly_diabetes: {
    key: 'elderly_diabetes',
    name: 'Chú Hùng', age: 68, desc: '68 tuổi, tiểu đường',
    birth_year: 1958, gender: 'Nam', full_name: 'Trần Văn Hùng',
    medical_conditions: ['Tiểu đường'],
  },
  middle_hypertension: {
    key: 'middle_hypertension',
    name: 'Chị Hương', age: 50, desc: '50 tuổi, huyết áp cao',
    birth_year: 1976, gender: 'Nữ', full_name: 'Phạm Thị Hương',
    medical_conditions: ['Cao huyết áp'],
  },
  young_healthy: {
    key: 'young_healthy',
    name: 'Anh Minh', age: 30, desc: '30 tuổi, khỏe mạnh',
    birth_year: 1996, gender: 'Nam', full_name: 'Nguyễn Văn Minh',
    medical_conditions: [],
  },
  no_profile: {
    key: 'no_profile',
    name: 'User mới', age: null, desc: 'Không có hồ sơ',
    birth_year: null, gender: null, full_name: null,
    medical_conditions: [],
  },
};

// ─── Answer strategies ─────────────────────────────────────────
const STRATEGIES = [
  { key: 'mildest', label: 'Nhẹ nhất', desc: 'Chọn option nhẹ nhất, slider thấp nhất' },
  { key: 'worst', label: 'Nặng nhất', desc: 'Chọn option nặng nhất, slider cao nhất' },
  { key: 'mixed', label: 'Lẫn lộn', desc: 'Chọn option giữa, slider 5' },
  { key: 'random', label: 'Ngẫu nhiên', desc: 'Random option, random slider' },
  { key: 'skip', label: 'Bỏ qua', desc: 'Chọn "không có", "không rõ", slider thấp' },
];

function pickAnswer(question, strategy) {
  const opts = question.options || [];
  switch (strategy) {
    case 'mildest':
      if (question.type === 'slider') return question.min || 0;
      return opts.find(o => o.includes('không') || o.includes('nhẹ')) || opts[0] || 'không có';
    case 'worst':
      if (question.type === 'slider') return question.max || 10;
      if (opts.length > 0) {
        const severe = opts.find(o => o.includes('nặng') || o.includes('dữ dội') || o.includes('liên tục'));
        if (severe) return severe;
        const last = opts.filter(o => !o.includes('không có') && !o.includes('không rõ'));
        return last.length > 0 ? last[last.length - 1] : opts[opts.length - 1];
      }
      return 'rất nặng';
    case 'mixed':
      if (question.type === 'slider') return 5;
      return opts.length >= 3 ? opts[Math.floor(opts.length / 2)] : opts[0] || 'bình thường';
    case 'random':
      if (question.type === 'slider') return Math.floor(Math.random() * 10) + 1;
      return opts.length > 0 ? opts[Math.floor(Math.random() * opts.length)] : 'không rõ';
    case 'skip':
      if (question.type === 'slider') return 1;
      return opts.find(o => o.includes('không có') || o.includes('không rõ') || o.includes('không')) || opts[0] || '';
    default:
      return opts[0] || 5;
  }
}

// ─── Run session ───────────────────────────────────────────────
function runSession(scriptData, profile, strategy) {
  const answers = [];
  const conversation = [];
  let step, count = 0;

  do {
    step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
    if (!step.isDone && step.question) {
      const ans = pickAnswer(step.question, strategy);
      conversation.push({
        question: step.question.text,
        type: step.question.type,
        options: step.question.options || null,
        answer: ans,
      });
      answers.push({ question_id: step.question.id, answer: ans });
      count++;
    }
  } while (!step.isDone && count < 10);

  return { step, answers, conversation, questionCount: count };
}

// ─── Safety criteria ───────────────────────────────────────────
function evaluateSafety(result, profileKey, strategyKey) {
  const c = result.conclusion;
  if (!c) return { pass: false, reason: 'Không có kết luận' };

  const issues = [];
  const profile = PROFILES[profileKey];
  const isElderly = profile.age && profile.age >= 60;
  const hasConditions = (profile.medical_conditions || []).length > 0;

  // Rule 1: severity=high → needsDoctor PHẢI = true
  if (c.severity === 'high' && !c.needsDoctor) {
    issues.push('Mức Nặng nhưng không khuyên đi bác sĩ');
  }

  // Rule 2: severity=high → followUpHours <= 1
  if (c.severity === 'high' && c.followUpHours > 1) {
    issues.push(`Mức Nặng nhưng hẹn lại ${c.followUpHours}h (phải <= 1h)`);
  }

  // Rule 3: severity=medium → followUpHours <= 3
  if (c.severity === 'medium' && c.followUpHours > 3) {
    issues.push(`Mức Trung bình nhưng hẹn lại ${c.followUpHours}h (phải <= 3h)`);
  }

  // Rule 4: Người cao tuổi + bệnh nền → KHÔNG BAO GIỜ severity=low
  if (isElderly && hasConditions && c.severity === 'low') {
    issues.push('Người cao tuổi + bệnh nền nhưng xếp Nhẹ (nguy hiểm)');
  }

  // Rule 5: Trả lời nặng nhất → ít nhất MEDIUM
  if (strategyKey === 'worst' && c.severity === 'low') {
    issues.push('Trả lời nặng nhất nhưng vẫn xếp Nhẹ');
  }

  // Rule 6: Kết luận phải có nội dung
  if (!c.summary || c.summary.length < 5) {
    issues.push('Thiếu tóm tắt kết luận');
  }
  if (!c.recommendation || c.recommendation.length < 5) {
    issues.push('Thiếu lời khuyên');
  }

  return {
    pass: issues.length === 0,
    issues,
    severity: c.severity,
    followUpHours: c.followUpHours,
    needsDoctor: c.needsDoctor,
    needsFamilyAlert: c.needsFamilyAlert,
  };
}

// ─── Follow-up test ────────────────────────────────────────────
function testFollowUp(scriptData, previousSeverity) {
  const results = [];
  const cases = [
    { answers: [{ question_id: 'fu1', answer: 'Đỡ hơn' }, { question_id: 'fu2', answer: 'Không' }], label: 'Đỡ hơn + không triệu chứng mới', expectLow: true },
    { answers: [{ question_id: 'fu1', answer: 'Nặng hơn' }, { question_id: 'fu2', answer: 'Có' }], label: 'Nặng hơn + có triệu chứng mới', expectHigh: true },
    { answers: [{ question_id: 'fu1', answer: 'Vẫn vậy' }, { question_id: 'fu2', answer: 'Không' }], label: 'Vẫn vậy + không mới', expectSame: true },
  ];

  for (const tc of cases) {
    const r = evaluateFollowUp(scriptData, tc.answers, previousSeverity);
    let pass = true;
    let issue = '';
    if (tc.expectLow && r.severity !== 'low') { pass = false; issue = `Mong đợi Nhẹ, được ${r.severity}`; }
    if (tc.expectHigh && r.severity !== 'high') { pass = false; issue = `Mong đợi Nặng, được ${r.severity}`; }
    results.push({ label: tc.label, severity: r.severity, action: r.action, needsDoctor: r.needsDoctor, pass, issue });
  }
  return results;
}

// ─── Main ──────────────────────────────────────────────────────
async function run() {
  console.log('Đang chạy test đa dạng câu trả lời...\n');

  // Cleanup + setup
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);

  const complaints = listComplaints();
  await createClustersFromOnboarding(pool, USER_ID, complaints);

  const allResults = [];
  let totalPass = 0, totalFail = 0;

  for (const complaint of complaints) {
    const key = toClusterKey(complaint);
    const script = await getScript(pool, USER_ID, key, 'initial');
    if (!script) continue;
    const sd = script.script_data;

    const complaintResults = {
      complaint,
      clusterKey: key,
      questions: sd.questions.map(q => ({
        id: q.id, text: q.text, type: q.type,
        options: q.options || null, min: q.min, max: q.max,
      })),
      scoringRules: sd.scoring_rules.length,
      scenarios: [],
      followUp: testFollowUp(sd, 'medium'),
    };

    for (const [profileKey, profile] of Object.entries(PROFILES)) {
      for (const strategy of STRATEGIES) {
        const { step, conversation, questionCount } = runSession(sd, profile, strategy.key);

        const safety = step.isDone
          ? evaluateSafety(step, profileKey, strategy.key)
          : { pass: false, issues: ['Phiên không hoàn thành'], severity: null };

        if (safety.pass) totalPass++; else totalFail++;

        complaintResults.scenarios.push({
          profile: { key: profileKey, name: profile.name, desc: profile.desc },
          strategy: { key: strategy.key, label: strategy.label },
          questionCount,
          conversation,
          result: {
            pass: safety.pass,
            issues: safety.issues,
            severity: safety.severity,
            followUpHours: safety.followUpHours,
            needsDoctor: safety.needsDoctor,
            needsFamilyAlert: safety.needsFamilyAlert,
            summary: step.conclusion?.summary || '',
            recommendation: step.conclusion?.recommendation || '',
            closeMessage: step.conclusion?.closeMessage || '',
          },
        });
      }
    }

    allResults.push(complaintResults);
    process.stdout.write('.');
  }

  // ─── Emergency tests ───────────────────────────────────────
  const emergencyTests = [
    { input: ['đau ngực', 'khó thở'], expected: true, label: 'Đau ngực + khó thở → Nhồi máu cơ tim' },
    { input: ['yếu nửa người'], expected: true, label: 'Yếu nửa người → Đột quỵ' },
    { input: ['co giật'], expected: true, label: 'Co giật → Động kinh' },
    { input: ['sốt cao', 'cứng cổ'], expected: true, label: 'Sốt + cứng cổ → Viêm màng não' },
    { input: ['nôn ra máu'], expected: true, label: 'Nôn ra máu → Xuất huyết tiêu hóa' },
    { input: ['hơi mệt'], expected: false, label: '"Hơi mệt" → Không phải cấp cứu' },
    { input: ['đau đầu nhẹ'], expected: false, label: '"Đau đầu nhẹ" → Không phải cấp cứu' },
    { input: ['không đau ngực'], expected: false, label: '"Không đau ngực" (phủ định) → An toàn' },
  ];
  const emergencyResults = emergencyTests.map(t => {
    const r = detectEmergency(t.input, PROFILES.elderly_sick);
    return { ...t, actual: r.isEmergency, type: r.type || null, pass: r.isEmergency === t.expected };
  });
  emergencyResults.forEach(r => { if (r.pass) totalPass++; else totalFail++; });

  // ─── Fallback tests ────────────────────────────────────────
  const fallbackTests = ['đau răng', 'ngứa da', 'đau vai phải', 'ợ nóng sau ăn', 'mắt mờ đột ngột'];
  const fallbackResults = [];
  for (const symptom of fallbackTests) {
    const match = await matchCluster(pool, USER_ID, symptom);
    const fbScript = getFallbackScriptData();
    const { step } = runSession(fbScript, PROFILES.elderly_sick, 'mixed');
    fallbackResults.push({
      symptom,
      matched: match.matched,
      matchedCluster: match.cluster?.cluster_key || null,
      fallbackCompleted: step.isDone,
      severity: step.conclusion?.severity || null,
      pass: step.isDone,
    });
    if (step.isDone) totalPass++; else totalFail++;
  }

  // ─── Save JSON ─────────────────────────────────────────────
  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalScenarios: totalPass + totalFail,
      passed: totalPass,
      failed: totalFail,
      passRate: ((totalPass / (totalPass + totalFail)) * 100).toFixed(1) + '%',
      complaints: complaints.length,
      profiles: Object.keys(PROFILES).length,
      strategies: STRATEGIES.length,
    },
    complaints: allResults,
    emergency: emergencyResults,
    fallback: fallbackResults,
  };

  const jsonPath = path.join(DATA_DIR, 'test-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(`\n\nJSON: ${jsonPath}`);

  // ─── Generate HTML ─────────────────────────────────────────
  const html = generateHTML(output);
  const htmlPath = path.join(DATA_DIR, 'test-report.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`HTML: ${htmlPath}`);

  console.log(`\nTổng: ${totalPass + totalFail} | Đạt: ${totalPass} | Lỗi: ${totalFail} | Tỉ lệ: ${output.summary.passRate}`);

  try { execSync(`open "${htmlPath}"`); } catch {}
  await pool.end();
}

// ─── HTML Generator ──────────────────────────────────────────
function generateHTML(data) {
  const s = data.summary;
  const allPass = s.failed === 0;
  const sevVN = { low: 'Nhẹ', medium: 'Trung bình', high: 'Nặng', critical: 'Nguy kịch' };
  const sevColor = { low: '#16a34a', medium: '#ca8a04', high: '#dc2626', critical: '#7f1d1d' };
  const sevBg = { low: '#f0fdf4', medium: '#fefce8', high: '#fef2f2', critical: '#fef2f2' };

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Asinu — Báo cáo kiểm thử đa dạng câu trả lời</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8fafc; color:#1e293b; font-size:13px; }

  .header { background:linear-gradient(135deg,#1e40af,#7c3aed); color:white; padding:32px 20px; text-align:center; }
  .header h1 { font-size:22px; margin-bottom:4px; }
  .header .sub { opacity:0.8; font-size:13px; }
  .status { display:inline-block; margin-top:12px; padding:6px 20px; border-radius:20px; font-weight:700; font-size:14px;
    background:${allPass ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'};
    color:${allPass ? '#bbf7d0' : '#fecaca'};
    border:2px solid ${allPass ? '#4ade80' : '#f87171'}; }

  .stats { display:flex; justify-content:center; gap:12px; margin:-20px auto 20px; max-width:700px; padding:0 16px; position:relative; z-index:1; flex-wrap:wrap; }
  .stat { background:white; border-radius:10px; padding:14px 18px; text-align:center; flex:1; min-width:100px; box-shadow:0 1px 4px rgba(0,0,0,0.08); }
  .stat .num { font-size:24px; font-weight:800; }
  .stat .lbl { font-size:10px; color:#64748b; text-transform:uppercase; margin-top:2px; }
  .stat.p .num { color:#16a34a; } .stat.f .num { color:#dc2626; } .stat.t .num { color:#2563eb; }

  .criteria { max-width:900px; margin:16px auto; padding:0 16px; }
  .criteria-box { background:white; border-radius:10px; padding:16px 20px; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .criteria-box h3 { font-size:14px; font-weight:700; margin-bottom:8px; }
  .criteria-list { list-style:none; padding:0; }
  .criteria-list li { padding:4px 0; font-size:12px; color:#475569; }
  .criteria-list li::before { content:'✓ '; color:#16a34a; font-weight:700; }

  .section { max-width:900px; margin:20px auto; padding:0 16px; }
  .section-title { font-size:16px; font-weight:700; margin-bottom:12px; color:#334155; display:flex; align-items:center; gap:8px; }

  .complaint { background:white; border-radius:10px; margin-bottom:10px; border:1px solid #e2e8f0; overflow:hidden; }
  .complaint-header { padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:10px; }
  .complaint-header:hover { background:#f8fafc; }
  .complaint-name { font-weight:700; font-size:14px; flex:1; }
  .complaint-stats { font-size:11px; color:#64748b; }
  .pill { padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600; display:inline-block; }
  .pill.green { background:#dcfce7; color:#166534; } .pill.red { background:#fee2e2; color:#991b1b; }
  .pill.blue { background:#dbeafe; color:#1e40af; } .pill.yellow { background:#fef9c3; color:#854d0e; }
  .arrow { color:#94a3b8; transition:transform 0.2s; font-size:11px; }
  .complaint.open .arrow { transform:rotate(90deg); }
  .complaint-body { display:none; border-top:1px solid #f1f5f9; }
  .complaint.open .complaint-body { display:block; }

  .questions-preview { padding:10px 16px; background:#f8fafc; border-bottom:1px solid #f1f5f9; font-size:11px; color:#64748b; }
  .questions-preview b { color:#334155; }

  .scenario { border-bottom:1px solid #f1f5f9; }
  .scenario:last-child { border-bottom:none; }
  .scenario-row { padding:8px 16px; display:flex; align-items:center; gap:8px; cursor:pointer; }
  .scenario-row:hover { background:#f8fafc; }
  .scenario-icon { font-size:14px; width:20px; text-align:center; }
  .scenario-profile { min-width:120px; font-weight:600; font-size:12px; }
  .scenario-strategy { min-width:100px; color:#64748b; font-size:11px; }
  .scenario-result { margin-left:auto; display:flex; gap:6px; align-items:center; }
  .sev { padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; }

  .scenario-detail { display:none; padding:10px 16px 14px 48px; background:#fafbfc; border-top:1px dashed #e2e8f0; font-size:12px; line-height:1.8; }
  .scenario.open .scenario-detail { display:block; }
  .convo-q { color:#1e40af; } .convo-a { color:#16a34a; margin-left:12px; }
  .convo-opts { color:#94a3b8; font-size:10px; margin-left:12px; }
  .result-box { margin-top:8px; padding:8px 12px; border-radius:6px; }
  .issue-box { margin-top:4px; padding:4px 10px; background:#fef2f2; border-left:3px solid #dc2626; color:#991b1b; font-size:11px; border-radius:0 4px 4px 0; }

  .followup-section { padding:10px 16px; background:#faf5ff; border-top:1px solid #f1f5f9; }
  .followup-row { padding:4px 0; font-size:12px; display:flex; gap:8px; align-items:center; }

  .emergency-section, .fallback-section { background:white; border-radius:10px; border:1px solid #e2e8f0; overflow:hidden; margin-bottom:10px; }
  .em-row, .fb-row { padding:8px 16px; display:flex; align-items:center; gap:8px; border-bottom:1px solid #f1f5f9; font-size:12px; }
  .em-row:last-child, .fb-row:last-child { border-bottom:none; }

  .footer { text-align:center; padding:30px; color:#94a3b8; font-size:11px; margin-top:20px; border-top:1px solid #e2e8f0; }

  @media(max-width:640px) { .scenario-strategy { display:none; } .stat { min-width:70px; padding:10px; } .stat .num { font-size:18px; } }
</style>
</head>
<body>

<div class="header">
  <h1>Báo cáo kiểm thử đa dạng câu trả lời</h1>
  <div class="sub">${s.complaints} triệu chứng × ${s.profiles} hồ sơ × ${s.strategies} cách trả lời + cấp cứu + fallback</div>
  <div class="status">${allPass ? '✔ TẤT CẢ ĐẠT' : '⚠ CÓ VẤN ĐỀ'} — ${s.passed}/${s.totalScenarios} (${s.passRate})</div>
</div>

<div class="stats">
  <div class="stat t"><div class="num">${s.totalScenarios}</div><div class="lbl">Kịch bản</div></div>
  <div class="stat p"><div class="num">${s.passed}</div><div class="lbl">Đạt</div></div>
  <div class="stat f"><div class="num">${s.failed}</div><div class="lbl">Lỗi</div></div>
  <div class="stat t"><div class="num">${s.complaints}</div><div class="lbl">Triệu chứng</div></div>
  <div class="stat t"><div class="num">${s.profiles}</div><div class="lbl">Loại user</div></div>
</div>

<div class="criteria">
  <div class="criteria-box">
    <h3>Tiêu chí đạt/không đạt (an toàn y khoa)</h3>
    <ul class="criteria-list">
      <li>Mức <b>Nặng</b> → bắt buộc khuyên đi bác sĩ (<code>needsDoctor=true</code>)</li>
      <li>Mức <b>Nặng</b> → hẹn lại tối đa 1 giờ</li>
      <li>Mức <b>Trung bình</b> → hẹn lại tối đa 3 giờ</li>
      <li>Người cao tuổi (≥60) + bệnh nền → <b>không bao giờ</b> được xếp Nhẹ</li>
      <li>Trả lời nặng nhất → ít nhất Trung bình</li>
      <li>Kết luận phải có tóm tắt + lời khuyên (không được trống)</li>
    </ul>
  </div>
</div>

<div class="section">
  <div class="section-title">📋 ${s.complaints} triệu chứng × ${s.profiles * s.strategies} kịch bản mỗi triệu chứng</div>

${data.complaints.map(comp => {
  const passCount = comp.scenarios.filter(s => s.result.pass).length;
  const failCount = comp.scenarios.filter(s => !s.result.pass).length;
  const hasIssue = failCount > 0;
  return `
  <div class="complaint${hasIssue ? ' open' : ''}">
    <div class="complaint-header" onclick="this.parentElement.classList.toggle('open')">
      <span style="font-size:16px">${hasIssue ? '⚠️' : '✅'}</span>
      <span class="complaint-name">${comp.complaint}</span>
      <span class="complaint-stats">
        ${comp.questions.length} câu hỏi · ${comp.scoringRules} luật ·
        <span class="pill green">${passCount} đạt</span>
        ${failCount > 0 ? `<span class="pill red">${failCount} lỗi</span>` : ''}
      </span>
      <span class="arrow">▶</span>
    </div>
    <div class="complaint-body">
      <div class="questions-preview">
        <b>Câu hỏi trong kịch bản:</b><br>
        ${comp.questions.map((q, i) => `${i + 1}. "${q.text}" <span class="pill blue">${q.type === 'slider' ? `Thang ${q.min}-${q.max}` : q.type === 'single_choice' ? 'Chọn 1' : q.type === 'multi_choice' ? 'Chọn nhiều' : 'Nhập tự do'}</span>`).join('<br>')}
      </div>

      ${comp.scenarios.map(sc => {
        const sev = sc.result.severity || 'low';
        return `
      <div class="scenario${!sc.result.pass ? ' open' : ''}">
        <div class="scenario-row" onclick="this.parentElement.classList.toggle('open')">
          <span class="scenario-icon">${sc.result.pass ? '✅' : '❌'}</span>
          <span class="scenario-profile">${sc.profile.name} <span style="color:#94a3b8;font-weight:400">(${sc.profile.desc})</span></span>
          <span class="scenario-strategy">${sc.strategy.label}</span>
          <span class="scenario-result">
            <span class="sev" style="background:${sevBg[sev]};color:${sevColor[sev]}">${sevVN[sev] || sev}</span>
            ${sc.result.needsDoctor ? '<span title="Cần bác sĩ">🏥</span>' : ''}
            ${sc.result.needsFamilyAlert ? '<span title="Báo gia đình">👨‍👩‍👧</span>' : ''}
            <span style="color:#94a3b8;font-size:10px">hẹn ${sc.result.followUpHours || '?'}h</span>
          </span>
        </div>
        <div class="scenario-detail">
          <div style="margin-bottom:4px"><b>💬 Hội thoại (${sc.questionCount} câu):</b></div>
          ${sc.conversation.map((cv, i) => `
            <div>
              <span class="convo-q"><b>Câu ${i + 1}:</b> ${cv.question}</span>
              ${cv.options ? `<div class="convo-opts">Lựa chọn: ${cv.options.join(' | ')}</div>` : ''}
              <div class="convo-a">→ <b>${cv.answer}</b></div>
            </div>
          `).join('')}
          <div class="result-box" style="background:${sevBg[sev]};border-left:3px solid ${sevColor[sev]}">
            <b>Kết quả:</b> <span style="color:${sevColor[sev]};font-weight:700">${sevVN[sev] || sev}</span>
            | Hẹn lại: <b>${sc.result.followUpHours || '?'}h</b>
            | Cần bác sĩ: <b>${sc.result.needsDoctor ? 'CÓ' : 'Không'}</b>
            | Báo gia đình: <b>${sc.result.needsFamilyAlert ? 'CÓ' : 'Không'}</b>
            ${sc.result.summary ? `<br><b>Tóm tắt:</b> ${sc.result.summary}` : ''}
            ${sc.result.recommendation ? `<br><b>Lời khuyên:</b> ${sc.result.recommendation}` : ''}
          </div>
          ${sc.result.issues.length > 0 ? sc.result.issues.map(i => `<div class="issue-box">⚠️ ${i}</div>`).join('') : ''}
        </div>
      </div>`;
      }).join('')}

      <div class="followup-section">
        <b>🔄 Follow-up (hỏi lại sau ${comp.scenarios[0]?.result.followUpHours || '?'}h):</b>
        ${comp.followUp.map(fu => `
          <div class="followup-row">
            <span>${fu.pass ? '✅' : '❌'}</span>
            <span>${fu.label}</span>
            <span class="sev" style="background:${sevBg[fu.severity]};color:${sevColor[fu.severity]}">${sevVN[fu.severity]}</span>
            <span style="color:#64748b">${fu.action}</span>
            ${fu.issue ? `<span style="color:#dc2626">${fu.issue}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  </div>`;
}).join('')}
</div>

<div class="section">
  <div class="section-title">🚨 Phát hiện cấp cứu (${data.emergency.length} tình huống)</div>
  <div class="emergency-section">
    ${data.emergency.map(e => `
    <div class="em-row">
      <span>${e.pass ? '✅' : '❌'}</span>
      <span style="flex:1">${e.label}</span>
      <span class="pill ${e.expected ? 'red' : 'green'}">${e.expected ? '🚨 CẤP CỨU' : '✓ An toàn'}</span>
      ${e.type ? `<span style="color:#64748b;font-size:10px">${e.type}</span>` : ''}
    </div>`).join('')}
  </div>
</div>

<div class="section">
  <div class="section-title">❓ Triệu chứng lạ — Fallback (${data.fallback.length} tình huống)</div>
  <div class="fallback-section">
    ${data.fallback.map(f => `
    <div class="fb-row">
      <span>${f.pass ? '✅' : '❌'}</span>
      <span style="flex:1">"${f.symptom}"</span>
      <span class="pill ${f.matched ? 'blue' : 'yellow'}">${f.matched ? `Tìm thấy: ${f.matchedCluster}` : 'Không tìm thấy → Fallback'}</span>
      ${f.severity ? `<span class="sev" style="background:${sevBg[f.severity]};color:${sevColor[f.severity]}">${sevVN[f.severity]}</span>` : ''}
    </div>`).join('')}
  </div>
</div>

<div class="footer">
  Asinu Health — Báo cáo tự động | ${new Date().toLocaleString('vi-VN')}<br>
  ${s.totalScenarios} kịch bản | ${s.complaints} triệu chứng | 0 AI call
</div>

<script>
document.querySelectorAll('.complaint').forEach(c => {
  if (c.querySelector('.scenario.open')) c.classList.add('open');
});
</script>
</body>
</html>`;
}

run().catch(err => { console.error('CRASH:', err); pool.end(); process.exit(1); });
