#!/usr/bin/env node
/**
 * Generate Interactive Test Page
 * Tạo HTML page để user tự test check-in trực tiếp trên browser.
 * Không cần backend — tất cả logic chạy bằng JS trong browser.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { createClustersFromOnboarding, getScript, toClusterKey } = require('../../src/services/checkin/script.service');
const { listComplaints } = require('../../src/services/checkin/clinical-mapping');
const { getFallbackScriptData } = require('../../src/services/checkin/fallback.service');

const USER_ID = 4;
const DATA_DIR = path.join(__dirname, 'data');

async function run() {
  console.log('Generating interactive test page...');

  // Ensure clusters exist
  await pool.query('DELETE FROM triage_scripts WHERE user_id=$1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id=$1', [USER_ID]);
  await createClustersFromOnboarding(pool, USER_ID, listComplaints());

  // Collect all scripts
  const complaints = listComplaints();
  const scripts = {};
  for (const c of complaints) {
    const key = toClusterKey(c);
    const script = await getScript(pool, USER_ID, key, 'initial');
    if (script) {
      scripts[key] = {
        displayName: c,
        clusterKey: key,
        scriptData: script.script_data,
      };
    }
  }

  const fallbackScript = getFallbackScriptData();

  // Emergency keywords (simplified for browser)
  const emergencyKeywords = [
    { words: ['đau ngực', 'khó thở'], type: 'Nhồi máu cơ tim', action: '🚨 GỌI 115 NGAY' },
    { words: ['yếu nửa người'], type: 'Đột quỵ', action: '🚨 GỌI 115 NGAY' },
    { words: ['nói ngọng'], type: 'Đột quỵ', action: '🚨 GỌI 115 NGAY' },
    { words: ['co giật'], type: 'Co giật', action: '🚨 GỌI 115' },
    { words: ['nôn ra máu'], type: 'Xuất huyết', action: '🚨 ĐẾN BỆNH VIỆN' },
    { words: ['sốt cao', 'cứng cổ'], type: 'Viêm màng não', action: '🚨 ĐẾN BỆNH VIỆN' },
  ];

  // Combo patterns (simplified)
  const comboPatterns = [
    { id: 'stroke', name: 'Nghi đột quỵ', groups: [['đau đầu','nhức đầu'],['mờ mắt','mắt mờ']], severity: 'critical' },
    { id: 'appendicitis', name: 'Nghi viêm ruột thừa', groups: [['đau bụng'],['sốt']], severity: 'high' },
    { id: 'hypertension', name: 'Cơn tăng huyết áp', groups: [['đau đầu'],['chóng mặt'],['buồn nôn']], severity: 'high' },
    { id: 'respiratory', name: 'Nhiễm trùng hô hấp', groups: [['ho'],['sốt'],['đau họng']], severity: 'medium' },
    { id: 'dehydration', name: 'Mất nước nặng', groups: [['tiêu chảy'],['nôn','buồn nôn'],['sốt']], severity: 'high' },
  ];

  const html = generateHTML(scripts, fallbackScript, emergencyKeywords, comboPatterns);
  const outPath = path.join(DATA_DIR, 'interactive-test.html');
  fs.writeFileSync(outPath, html);
  console.log('Output:', outPath);
  try { execSync(`open "${outPath}"`); } catch {}
  await pool.end();
}

function generateHTML(scripts, fallbackScript, emergencyKeywords, comboPatterns) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Asinu — Tự test Check-in</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f0f4f8; min-height:100vh; display:flex; justify-content:center; align-items:flex-start; padding:20px; }

.phone {
  width:375px; min-height:700px; background:#fff; border-radius:40px; box-shadow:0 20px 60px rgba(0,0,0,.15);
  overflow:hidden; position:relative; border:8px solid #1a1a2e;
}
.phone-notch { width:150px; height:24px; background:#1a1a2e; border-radius:0 0 16px 16px; margin:0 auto; }
.phone-screen { padding:16px; min-height:620px; display:flex; flex-direction:column; }

/* Chat area */
.chat-area { flex:1; overflow-y:auto; padding-bottom:10px; }
.msg { margin:8px 0; max-width:85%; animation:fadeUp .3s ease; }
.msg-bot { margin-right:auto; }
.msg-user { margin-left:auto; }
.msg-bubble { padding:10px 14px; border-radius:16px; font-size:13px; line-height:1.5; }
.msg-bot .msg-bubble { background:#eff6ff; color:#1e40af; border-bottom-left-radius:4px; }
.msg-user .msg-bubble { background:#f0fdf4; color:#166534; border-bottom-right-radius:4px; text-align:right; }
.msg-label { font-size:9px; color:#94a3b8; margin-bottom:2px; padding:0 4px; }
.msg-bot .msg-label { text-align:left; }
.msg-user .msg-label { text-align:right; }

/* Options */
.options { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.opt-btn { padding:8px 14px; border-radius:20px; border:1.5px solid #e2e8f0; background:#fff; cursor:pointer;
  font-size:12px; color:#334155; transition:all .15s; }
.opt-btn:hover { border-color:#3b82f6; color:#3b82f6; background:#eff6ff; }
.opt-btn.selected { background:#3b82f6; color:#fff; border-color:#3b82f6; }
.opt-btn.status-fine { border-color:#16a34a; color:#16a34a; }
.opt-btn.status-fine:hover,.opt-btn.status-fine.selected { background:#16a34a; color:#fff; }
.opt-btn.status-tired { border-color:#ca8a04; color:#ca8a04; }
.opt-btn.status-tired:hover,.opt-btn.status-tired.selected { background:#ca8a04; color:#fff; }
.opt-btn.status-very { border-color:#dc2626; color:#dc2626; }
.opt-btn.status-very:hover,.opt-btn.status-very.selected { background:#dc2626; color:#fff; }

/* Slider */
.slider-wrap { margin:8px 0; padding:10px 14px; background:#f8fafc; border-radius:12px; }
.slider-label { display:flex; justify-content:space-between; font-size:11px; color:#64748b; margin-bottom:4px; }
.slider-input { width:100%; accent-color:#3b82f6; }
.slider-value { text-align:center; font-size:24px; font-weight:800; color:#1e40af; margin-top:4px; }
.slider-submit { display:block; width:100%; margin-top:8px; padding:8px; border-radius:10px; border:none;
  background:#3b82f6; color:#fff; font-weight:600; cursor:pointer; font-size:13px; }
.slider-submit:hover { background:#2563eb; }

/* Free text */
.free-input { display:flex; gap:6px; margin:8px 0; }
.free-input input { flex:1; padding:10px 14px; border-radius:20px; border:1.5px solid #e2e8f0; font-size:12px; outline:none; }
.free-input input:focus { border-color:#3b82f6; }
.free-input button { padding:10px 16px; border-radius:20px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-size:12px; }

/* Result card */
.result-card { margin:10px 0; padding:14px; border-radius:12px; border-left:4px solid; animation:fadeUp .4s ease; }
.result-card.low { background:#f0fdf4; border-color:#16a34a; }
.result-card.medium { background:#fefce8; border-color:#ca8a04; }
.result-card.high { background:#fef2f2; border-color:#dc2626; }
.result-card.critical { background:#450a0a; border-color:#dc2626; color:#fecaca; }
.result-sev { font-weight:800; font-size:16px; }
.result-detail { font-size:11px; margin-top:6px; line-height:1.6; color:#475569; }
.result-card.critical .result-detail { color:#fca5a5; }

/* Emergency */
.emergency-card { margin:10px 0; padding:16px; background:#450a0a; border-radius:12px; color:#fecaca; text-align:center; animation:shake .5s ease; }
.emergency-card h3 { color:#f87171; font-size:18px; margin-bottom:6px; }

/* Typing */
.typing { padding:10px 18px; background:#eff6ff; border-radius:16px; display:inline-block; margin:6px 0; }
.typing span { display:inline-block; width:6px; height:6px; background:#3b82f6; border-radius:50%; margin:0 2px;
  animation:bounce .6s infinite; }
.typing span:nth-child(2) { animation-delay:.1s; }
.typing span:nth-child(3) { animation-delay:.2s; }

/* Restart */
.restart-btn { display:block; width:100%; margin-top:12px; padding:10px; border-radius:12px; border:2px solid #e2e8f0;
  background:#fff; cursor:pointer; font-size:13px; color:#64748b; font-weight:600; }
.restart-btn:hover { border-color:#3b82f6; color:#3b82f6; }

/* Side panel */
.side-panel { width:320px; margin-left:20px; }
.panel-card { background:#fff; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,.06); }
.panel-card h3 { font-size:14px; margin-bottom:8px; color:#334155; }
.panel-card .info { font-size:11px; color:#64748b; line-height:1.6; }
.log-item { padding:4px 0; font-size:11px; color:#475569; border-bottom:1px solid #f1f5f9; }
.log-item:last-child { border:none; }
.log-time { color:#94a3b8; font-size:9px; }

.wrapper { display:flex; align-items:flex-start; gap:20px; max-width:750px; }

@keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
@keyframes shake { 0%,100%{transform:translateX(0)} 10%,30%,50%,70%,90%{transform:translateX(-4px)} 20%,40%,60%,80%{transform:translateX(4px)} }

@media(max-width:768px) { .wrapper{flex-direction:column;align-items:center} .side-panel{width:100%;max-width:375px;margin:0} }
</style>
</head>
<body>

<div class="wrapper">
  <div class="phone">
    <div class="phone-notch"></div>
    <div class="phone-screen">
      <div class="chat-area" id="chatArea"></div>
    </div>
  </div>

  <div class="side-panel">
    <div class="panel-card">
      <h3>📋 Hồ sơ người dùng test</h3>
      <div class="info">
        <b>Tên:</b> Trần Văn Hùng<br>
        <b>Tuổi:</b> 68 | <b>Giới:</b> Nam<br>
        <b>Bệnh nền:</b> Tiểu đường, Cao huyết áp, Tim mạch<br>
        <b>Nhóm:</b> Cần theo dõi (monitoring)
      </div>
    </div>
    <div class="panel-card">
      <h3>🔍 Log hệ thống</h3>
      <div id="sysLog" style="max-height:300px;overflow-y:auto">
        <div class="log-item"><span class="log-time">--:--</span> Chờ bắt đầu check-in...</div>
      </div>
    </div>
    <div class="panel-card">
      <h3>📊 Kết quả scoring</h3>
      <div id="scoringLog" class="info">Chưa có kết quả</div>
    </div>
    <div class="panel-card">
      <h3>ℹ️ Hướng dẫn</h3>
      <div class="info">
        Đây là mô phỏng luồng check-in Asinu.<br>
        • Chọn trạng thái sức khỏe<br>
        • Chọn/nhập triệu chứng<br>
        • Trả lời câu hỏi<br>
        • Xem kết quả đánh giá<br><br>
        <b>Tất cả chạy offline — 0 AI call.</b>
      </div>
    </div>
  </div>
</div>

<script>
// ─── Data ────────────────────────────────────────────────
const SCRIPTS = ${JSON.stringify(scripts)};
const FALLBACK = ${JSON.stringify(fallbackScript)};
const EMERGENCIES = ${JSON.stringify(emergencyKeywords)};
const COMBOS = ${JSON.stringify(comboPatterns)};

const CLUSTER_NAMES = Object.entries(SCRIPTS).map(([k,v]) => ({ key: k, name: v.displayName }));
const sevVN = { low:'Nhẹ', medium:'Trung bình', high:'Nặng', critical:'Nguy kịch' };
const sevEmoji = { low:'🟢', medium:'🟡', high:'🔴', critical:'🚨' };

const chat = document.getElementById('chatArea');
const sysLog = document.getElementById('sysLog');
const scoringLog = document.getElementById('scoringLog');

let currentScript = null;
let currentQuestionIdx = 0;
let answers = [];
let sessionCluster = null;

// ─── Helpers ─────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  sysLog.innerHTML += '<div class="log-item"><span class="log-time">'+t+'</span> '+msg+'</div>';
  sysLog.scrollTop = sysLog.scrollHeight;
}

function addBot(html, delay) {
  return new Promise(r => {
    const typing = document.createElement('div');
    typing.className = 'msg msg-bot';
    typing.innerHTML = '<div class="msg-label">🤖 Asinu</div><div class="typing"><span></span><span></span><span></span></div>';
    chat.appendChild(typing);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => {
      typing.innerHTML = '<div class="msg-label">🤖 Asinu</div><div class="msg-bubble">'+html+'</div>';
      chat.scrollTop = chat.scrollHeight;
      r();
    }, delay || 500);
  });
}

function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.innerHTML = '<div class="msg-label">👤 Chú Hùng</div><div class="msg-bubble">'+text+'</div>';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function addOptions(opts, callback, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = 'options';
  opts.forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'opt-btn' + (extraClass ? ' '+extraClass : '');
    btn.textContent = typeof o === 'object' ? o.label : o;
    btn.onclick = () => {
      wrap.querySelectorAll('.opt-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      wrap.querySelectorAll('.opt-btn').forEach(b => { b.disabled = true; b.style.opacity='.6'; });
      btn.style.opacity = '1';
      const val = typeof o === 'object' ? o.value : o;
      addUser(typeof o === 'object' ? o.label : o);
      setTimeout(() => callback(val), 300);
    };
    wrap.appendChild(btn);
  });
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function addSlider(min, max, callback) {
  const wrap = document.createElement('div');
  wrap.className = 'slider-wrap';
  wrap.innerHTML = '<div class="slider-label"><span>'+min+' (không đau)</span><span>(rất đau) '+max+'</span></div>'
    + '<input type="range" class="slider-input" min="'+min+'" max="'+max+'" value="5">'
    + '<div class="slider-value">5</div>'
    + '<button class="slider-submit">Xác nhận</button>';
  const input = wrap.querySelector('input');
  const display = wrap.querySelector('.slider-value');
  input.oninput = () => { display.textContent = input.value; };
  wrap.querySelector('button').onclick = () => {
    const val = parseInt(input.value);
    input.disabled = true;
    wrap.querySelector('button').disabled = true;
    wrap.querySelector('button').style.opacity = '.5';
    addUser(val + '/'+max);
    setTimeout(() => callback(val), 300);
  };
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function addFreeText(callback) {
  const wrap = document.createElement('div');
  wrap.className = 'free-input';
  wrap.innerHTML = '<input type="text" placeholder="Nhập triệu chứng..."><button>Gửi</button>';
  const input = wrap.querySelector('input');
  const submit = () => {
    const val = input.value.trim();
    if (!val) return;
    input.disabled = true;
    wrap.querySelector('button').disabled = true;
    addUser(val);
    setTimeout(() => callback(val), 300);
  };
  wrap.querySelector('button').onclick = submit;
  input.onkeydown = e => { if(e.key==='Enter') submit(); };
  chat.appendChild(wrap);
  input.focus();
  chat.scrollTop = chat.scrollHeight;
}

function checkEmergency(text) {
  const lower = text.toLowerCase();
  if (lower.includes('không') || lower.includes('hết') || lower.includes('chưa')) return null;
  for (const em of EMERGENCIES) {
    if (em.words.every(w => lower.includes(w))) return em;
  }
  return null;
}

function checkCombo(symptoms) {
  const found = [];
  for (const combo of COMBOS) {
    const allMatch = combo.groups.every(g => g.some(w => symptoms.some(s => s.includes(w))));
    if (allMatch) found.push(combo);
  }
  return found;
}

function evaluate(scriptData, answers) {
  const map = {};
  answers.forEach(a => { map[a.qid] = a.value; });
  const rules = scriptData.scoring_rules || [];

  for (const rule of rules) {
    if (!rule.conditions || rule.conditions.length === 0) continue;
    const match = rule.conditions.every(c => {
      const v = map[c.field];
      if (v === undefined) return false;
      switch(c.op) {
        case 'gte': return Number(v) >= Number(c.value);
        case 'gt': return Number(v) > Number(c.value);
        case 'lt': return Number(v) < Number(c.value);
        case 'eq': return v === c.value;
        case 'contains': return String(v).includes(c.value);
        default: return false;
      }
    });
    if (match) return { severity: rule.severity, followUpHours: rule.follow_up_hours, needsDoctor: rule.needs_doctor, needsFamilyAlert: rule.needs_family_alert };
  }

  // Default + elderly modifier
  let sev = 'low', fuh = 6, nd = false, nfa = false;
  if (answers.length > 0) { sev = 'medium'; fuh = 3; } // elderly default safety
  return { severity: sev, followUpHours: fuh, needsDoctor: nd, needsFamilyAlert: nfa };
}

// ─── Flow ────────────────────────────────────────────────
async function startCheckin() {
  chat.innerHTML = '';
  answers = [];
  currentQuestionIdx = 0;
  currentScript = null;
  sessionCluster = null;
  scoringLog.innerHTML = 'Chưa có kết quả';
  sysLog.innerHTML = '';
  log('Bắt đầu phiên check-in mới');

  await addBot('Chào chú Hùng! Hôm nay chú thế nào? 💙', 600);
  log('Hiển thị 3 lựa chọn trạng thái');

  addOptions([
    { label: '😊 Tôi ổn', value: 'fine' },
    { label: '😐 Hơi mệt', value: 'tired' },
    { label: '😫 Rất mệt', value: 'very_tired' },
  ], handleStatus, 'status-fine');
}

async function handleStatus(status) {
  log('User chọn: ' + status);

  if (status === 'fine') {
    await addBot('Tốt quá! Cháu hẹn chú tối nay nhé 💙');
    log('Status=fine → không chạy script, hẹn 21:00');
    showResult({ severity:'low', followUpHours:6, needsDoctor:false, summary:'Chú khỏe, không cần theo dõi đặc biệt.', recommendation:'Nghỉ ngơi, uống đủ nước. Hẹn tối nay.' });
    addRestartButton();
    return;
  }

  await addBot('Chú đang gặp vấn đề gì? Chọn hoặc nhập triệu chứng:', 500);
  log('Hiển thị danh sách clusters + ô nhập tự do');

  // Show cluster options + free text
  const clusterOpts = CLUSTER_NAMES.slice(0, 8).map(c => c.name);
  addOptions(clusterOpts, val => handleSymptomSelect(val, status));

  await new Promise(r => setTimeout(r, 100));
  const orEl = document.createElement('div');
  orEl.style.cssText = 'text-align:center;font-size:11px;color:#94a3b8;margin:4px 0';
  orEl.textContent = '— hoặc nhập triệu chứng —';
  chat.appendChild(orEl);
  addFreeText(val => handleSymptomInput(val, status));
}

async function handleSymptomSelect(symptom, status) {
  log('User chọn cluster: ' + symptom);
  const key = Object.keys(SCRIPTS).find(k => SCRIPTS[k].displayName === symptom);
  if (key && SCRIPTS[key]) {
    sessionCluster = key;
    currentScript = SCRIPTS[key].scriptData;
    log('Loaded script: ' + key + ' (' + currentScript.questions.length + ' câu hỏi)');
    await runScript();
  } else {
    await runFallback(symptom);
  }
}

async function handleSymptomInput(input, status) {
  log('User nhập tự do: "' + input + '"');

  // Check emergency
  const em = checkEmergency(input);
  if (em) {
    log('🚨 EMERGENCY DETECTED: ' + em.type);
    showEmergency(em);
    return;
  }

  // Check combo
  const parts = input.split(/[,+]|và|kèm|với/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const combos = checkCombo(parts);
    if (combos.length > 0) {
      log('⚠️ COMBO DETECTED: ' + combos.map(c=>c.name).join(', '));
      await addBot('⚠️ <b>Cảnh báo:</b> Tổ hợp triệu chứng "' + parts.join(' + ') + '" có thể nguy hiểm: <b>' + combos[0].name + '</b>');
    }
  }

  // Try match cluster
  const lower = input.toLowerCase();
  const matched = CLUSTER_NAMES.find(c => lower.includes(c.name) || c.name.includes(lower));
  if (matched && SCRIPTS[matched.key]) {
    log('Matched cluster: ' + matched.key);
    sessionCluster = matched.key;
    currentScript = SCRIPTS[matched.key].scriptData;
    await runScript();
  } else {
    log('Không match cluster → FALLBACK');
    await runFallback(input);
  }
}

async function runFallback(symptom) {
  sessionCluster = 'fallback';
  currentScript = FALLBACK;
  log('Chạy fallback script (3 câu cơ bản)');
  await addBot('Cháu chưa có kịch bản cho "' + symptom + '", nhưng cháu sẽ hỏi thêm để đánh giá nhé.');
  await runScript();
}

async function runScript() {
  const questions = currentScript.questions || [];
  if (currentQuestionIdx >= questions.length) {
    finishScript();
    return;
  }

  const q = questions[currentQuestionIdx];
  log('Câu ' + (currentQuestionIdx+1) + '/' + questions.length + ': ' + q.text);

  await addBot(q.text, 400);

  if (q.type === 'slider') {
    addSlider(q.min || 0, q.max || 10, val => {
      answers.push({ qid: q.id, value: val, text: q.text });
      log('→ Trả lời: ' + val + '/' + (q.max||10));

      // Check emergency in answer
      const em = checkEmergency(String(val));
      if (em) { showEmergency(em); return; }

      currentQuestionIdx++;
      setTimeout(() => runScript(), 300);
    });
  } else if (q.type === 'single_choice' || q.type === 'multi_choice') {
    addOptions(q.options || [], val => {
      answers.push({ qid: q.id, value: val, text: q.text });
      log('→ Trả lời: ' + val);

      const em = checkEmergency(val);
      if (em) { showEmergency(em); return; }

      currentQuestionIdx++;
      setTimeout(() => runScript(), 300);
    });
  } else {
    addFreeText(val => {
      answers.push({ qid: q.id, value: val, text: q.text });
      log('→ Trả lời: ' + val);

      const em = checkEmergency(val);
      if (em) { showEmergency(em); return; }

      currentQuestionIdx++;
      setTimeout(() => runScript(), 300);
    });
  }
}

async function finishScript() {
  log('Script hoàn thành. Đang chấm điểm...');
  const result = evaluate(currentScript, answers);

  // Get conclusion template
  const templates = currentScript.conclusion_templates || {};
  const tpl = templates[result.severity] || {};

  result.summary = tpl.summary || 'Đã thu thập đủ thông tin.';
  result.recommendation = tpl.recommendation || 'Nghỉ ngơi, theo dõi thêm.';
  result.closeMessage = tpl.close_message || 'Cháu sẽ hỏi lại chú sau.';

  // Personalize
  result.summary = result.summary.replace(/\\{Honorific\\}/g,'Chú').replace(/\\{honorific\\}/g,'chú').replace(/\\{selfRef\\}/g,'cháu').replace(/\\{callName\\}/g,'chú Hùng').replace(/\\{CallName\\}/g,'Chú Hùng');
  result.recommendation = result.recommendation.replace(/\\{Honorific\\}/g,'Chú').replace(/\\{honorific\\}/g,'chú').replace(/\\{selfRef\\}/g,'cháu');
  result.closeMessage = result.closeMessage.replace(/\\{Honorific\\}/g,'Chú').replace(/\\{honorific\\}/g,'chú').replace(/\\{selfRef\\}/g,'cháu');

  log('Kết quả: ' + sevVN[result.severity] + ' | Hẹn ' + result.followUpHours + 'h');

  await addBot(result.summary, 500);
  await addBot(result.recommendation, 400);
  await addBot(result.closeMessage, 300);

  showResult(result);

  // Follow-up prompt
  await new Promise(r => setTimeout(r, 800));
  await addBot('--- Giả lập ' + result.followUpHours + 'h sau ---<br>So với lúc trước, chú thấy thế nào?', 600);
  log('Follow-up sau ' + result.followUpHours + 'h');
  addOptions(['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'], async (val) => {
    log('Follow-up: ' + val);
    const fuSev = val === 'Đỡ hơn' ? 'low' : val === 'Nặng hơn' ? 'high' : result.severity;
    const fuAction = val === 'Đỡ hơn' ? 'Theo dõi → hẹn tối' : val === 'Nặng hơn' ? '🚨 Cảnh báo + khuyên bác sĩ' : 'Tiếp tục follow-up';
    await addBot(sevEmoji[fuSev] + ' <b>' + sevVN[fuSev] + '</b> → ' + fuAction);
    log('Follow-up result: ' + fuSev + ' → ' + fuAction);
    showResult({ severity: fuSev, followUpHours: fuSev==='high'?1:fuSev==='low'?6:3, needsDoctor: fuSev==='high', summary: 'Follow-up: ' + val, recommendation: fuAction });
    addRestartButton();
  });
}

function showEmergency(em) {
  const el = document.createElement('div');
  el.className = 'emergency-card';
  el.innerHTML = '<h3>🚨 CẤP CỨU: ' + em.type + '</h3><div>' + em.action + '</div><div style="margin-top:8px;font-size:12px">Đã thông báo cho người thân</div>';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  log('🚨 EMERGENCY: ' + em.type + ' — ' + em.action);
  scoringLog.innerHTML = '<div style="color:#dc2626;font-weight:700">🚨 CẤP CỨU: ' + em.type + '</div><div style="font-size:11px;margin-top:4px">' + em.action + '</div>';
  addRestartButton();
}

function showResult(result) {
  const el = document.createElement('div');
  el.className = 'result-card ' + result.severity;
  el.innerHTML = '<div class="result-sev">' + sevEmoji[result.severity] + ' ' + sevVN[result.severity] + '</div>'
    + '<div class="result-detail">'
    + 'Hẹn lại: <b>' + (result.followUpHours||'?') + 'h</b> · Bác sĩ: <b>' + (result.needsDoctor?'CÓ':'Không') + '</b>'
    + (result.summary ? '<br>' + result.summary : '')
    + '</div>';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;

  scoringLog.innerHTML = '<div style="font-weight:700">' + sevEmoji[result.severity] + ' ' + sevVN[result.severity] + '</div>'
    + '<div style="font-size:11px;margin-top:4px">Hẹn: ' + (result.followUpHours||'?') + 'h | Bác sĩ: ' + (result.needsDoctor?'CÓ':'Không') + '</div>'
    + (result.recommendation ? '<div style="font-size:11px;margin-top:4px;color:#475569">' + result.recommendation + '</div>' : '');
}

function addRestartButton() {
  const btn = document.createElement('button');
  btn.className = 'restart-btn';
  btn.textContent = '🔄 Test lại từ đầu';
  btn.onclick = startCheckin;
  chat.appendChild(btn);
  chat.scrollTop = chat.scrollHeight;
}

// ─── Start ───────────────────────────────────────────────
startCheckin();
</script>
</body>
</html>`;
}

run().catch(err => { console.error('CRASH:', err); pool.end(); process.exit(1); });
