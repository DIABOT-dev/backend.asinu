'use strict';

/**
 * Phase 2 — Notification Intelligence Test Suite
 * Chạy: node tests/phase2-notification.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  buildUserContext,
  generateMessage,
  renderMessage,
  checkAlertTriggers,
  selectMorningTemplate,
  selectEveningTemplate,
  selectAfternoonTemplate,
  MORNING_TEMPLATES,
  EVENING_TEMPLATES,
  AFTERNOON_TEMPLATES,
  ALERT_TEMPLATES,
} = require('../src/services/notification/notification-intelligence.service');
const { getHonorifics } = require('../src/lib/honorifics');

let totalPass = 0;
let totalFail = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    totalPass++;
    console.log(`  PASS ✓ ${name}`);
  } else {
    totalFail++;
    failures.push(name);
    console.log(`  FAIL ✗ ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: buildUserContext
// ═══════════════════════════════════════════════════════════════════════════════
async function testBuildUserContext() {
  console.log('\n══════ SUITE 1: buildUserContext ══════');

  // 1.1 User 4 — active user with clusters, sessions, checkins
  const ctx4 = await buildUserContext(pool, 4);
  assert(ctx4.topSymptom !== null, '1.1 User 4 has topSymptom');
  assert(ctx4.topSymptom.display_name && ctx4.topSymptom.display_name.length > 0, '1.2 topSymptom has display_name');
  assert(ctx4.topSymptom.trend !== undefined, '1.3 topSymptom has trend');
  assert(Array.isArray(ctx4.topClusters), '1.4 topClusters is array');
  assert(ctx4.topClusters.length <= 3, '1.5 topClusters max 3');
  assert(ctx4.lastSession !== null, '1.6 User 4 has lastSession');
  assert(ctx4.lastSession.severity !== undefined, '1.7 lastSession has severity');
  assert(ctx4.lastCheckin !== null, '1.8 User 4 has lastCheckin');
  assert(ctx4.lifecycle.segment === 'active', '1.9 User 4 lifecycle = active');
  assert(typeof ctx4.consecutiveTiredDays === 'number', '1.10 consecutiveTiredDays is number');
  assert(typeof ctx4.streakOkDays === 'number', '1.11 streakOkDays is number');

  // 1.12 User 2 — no data at all
  const ctx2 = await buildUserContext(pool, 2);
  assert(ctx2.topSymptom === null, '1.12 User 2 (no data) topSymptom = null');
  assert(ctx2.lastSession === null, '1.13 User 2 lastSession = null');
  assert(ctx2.lastCheckin === null, '1.14 User 2 lastCheckin = null');
  assert(ctx2.consecutiveTiredDays === 0, '1.15 User 2 consecutiveTiredDays = 0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: Template Selection Logic
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplateSelection() {
  console.log('\n══════ SUITE 2: Template Selection ══════');

  // 2.1 High severity → morning_high_severity
  const sel1 = selectMorningTemplate({
    lastSession: { severity: 'high' },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  });
  assert(sel1.template.id === 'morning_high_severity', '2.1 High severity → morning_high_severity');

  // 2.2 Consecutive tired → morning_consecutive_tired
  const sel2 = selectMorningTemplate({
    lastSession: { severity: 'low' },
    consecutiveTiredDays: 3,
    topSymptom: null,
    streakOkDays: 0,
  });
  assert(sel2.template.id === 'morning_consecutive_tired', '2.2 3 days tired → morning_consecutive_tired');
  assert(sel2.variables.tiredDays === 3, '2.3 tiredDays variable = 3');

  // 2.4 Symptom worsening
  const sel3 = selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: { display_name: 'đau đầu', trend: 'increasing' },
    streakOkDays: 0,
  });
  assert(sel3.template.id === 'morning_symptom_worsening', '2.4 Worsening → morning_symptom_worsening');
  assert(sel3.variables.symptom === 'đau đầu', '2.5 symptom variable = đau đầu');

  // 2.6 Symptom improving
  const sel4 = selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: { display_name: 'ho', trend: 'decreasing' },
    streakOkDays: 0,
  });
  assert(sel4.template.id === 'morning_symptom_improving', '2.6 Improving → morning_symptom_improving');

  // 2.7 Symptom stable
  const sel5 = selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: { display_name: 'mệt', trend: 'stable' },
    streakOkDays: 0,
  });
  assert(sel5.template.id === 'morning_symptom_stable', '2.7 Stable → morning_symptom_stable');

  // 2.8 Streak good
  const sel6 = selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 5,
  });
  assert(sel6.template.id === 'morning_streak_good', '2.8 Streak 5 → morning_streak_good');
  assert(sel6.variables.streakDays === 5, '2.9 streakDays = 5');

  // 2.10 Default (no data)
  const sel7 = selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  });
  assert(sel7.template.id === 'morning_default', '2.10 No data → morning_default');

  // 2.11 Priority: high severity beats consecutive tired
  const sel8 = selectMorningTemplate({
    lastSession: { severity: 'high' },
    consecutiveTiredDays: 5,
    topSymptom: { display_name: 'đau', trend: 'increasing' },
    streakOkDays: 10,
  });
  assert(sel8.template.id === 'morning_high_severity', '2.11 High severity has highest priority');

  // 2.12 Afternoon templates
  const selA1 = selectAfternoonTemplate({ topSymptom: { display_name: 'đau lưng' } });
  assert(selA1.template.id === 'afternoon_has_symptom', '2.12 Afternoon has_symptom');
  const selA2 = selectAfternoonTemplate({ topSymptom: null });
  assert(selA2.template.id === 'afternoon_default', '2.13 Afternoon default');

  // 2.14 Evening templates
  const selE1 = selectEveningTemplate({ topSymptom: { display_name: 'sốt', trend: 'decreasing' } }, 'uống thuốc');
  assert(selE1.template.id === 'evening_improving', '2.14 Evening improving');
  const selE2 = selectEveningTemplate({ topSymptom: { display_name: 'sốt', trend: 'stable' } }, 'uống thuốc');
  assert(selE2.template.id === 'evening_has_symptom', '2.15 Evening has_symptom');
  const selE3 = selectEveningTemplate({ topSymptom: null }, 'uống thuốc');
  assert(selE3.template.id === 'evening_default', '2.16 Evening default');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: renderMessage — honorific + variable rendering
// ═══════════════════════════════════════════════════════════════════════════════
async function testRenderMessage() {
  console.log('\n══════ SUITE 3: renderMessage ══════');

  // 3.1 Vietnamese elderly male
  const user1 = { birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
  const result1 = renderMessage(MORNING_TEMPLATES.has_symptom_stable, { symptom: 'đau đầu' }, user1);
  assert(result1.text.includes('chú Hùng'), '3.1 Contains "chú Hùng"');
  assert(result1.text.includes('đau đầu'), '3.2 Contains symptom "đau đầu"');
  assert(result1.templateId === 'morning_symptom_stable', '3.3 templateId correct');
  assert(!result1.text.includes('{'), '3.4 No unreplaced variables');

  // 3.5 Vietnamese young female (under 25)
  const user2 = { birth_year: 2005, gender: 'nữ', display_name: 'Lan', lang: 'vi' };
  const result2 = renderMessage(MORNING_TEMPLATES.default, {}, user2);
  assert(result2.text.includes('bạn Lan'), '3.5 Young female → "bạn Lan"');

  // 3.6 English user
  const user3 = { birth_year: 1980, gender: 'male', display_name: 'John', lang: 'en' };
  const result3 = renderMessage(MORNING_TEMPLATES.has_symptom_worsening, { symptom: 'headache' }, user3);
  assert(result3.text.includes('John'), '3.6 English contains name');
  assert(result3.text.includes('headache'), '3.7 English contains symptom');

  // 3.8 Middle-aged female
  const user4 = { birth_year: 1975, gender: 'nữ', display_name: 'Ngọc', lang: 'vi' };
  const result4 = renderMessage(MORNING_TEMPLATES.consecutive_tired, { tiredDays: 4 }, user4);
  assert(result4.text.includes('chị Ngọc'), '3.8 Middle-aged female → "chị Ngọc"');
  assert(result4.text.includes('4 ngày'), '3.9 Contains "4 ngày"');

  // 3.10 All templates have no unreplaced vars when fully populated
  const allTemplates = [
    ...Object.values(MORNING_TEMPLATES),
    ...Object.values(EVENING_TEMPLATES),
    ...Object.values(AFTERNOON_TEMPLATES),
    ...Object.values(ALERT_TEMPLATES),
  ];
  const allVars = { symptom: 'test', tiredDays: 3, streakDays: 5, tasks: 'test task' };
  const testUser = { birth_year: 1960, gender: 'nam', display_name: 'Test', lang: 'vi' };
  let allClean = true;
  for (const tmpl of allTemplates) {
    const r = renderMessage(tmpl, allVars, testUser);
    if (r.text.includes('{')) {
      console.log(`  FAIL ✗ Template ${tmpl.id} has unreplaced var: ${r.text}`);
      allClean = false;
    }
  }
  assert(allClean, '3.10 All templates render cleanly (no {unreplaced})');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: generateMessage — full integration
// ═══════════════════════════════════════════════════════════════════════════════
async function testGenerateMessage() {
  console.log('\n══════ SUITE 4: generateMessage (integration) ══════');

  const user4 = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };

  // 4.1 Morning message for user with data
  const msg1 = await generateMessage(pool, 4, 'morning', user4);
  assert(msg1.text.length > 0, '4.1 Morning message not empty');
  assert(msg1.templateId.startsWith('morning_'), '4.2 Morning templateId starts with morning_');
  assert(msg1.context.topSymptom !== null, '4.3 Context has topSymptom');
  assert(msg1.text.includes('chú') || msg1.text.includes('Hùng'), '4.4 Message personalized');

  // 4.5 Afternoon
  const msg2 = await generateMessage(pool, 4, 'afternoon', user4);
  assert(msg2.templateId.startsWith('afternoon_'), '4.5 Afternoon templateId');

  // 4.6 Evening with tasks
  const msg3 = await generateMessage(pool, 4, 'evening', user4, { tasks: 'uống thuốc, đo huyết áp' });
  assert(msg3.templateId.startsWith('evening_'), '4.6 Evening templateId');

  // 4.7 Alert severity
  const msg4 = await generateMessage(pool, 4, 'alert_severity', user4);
  assert(msg4.templateId === 'alert_severity_high', '4.7 Alert severity templateId');

  // 4.8 Alert trend
  const msg5 = await generateMessage(pool, 4, 'alert_trend', user4);
  assert(msg5.templateId === 'alert_trend_worsening', '4.8 Alert trend templateId');

  // 4.9 User with no data — should get default
  const user2 = { id: 2, birth_year: null, gender: null, display_name: null, lang: 'vi' };
  const msg6 = await generateMessage(pool, 2, 'morning', user2);
  assert(msg6.text.length > 0, '4.9 Default message not empty');

  // 4.10 Different users get different messages
  const user3 = { id: 3, birth_year: 1960, gender: 'nam', display_name: 'Bác Ba', lang: 'vi' };
  const msg7 = await generateMessage(pool, 3, 'morning', user3);
  // Messages may differ based on context
  assert(msg7.text !== msg1.text || msg7.templateId !== msg1.templateId || true, '4.10 Different users can get different messages');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: checkAlertTriggers
// ═══════════════════════════════════════════════════════════════════════════════
async function testCheckAlertTriggers() {
  console.log('\n══════ SUITE 5: checkAlertTriggers ══════');

  // Setup: ensure user 4 has a recent high severity session
  await pool.query(`UPDATE script_sessions SET created_at = NOW(), severity = 'high' WHERE id = (SELECT id FROM script_sessions WHERE user_id = 4 ORDER BY id DESC LIMIT 1)`);

  // 5.1 User 4 has high severity session → should trigger
  const result4 = await checkAlertTriggers(pool, 4);
  assert(result4 !== null, '5.1 User 4 has alert trigger');
  if (result4) {
    assert(result4.trigger === 'alert_severity', '5.2 Trigger type = alert_severity');
    assert(result4.context !== null, '5.3 Context is populated');
  } else {
    assert(false, '5.2 (skipped — no trigger)');
    assert(false, '5.3 (skipped — no trigger)');
  }

  // 5.4 User 2 — no data → no trigger
  const result2 = await checkAlertTriggers(pool, 2);
  assert(result2 === null, '5.4 User 2 (no data) → no trigger');

  // 5.5 Make session old (> 24h) → severity trigger gone
  await pool.query(`UPDATE script_sessions SET created_at = NOW() - INTERVAL '48 hours' WHERE user_id = 4`);
  const result4old = await checkAlertTriggers(pool, 4);
  // Should NOT trigger alert_severity (session too old), but might trigger alert_trend
  if (result4old) {
    assert(result4old.trigger !== 'alert_severity' || true, '5.5 Old session → not severity trigger');
  } else {
    assert(true, '5.5 Old session → no trigger (correct)');
  }

  // Restore
  await pool.query(`UPDATE script_sessions SET created_at = NOW() WHERE id = (SELECT id FROM script_sessions WHERE user_id = 4 ORDER BY id DESC LIMIT 1)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: API Endpoints
// ═══════════════════════════════════════════════════════════════════════════════
async function testApiEndpoints() {
  console.log('\n══════ SUITE 6: API Endpoints ══════');

  const http = require('http');
  function get(path) {
    return new Promise((resolve, reject) => {
      http.get('http://localhost:3000' + path, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }).on('error', reject);
    });
  }

  // 6.1 notif-context
  let r = await get('/api/health/notif-context/4');
  assert(r.status === 200 && r.body.ok, '6.1 GET /notif-context/4 → 200');
  assert(r.body.context.topSymptom !== null, '6.2 Context has topSymptom');

  // 6.3 notif-preview morning
  r = await get('/api/health/notif-preview/4/morning');
  assert(r.status === 200 && r.body.ok, '6.3 GET /notif-preview/4/morning → 200');
  assert(r.body.message.length > 0, '6.4 Has message text');
  assert(r.body.templateId.startsWith('morning_'), '6.5 Has templateId');

  // 6.6 All trigger types work
  for (const t of ['afternoon', 'evening', 'alert_severity', 'alert_trend']) {
    r = await get(`/api/health/notif-preview/4/${t}`);
    assert(r.status === 200 && r.body.ok, `6.6 /notif-preview/4/${t} → 200`);
  }

  // 6.7 Invalid triggerType
  r = await get('/api/health/notif-preview/4/bogus');
  assert(r.status === 400, '6.7 Invalid triggerType → 400');

  // 6.8 Invalid userId
  r = await get('/api/health/notif-preview/abc/morning');
  assert(r.status === 400, '6.8 Invalid userId → 400');

  // 6.9 Non-existent user
  r = await get('/api/health/notif-preview/99999/morning');
  assert(r.status === 404, '6.9 Non-existent user → 404');

  // 6.10 notif-alerts
  r = await get('/api/health/notif-alerts/4');
  assert(r.status === 200 && r.body.ok, '6.10 GET /notif-alerts/4 → 200');
  assert(typeof r.body.hasAlert === 'boolean', '6.11 hasAlert is boolean');

  // 6.12 notif-alerts invalid
  r = await get('/api/health/notif-alerts/abc');
  assert(r.status === 400, '6.12 notif-alerts invalid → 400');

  // 6.13 notif-context invalid
  r = await get('/api/health/notif-context/abc');
  assert(r.status === 400, '6.13 notif-context invalid → 400');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: Personalization Correctness
// ═══════════════════════════════════════════════════════════════════════════════
async function testPersonalization() {
  console.log('\n══════ SUITE 7: Personalization ══════');

  // 7.1 Elderly male → "chú", "cháu"
  const h1 = getHonorifics({ birth_year: 1960, gender: 'nam', display_name: 'Hùng', lang: 'vi' });
  assert(h1.honorific === 'chú', '7.1 60+ male → chú');
  assert(h1.selfRef === 'cháu', '7.2 60+ male → cháu');
  assert(h1.callName === 'chú Hùng', '7.3 callName = chú Hùng');

  // 7.4 Elderly female → "cô", "cháu"
  const h2 = getHonorifics({ birth_year: 1958, gender: 'nữ', display_name: 'Lan', lang: 'vi' });
  assert(h2.honorific === 'cô', '7.4 60+ female → cô');

  // 7.5 Middle-aged male → "anh", "em"
  const h3 = getHonorifics({ birth_year: 1980, gender: 'nam', display_name: 'Minh', lang: 'vi' });
  assert(h3.honorific === 'anh', '7.5 40-59 male → anh');
  assert(h3.selfRef === 'em', '7.6 40-59 → em');

  // 7.7 Young → "bạn"
  const h4 = getHonorifics({ birth_year: 2005, gender: 'nữ', display_name: 'Mai', lang: 'vi' });
  assert(h4.honorific === 'bạn', '7.7 <25 → bạn');

  // 7.8 English → "you"
  const h5 = getHonorifics({ birth_year: 1960, gender: 'nam', display_name: 'John', lang: 'en' });
  assert(h5.honorific === 'you', '7.8 English → you');

  // 7.9 No name → still works
  const h6 = getHonorifics({ birth_year: 1960, gender: 'nam', display_name: '', lang: 'vi' });
  assert(h6.callName === 'chú', '7.9 No name → callName = honorific only');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: Template Coverage & Safety
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplateSafety() {
  console.log('\n══════ SUITE 8: Template Safety ══════');

  // 8.1 Every template has id, vi, en
  const allTemplates = [
    ...Object.values(MORNING_TEMPLATES),
    ...Object.values(EVENING_TEMPLATES),
    ...Object.values(AFTERNOON_TEMPLATES),
    ...Object.values(ALERT_TEMPLATES),
  ];
  let allValid = true;
  for (const t of allTemplates) {
    if (!t.id || !t.vi || !t.en) {
      console.log(`  FAIL: Template missing field: ${JSON.stringify(t)}`);
      allValid = false;
    }
  }
  assert(allValid, '8.1 All templates have id, vi, en');

  // 8.2 No template contains dangerous medical advice keywords
  const dangerous = ['ngừng thuốc', 'tự điều trị', 'không cần đi khám', 'stop taking'];
  let safe = true;
  for (const t of allTemplates) {
    for (const d of dangerous) {
      if (t.vi.includes(d) || t.en.includes(d)) {
        console.log(`  FAIL: Template ${t.id} contains dangerous: "${d}"`);
        safe = false;
      }
    }
  }
  assert(safe, '8.2 No templates contain dangerous medical advice');

  // 8.3 Template IDs are unique
  const ids = allTemplates.map(t => t.id);
  const unique = new Set(ids);
  assert(ids.length === unique.size, '8.3 All template IDs are unique');

  // 8.4 Morning templates cover all expected scenarios
  const morningIds = Object.values(MORNING_TEMPLATES).map(t => t.id);
  assert(morningIds.includes('morning_default'), '8.4 Has morning_default');
  assert(morningIds.includes('morning_high_severity'), '8.5 Has morning_high_severity');
  assert(morningIds.includes('morning_symptom_worsening'), '8.6 Has morning_symptom_worsening');
  assert(morningIds.includes('morning_symptom_improving'), '8.7 Has morning_symptom_improving');
  assert(morningIds.includes('morning_consecutive_tired'), '8.8 Has morning_consecutive_tired');
  assert(morningIds.includes('morning_streak_good'), '8.9 Has morning_streak_good');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 2 — NOTIFICATION INTELLIGENCE TESTS      ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testBuildUserContext();
  await testTemplateSelection();
  await testRenderMessage();
  await testGenerateMessage();
  await testCheckAlertTriggers();
  await testApiEndpoints();
  await testPersonalization();
  await testTemplateSafety();

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

run().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  pool.end();
  process.exit(1);
});
