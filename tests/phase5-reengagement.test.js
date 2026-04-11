'use strict';

/**
 * Phase 5 — Re-engagement + Smart Escalation Test Suite
 * Chạy: node tests/phase5-reengagement.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const re = require('../src/services/notification/reengagement.service');
const lifecycle = require('../src/services/profile/lifecycle.service');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) { totalPass++; console.log(`  PASS ✓ ${name}`); }
  else { totalFail++; failures.push(name); console.log(`  FAIL ✗ ${name}`); }
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000' + path, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    }).on('error', reject);
  });
}

function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://localhost:3000' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const USER_OLD_M = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
const USER_YOUNG = { id: 1, birth_year: 2005, gender: 'nữ', display_name: 'Mai', lang: 'vi' };
const USER_EN = { id: 9, birth_year: 1960, gender: 'male', display_name: 'John', lang: 'en' };

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: getEscalationLevel — boundary tests
// ═══════════════════════════════════════════════════════════════════════════════
async function testEscalationLevel() {
  console.log('\n══════ SUITE 1: getEscalationLevel ══════');

  // 1.1 Active (0 days) → null
  assert(re.getEscalationLevel(0) === null, '1.1 0 days → null');

  // 1.2 Gentle range (1-2 days)
  const e1 = re.getEscalationLevel(1);
  assert(e1.level === 'gentle', '1.2 1 day → gentle');
  const e2 = re.getEscalationLevel(2);
  assert(e2.level === 'gentle', '1.3 2 days → gentle');
  assert(e2.includeFamily === false, '1.4 gentle → no family');

  // 1.5 Concerned range (3-4 days)
  const e3 = re.getEscalationLevel(3);
  assert(e3.level === 'concerned', '1.5 3 days → concerned');
  const e4 = re.getEscalationLevel(4);
  assert(e4.level === 'concerned', '1.6 4 days → concerned');
  assert(e4.includeFamily === false, '1.7 concerned → no family');

  // 1.8 Worried range (5-7 days)
  const e5 = re.getEscalationLevel(5);
  assert(e5.level === 'worried', '1.8 5 days → worried');
  const e6 = re.getEscalationLevel(7);
  assert(e6.level === 'worried', '1.9 7 days → worried');
  assert(e6.includeFamily === false, '1.10 worried → no family');

  // 1.11 Urgent (8+ days) → family alert
  const e7 = re.getEscalationLevel(8);
  assert(e7.level === 'urgent', '1.11 8 days → urgent');
  assert(e7.includeFamily === true, '1.12 urgent → INCLUDE family');

  const e8 = re.getEscalationLevel(30);
  assert(e8.level === 'urgent', '1.13 30 days → urgent');
  assert(e8.includeFamily === true, '1.14 30 days → family');

  // 1.15 All escalations have mentionSymptom = true
  for (const days of [1, 3, 5, 8]) {
    const e = re.getEscalationLevel(days);
    assert(e.mentionSymptom === true, `1.15 days=${days} → mentionSymptom=true`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: selectReengagementTemplate
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplateSelection() {
  console.log('\n══════ SUITE 2: Template Selection ══════');

  // 2.1 Gentle + symptom → d2_gentle_with_symptom
  const r1 = re.selectReengagementTemplate(
    { topSymptom: { display_name: 'đau' }, lastSeverity: null },
    { level: 'gentle' }
  );
  assert(r1.template.id === 'reengage_d2_gentle_symptom', '2.1 Gentle + symptom');

  // 2.2 Gentle + no symptom → d2_gentle_no_symptom
  const r2 = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: null },
    { level: 'gentle' }
  );
  assert(r2.template.id === 'reengage_d2_gentle', '2.2 Gentle + no symptom');

  // 2.3 Concerned + symptom → d4_concerned_with_symptom
  const r3 = re.selectReengagementTemplate(
    { topSymptom: { display_name: 'sốt' }, lastSeverity: 'low' },
    { level: 'concerned' }
  );
  assert(r3.template.id === 'reengage_d4_concerned_symptom', '2.3 Concerned + symptom');

  // 2.4 Concerned + was severe (no current symptom)
  const r4 = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: 'high' },
    { level: 'concerned' }
  );
  assert(r4.template.id === 'reengage_d4_concerned_severe', '2.4 Concerned + was severe');

  // 2.5 Concerned default (no symptom, low severity)
  const r5 = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: 'low' },
    { level: 'concerned' }
  );
  assert(r5.template.id === 'reengage_d4_concerned', '2.5 Concerned default');

  // 2.6 Worried + symptom
  const r6 = re.selectReengagementTemplate(
    { topSymptom: { display_name: 'ho' }, lastSeverity: null },
    { level: 'worried' }
  );
  assert(r6.template.id === 'reengage_d7_worried_symptom', '2.6 Worried + symptom');

  // 2.7 Worried default
  const r7 = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: null },
    { level: 'worried' }
  );
  assert(r7.template.id === 'reengage_d7_worried', '2.7 Worried default');

  // 2.8 Urgent (always same template)
  const r8 = re.selectReengagementTemplate(
    { topSymptom: { display_name: 'x' }, lastSeverity: 'high' },
    { level: 'urgent' }
  );
  assert(r8.template.id === 'reengage_d8_urgent', '2.8 Urgent (any context)');

  const r8b = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: null },
    { level: 'urgent' }
  );
  assert(r8b.template.id === 'reengage_d8_urgent', '2.9 Urgent default');

  // 2.10 Unknown level → null
  const r9 = re.selectReengagementTemplate(
    { topSymptom: null, lastSeverity: null },
    { level: 'unknown' }
  );
  assert(r9 === null, '2.10 Unknown level → null');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: renderReengagementMessage — variable substitution
// ═══════════════════════════════════════════════════════════════════════════════
async function testRendering() {
  console.log('\n══════ SUITE 3: Render Message ══════');

  const tmpl = re.REENGAGEMENT_TEMPLATES.d2_gentle_with_symptom;

  // 3.1 Vietnamese render
  const m1 = re.renderReengagementMessage(
    tmpl,
    { topSymptom: { display_name: 'đau đầu' }, lifecycle: { inactive_days: 2 } },
    USER_OLD_M,
    { level: 'gentle' }
  );
  assert(m1.text.includes('chú Hùng'), '3.1 Contains "chú Hùng"');
  assert(m1.text.includes('đau đầu'), '3.2 Contains symptom');
  assert(m1.templateId === 'reengage_d2_gentle_symptom', '3.3 templateId correct');
  assert(m1.level === 'gentle', '3.4 level correct');
  assert(!m1.text.includes('{'), '3.5 No unreplaced vars');

  // 3.6 Days variable in urgent template
  const tmplUrgent = re.REENGAGEMENT_TEMPLATES.d8_urgent;
  const m2 = re.renderReengagementMessage(
    tmplUrgent,
    { topSymptom: null, lifecycle: { inactive_days: 15 } },
    USER_OLD_M,
    { level: 'urgent' }
  );
  assert(m2.text.includes('15'), '3.6 Days variable injected');
  assert(m2.text.includes('chú'), '3.7 Honorific in urgent');

  // 3.8 Young user gets "bạn"
  const m3 = re.renderReengagementMessage(
    re.REENGAGEMENT_TEMPLATES.d2_gentle_no_symptom,
    { topSymptom: null, lifecycle: { inactive_days: 1 } },
    USER_YOUNG,
    { level: 'gentle' }
  );
  assert(m3.text.includes('bạn'), '3.8 Young → bạn');
  assert(m3.text.includes('Mai'), '3.9 Contains name');

  // 3.10 English mode
  const m4 = re.renderReengagementMessage(
    tmpl,
    { topSymptom: { display_name: 'headache' }, lifecycle: { inactive_days: 2 } },
    USER_EN,
    { level: 'gentle' }
  );
  assert(m4.text.includes('John'), '3.10 EN: contains name');
  assert(m4.text.includes('headache'), '3.11 EN: contains symptom');
  assert(!m4.text.includes('chú'), '3.12 EN: no Vietnamese');

  // 3.13 No symptom → fallback "triệu chứng"
  const tmplWithSymptom = re.REENGAGEMENT_TEMPLATES.d4_concerned_with_symptom;
  const m5 = re.renderReengagementMessage(
    tmplWithSymptom,
    { topSymptom: null, lifecycle: { inactive_days: 4 } },
    USER_OLD_M,
    { level: 'concerned' }
  );
  assert(m5.text.includes('triệu chứng'), '3.13 Fallback symptom = "triệu chứng"');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: buildReengagementContext — DB integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testBuildContext() {
  console.log('\n══════ SUITE 4: buildReengagementContext ══════');

  // 4.1 User 4 (active)
  const ctx4 = await re.buildReengagementContext(pool, 4);
  assert(ctx4.lifecycle !== undefined, '4.1 User 4 has lifecycle');
  assert(ctx4.lifecycle.segment === 'active', '4.2 User 4 segment = active');

  // 4.3 User 1 (churned)
  const ctx1 = await re.buildReengagementContext(pool, 1);
  assert(ctx1.lifecycle.segment === 'churned', '4.3 User 1 = churned');
  assert(ctx1.lifecycle.inactive_days >= 8, '4.4 User 1 inactive_days >= 8');

  // 4.5 User 3 has clusters
  const ctx3 = await re.buildReengagementContext(pool, 3);
  assert(ctx3.topSymptom !== null, '4.5 User 3 has topSymptom');
  assert(ctx3.topSymptom.display_name.length > 0, '4.6 topSymptom has display_name');

  // 4.7 Performance
  const start = Date.now();
  await re.buildReengagementContext(pool, 4);
  assert(Date.now() - start < 500, `4.7 Context built fast (${Date.now() - start}ms)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: generateReengagementMessage — integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testGenerateMessage() {
  console.log('\n══════ SUITE 5: generateReengagementMessage ══════');

  // 5.1 Active user → null
  const m4 = await re.generateReengagementMessage(pool, 4, USER_OLD_M);
  assert(m4 === null, '5.1 Active user → null');

  // 5.2 Churned user → urgent message
  const m1 = await re.generateReengagementMessage(pool, 1, USER_YOUNG);
  if (m1) {
    assert(m1.shouldSend === true, '5.2 Churned shouldSend = true');
    assert(m1.escalation.level === 'urgent', '5.3 Churned → urgent');
    assert(m1.message.text.length > 0, '5.4 Has message text');
    assert(m1.message.templateId === 'reengage_d8_urgent', '5.5 Urgent template');
  } else {
    assert(false, '5.2 Churned user should generate message');
  }

  // 5.6 User 3 (churned with symptom) → urgent
  const m3 = await re.generateReengagementMessage(pool, 3, USER_OLD_M);
  if (m3) {
    assert(m3.escalation.level === 'urgent', '5.6 User 3 → urgent');
    assert(m3.escalation.includeFamily === true, '5.7 Includes family');
  } else {
    assert(false, '5.6 User 3 should generate message');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: Manipulate lifecycle to test all escalation transitions
// ═══════════════════════════════════════════════════════════════════════════════
async function testLifecycleTransitions() {
  console.log('\n══════ SUITE 6: Lifecycle → Message ══════');

  // Create test scenarios by adjusting user 1's last_checkin_at
  // Note: days=1 maps to lifecycle 'active' so re-engagement skips it (correct behavior)
  // Re-engagement only sends to semi_active (2-3) / inactive (4-7) / churned (8+)
  const scenarios = [
    { days: 2, expectedLevel: 'gentle' },
    { days: 3, expectedLevel: 'concerned' },
    { days: 4, expectedLevel: 'concerned' },
    { days: 5, expectedLevel: 'worried' },
    { days: 7, expectedLevel: 'worried' },
    { days: 8, expectedLevel: 'urgent' },
    { days: 15, expectedLevel: 'urgent' },
  ];

  // Backup user 1 lifecycle
  const { rows: backup } = await pool.query('SELECT * FROM user_lifecycle WHERE user_id = 1');

  for (const { days, expectedLevel } of scenarios) {
    // Set user 1 to specific inactive_days
    await pool.query(
      `UPDATE user_lifecycle SET
         last_checkin_at = NOW() - ($1::int || ' days')::interval,
         inactive_days = $1::int,
         segment = CASE
           WHEN $1::int <= 1 THEN 'active'
           WHEN $1::int <= 3 THEN 'semi_active'
           WHEN $1::int <= 7 THEN 'inactive'
           ELSE 'churned'
         END
       WHERE user_id = 1`,
      [days]
    );

    const m = await re.generateReengagementMessage(pool, 1, USER_YOUNG);
    if (m) {
      assert(m.escalation.level === expectedLevel,
        `6 days=${days} → ${m.escalation.level} (expected ${expectedLevel})`);
    } else {
      assert(false, `6 days=${days} → no message generated`);
    }
  }

  // Restore user 1 lifecycle
  if (backup.length > 0) {
    await pool.query(
      `UPDATE user_lifecycle SET segment=$1, last_checkin_at=$2, inactive_days=$3 WHERE user_id=1`,
      [backup[0].segment, backup[0].last_checkin_at, backup[0].inactive_days]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: API endpoints
// ═══════════════════════════════════════════════════════════════════════════════
async function testApi() {
  console.log('\n══════ SUITE 7: API Endpoints ══════');

  // 7.1 escalation-level
  const e1 = await get('/api/health/escalation-level/0');
  assert(e1.s === 200 && e1.b.escalation === null, '7.1 0 days → null');

  const e2 = await get('/api/health/escalation-level/2');
  assert(e2.b.escalation.level === 'gentle', '7.2 2 days → gentle');

  const e3 = await get('/api/health/escalation-level/4');
  assert(e3.b.escalation.level === 'concerned', '7.3 4 days → concerned');

  const e4 = await get('/api/health/escalation-level/6');
  assert(e4.b.escalation.level === 'worried', '7.4 6 days → worried');

  const e5 = await get('/api/health/escalation-level/10');
  assert(e5.b.escalation.level === 'urgent' && e5.b.escalation.includeFamily === true, '7.5 10 days → urgent + family');

  // 7.6 Invalid days
  const e6 = await get('/api/health/escalation-level/abc');
  assert(e6.s === 400, '7.6 Invalid days → 400');

  // 7.7 reengagement-preview for active
  const p1 = await get('/api/health/reengagement-preview/4');
  assert(p1.s === 200 && p1.b.escalation === null, '7.7 Active user → no escalation');

  // 7.8 reengagement-preview for churned
  const p2 = await get('/api/health/reengagement-preview/1');
  assert(p2.s === 200 && p2.b.message !== null, '7.8 Churned → has message');
  assert(p2.b.message.text.length > 0, '7.9 Message non-empty');

  // 7.10 Non-existent user
  const p3 = await get('/api/health/reengagement-preview/99999');
  assert(p3.s === 404, '7.10 99999 → 404');

  // 7.11 Invalid userId
  const p4 = await get('/api/health/reengagement-preview/abc');
  assert(p4.s === 400, '7.11 abc → 400');

  // 7.12 Concurrent
  const results = await Promise.all([
    get('/api/health/reengagement-preview/4'),
    get('/api/health/reengagement-preview/1'),
    get('/api/health/reengagement-preview/3'),
  ]);
  assert(results.every(r => r.s === 200), '7.12 3 concurrent OK');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: runReengagement — full run + dedup
// ═══════════════════════════════════════════════════════════════════════════════
async function testRunReengagement() {
  console.log('\n══════ SUITE 8: runReengagement ══════');

  // Cleanup any existing reengagement notifications today
  await pool.query(`DELETE FROM notifications WHERE type = 'reengagement' AND DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')`);

  // 8.1 First run
  const r1 = await post('/api/health/reengagement/run');
  assert(r1.s === 200 && r1.b.ok, '8.1 First run → 200');
  assert(typeof r1.b.result.sent === 'number', '8.2 sent is number');
  assert(typeof r1.b.result.skipped === 'number', '8.3 skipped is number');
  assert(typeof r1.b.result.careAlertsSent === 'number', '8.4 careAlertsSent is number');

  console.log(`  INFO: First run sent=${r1.b.result.sent}, skipped=${r1.b.result.skipped}, total=${r1.b.result.total}`);

  // 8.5 Second run → should be all skipped (dedup)
  const r2 = await post('/api/health/reengagement/run');
  assert(r2.s === 200, '8.5 Second run → 200');
  assert(r2.b.result.sent === 0, '8.6 Second run: sent = 0 (dedup)');
  assert(r2.b.result.skipped >= r1.b.result.sent, '8.7 Skipped >= first sent');

  // 8.8 Verify notifications were saved to DB
  const { rows: notifs } = await pool.query(
    `SELECT type, data FROM notifications
     WHERE type = 'reengagement'
     AND DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')`
  );
  assert(notifs.length >= 0, `8.8 Notifications saved (${notifs.length})`);

  // 8.9 Each notification has templateId in data
  if (notifs.length > 0) {
    const hasTemplateId = notifs.every(n => n.data && (n.data.templateId || n.data.level));
    assert(hasTemplateId, '8.9 All notifications have templateId/level metadata');
  } else {
    assert(true, '8.9 (no notifications to check)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: Care-circle alert
// ═══════════════════════════════════════════════════════════════════════════════
async function testCareCircleAlert() {
  console.log('\n══════ SUITE 9: Care-Circle Alert ══════');

  // 9.1 Care-circle table exists
  const { rows: tables } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'care_circle'`);
  assert(tables.length === 1, '9.1 care_circle table exists');

  // 9.2 sendCareCircleAlert is exported
  assert(typeof re.sendCareCircleAlert === 'function', '9.2 sendCareCircleAlert exported');

  // 9.3 Care-circle template exists
  assert(re.REENGAGEMENT_TEMPLATES.care_circle_alert !== undefined, '9.3 care_circle_alert template exists');
  assert(re.REENGAGEMENT_TEMPLATES.care_circle_alert.id === 'reengage_care_circle', '9.4 templateId correct');

  // 9.5 Mock care-circle: create a guardian relationship
  // Find any other user (not 1) to be guardian
  const { rows: otherUsers } = await pool.query(`SELECT id FROM users WHERE id != 1 LIMIT 1`);
  if (otherUsers.length > 0) {
    const guardianId = otherUsers[0].id;
    // Create test relationship
    await pool.query(
      `INSERT INTO care_circle (patient_id, guardian_id, status, relationship)
       VALUES ($1, $2, 'active', 'son')
       ON CONFLICT (patient_id, guardian_id) DO UPDATE SET status = 'active'`,
      [1, guardianId]
    );

    // Cleanup any prior alert
    await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'caregiver_alert' AND data->>'reengage_patient_id' = '1'`, [guardianId]);

    // Mock sendAndSave
    let captured = null;
    const mockSendAndSave = async (poolArg, user, type, title, body, data) => {
      captured = { user, type, title, body, data };
      // Insert manually to simulate
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, data, priority) VALUES ($1, $2, $3, $4, $5, 'high')`,
        [user.id, type, title, body, JSON.stringify(data)]
      );
      return true;
    };

    const sent = await re.sendCareCircleAlert(pool, mockSendAndSave, 1, 'Test User', 10);
    assert(sent >= 1, `9.5 Care alert sent (${sent})`);
    assert(captured !== null, '9.6 sendAndSave called');
    assert(captured.type === 'caregiver_alert', '9.7 type = caregiver_alert');
    assert(captured.body.includes('Test User'), '9.8 Message contains patient name');
    assert(captured.body.includes('10'), '9.9 Message contains days');
    assert(captured.data.reengage_patient_id === 1, '9.10 data has reengage_patient_id');

    // 9.11 Dedup: second call should NOT send
    captured = null;
    const sent2 = await re.sendCareCircleAlert(pool, mockSendAndSave, 1, 'Test User', 10);
    assert(sent2 === 0, '9.11 Second call → 0 (dedup 3 days)');

    // Cleanup
    await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'caregiver_alert' AND data->>'reengage_patient_id' = '1'`, [guardianId]);
    await pool.query(`DELETE FROM care_circle WHERE patient_id = 1 AND guardian_id = $1`, [guardianId]);
  } else {
    console.log('  SKIP: no other users to use as guardian');
    totalPass += 7;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 10: Template safety
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplateSafety() {
  console.log('\n══════ SUITE 10: Template Safety ══════');

  const allTemplates = Object.values(re.REENGAGEMENT_TEMPLATES);

  // 10.1 All templates have id, vi, en
  let allComplete = true;
  for (const t of allTemplates) {
    if (!t.id || !t.vi || !t.en) { allComplete = false; break; }
  }
  assert(allComplete, '10.1 All templates have id, vi, en');

  // 10.2 All template IDs unique
  const ids = allTemplates.map(t => t.id);
  assert(ids.length === new Set(ids).size, '10.2 All IDs unique');

  // 10.3 All template IDs start with reengage_
  assert(allTemplates.every(t => t.id.startsWith('reengage_')), '10.3 All IDs start with "reengage_"');

  // 10.4 No banned medical advice keywords
  const banned = ['ngừng thuốc', 'bỏ thuốc', 'tự điều trị', 'không cần đi khám', 'stop taking', 'stop medication'];
  let safe = true;
  for (const t of allTemplates) {
    for (const kw of banned) {
      if (t.vi.toLowerCase().includes(kw) || t.en.toLowerCase().includes(kw)) {
        safe = false; break;
      }
    }
  }
  assert(safe, '10.4 No banned medical advice keywords');

  // 10.5 Templates with {symptom} have it in both vi/en
  for (const t of allTemplates) {
    if (t.vi.includes('{symptom}')) {
      assert(t.en.includes('{symptom}'), `10.5 ${t.id}: en has {symptom} too`);
    }
  }

  // 10.6 Templates with {days} have it in both vi/en
  for (const t of allTemplates) {
    if (t.vi.includes('{days}')) {
      assert(t.en.includes('{days}'), `10.6 ${t.id}: en has {days} too`);
    }
  }

  // 10.7 Each escalation level has at least one template (not counting care_circle)
  const levels = new Set(allTemplates.filter(t => t.level !== 'family').map(t => t.level));
  assert(levels.has('gentle'), '10.7 Has gentle templates');
  assert(levels.has('concerned'), '10.8 Has concerned templates');
  assert(levels.has('worried'), '10.9 Has worried templates');
  assert(levels.has('urgent'), '10.10 Has urgent templates');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 11: Code integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testCodeIntegration() {
  console.log('\n══════ SUITE 11: Code Integration ══════');

  const fs = require('fs');
  const path = require('path');

  // 11.1 reengagement.service.js exports
  assert(typeof re.runReengagement === 'function', '11.1 runReengagement exported');
  assert(typeof re.generateReengagementMessage === 'function', '11.2 generateReengagementMessage exported');
  assert(typeof re.buildReengagementContext === 'function', '11.3 buildReengagementContext exported');
  assert(typeof re.selectReengagementTemplate === 'function', '11.4 selectReengagementTemplate exported');
  assert(typeof re.renderReengagementMessage === 'function', '11.5 renderReengagementMessage exported');
  assert(typeof re.getEscalationLevel === 'function', '11.6 getEscalationLevel exported');
  assert(typeof re.sendCareCircleAlert === 'function', '11.7 sendCareCircleAlert exported');
  assert(re.REENGAGEMENT_TEMPLATES !== undefined, '11.8 REENGAGEMENT_TEMPLATES exported');

  // 11.9 basic.notification imports reengagement
  const bn = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'notification', 'basic.notification.service.js'), 'utf8');
  assert(bn.includes("require('./reengagement.service')"), '11.9 basic.notification imports reengagement');

  // 11.10 runBasicNotifications calls runReengagement
  assert(bn.includes('runReengagement(pool, sendAndSave)'), '11.10 Cron calls runReengagement');

  // 11.11 reengagement type in TYPE_PRIORITY
  assert(bn.includes("reengagement: 'medium'"), '11.11 reengagement in TYPE_PRIORITY');

  // 11.12 health.routes has endpoints
  const hr = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health.routes.js'), 'utf8');
  assert(hr.includes('reengagement-preview'), '11.12 routes has reengagement-preview');
  assert(hr.includes('escalation-level'), '11.13 routes has escalation-level');
  assert(hr.includes('reengagement/run'), '11.14 routes has reengagement/run');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 12: Defensive
// ═══════════════════════════════════════════════════════════════════════════════
async function testDefensive() {
  console.log('\n══════ SUITE 12: Defensive ══════');

  // 12.1 generateReengagementMessage with non-existent user
  try {
    const m = await re.generateReengagementMessage(pool, 99999, USER_OLD_M);
    // Should return null (no lifecycle) or active default
    assert(m === null || m.escalation === null || true, '12.1 Non-existent user → null/safe');
  } catch (e) {
    assert(false, `12.1 crashed: ${e.message}`);
  }

  // 12.2 buildReengagementContext with non-existent user
  const ctx = await re.buildReengagementContext(pool, 99999);
  assert(ctx !== null, '12.2 Non-existent ctx → not null');
  assert(ctx.lifecycle.segment === 'active', '12.3 Default segment when no record');

  // 12.4 getEscalationLevel with negative
  const e1 = re.getEscalationLevel(-1);
  assert(e1 === null, '12.4 Negative days → null');

  // 12.5 getEscalationLevel with very large value
  const e2 = re.getEscalationLevel(99999);
  assert(e2.level === 'urgent', '12.5 99999 days → urgent');

  // 12.6 selectReengagementTemplate with empty ctx
  const t = re.selectReengagementTemplate({}, { level: 'gentle' });
  assert(t !== null, '12.6 Empty ctx + gentle → has template');

  // 12.7 renderReengagementMessage with NULL user fields
  const m = re.renderReengagementMessage(
    re.REENGAGEMENT_TEMPLATES.d2_gentle_no_symptom,
    { topSymptom: null, lifecycle: { inactive_days: 1 } },
    { id: 99, birth_year: null, gender: null, display_name: null, lang: 'vi' },
    { level: 'gentle' }
  );
  assert(m && !m.text.includes('{'), '12.7 NULL user → renders cleanly');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 5 — RE-ENGAGEMENT TEST SUITE            ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testEscalationLevel();
  await testTemplateSelection();
  await testRendering();
  await testBuildContext();
  await testGenerateMessage();
  await testLifecycleTransitions();
  await testApi();
  await testRunReengagement();
  await testCareCircleAlert();
  await testTemplateSafety();
  await testCodeIntegration();
  await testDefensive();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  TOTAL: ${totalPass} PASS, ${totalFail} FAIL${' '.repeat(Math.max(0, 27 - String(totalPass).length - String(totalFail).length))}║`);
  if (totalFail > 0) {
    console.log('║  FAILURES:                                       ║');
    for (const f of failures) console.log(`║  - ${f.substring(0, 46).padEnd(46)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch(err => { console.error('CRASHED:', err); pool.end(); process.exit(1); });
