#!/usr/bin/env node
/**
 * Diverse Answer Test — Mô phỏng nhiều cách trả lời khác nhau
 *
 * Mỗi triệu chứng test 5 kiểu user khác nhau:
 *   1. User trả lời nhẹ nhất (chọn option đầu/thấp nhất)
 *   2. User trả lời nặng nhất (chọn option cuối/cao nhất)
 *   3. User trả lời lẫn lộn (nhẹ + nặng xen kẽ)
 *   4. User cao tuổi có bệnh nền
 *   5. User trẻ khỏe mạnh
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { createClustersFromOnboarding, getUserScript, getScript, toClusterKey } = require('../src/services/checkin/script.service');
const { getNextQuestion, validateScript } = require('../src/services/checkin/script-runner');
const { evaluateScript, evaluateFollowUp } = require('../src/services/checkin/scoring-engine');
const { getFallbackScriptData, matchCluster } = require('../src/services/checkin/fallback.service');
const { detectEmergency } = require('../src/services/checkin/emergency-detector');
const { listComplaints } = require('../src/services/checkin/clinical-mapping');

const USER_ID = 4;

const PROFILES = {
  elderly_sick: { name: 'Bà Lan (75t, 4 bệnh nền)', birth_year: 1951, gender: 'Nữ', full_name: 'Nguyễn Thị Lan', medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp', 'Suy tim', 'Loãng xương'], age: 75 },
  elderly_one: { name: 'Chú Hùng (68t, tiểu đường)', birth_year: 1958, gender: 'Nam', full_name: 'Trần Văn Hùng', medical_conditions: ['Tiểu đường'], age: 68 },
  middle_healthy: { name: 'Chị Hương (50t, huyết áp)', birth_year: 1976, gender: 'Nữ', full_name: 'Phạm Thị Hương', medical_conditions: ['Cao huyết áp'], age: 50 },
  young_healthy: { name: 'Anh Minh (30t, khỏe)', birth_year: 1996, gender: 'Nam', full_name: 'Nguyễn Văn Minh', medical_conditions: [], age: 30 },
  no_profile: { name: 'User mới (không có hồ sơ)', birth_year: null, gender: null, full_name: null, medical_conditions: [], age: null },
};

// ─── Answer strategies ─────────────────────────────────────────
function pickAnswer(question, strategy) {
  const opts = question.options || [];
  const type = question.type;

  switch (strategy) {
    case 'mildest': // Chọn nhẹ nhất
      if (type === 'slider') return question.min || 0;
      if (opts.length > 0) return opts.find(o => o.includes('không') || o.includes('nhẹ')) || opts[0];
      return 'không có gì';

    case 'worst': // Chọn nặng nhất
      if (type === 'slider') return question.max || 10;
      if (opts.length > 0) {
        // Pick last non-"không" option or option with "nặng"/"dữ dội"/"liên tục"
        const severe = opts.find(o => o.includes('nặng') || o.includes('dữ dội') || o.includes('liên tục'));
        if (severe) return severe;
        const last = opts.filter(o => !o.includes('không có') && !o.includes('không rõ'));
        return last.length > 0 ? last[last.length - 1] : opts[opts.length - 1];
      }
      return 'rất nặng';

    case 'mixed': // Xen kẽ nhẹ-nặng
      if (type === 'slider') return 5;
      if (opts.length >= 3) return opts[Math.floor(opts.length / 2)]; // middle
      return opts[0] || 'bình thường';

    case 'random': // Random realistic
      if (type === 'slider') return Math.floor(Math.random() * 10) + 1;
      if (opts.length > 0) return opts[Math.floor(Math.random() * opts.length)];
      return 'không rõ';

    case 'skip': // Chọn "không có" / "không rõ" nếu có
      if (type === 'slider') return 1;
      const skip = opts.find(o => o.includes('không có') || o.includes('không rõ') || o.includes('không'));
      return skip || opts[0] || '';

    default:
      return opts[0] || (type === 'slider' ? 5 : 'test');
  }
}

// ─── Run one session ───────────────────────────────────────────
function runSession(scriptData, profile, strategy) {
  const answers = [];
  const conversation = [];
  let step;
  let count = 0;

  do {
    step = getNextQuestion(scriptData, answers, { sessionType: 'initial', profile });
    if (!step.isDone && step.question) {
      const ans = pickAnswer(step.question, strategy);
      conversation.push({
        q: step.question.text,
        type: step.question.type,
        options: step.question.options,
        answer: ans,
      });
      answers.push({ question_id: step.question.id, answer: ans });
      count++;
    }
  } while (!step.isDone && count < 10);

  return { step, answers, conversation, count };
}

// ─── Test collector ────────────────────────────────────────────
const results = [];

function addResult(complaint, profileName, strategy, strategyLabel, conversation, conclusion) {
  results.push({ complaint, profileName, strategy, strategyLabel, conversation, conclusion });
}

// ─── Main ──────────────────────────────────────────────────────
async function run() {
  console.log('Chạy test đa dạng câu trả lời...\n');

  // Cleanup + setup
  await pool.query('DELETE FROM script_sessions WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);

  const complaints = listComplaints();
  await createClustersFromOnboarding(pool, USER_ID, complaints);

  const strategies = [
    ['mildest', 'Trả lời nhẹ nhất có thể'],
    ['worst', 'Trả lời nặng nhất có thể'],
    ['mixed', 'Trả lời lẫn lộn (giữa)'],
    ['random', 'Trả lời ngẫu nhiên'],
    ['skip', 'Chọn "không có / không rõ"'],
  ];

  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  const issues = [];

  for (const c of complaints) {
    const key = toClusterKey(c);
    const script = await getScript(pool, USER_ID, key, 'initial');
    if (!script) continue;
    const sd = script.script_data;

    for (const [profileKey, profile] of Object.entries(PROFILES)) {
      for (const [strategy, strategyLabel] of strategies) {
        const { step, conversation, count } = runSession(sd, profile, strategy);
        totalTests++;

        if (!step.isDone || !step.conclusion) {
          totalFail++;
          issues.push(`${c} + ${profile.name} + ${strategyLabel}: KHÔNG HOÀN THÀNH`);
          addResult(c, profile.name, strategy, strategyLabel, conversation, { severity: 'ERROR', error: true });
          continue;
        }

        const con = step.conclusion;

        // Safety checks
        let safe = true;
        let safetyNote = '';

        // Rule: elderly + conditions + worst answers should NOT be LOW
        if (profile.age >= 60 && (profile.medical_conditions || []).length > 0 && strategy === 'worst' && con.severity === 'low') {
          safe = false;
          safetyNote = 'NGUY HIỂM: Người cao tuổi + bệnh nền + trả lời nặng nhất nhưng xếp Nhẹ';
        }

        // Rule: worst answers for anyone should be at least MEDIUM
        if (strategy === 'worst' && con.severity === 'low') {
          safe = false;
          safetyNote = 'CẢNH BÁO: Trả lời nặng nhất nhưng vẫn xếp Nhẹ';
        }

        // Rule: mildest + young healthy should be LOW
        if (strategy === 'mildest' && profileKey === 'young_healthy' && con.severity === 'high') {
          safetyNote = 'GHI CHÚ: Người trẻ khỏe + trả lời nhẹ nhất nhưng xếp Nặng (có thể do câu hỏi)';
        }

        if (safe) totalPass++; else totalFail++;

        addResult(c, profile.name, strategy, strategyLabel, conversation, {
          severity: con.severity,
          followUpHours: con.followUpHours,
          needsDoctor: con.needsDoctor,
          needsFamilyAlert: con.needsFamilyAlert,
          summary: con.summary,
          recommendation: con.recommendation,
          safe,
          safetyNote,
        });
      }
    }
    process.stdout.write(`.`);
  }

  console.log(`\n\nTổng: ${totalTests} test | ${totalPass} đạt | ${totalFail} lỗi\n`);
  if (issues.length) {
    console.log('LỖI:');
    issues.forEach(i => console.log(`  ❌ ${i}`));
  }

  // ─── Generate HTML ───────────────────────────────────────────
  const html = generateHTML(results, totalTests, totalPass, totalFail, complaints);
  const reportPath = path.join(__dirname, '..', 'test-report.html');
  fs.writeFileSync(reportPath, html);
  console.log(`\nReport: ${reportPath}`);
  try { execSync(`open "${reportPath}"`); } catch {}

  await pool.end();
}

function generateHTML(results, totalTests, totalPass, totalFail, complaints) {
  const allPass = totalFail === 0;
  const sevVN = { low: 'Nhẹ', medium: 'Trung bình', high: 'Nặng', ERROR: 'LỖI' };
  const sevColor = { low: '#16a34a', medium: '#ca8a04', high: '#dc2626', ERROR: '#7f1d1d' };
  const sevBg = { low: '#f0fdf4', medium: '#fefce8', high: '#fef2f2', ERROR: '#fef2f2' };

  // Group results by complaint
  const byComplaint = {};
  for (const r of results) {
    if (!byComplaint[r.complaint]) byComplaint[r.complaint] = [];
    byComplaint[r.complaint].push(r);
  }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Asinu — Test đa dạng câu trả lời</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8fafc; color:#1e293b; }

  .header { background:linear-gradient(135deg,#1e40af,#7c3aed); color:white; padding:32px 20px; text-align:center; }
  .header h1 { font-size:22px; margin-bottom:4px; }
  .header .sub { opacity:0.8; font-size:13px; }
  .status { display:inline-block; margin-top:12px; padding:6px 20px; border-radius:20px; font-weight:700; font-size:14px;
    background:${allPass ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'};
    color:${allPass ? '#bbf7d0' : '#fecaca'};
    border:2px solid ${allPass ? '#4ade80' : '#f87171'}; }

  .stats { display:flex; justify-content:center; gap:12px; margin:-20px auto 20px; max-width:600px; padding:0 16px; position:relative; z-index:1; }
  .stat { background:white; border-radius:10px; padding:16px; text-align:center; flex:1; box-shadow:0 1px 4px rgba(0,0,0,0.08); }
  .stat .num { font-size:28px; font-weight:800; }
  .stat .lbl { font-size:10px; color:#64748b; text-transform:uppercase; margin-top:2px; }
  .stat.p .num { color:#16a34a; }
  .stat.f .num { color:#dc2626; }
  .stat.t .num { color:#2563eb; }

  .info { max-width:900px; margin:16px auto; padding:0 16px; }
  .info-box { background:white; border-radius:10px; padding:16px 20px; box-shadow:0 1px 3px rgba(0,0,0,0.06); font-size:13px; color:#475569; line-height:1.6; }
  .info-box b { color:#1e293b; }

  .complaint-section { max-width:900px; margin:20px auto; padding:0 16px; }
  .complaint-header { display:flex; align-items:center; gap:10px; padding:12px 16px; background:white; border-radius:10px 10px 0 0; border:1px solid #e2e8f0; cursor:pointer; }
  .complaint-header:hover { background:#f8fafc; }
  .complaint-name { font-weight:700; font-size:15px; flex:1; }
  .complaint-stats { font-size:12px; color:#64748b; }
  .complaint-arrow { color:#94a3b8; transition:transform 0.2s; }
  .complaint-section.open .complaint-arrow { transform:rotate(90deg); }

  .complaint-body { display:none; border:1px solid #e2e8f0; border-top:none; border-radius:0 0 10px 10px; overflow:hidden; }
  .complaint-section.open .complaint-body { display:block; }

  .scenario { border-bottom:1px solid #f1f5f9; }
  .scenario:last-child { border-bottom:none; }
  .scenario-header { padding:10px 16px; display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; background:white; }
  .scenario-header:hover { background:#f8fafc; }
  .scenario-profile { font-weight:600; color:#334155; min-width:180px; }
  .scenario-strategy { color:#64748b; min-width:180px; }
  .scenario-result { margin-left:auto; display:flex; gap:6px; align-items:center; }
  .sev-badge { padding:2px 10px; border-radius:4px; font-size:11px; font-weight:700; }
  .scenario-detail { display:none; padding:10px 16px 14px 32px; background:#fafbfc; font-size:12px; line-height:1.8; border-top:1px dashed #e2e8f0; }
  .scenario.open .scenario-detail { display:block; }

  .convo-line { padding:3px 0; }
  .convo-q { color:#1e40af; }
  .convo-a { color:#16a34a; margin-left:16px; }
  .convo-opts { color:#94a3b8; font-size:11px; margin-left:16px; }

  .result-box { margin-top:8px; padding:8px 12px; border-radius:6px; }
  .safety-warn { margin-top:6px; padding:6px 10px; background:#fef2f2; border-left:3px solid #dc2626; color:#991b1b; font-size:11px; border-radius:0 4px 4px 0; }

  .filter-bar { max-width:900px; margin:16px auto; padding:0 16px; display:flex; gap:8px; flex-wrap:wrap; }
  .filter-btn { padding:4px 12px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid #e2e8f0; background:white; cursor:pointer; color:#475569; }
  .filter-btn:hover { background:#f1f5f9; }
  .filter-btn.active { background:#1e40af; color:white; border-color:#1e40af; }

  .footer { text-align:center; padding:30px; color:#94a3b8; font-size:11px; margin-top:20px; border-top:1px solid #e2e8f0; }
</style>
</head>
<body>

<div class="header">
  <h1>Test đa dạng câu trả lời</h1>
  <div class="sub">Mỗi triệu chứng × 5 profile × 5 cách trả lời = ${totalTests} kịch bản</div>
  <div class="status">${allPass ? '✔ TẤT CẢ ĐẠT' : '⚠ CÓ VẤN ĐỀ'} — ${totalPass}/${totalTests}</div>
</div>

<div class="stats">
  <div class="stat t"><div class="num">${complaints.length}</div><div class="lbl">Triệu chứng</div></div>
  <div class="stat t"><div class="num">${Object.keys(PROFILES).length}</div><div class="lbl">Loại user</div></div>
  <div class="stat t"><div class="num">${totalTests}</div><div class="lbl">Kịch bản</div></div>
  <div class="stat p"><div class="num">${totalPass}</div><div class="lbl">Đạt</div></div>
  <div class="stat f"><div class="num">${totalFail}</div><div class="lbl">Lỗi</div></div>
</div>

<div class="info">
  <div class="info-box">
    <b>Cách test:</b> Mỗi triệu chứng (đau đầu, đau bụng...) được test với <b>5 loại người dùng</b> khác nhau (bà 75 tuổi 4 bệnh, chú 68 tuổi tiểu đường, chị 50 tuổi, anh 30 tuổi khỏe, user không có hồ sơ).
    Mỗi người dùng trả lời theo <b>5 cách khác nhau</b>: nhẹ nhất, nặng nhất, lẫn lộn, ngẫu nhiên, bỏ qua.
    <br><b>Click vào từng dòng</b> để xem chi tiết: câu hỏi → user trả lời gì → hệ thống chấm điểm ra sao.
  </div>
</div>

<div class="filter-bar">
  <span style="font-size:12px;color:#64748b;padding:4px 0">Lọc:</span>
  <button class="filter-btn active" onclick="filterAll()">Tất cả</button>
  <button class="filter-btn" onclick="filterBy('worst')">Chỉ nặng nhất</button>
  <button class="filter-btn" onclick="filterBy('mildest')">Chỉ nhẹ nhất</button>
  <button class="filter-btn" onclick="filterBy('elderly_sick')">Chỉ người cao tuổi</button>
  <button class="filter-btn" onclick="filterBy('young_healthy')">Chỉ người trẻ</button>
  <button class="filter-btn" onclick="filterBy('issue')">Chỉ có vấn đề</button>
</div>

${Object.entries(byComplaint).map(([complaint, items]) => {
  const passCount = items.filter(i => i.conclusion.safe !== false).length;
  const failCount = items.filter(i => i.conclusion.safe === false).length;
  const hasIssue = failCount > 0;

  return `
<div class="complaint-section${hasIssue ? ' open' : ''}" data-complaint="${complaint}">
  <div class="complaint-header" onclick="this.parentElement.classList.toggle('open')">
    <span style="font-size:18px">${hasIssue ? '⚠️' : '✅'}</span>
    <span class="complaint-name">${complaint}</span>
    <span class="complaint-stats">${passCount} đạt${failCount > 0 ? ` · <span style="color:#dc2626">${failCount} lỗi</span>` : ''} · ${items.length} kịch bản</span>
    <span class="complaint-arrow">▶</span>
  </div>
  <div class="complaint-body">
    ${items.map((item, idx) => {
      const c = item.conclusion;
      const sev = c.severity || 'low';
      return `
    <div class="scenario" data-strategy="${item.strategy}" data-profile="${Object.keys(PROFILES).find(k => PROFILES[k].name === item.profileName) || ''}" data-issue="${c.safe === false ? 'yes' : 'no'}">
      <div class="scenario-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="scenario-profile">${item.profileName}</span>
        <span class="scenario-strategy">${item.strategyLabel}</span>
        <span class="scenario-result">
          <span class="sev-badge" style="background:${sevBg[sev]};color:${sevColor[sev]}">${sevVN[sev]}</span>
          ${c.needsDoctor ? '<span style="font-size:11px">🏥</span>' : ''}
          ${c.needsFamilyAlert ? '<span style="font-size:11px">👨‍👩‍👧</span>' : ''}
          <span style="font-size:11px;color:#64748b">hẹn ${c.followUpHours || '?'}h</span>
        </span>
      </div>
      <div class="scenario-detail">
        <div style="margin-bottom:6px"><b>💬 Hội thoại:</b></div>
        ${item.conversation.map((cv, i) => `
          <div class="convo-line">
            <span class="convo-q"><b>Câu ${i+1}:</b> ${cv.q}</span>
            ${cv.options ? `<div class="convo-opts">Lựa chọn: ${cv.options.join(' | ')}</div>` : ''}
            <div class="convo-a">→ <b>${cv.answer}</b></div>
          </div>
        `).join('')}
        <div class="result-box" style="background:${sevBg[sev]};border-left:3px solid ${sevColor[sev]}">
          <b>Kết quả:</b> <span style="color:${sevColor[sev]};font-weight:700">${sevVN[sev]}</span>
          | Hẹn lại: <b>${c.followUpHours || '?'}h</b>
          | Cần bác sĩ: <b>${c.needsDoctor ? 'CÓ' : 'Không'}</b>
          | Báo gia đình: <b>${c.needsFamilyAlert ? 'CÓ' : 'Không'}</b>
          ${c.summary ? `<br><b>Tóm tắt:</b> ${c.summary}` : ''}
          ${c.recommendation ? `<br><b>Lời khuyên:</b> ${c.recommendation}` : ''}
        </div>
        ${c.safetyNote ? `<div class="safety-warn">⚠️ ${c.safetyNote}</div>` : ''}
      </div>
    </div>`;
    }).join('')}
  </div>
</div>`;
}).join('')}

<div class="footer">
  Asinu Health — Test đa dạng | ${totalTests} kịch bản | ${complaints.length} triệu chứng × ${Object.keys(PROFILES).length} profile × 5 cách trả lời
</div>

<script>
function filterAll() {
  document.querySelectorAll('.scenario').forEach(s => s.style.display = '');
  document.querySelectorAll('.complaint-section').forEach(s => s.style.display = '');
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.filter-btn').classList.add('active');
}
function filterBy(key) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('.scenario').forEach(s => {
    if (key === 'issue') {
      s.style.display = s.dataset.issue === 'yes' ? '' : 'none';
    } else if (['worst','mildest','mixed','random','skip'].includes(key)) {
      s.style.display = s.dataset.strategy === key ? '' : 'none';
    } else {
      s.style.display = s.dataset.profile === key ? '' : 'none';
    }
  });
  // Hide empty complaint sections
  document.querySelectorAll('.complaint-section').forEach(cs => {
    const visible = cs.querySelectorAll('.scenario[style=""], .scenario:not([style])');
    cs.style.display = visible.length > 0 ? '' : 'none';
    if (visible.length > 0) cs.classList.add('open');
  });
}
// Auto-open sections with issues
document.querySelectorAll('.scenario[data-issue="yes"]').forEach(s => s.classList.add('open'));
</script>
</body>
</html>`;
}

run().catch(err => { console.error('CRASH:', err); pool.end(); process.exit(1); });
