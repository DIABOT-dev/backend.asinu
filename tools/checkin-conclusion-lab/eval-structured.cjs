'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { withPublicAiTemplate } = require('../../src/services/ai/ai-consent.service');
const ai = require('../../src/services/ai/ai.service');
const originalCall = ai.callTextAi;
let captured;
let providerError;
let rejectedByGenerator = [];
const logger = require('../../src/lib/logger');
const originalWarn = logger.warn;
logger.warn = (message, detail) => {
  if (message === 'conclusion_rejected') rejectedByGenerator.push({ ...detail });
  originalWarn(message, detail);
};
// This isolated process observes calls without changing the running app or
// introducing a test bypass in production. Only fixed synthetic cases follow.
ai.callTextAi = async (options) => {
  try {
    captured = await originalCall(options);
  } catch (error) {
    providerError = error;
    throw error;
  }
  return captured;
};
const conclusion = require('../../src/core/checkin/triage-conclusion');
const { validatePresentation } = require('../../src/core/checkin/triage-conclusion-contract');
const { cases } = require('./cases.cjs');
const fixed = require('./fixture.json');
const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8) || 'initial';
if (!/^[a-z0-9-]{1,24}$/.test(round)) throw new Error('Invalid round label');
const creditBefore = process.argv.find((arg) => arg.startsWith('--credit-before='))?.slice(16);
if (creditBefore !== undefined && !/^\d+(?:\.\d+)?$/.test(creditBefore))
  throw new Error('Invalid initial credit balance');
const out = path.resolve(
  __dirname,
  '../../../..',
  'preview/checkin-conclusion-implementation-20261029' + (round === 'initial' ? '' : '-' + round)
);

async function main() {
  if (!process.argv.includes('--live'))
    throw new Error('--live required for the 3 revised + 30 acceptance requests');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, 'results.json');
  const report = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {
        syntheticDataOnly: true,
        founderDirection:
          'User explicitly approved P2 with the proposed measurement rules in this conversation.',
        clinicalReview: 'pending',
        startedAt: new Date().toISOString(),
        ...(creditBefore !== undefined ? { creditBefore: Number(creditBefore) } : {}),
        revisedPrompt: [],
        cases: [],
      };
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  const facts = {
    ...fixed,
    viec_da_ke: [],
    tuan_thu_thuoc_7_ngay: null,
    assessment_incomplete: false,
  };
  fs.writeFileSync(path.join(out, 'p2-revised.txt'), conclusion.buildConclusionPrompt(facts));
  for (let run = 1; run <= 3; run++) {
    if (report.revisedPrompt.some((r) => r.run === run)) continue;
    const start = Date.now();
    const response = await withPublicAiTemplate(() =>
      originalCall({
        system: conclusion.buildConclusionSystem(facts),
        prompt: conclusion.buildConclusionPrompt(facts),
        provider: 'medgemma',
        strictProvider: true,
        model: 'medgemma-27b-it',
        temperature: 0.2,
        maxTokens: 700,
        timeoutMs: 10000,
        maxRetries: 0,
      })
    );
    const parsed = JSON.parse(
      response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    );
    const rejected = conclusion.BLOCKS.map((block) => ({
      block,
      reason:
        conclusion.validateBlock(block, parsed[block], facts) ||
        validatePresentation(block, parsed[block], facts),
    })).filter((x) => x.reason);
    report.revisedPrompt.push({
      run,
      raw: response.content,
      rejected,
      elapsedMs: Date.now() - start,
      model: response.model,
      usage: response.usage,
      creditsRemaining: response.credits_remaining ?? null,
    });
    save();
    console.log(JSON.stringify({ stage: 'revised', run, rejected, ms: Date.now() - start }));
  }
  if (process.argv.includes('--revised-only')) return;
  for (const item of cases()) {
    if (report.cases.some((r) => r.id === item.id)) continue;
    captured = null;
    providerError = null;
    rejectedByGenerator = [];
    const start = Date.now();
    const output = await withPublicAiTemplate(() =>
      conclusion.generateStructuredConclusion(item.state, item.profile, item.lang, item.context)
    );
    let parsed;
    try {
      parsed = JSON.parse(
        captured?.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      );
    } catch {}
    const facts = conclusion.buildConclusionFacts(
      item.state,
      item.profile,
      item.context,
      item.lang
    );
    const rawRejected = conclusion.BLOCKS.map((block) => ({
      block,
      reason:
        conclusion.validateBlock(block, parsed?.[block], facts) ||
        validatePresentation(block, parsed?.[block], facts),
    })).filter((x) => x.reason);
    const rejected = rejectedByGenerator;
    report.cases.push({
      id: item.id,
      lang: item.lang,
      facts,
      state: {
        severity: item.state.severity,
        needsDoctor: item.state.needsDoctor,
        needsFamilyAlert: item.state.needsFamilyAlert,
        followUpHours: item.state.followUpHours,
      },
      raw: captured?.content || null,
      output,
      rejected,
      rawRejected,
      elapsedMs: Date.now() - start,
      model: captured?.model,
      usage: captured?.usage,
      creditsRemaining: captured?.credits_remaining ?? null,
    });
    save();
    if ([401, 402, 403].includes(providerError?.status)) throw providerError;
    console.log(
      JSON.stringify({ stage: 'acceptance', id: item.id, rejected, ms: Date.now() - start })
    );
  }
  const timings = report.cases.map((r) => r.elapsedMs).sort((a, b) => a - b);
  report.metrics = {
    count: report.cases.length,
    fallbackCases: report.cases.filter((r) => r.rejected.length).length,
    fallbackBlocks: report.cases.reduce((n, r) => n + r.rejected.length, 0),
    p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
    within10s: timings.filter((n) => n <= 10000).length,
    totalTokens: [...report.revisedPrompt, ...report.cases].reduce(
      (n, r) => n + (r.usage?.total || 0),
      0
    ),
  };
  const responses = [...report.revisedPrompt, ...report.cases];
  const balance = (value) =>
    value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  let previousBalance = balance(report.creditBefore);
  for (const response of responses) {
    const remaining = balance(response.creditsRemaining);
    response.observedAccountDebit =
      previousBalance !== null && remaining !== null
        ? Number((previousBalance - remaining).toFixed(6))
        : null;
    previousBalance = remaining;
  }
  report.creditCheck = {
    source: 'x-dr7-credit-remaining response header',
    before: balance(report.creditBefore),
    after: previousBalance,
    observedAccountDebit:
      balance(report.creditBefore) !== null && previousBalance !== null
        ? Number((Number(report.creditBefore) - previousBalance).toFixed(6))
        : null,
    note: 'Account balance differences can include concurrent requests. Token-based estimates and observed account debits are separate; neither reveals an independently audited invoice.',
  };
  save();
  console.log(JSON.stringify(report.metrics));
}
main().catch((e) => {
  console.error(JSON.stringify({ name: e.name, code: e.code || null, status: e.status || null }));
  process.exitCode = 1;
});
