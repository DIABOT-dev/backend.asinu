'use strict';

// Calls the current planner and reviewer with fixed synthetic fixtures. Database
// access, applying actions, and network access outside the configured AI API fail.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getClinicalConfig } = require('../src/services/ai/providers/clinical-config');
const cases = [
  ...require('../tests/fixtures/assistant-skill-cases.cjs'),
  ...require('../tests/fixtures/assistant-skill-negative.cjs'),
];
assert.ok(process.argv.includes('--live'), 'Use --live to measure actual 9Router usage.');
const config = getClinicalConfig();
assert.equal(config.provider, '9router');
assert.ok(config.endpoint && config.apiKey && config.model);
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = argument('only')?.split(',');
if (only) assert.ok(only.every(id => cases.some(scenario => scenario.id === id)), 'Unknown fixture');
const selected = only ? only.map(id => cases.find(scenario => scenario.id === id)) : cases;
const reportPath = path.resolve(argument('report') || '../reports/agent-tokens-20261117/results.json');
assert.ok(!fs.existsSync(reportPath), 'Choose a new report filename to preserve earlier runs.');
fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
process.env.JWT_SECRET = 'synthetic-agent-token-benchmark-only';
process.env.REMINDER_ASSISTANT_ENABLED = 'true';

const report = {
  startedAt: new Date().toISOString(),
  provider: config.provider,
  endpoint: config.endpoint,
  requestedModel: config.model,
  scope: 'Current app assistant planner, router, semantic reviewer, and nested routine-reminder planner/reviewer.',
  limitations: [
    'Fixed synthetic requests and synthetic saved state; no patient database or action execution.',
    'Tokens are usage values returned by 9Router, not a separately verified billable-token count.',
    'Failed or cancelled upstream requests may consume tokens without returning usage.',
    'No USD estimate: Dr7 prices do not apply to this gateway.',
    'One run per fixture; actual history, context, retries, and wording can change usage.',
  ],
  selectedCases: selected.length,
  limits: { apiRequests: 250, reportedTokens: 1_000_000 },
  rows: [],
  apiRequests: [],
};
let active;
let trace = [];

function sumUsage(requests) {
  return requests.reduce((total, request) => {
    if (request.usage) {
      total.input += request.usage.prompt_tokens || 0;
      total.output += request.usage.completion_tokens || 0;
      total.total += request.usage.total_tokens ??
        (request.usage.prompt_tokens || 0) + (request.usage.completion_tokens || 0);
      total.withUsage++;
    } else total.withoutUsage++;
    return total;
  }, { input: 0, output: 0, total: 0, withUsage: 0, withoutUsage: 0 });
}

function save() {
  report.totals = {
    ...sumUsage(report.apiRequests),
    apiRequests: report.apiRequests.length,
    completedCases: report.rows.length,
    passedCases: report.rows.filter(row => row.passed).length,
    failedCases: report.rows.filter(row => !row.passed).length,
    zeroTokenCases: report.rows.filter(row => !row.apiRequests).length,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

// Observe HTTP usage as well as successful service results. This retains usage
// for a malformed model answer even if the planner subsequently rejects it.
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  assert.equal(String(url), config.endpoint, 'Unexpected outbound request');
  if (report.apiRequests.length >= report.limits.apiRequests ||
      sumUsage(report.apiRequests).total >= report.limits.reportedTokens)
    throw Object.assign(new Error('Benchmark request/token limit reached'), { code: 'BENCHMARK_LIMIT' });
  const body = JSON.parse(options.body);
  const request = {
    case: active.id,
    stage: active.stage,
    requestedModel: body.model,
    maxOutputTokens: body.max_tokens,
    requestCharacters: body.messages.reduce((n, turn) => n + String(turn.content).length, 0),
    startedAt: new Date().toISOString(),
  };
  report.apiRequests.push(request);
  const start = Date.now();
  try {
    const response = await realFetch(url, options);
    request.status = response.status;
    const data = await response.clone().json().catch(() => null);
    if (data) {
      request.responseId = data.id;
      request.returnedModel = data.model;
      request.usage = data.usage || null;
      request.finishReason = data.choices?.[0]?.finish_reason;
      request.syntheticReply = data.choices?.[0]?.message?.content;
    }
    return response;
  } catch (error) {
    request.error = error.code || error.name;
    throw error;
  } finally {
    request.ms = Date.now() - start;
    save();
  }
};

const ai = require('../src/services/ai/ai.service');
const realAi = ai.callTextAi;
ai.callTextAi = async options => {
  const system = options.system || '';
  active.stage = system.startsWith('Select only relevant skills') ? 'router'
    : system.startsWith('You interpret commands for ONE tool') ? 'reminder_planner'
      : system.startsWith('Review a routine-reminder') ? 'reminder_review'
        : /^(?:Review |Independently review)/u.test(system) ? 'review' : 'planner';
  // Preserve the application's actual model, timeout, output cap and retries.
  return realAi(options);
};

// Install synthetic dependencies before importing modules that capture them.
const schedule = require('../src/services/notification/smart.schedule.service');
schedule.getPreferences = async () => ({
  reminders_enabled: true, morning_time: '08:00', afternoon_time: '13:00', evening_time: '19:00',
  effective_morning_time: '08:00', effective_afternoon_time: '13:00', effective_evening_time: '19:00',
});
const prohibited = () => { throw new Error('Database access and writes are prohibited in this benchmark'); };
schedule.updatePreferences = prohibited;
const db = { query: prohibited, connect: prohibited };
const medication = require('../src/services/assistant/medication-assistant.service');
medication.contextForPlan = async () => ({ available: true, items: [], schedules: [], doses: [] });
const prepareMedication = medication.prepareWithPurpose;
medication.prepareWithPurpose = async (_db, actions, ...args) => {
  trace.push(...actions.filter(medication.isMedication));
  return prepareMedication(db, actions, ...args);
};
require('../src/services/v21/medication-purpose.service').lookup = async () => ({ status: 'not_found', tags: [] });
const tools = require('../src/services/assistant/app-tools.service');
tools.profileContext = async () => ({ name: 'Người thử', chronicDiseases: [], version: 'synthetic:1' });
tools.query = async (_db, _owner, action) => { trace.push(action); return 'Synthetic read result'; };
const prepareReminders = tools.prepareReminders;
tools.prepareReminders = async (...args) => { trace.push(args[2]); return prepareReminders(...args); };
const profile = require('../src/services/assistant/profile-assistant.service');
const prepareProfile = profile.prepare;
profile.prepare = (action, ...args) => { trace.push(action); return prepareProfile(action, ...args); };
const domains = require('../src/services/assistant/domain-tools.service');
domains.prepare = async (_db, _owner, raw) => {
  const action = require('../src/services/assistant/domain-tools.schema').parse(raw);
  trace.push(action);
  return { action: { type: 'app_tool', tool: raw.tool, label: 'synthetic preview', planToken: 'synthetic-only' } };
};
const assistant = require('../src/services/assistant/app-assistant.service');
const { withPublicAiTemplate } = require('../src/services/ai/ai-consent.service');

function matches(actual, expected) {
  if (expected.type !== actual.type) return false;
  if (expected.type === 'app_tool') {
    if (expected.tool !== actual.tool) return false;
    const parameters = { ...actual.parameters };
    if (expected.tool === 'checkin.conclusion' && expected.parameters.speak === undefined && parameters.speak === false)
      delete parameters.speak;
    if (expected.parameters.target === 'mới nhất' && ['latest', 'newest', 'mới nhất', 'moi nhat'].includes(parameters.target))
      parameters.target = 'mới nhất';
    try { assert.deepEqual(parameters, expected.parameters); return true; } catch { return false; }
  }
  return Object.entries(expected).filter(([key]) => key !== 'evidence').every(([key, value]) => {
    if (key === 'value' && expected.type === 'font_size' && value === 'increase') return actual.value === 'large';
    try { assert.deepEqual(actual[key], value); return true; } catch { return false; }
  });
}

async function measure(scenario) {
  active = { id: scenario.id, stage: '' };
  trace = [];
  const start = Date.now();
  const before = report.apiRequests.length;
  const row = { id: scenario.id, group: scenario.skill, text: scenario.text, negative: Boolean(scenario.expectNoActions), passed: false };
  try {
    const result = await withPublicAiTemplate(() => assistant.plan({
      text: scenario.text, current: { language: 'vi', fontSize: 'normal' },
    }, 'vi', { pool: db, userId: 7 }));
    row.resultStatus = result.status;
    row.question = result.question || '';
    assert.ok((scenario.expectNoActions ? ['clarify', 'unsupported'] : ['ready', 'answer']).includes(result.status),
      result.question || result.status);
    trace.push(...result.actions.filter(action => ['water', 'blood_pressure', 'glucose', 'meal', 'language', 'font_size', 'navigate'].includes(action.type)));
    assert.equal(trace.length, scenario.actions.length, 'Added or omitted task');
    for (const expected of scenario.actions) assert.ok(trace.some(action => matches(action, expected)), 'Incorrect action or parameters');
    if (scenario.id === 'reminders.evening') assert.equal(result.actions[0].changes[0].time, '20:30');
    row.passed = true;
  } catch (error) {
    row.error = error.code || error.name;
    row.message = error.message;
  }
  row.trace = trace;
  row.ms = Date.now() - start;
  const requests = report.apiRequests.slice(before);
  row.apiRequests = requests.length;
  row.tokens = sumUsage(requests);
  report.rows.push(row);
  save();
  console.log(JSON.stringify({ completed: report.rows.length, of: selected.length, ...row, trace: undefined, text: undefined }));
  if (row.error === 'BENCHMARK_LIMIT') throw new Error('Benchmark limit reached');
}

(async () => {
  save();
  for (const scenario of selected) await measure(scenario);
  report.finishedAt = new Date().toISOString();
  report.groups = {};
  for (const row of report.rows) {
    const group = report.groups[row.group] ||= { cases: 0, passed: 0, apiRequests: 0, input: 0, output: 0, total: 0 };
    group.cases++; group.passed += Number(row.passed); group.apiRequests += row.apiRequests;
    for (const key of ['input', 'output', 'total']) group[key] += row.tokens[key];
  }
  save();
  console.log(JSON.stringify({ reportPath, totals: report.totals, groups: report.groups }));
  if (report.rows.some(row => !row.passed)) process.exitCode = 1;
})().catch(error => {
  report.stoppedAt = new Date().toISOString();
  report.stopReason = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
});
