'use strict';
// Reproducible, synthetic-only planner benchmark. Default is offline: no API
// requests, patient data or writes. --live opts into Dr7 with a hard cost budget.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const live = process.argv.includes('--live');
const capArgument = process.argv.find(value => value.startsWith('--completion-cap='));
const completionCap = capArgument ? Number(capArgument.slice(17)) : null;
if (completionCap !== null) assert.ok(Number.isInteger(completionCap) && completionCap >= 40 && completionCap <= 1600);
const variant = 'operation-skills';
const baseline = '215ef8494b6cb16f6a8c7acd0a85ab05f1cbf077';
const budget = Math.min(0.20, Math.max(0, Number(process.env.ASSISTANT_SKILL_TEST_BUDGET || 0.20)));
const reportPath = live ? '/private/tmp/asinu-assistant-skills-live-20261115.json' : '/private/tmp/asinu-operation-skills-offline-20261115.json';
const cases = [...require('../tests/fixtures/assistant-skill-cases.cjs'),...require('../tests/fixtures/assistant-skill-negative.cjs')];
assert.ok(Number.isFinite(budget), 'Invalid budget');
let report = { live, baseline, budgetUsd: live ? budget : null, model: 'medgemma-27b-it',
  rates: { inputPer1k: 0.003, outputPer1k: 0.006, source: 'https://dr7.ai/docs' },
  limitations: ['Synthetic planner inputs; no patient DB access, apply, external message or purchase.', 'Offline responses are mocked and cannot measure actual tokens/credits.', 'Live comparison is a sample, not a guarantee for every future command.'], rows: [] };
let spent = 0, trace = [], calls = [], active, lastCall = 0;
const resume = live && process.argv.includes('--resume');
if (resume) {
  const saved = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(saved.baseline, baseline); assert.equal(saved.live, true);
  report = saved; spent = Number(saved.spentUsd);
  assert.ok(Number.isFinite(spent) && spent <= budget);
}
const onlyArgument = process.argv.find(arg => arg.startsWith('--only='));
const only = onlyArgument ? onlyArgument.slice(7).split(',') : null;
if (only) assert.ok(only.length && only.every(id => cases.some(c => c.id === id)), 'Only fixed synthetic cases are allowed');
process.env.JWT_SECRET = 'synthetic-benchmark-no-production-tokens';
process.env.REMINDER_ASSISTANT_ENABLED = 'true';
const ai = require('../src/services/ai/ai.service');
const realAi = ai.callTextAi;
function save() {
  report.spentUsd = live ? Number(spent.toFixed(8)) : null;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(reportPath, 0o600);
}
ai.callTextAi = async options => {
  if (completionCap !== null) options = {...options,maxTokens:Math.min(options.maxTokens,completionCap)};
  const size = Buffer.byteLength(options.system || '') + Buffer.byteLength(options.prompt || '');
  const record = { completionCap: options.maxTokens, characters: (options.system || '').length + (options.prompt || '').length, model: options.model };
  if (live) {
    if (options.model !== report.model) throw Error('Unexpected paid-test model');
    // Conservative byte/token bound plus maximum completion cost. Stop before
    // sending when remaining budget cannot cover this call; never auto-topup.
    const reserve = size * 0.003 / 1000 + options.maxTokens * 0.006 / 1000;
    if (spent + reserve > budget) throw Object.assign(Error('Budget reached before sending'), { code: 'TEST_BUDGET' });
    const pause = Math.max(0, 2200 - (Date.now() - lastCall));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    lastCall = Date.now();
    const result = await realAi(options);
    record.usage = result.usage;
    try { record.response = JSON.parse(String(result.content).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1')); }
    catch { record.response = String(result.content).slice(0, 500); }
    record.costUsd = (result.usage.prompt * 0.003 + result.usage.completion * 0.006) / 1000;
    if (!Number.isFinite(record.costUsd) || !(result.usage.prompt > 0)) throw Error('Provider omitted usage');
    spent += record.costUsd;
    if (result.credits_remaining != null) {
      record.creditsRemaining = Number(result.credits_remaining);
      if (report.creditBeforeEstimated == null) report.creditBeforeEstimated = record.creditsRemaining + record.costUsd;
      report.creditAfter = record.creditsRemaining;
    }
    calls.push(record);
    save();
    return result;
  }
  calls.push(record);
  let value;
  if (options.system.startsWith('Select only relevant skills')) value = { skills: [active.skill] };
  else if (options.system.startsWith('You interpret commands for ONE tool')) value = { status: 'ready', question: '', changes: [{slot:'evening',action:'set',time:'20:30',evidence:active.text}] };
  else if (/^(?:Review |Independently review)/u.test(options.system)) value = { approved: true };
  else if (active.expectNoActions) value = {status:'clarify',question:'Bạn nói rõ thêm thông tin giúp mình nhé.',actions:[]};
  else value = /Select Asinu skills/.test(options.system) ? {status:'ready',calls:active.actions.map(action=>require('../src/services/assistant/skills').manager.callForAction(action))} : { status: 'ready', actions: active.actions };
  return { content: JSON.stringify(value) };
};
// Synthetic preferences only, installed before the clock helper imports them.
const schedule = require('../src/services/notification/smart.schedule.service');
schedule.getPreferences = async () => ({ reminders_enabled:true,morning_time:'08:00',afternoon_time:'13:00',evening_time:'19:00',
  effective_morning_time:'08:00',effective_afternoon_time:'13:00',effective_evening_time:'19:00' });
schedule.updatePreferences = async () => { throw Error('Writes prohibited'); };
const medication = require('../src/services/assistant/medication-assistant.service');
medication.contextForPlan = async () => ({ available:true,items:[],schedules:[],doses:[] });
const prepareMed = medication.prepare;
medication.prepare = (actions,...args) => { trace.push(...actions.filter(medication.isMedication)); return prepareMed(actions,...args); };
const prepareMedWithPurpose = medication.prepareWithPurpose;
medication.prepareWithPurpose = async (db, actions, ...args) => { trace.push(...actions.filter(medication.isMedication)); return prepareMedWithPurpose(db, actions, ...args); };
// Purpose integration is exercised separately against manufacturer fixtures;
// this planner benchmark must never access patient DBs or external catalogs.
require('../src/services/v21/medication-purpose.service').lookup = async () => ({ status: 'not_found', tags: [] });
const tools = require('../src/services/assistant/app-tools.service');
tools.profileContext = async () => ({ name:'Người thử',chronicDiseases:[],version:'synthetic:1' });
tools.query = async (_db,_owner,action) => { trace.push(action); return 'Synthetic read result'; };
const prepareReminders = tools.prepareReminders;
tools.prepareReminders = async (...args) => { trace.push(args[2]); return prepareReminders(...args); };
const profile = require('../src/services/assistant/profile-assistant.service');
const prepareProfile = profile.prepare;
profile.prepare = (action,...args) => { trace.push(action); return prepareProfile(action,...args); };
const domains = require('../src/services/assistant/domain-tools.service');
domains.prepare = async (_db,_owner,raw) => {
  const action = require('../src/services/assistant/domain-tools.schema').parse(raw);
  trace.push(action);
  return {action:{type:'app_tool',tool:raw.tool,label:'synthetic preview',planToken:'synthetic-only'}};
};
const current = require('../src/services/assistant/app-assistant.service');
const filename = path.resolve(__dirname, '../src/services/assistant/app-assistant.service.js');
const previous = new Module(filename, module);
previous.filename = filename;
previous.paths = Module._nodeModulePaths(path.dirname(filename));
previous._compile(execFileSync('git',['show',baseline + ':src/services/assistant/app-assistant.service.js'],{encoding:'utf8'}),filename);
const { withPublicAiTemplate } = require('../src/services/ai/ai-consent.service');
function matches(actual, expected) {
  if (expected.type !== actual.type) return false;
  if (expected.type === 'app_tool') {
    if (expected.tool !== actual.tool) return false;
    const parameters = {...actual.parameters};
    if (expected.tool === 'checkin.conclusion' && expected.parameters.speak === undefined && parameters.speak === false) delete parameters.speak;
    if (expected.parameters.target === 'mới nhất' && ['latest','newest','mới nhất','moi nhat'].includes(parameters.target)) parameters.target = 'mới nhất';
    try { assert.deepEqual(parameters,expected.parameters); return true; } catch { return false; }
  }
  return Object.entries(expected).filter(([key]) => key !== 'evidence').every(([key,value]) => {
    if (key === 'value' && expected.type === 'font_size' && value === 'increase') return actual.value === 'large';
    try { assert.deepEqual(actual[key],value); return true; } catch { return false; }
  });
}
async function measure(version, scenario) {
  active = scenario; trace = []; calls = [];
  const start = Date.now();
  let status = 'pass', error, message;
  try {
    const service = version === 'before' ? previous.exports : current;
    const result = await withPublicAiTemplate(() => service.plan({text:scenario.text,current:{language:'vi',fontSize:'normal'}},'vi',{
      userId:7,pool:{query(){throw Error('Patient DB access prohibited');},connect(){throw Error('Patient DB access prohibited');}},
    }));
    assert.ok((scenario.expectNoActions ? ['clarify','unsupported'] : ['ready','answer']).includes(result.status), result.question || result.status);
    trace.push(...result.actions.filter(action => ['water','blood_pressure','glucose','meal','language','font_size','navigate'].includes(action.type)));
    assert.equal(trace.length,scenario.actions.length, 'Added or omitted task');
    if (live && version==='after' && process.argv.includes('--require-skill-calls') && calls.length) assert.ok(calls.some(call=>Array.isArray(call.response?.calls)&&call.response.calls.length),'Model did not invoke named skill');
    for (const expected of scenario.actions) assert.ok(trace.some(action=>matches(action,expected)), 'Incorrect action or parameters');
    if (scenario.id === 'reminders.evening') assert.equal(result.actions[0].changes[0].time,'20:30');
  } catch(reason) { status = 'fail'; error = reason.code || reason.name; message = reason.message; }
  const row = {id:scenario.id,skill:scenario.skill,version,variant:version==='before'?'all-instructions':variant,status,...(error?{error,message,trace}:{}),ms:Date.now()-start,
    calls:calls.length,characters:calls.reduce((n,c)=>n+c.characters,0),
    ...(live?{inputTokens:calls.reduce((n,c)=>n+c.usage.prompt,0),outputTokens:calls.reduce((n,c)=>n+c.usage.completion,0),costUsd:calls.reduce((n,c)=>n+c.costUsd,0)}:{}),details:calls};
  report.rows.push(row); save();
  console.log(JSON.stringify({...row,details:undefined}));
  if (row.error === 'TEST_BUDGET') throw Error('TEST_BUDGET');
}
function comparisons() {
  const pairs = [];
  for (const before of report.rows.filter(row=>row.version==='before'&&row.status==='pass')) {
    const after = report.rows.filter(row=>row.id===before.id&&row.version==='after'&&row.status==='pass').at(-1);
    if (after) pairs.push({id:before.id,before,after});
  }
  const percent = (before,after) => before ? Number((100*(1-after/before)).toFixed(2)) : null;
  const total = (rows,key) => rows.reduce((n,row)=>n+(row[key]||0),0);
  const summarize = values => ({pairedCommands:values.length,
    characterReductionPercent:percent(total(values.map(p=>p.before),'characters'),total(values.map(p=>p.after),'characters')),
    ...(live?{inputTokenReductionPercent:percent(total(values.map(p=>p.before),'inputTokens'),total(values.map(p=>p.after),'inputTokens')),
      costReductionPercent:percent(total(values.map(p=>p.before),'costUsd'),total(values.map(p=>p.after),'costUsd')),
      beforeUsd:total(values.map(p=>p.before),'costUsd'),afterUsd:total(values.map(p=>p.after),'costUsd')}:{}),
  });
  report.comparison = summarize(pairs);
  report.comparisonWithAi = summarize(pairs.filter(p=>p.after.calls>0));
  report.comparison.mixedVariants = new Set(pairs.map(p=>p.after.variant||'grouped-skills')).size>1;
  report.comparisonByVariant = {};
  for (const name of new Set(report.rows.filter(row=>row.version==='after').map(row=>row.variant||'grouped-skills'))) {
    const ownPairs = [];
    for (const before of report.rows.filter(row=>row.version==='before'&&row.status==='pass')) {
      const after = report.rows.filter(row=>row.id===before.id&&row.version==='after'&&row.status==='pass'&&(row.variant||'grouped-skills')===name).at(-1);
      if (after) ownPairs.push({id:before.id,before,after});
    }
    report.comparisonByVariant[name] = summarize(ownPairs);
  }
  const latest = new Map(report.rows.map(row=>[row.version+':'+row.id,row]));
  report.validation = {latestPassed:[...latest.values()].filter(row=>row.status==='pass').length,latestFailed:[...latest.values()].filter(row=>row.status!=='pass').length,historicalFailedAttempts:report.rows.filter(row=>row.status!=='pass').length};
}
(async()=>{
  const paidIds = ['journal.conversational','medication.conversational','profile.height','settings.font','reminders.evening','notifications.list',
    'checkin.conclusion','calls.personalize','family.health','coins.balance','gifts.open','early_signal.latest','feed.search','subscription.upgrade','app.guide',
    'mixed.water-language','journal.explicit','medication.explicit'];
  const beforeIds = resume || only ? [] : live ? ['journal.conversational','medication.conversational','settings.font','journal.explicit','medication.explicit'] : cases.map(c=>c.id);
  try {
    for (const id of beforeIds) await measure('before',cases.find(c=>c.id===id));
    for (const scenario of only ? only.map(id=>cases.find(c=>c.id===id)) : live ? paidIds.map(id=>cases.find(c=>c.id===id)) : cases) await measure('after',scenario);
  } finally { comparisons(); save(); }
  console.log(JSON.stringify({reportPath,live,spentUsd:report.spentUsd,comparison:report.comparison,comparisonWithAi:report.comparisonWithAi,
    passed:report.rows.filter(r=>r.status==='pass').length,failed:report.rows.filter(r=>r.status!=='pass').length}));
  const latest = new Map(report.rows.map(row=>[row.version+':'+row.id,row]));
  if ([...latest.values()].some(row=>row.status!=='pass')) process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
