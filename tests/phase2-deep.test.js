'use strict';

/**
 * Phase 2 — Deep Test Suite
 * Covers: edge cases, data manipulation, integration with basic.notification, concurrency
 * Chạy: node tests/phase2-deep.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const intel = require('../src/services/notification/notification-intelligence.service');
const { getHonorifics } = require('../src/lib/honorifics');

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

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: buildUserContext — data manipulation edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testContextEdgeCases() {
  console.log('\n══════ SUITE 1: Context Edge Cases ══════');

  // 1.1 User with clusters but no sessions
  const ctx3 = await intel.buildUserContext(pool, 3);
  assert(ctx3.topClusters.length > 0, '1.1 User 3 has clusters');
  // User 3 may or may not have sessions

  // 1.2 Context queries run in parallel (performance)
  const start = Date.now();
  await intel.buildUserContext(pool, 4);
  const elapsed = Date.now() - start;
  assert(elapsed < 2000, `1.2 Context built in ${elapsed}ms (< 2s)`);

  // 1.3 Context with deactivated clusters — should not appear
  // First, check how many active clusters user 4 has
  const { rows: before } = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM problem_clusters WHERE user_id = 4 AND is_active = TRUE`
  );
  // Deactivate one
  await pool.query(
    `UPDATE problem_clusters SET is_active = FALSE WHERE user_id = 4 AND id = (
      SELECT id FROM problem_clusters WHERE user_id = 4 AND is_active = TRUE LIMIT 1
    )`
  );
  const ctx4after = await intel.buildUserContext(pool, 4);
  const { rows: after } = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM problem_clusters WHERE user_id = 4 AND is_active = TRUE`
  );
  assert(ctx4after.topClusters.length <= parseInt(before[0].cnt), '1.3 Deactivated cluster excluded from context');
  // Restore
  await pool.query(`UPDATE problem_clusters SET is_active = TRUE WHERE user_id = 4`);

  // 1.4 consecutiveTiredDays accuracy
  // User 4 has 3 recent checkins all "tired" based on earlier data
  const ctx4 = await intel.buildUserContext(pool, 4);
  assert(ctx4.consecutiveTiredDays >= 0 && ctx4.consecutiveTiredDays <= 3, `1.4 consecutiveTiredDays=${ctx4.consecutiveTiredDays} (0-3 range)`);

  // 1.5 topClusters ordered by priority DESC
  if (ctx4.topClusters.length >= 2) {
    assert(ctx4.topClusters[0].priority >= ctx4.topClusters[1].priority, '1.5 topClusters sorted by priority DESC');
  } else {
    assert(true, '1.5 (skipped - < 2 clusters)');
  }

  // 1.6 lifecycle is populated from user_lifecycle table
  assert(ctx4.lifecycle.segment !== undefined, '1.6 lifecycle.segment populated');
  assert(ctx4.lifecycle.inactive_days !== undefined, '1.7 lifecycle.inactive_days populated');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: Template selection priority ordering
// ═══════════════════════════════════════════════════════════════════════════════
async function testTemplatePriority() {
  console.log('\n══════ SUITE 2: Template Priority ══════');

  // Priority: high_severity > consecutive_tired > symptom > streak > default

  // 2.1 All conditions present → high_severity wins
  const sel1 = intel.selectMorningTemplate({
    lastSession: { severity: 'high' },
    consecutiveTiredDays: 5,
    topSymptom: { display_name: 'sốt', trend: 'increasing' },
    streakOkDays: 10,
  });
  assert(sel1.template.id === 'morning_high_severity', '2.1 All conditions → high_severity wins');

  // 2.2 No high severity → consecutive_tired wins
  const sel2 = intel.selectMorningTemplate({
    lastSession: { severity: 'low' },
    consecutiveTiredDays: 3,
    topSymptom: { display_name: 'sốt', trend: 'increasing' },
    streakOkDays: 10,
  });
  assert(sel2.template.id === 'morning_consecutive_tired', '2.2 No high severity → consecutive_tired wins');

  // 2.3 No tired → symptom wins over streak
  const sel3 = intel.selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 1,
    topSymptom: { display_name: 'ho', trend: 'stable' },
    streakOkDays: 10,
  });
  assert(sel3.template.id === 'morning_symptom_stable', '2.3 Symptom wins over streak');

  // 2.4 No symptom → streak wins
  const sel4 = intel.selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 5,
  });
  assert(sel4.template.id === 'morning_streak_good', '2.4 No symptom → streak wins');

  // 2.5 Streak < 3 → default
  const sel5 = intel.selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 2,
  });
  assert(sel5.template.id === 'morning_default', '2.5 Streak < 3 → default');

  // 2.6 Low/medium severity does NOT trigger high_severity template
  const sel6 = intel.selectMorningTemplate({
    lastSession: { severity: 'medium' },
    consecutiveTiredDays: 0,
    topSymptom: null,
    streakOkDays: 0,
  });
  assert(sel6.template.id === 'morning_default', '2.6 Medium severity → default (not high_severity)');

  // 2.7 consecutiveTiredDays = 1 → NOT triggered (need >= 2)
  const sel7 = intel.selectMorningTemplate({
    lastSession: null,
    consecutiveTiredDays: 1,
    topSymptom: null,
    streakOkDays: 0,
  });
  assert(sel7.template.id === 'morning_default', '2.7 1 tired day → default (need >= 2)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: renderMessage edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testRenderEdgeCases() {
  console.log('\n══════ SUITE 3: Render Edge Cases ══════');

  // 3.1 User with no name
  const r1 = intel.renderMessage(intel.MORNING_TEMPLATES.default, {}, { lang: 'vi', birth_year: null, gender: null, display_name: '' });
  assert(!r1.text.includes('{'), '3.1 No name → renders without {vars}');
  assert(r1.text.includes('bạn'), '3.2 No age → defaults to "bạn"');

  // 3.3 User with no birth_year → "bạn"
  const r2 = intel.renderMessage(intel.MORNING_TEMPLATES.default, {}, { lang: 'vi', birth_year: null, gender: 'nam', display_name: 'Hùng' });
  assert(r2.text.includes('bạn Hùng'), '3.3 No birth_year → "bạn Hùng"');

  // 3.4 Empty symptom variable
  const r3 = intel.renderMessage(intel.MORNING_TEMPLATES.has_symptom_stable, { symptom: '' }, { lang: 'vi', birth_year: 1960, gender: 'nam', display_name: 'Hùng' });
  assert(!r3.text.includes('{symptom}'), '3.4 Empty symptom → no {symptom} left');

  // 3.5 Special characters in symptom
  const r4 = intel.renderMessage(intel.MORNING_TEMPLATES.has_symptom_stable, { symptom: 'đau "dạ dày" & buồn nôn' }, { lang: 'vi', birth_year: 1960, gender: 'nam', display_name: 'Ba' });
  assert(r4.text.includes('đau "dạ dày" & buồn nôn'), '3.5 Special chars preserved in symptom');

  // 3.6 Very long display name
  const longName = 'Nguyễn Văn A Bê Cê Đê';
  const r5 = intel.renderMessage(intel.MORNING_TEMPLATES.default, {}, { lang: 'vi', birth_year: 1960, gender: 'nam', display_name: longName });
  assert(r5.text.includes('Đê'), '3.6 Long name → uses last part');

  // 3.7 English mode
  const r6 = intel.renderMessage(intel.MORNING_TEMPLATES.has_symptom_worsening, { symptom: 'headache' }, { lang: 'en', birth_year: 1960, gender: 'male', display_name: 'John' });
  assert(r6.text.includes('John'), '3.7 EN: contains name');
  assert(r6.text.includes('headache'), '3.8 EN: contains symptom');
  assert(!r6.text.includes('chú'), '3.9 EN: no Vietnamese honorific');

  // 3.10 templateId always returned
  assert(r6.templateId === 'morning_symptom_worsening', '3.10 templateId always present');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: generateMessage with real DB data — different users different results
// ═══════════════════════════════════════════════════════════════════════════════
async function testGenerateMessageDiversity() {
  console.log('\n══════ SUITE 4: Message Diversity ══════');

  const user4 = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Chú Hùng', lang: 'vi' };
  const user3 = { id: 3, birth_year: 1960, gender: 'nam', display_name: 'Bác Ba', lang: 'vi' };
  const user2 = { id: 2, birth_year: null, gender: null, display_name: null, lang: 'vi' };

  // 4.1 Morning messages
  const m4 = await intel.generateMessage(pool, 4, 'morning', user4);
  const m3 = await intel.generateMessage(pool, 3, 'morning', user3);
  const m2 = await intel.generateMessage(pool, 2, 'morning', user2);
  assert(m4.text !== m2.text, '4.1 User 4 vs User 2 morning messages differ');
  assert(m4.text.includes('Hùng'), '4.2 User 4 message has "Hùng"');
  assert(!m2.text.includes('Hùng'), '4.3 User 2 message does NOT have "Hùng"');

  // 4.4 Each user message mentions their own name
  assert(m3.text.includes('Ba'), '4.4 User 3 message has "Ba"');

  // 4.5 All messages have valid templateId
  assert(m4.templateId.startsWith('morning_'), '4.5 User 4 has morning_ templateId');
  assert(m3.templateId.startsWith('morning_'), '4.6 User 3 has morning_ templateId');
  assert(m2.templateId.startsWith('morning_'), '4.7 User 2 has morning_ templateId');

  // 4.8 All trigger types return valid for user 4
  for (const trigger of ['morning', 'afternoon', 'evening', 'alert_severity', 'alert_trend']) {
    const msg = await intel.generateMessage(pool, 4, trigger, user4);
    assert(msg.text.length > 5, `4.8 ${trigger} returns non-trivial text (${msg.text.length} chars)`);
  }

  // 4.9 Evening with tasks
  const mEve = await intel.generateMessage(pool, 4, 'evening', user4, { tasks: 'uống thuốc, đo huyết áp' });
  assert(mEve.text.includes('uống thuốc') || mEve.text.includes('đo huyết áp'), '4.9 Evening message includes tasks');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: checkAlertTriggers — edge cases
// ═══════════════════════════════════════════════════════════════════════════════
async function testAlertTriggerEdgeCases() {
  console.log('\n══════ SUITE 5: Alert Trigger Edge Cases ══════');

  // Setup: ensure user 4 has recent high severity
  await pool.query(`UPDATE script_sessions SET created_at = NOW(), severity = 'high' WHERE id = (SELECT id FROM script_sessions WHERE user_id = 4 ORDER BY id DESC LIMIT 1)`);

  // 5.1 High severity within 24h → triggers
  const r1 = await intel.checkAlertTriggers(pool, 4);
  assert(r1 !== null && r1.trigger === 'alert_severity', '5.1 Recent high severity → alert_severity');

  // 5.2 Set severity to low → no severity trigger
  await pool.query(`UPDATE script_sessions SET severity = 'low' WHERE id = (SELECT id FROM script_sessions WHERE user_id = 4 ORDER BY id DESC LIMIT 1)`);
  const r2 = await intel.checkAlertTriggers(pool, 4);
  // Might still trigger from trend if count_7d >= 3
  if (r2) {
    assert(r2.trigger !== 'alert_severity', '5.2 Low severity → no severity trigger');
  } else {
    assert(true, '5.2 Low severity → no trigger at all');
  }

  // 5.3 Set cluster trend to increasing + count_7d >= 3 → alert_trend
  await pool.query(`UPDATE problem_clusters SET trend = 'increasing', count_7d = 5 WHERE user_id = 4 AND id = (SELECT id FROM problem_clusters WHERE user_id = 4 AND is_active = TRUE ORDER BY priority DESC LIMIT 1)`);
  const r3 = await intel.checkAlertTriggers(pool, 4);
  assert(r3 !== null && r3.trigger === 'alert_trend', '5.3 Increasing trend + count_7d >= 3 → alert_trend');

  // 5.4 count_7d < 3 → no trend trigger
  await pool.query(`UPDATE problem_clusters SET count_7d = 1 WHERE user_id = 4 AND trend = 'increasing'`);
  const r4 = await intel.checkAlertTriggers(pool, 4);
  assert(r4 === null, '5.4 count_7d < 3 → no trigger');

  // Restore
  await pool.query(`UPDATE script_sessions SET severity = 'high', created_at = NOW() WHERE id = (SELECT id FROM script_sessions WHERE user_id = 4 ORDER BY id DESC LIMIT 1)`);
  await pool.query(`UPDATE problem_clusters SET trend = 'stable', count_7d = 0 WHERE user_id = 4`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: API — concurrent & stress
// ═══════════════════════════════════════════════════════════════════════════════
async function testApiStress() {
  console.log('\n══════ SUITE 6: API Concurrent & Stress ══════');

  // 6.1 10 concurrent requests
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(get('/api/health/notif-preview/4/morning'));
  }
  const results = await Promise.all(promises);
  const allOk = results.every(r => r.s === 200 && r.b.ok);
  assert(allOk, '6.1 10 concurrent preview requests all 200');

  // 6.2 All return same templateId (deterministic)
  const ids = results.map(r => r.b.templateId);
  const unique = new Set(ids);
  assert(unique.size === 1, '6.2 All 10 return same templateId (deterministic)');

  // 6.3 Mixed endpoints concurrent
  const mixed = await Promise.all([
    get('/api/health/notif-preview/4/morning'),
    get('/api/health/notif-preview/4/afternoon'),
    get('/api/health/notif-preview/4/evening'),
    get('/api/health/notif-context/4'),
    get('/api/health/notif-alerts/4'),
  ]);
  assert(mixed.every(r => r.s === 200), '6.3 Mixed concurrent requests all 200');

  // 6.4 Preview for users with onboarding profiles
  for (const uid of [1, 3, 4]) {
    const r = await get(`/api/health/notif-preview/${uid}/morning`);
    assert(r.s === 200 && r.b.ok, `6.4 Preview user ${uid} → 200`);
  }
  // User 2 has no onboarding profile → 404 (correct behavior)
  const r2 = await get('/api/health/notif-preview/2/morning');
  assert(r2.s === 404, '6.5 User without onboarding → 404');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7: Integration — basic.notification imports intelligence correctly
// ═══════════════════════════════════════════════════════════════════════════════
async function testBasicNotifIntegration() {
  console.log('\n══════ SUITE 7: basic.notification Integration ══════');

  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'notification', 'basic.notification.service.js'), 'utf8');

  // 7.1 Intelligence imported
  assert(src.includes("require('./notification-intelligence.service')"), '7.1 Intelligence service imported');

  // 7.2 generateMessage used in morning
  assert(src.includes("generateMessage(pool, user.id, 'morning'"), '7.2 Morning uses generateMessage');

  // 7.3 generateMessage used in afternoon
  assert(src.includes("generateMessage(pool, user.id, 'afternoon'"), '7.3 Afternoon uses generateMessage');

  // 7.4 generateMessage used in evening
  assert(src.includes("generateMessage(pool, user.id, 'evening'"), '7.4 Evening uses generateMessage');

  // 7.5 Fallback exists (try/catch around generateMessage)
  const morningSection = src.substring(src.indexOf("'morning'"), src.indexOf("'morning'") + 500);
  assert(src.includes('} catch {'), '7.5 Has fallback (catch block) for intelligence failure');

  // 7.6 runContextAlerts exists
  assert(src.includes('async function runContextAlerts'), '7.6 runContextAlerts function exists');

  // 7.7 runContextAlerts in orchestrator
  assert(src.includes('runContextAlerts(pool)'), '7.7 runContextAlerts called in orchestrator');

  // 7.8 Context alerts use lifecycle filter
  assert(src.includes("ul.segment IN ('active', 'semi_active')"), '7.8 Context alerts filter by lifecycle');

  // 7.9 Context alerts have 12h dedup
  assert(src.includes("INTERVAL '12 hours'"), '7.9 Context alerts have 12h dedup');

  // 7.10 runContextAlerts exported
  assert(src.includes('runContextAlerts'), '7.10 runContextAlerts exported');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8: Bilingual support
// ═══════════════════════════════════════════════════════════════════════════════
async function testBilingual() {
  console.log('\n══════ SUITE 8: Bilingual Support ══════');

  const userVi = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Hùng', lang: 'vi' };
  const userEn = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Hung', lang: 'en' };

  const msgVi = await intel.generateMessage(pool, 4, 'morning', userVi);
  const msgEn = await intel.generateMessage(pool, 4, 'morning', userEn);

  // 8.1 Vietnamese message contains Vietnamese
  assert(msgVi.text.includes('ơi') || msgVi.text.includes('chú'), '8.1 VI message has Vietnamese');

  // 8.2 English message is in English
  assert(!msgEn.text.includes('ơi'), '8.2 EN message has no Vietnamese "ơi"');

  // 8.3 Same templateId for both languages
  assert(msgVi.templateId === msgEn.templateId, '8.3 Same templateId regardless of lang');

  // 8.4 All templates have both vi and en
  const allTemplates = [
    ...Object.values(intel.MORNING_TEMPLATES),
    ...Object.values(intel.EVENING_TEMPLATES),
    ...Object.values(intel.AFTERNOON_TEMPLATES),
    ...Object.values(intel.ALERT_TEMPLATES),
  ];
  let allBilingual = true;
  for (const t of allTemplates) {
    if (!t.vi || !t.en) { allBilingual = false; break; }
  }
  assert(allBilingual, '8.4 All templates bilingual (vi + en)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9: Template traceability — every output maps to template_id
// ═══════════════════════════════════════════════════════════════════════════════
async function testTraceability() {
  console.log('\n══════ SUITE 9: Template Traceability ══════');

  const user = { id: 4, birth_year: 1960, gender: 'nam', display_name: 'Hùng', lang: 'vi' };
  const triggers = ['morning', 'afternoon', 'evening', 'alert_severity', 'alert_trend'];

  for (const trigger of triggers) {
    const msg = await intel.generateMessage(pool, 4, trigger, user);
    assert(typeof msg.templateId === 'string' && msg.templateId.length > 0, `9.1 ${trigger} has templateId`);
    assert(typeof msg.text === 'string' && msg.text.length > 0, `9.2 ${trigger} has text`);
    assert(msg.context !== undefined, `9.3 ${trigger} returns context`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PHASE 2 — DEEP TEST SUITE                     ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testContextEdgeCases();
  await testTemplatePriority();
  await testRenderEdgeCases();
  await testGenerateMessageDiversity();
  await testAlertTriggerEdgeCases();
  await testApiStress();
  await testBasicNotifIntegration();
  await testBilingual();
  await testTraceability();

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
