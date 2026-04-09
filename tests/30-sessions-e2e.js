/**
 * 30 Full Check-in Sessions E2E Test
 *
 * Runs 30 complete check-in sessions via REAL API (localhost:3000).
 * NO function imports -- only HTTP calls.
 */

const fs = require('fs');
const jwt = require('jsonwebtoken');

// Read JWT_SECRET directly from .env file to avoid dotenv stdout pollution
const envContent = fs.readFileSync(__dirname + '/../.env', 'utf8');
let JWT_SECRET = '';
for (const line of envContent.split('\n')) {
  const m = line.match(/^JWT_SECRET\s*=\s*(.+)/);
  if (m) { JWT_SECRET = m[1].trim(); break; }
}
const TOKEN = jwt.sign({ id: 4 }, JWT_SECRET, { expiresIn: '1d' });

const BASE = 'http://localhost:3000/api/mobile';

async function api(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(BASE + path, opts);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
}

async function resetSession() {
  return api('/checkin/reset-today', {});
}

// ─── Answer helper ─────────────────────────────────────────────────────────────
// Given a question, pick an answer:
//   - single_choice → first option (or custom text if provided)
//   - slider → 5 (or custom value)
//   - multi_choice → first option
//   - free_text → custom text or "bình thường"
function pickAnswer(question, customText) {
  if (!question) return null;
  const type = question.type;

  if (customText !== undefined && customText !== null) {
    return customText;
  }

  switch (type) {
    case 'single_choice':
      return (question.options && question.options[0]) || 'option1';
    case 'multi_choice':
      return (question.options && [question.options[0]]) || ['option1'];
    case 'slider':
      return 5;
    case 'free_text':
      return 'bình thường';
    default:
      return 'ok';
  }
}

// ─── Run a single full session ─────────────────────────────────────────────────
async function runSession(sessionNum, config) {
  const result = {
    session: sessionNum,
    cluster_or_input: config.label,
    session_id: null,
    questions_asked: 0,
    severity: null,
    needsDoctor: null,
    needsFamilyAlert: null,
    summary: '',
    recommendation: '',
    isDone: false,
    errors: [],
    pass: true,
  };

  try {
    // Reset before each session
    await resetSession();

    // Start session
    const startBody = { status: config.status || 'tired' };
    if (config.cluster_key) startBody.cluster_key = config.cluster_key;
    if (config.symptom_input) startBody.symptom_input = config.symptom_input;

    const startRes = await api('/checkin/script/start', startBody);

    if (!startRes.ok) {
      result.errors.push('START FAILED: ' + (startRes.error || JSON.stringify(startRes)));
      result.pass = false;
      return result;
    }

    if (startRes.is_emergency) {
      result.errors.push('EMERGENCY detected at start (unexpected for test)');
      result.pass = false;
      return result;
    }

    const sessionId = startRes.session_id;
    result.session_id = sessionId;

    if (!sessionId) {
      result.errors.push('No session_id returned');
      result.pass = false;
      return result;
    }

    // Answer loop
    let currentQuestion = startRes.question;
    let questionsAnswered = 0;
    const maxQuestions = 30; // safety limit

    const customAnswers = config.customAnswers || [];

    while (currentQuestion && questionsAnswered < maxQuestions) {
      const customText = customAnswers[questionsAnswered] !== undefined
        ? customAnswers[questionsAnswered]
        : null;

      const answer = pickAnswer(currentQuestion, customText);

      const ansRes = await api('/checkin/script/answer', {
        session_id: sessionId,
        question_id: currentQuestion.id,
        answer,
      });

      questionsAnswered++;

      if (!ansRes.ok) {
        result.errors.push(`ANSWER Q${questionsAnswered} FAILED: ${ansRes.error || JSON.stringify(ansRes)}`);
        result.pass = false;
        return result;
      }

      if (ansRes.is_emergency) {
        result.errors.push('EMERGENCY during answers');
        result.pass = false;
        return result;
      }

      if (ansRes.isDone) {
        result.isDone = true;
        const c = ansRes.conclusion || {};
        result.severity = c.severity;
        result.needsDoctor = c.needsDoctor;
        result.needsFamilyAlert = c.needsFamilyAlert;
        result.summary = c.summary || '';
        result.recommendation = c.recommendation || '';
        currentQuestion = null;
      } else {
        currentQuestion = ansRes.question;
      }
    }

    result.questions_asked = questionsAnswered;

    // ─── Validations ──────────────────────────────────────────────────
    if (!result.isDone) {
      result.errors.push('Session did NOT reach isDone=true');
      result.pass = false;
    }

    if (!result.severity) {
      result.errors.push('No severity');
      result.pass = false;
    }

    if (!result.summary || result.summary.trim() === '') {
      result.errors.push('Empty summary');
      result.pass = false;
    }

    if (!result.recommendation || result.recommendation.trim() === '') {
      result.errors.push('Empty recommendation');
      result.pass = false;
    }

    // needsDoctor consistency: LOW severity should NOT have needsDoctor=true
    if (result.severity === 'low' && result.needsDoctor === true) {
      result.errors.push('LOW severity but needsDoctor=true');
      result.pass = false;
    }

    // needsFamilyAlert should be false for first-time-like cases (conservative check)
    // We only flag if needsFamilyAlert is true AND severity is low
    if (result.severity === 'low' && result.needsFamilyAlert === true) {
      result.errors.push('LOW severity but needsFamilyAlert=true');
      result.pass = false;
    }

  } catch (err) {
    result.errors.push('EXCEPTION: ' + err.message);
    result.pass = false;
  }

  return result;
}

// ─── Session configurations ────────────────────────────────────────────────────

const sessions = [
  // 1-10: Known clusters with option answers (pick first option / slider=5)
  { label: 'headache', cluster_key: 'headache' },
  { label: 'abdominal_pain', cluster_key: 'abdominal_pain' },
  { label: 'dizziness', cluster_key: 'dizziness' },
  { label: 'fatigue', cluster_key: 'fatigue' },
  { label: 'chest_pain', cluster_key: 'chest_pain' },
  { label: 'dyspnea', cluster_key: 'dyspnea' },
  { label: 'fever', cluster_key: 'fever' },
  { label: 'cough', cluster_key: 'cough' },
  { label: 'nausea', cluster_key: 'nausea' },
  { label: 'insomnia', cluster_key: 'insomnia' },

  // 11-15: Known clusters with LONG TEXT answers (parser must handle)
  {
    label: 'headache+longtext',
    cluster_key: 'headache',
    customAnswers: ['đau sau gáy nặng lắm', 'nhói dữ dội', 'buồn nôn chóng mặt mờ mắt', 'nặng phải nằm'],
  },
  {
    label: 'dizziness+longtext',
    cluster_key: 'dizziness',
    customAnswers: ['quay cuồng', 'liên tục', 'buồn nôn', 'có thuốc huyết áp'],
  },
  {
    label: 'fatigue+longtext',
    cluster_key: 'fatigue',
    customAnswers: ['cả tuần rồi', 'không làm gì được', 'chóng mặt', 'ngủ không được'],
  },
  {
    label: 'abdominal_pain+longtext',
    cluster_key: 'abdominal_pain',
    customAnswers: ['đau trên rốn', 'âm ỉ cả ngày', 'đau sau ăn', 'buồn nôn'],
  },
  {
    label: 'fever+longtext',
    cluster_key: 'fever',
    customAnswers: ['39 độ', 'từ hôm qua', 'sốt liên tục', 'đau đầu sốt', 'chưa uống thuốc'],
  },

  // 16-20: Free text symptom_input
  { label: 'freetext: nhức đầu quá', symptom_input: 'nhức đầu quá' },
  { label: 'freetext: bụng đau', symptom_input: 'bụng đau' },
  { label: 'freetext: chong mat', symptom_input: 'chong mat' },
  { label: 'freetext: mệt vãi', symptom_input: 'mệt vãi' },
  { label: 'freetext: ho nhiều', symptom_input: 'ho nhiều' },

  // 21-25: New/unknown symptoms via API
  { label: 'unknown: đau gót chân', symptom_input: 'đau gót chân' },
  { label: 'unknown: ngứa da', symptom_input: 'ngứa da' },
  { label: 'unknown: ợ nóng', symptom_input: 'ợ nóng' },
  { label: 'unknown: đau tai', symptom_input: 'đau tai' },
  { label: 'unknown: tê mặt', symptom_input: 'tê mặt' },

  // 26-30: Mixed answers per session
  {
    label: 'mixed: headache (opt+text)',
    cluster_key: 'headache',
    customAnswers: [null, 'nhói dữ dội từ sáng', null, 'nặng lắm phải nằm'],
  },
  {
    label: 'mixed: chest_pain (opt+text)',
    cluster_key: 'chest_pain',
    customAnswers: ['tuc nguc', null, 'khi leo cầu thang', null],
  },
  {
    label: 'mixed: dizziness (no-diac)',
    cluster_key: 'dizziness',
    customAnswers: ['quay cuong', 'lien tuc', null, 'co thuoc huyet ap'],
  },
  {
    label: 'mixed: fatigue (opt+long)',
    cluster_key: 'fatigue',
    customAnswers: [null, 'khong lam gi duoc ca tuan roi', null, null],
  },
  {
    label: 'mixed: fever (text+opt)',
    cluster_key: 'fever',
    customAnswers: ['ba muoi chin do', null, null, 'dau dau sot', null],
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(120));
  console.log('30 FULL CHECK-IN SESSIONS E2E TEST');
  console.log('='.repeat(120));
  console.log(`Target: ${BASE}`);
  console.log(`User ID: 4, Token generated.\n`);

  // Verify server is reachable
  const health = await api('/../../healthz');
  if (!health.status) {
    console.error('ERROR: Server not reachable at localhost:3000');
    process.exit(1);
  }
  console.log(`Server OK (uptime: ${Math.round(health.uptime)}s)\n`);

  const results = [];
  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < sessions.length; i++) {
    const cfg = sessions[i];
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${sessions.length}] ${cfg.label.padEnd(35)} ... `);

    const r = await runSession(i + 1, cfg);
    results.push(r);

    if (r.pass) {
      passCount++;
      console.log(`PASS  sev=${r.severity}  Qs=${r.questions_asked}  doc=${r.needsDoctor}  fam=${r.needsFamilyAlert}`);
    } else {
      failCount++;
      console.log(`FAIL  ${r.errors.join(' | ')}`);
    }
  }

  // ─── Summary table ──────────────────────────────────────────────────
  console.log('\n' + '='.repeat(120));
  console.log('RESULTS TABLE');
  console.log('='.repeat(120));

  const hdr = [
    '#'.padStart(3),
    'Cluster/Input'.padEnd(38),
    'Qs'.padStart(3),
    'Severity'.padEnd(8),
    'Doctor'.padEnd(7),
    'FamAlert'.padEnd(9),
    'Done'.padEnd(5),
    'Status'.padEnd(6),
    'Errors',
  ];
  console.log(hdr.join(' | '));
  console.log('-'.repeat(120));

  for (const r of results) {
    const row = [
      String(r.session).padStart(3),
      r.cluster_or_input.padEnd(38).slice(0, 38),
      String(r.questions_asked).padStart(3),
      (r.severity || '-').padEnd(8),
      String(r.needsDoctor ?? '-').padEnd(7),
      String(r.needsFamilyAlert ?? '-').padEnd(9),
      String(r.isDone).padEnd(5),
      (r.pass ? 'PASS' : 'FAIL').padEnd(6),
      r.errors.length ? r.errors.join('; ') : '',
    ];
    console.log(row.join(' | '));
  }

  console.log('-'.repeat(120));
  console.log(`\nTOTAL: ${passCount} PASS / ${failCount} FAIL out of ${sessions.length} sessions`);

  if (failCount > 0) {
    console.log('\n--- FAILED SESSION DETAILS ---');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  Session #${r.session} (${r.cluster_or_input}):`);
      for (const e of r.errors) {
        console.log(`    - ${e}`);
      }
    }
  }

  console.log('\n' + '='.repeat(120));
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
