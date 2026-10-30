'use strict';

// Offline replay of saved synthetic responses through the production generator.
// No .env is read and the provider function is replaced before importing it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8) || 'r2';
if (!/^[a-z0-9-]{1,24}$/.test(round)) throw new Error('Invalid round label');
const out = path.resolve(
  __dirname,
  '../../../..',
  'preview/checkin-conclusion-implementation-20261029' + (round === 'initial' ? '' : '-' + round)
);
const file = path.join(out, 'results.json');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const previous = new Map(report.cases.map((row) => [row.id, row]));
let current;
require('../../src/services/ai/ai.service').callTextAi = async () => {
  if (!current?.raw) throw new Error('A saved response is required; replay never calls a provider');
  return { content: current.raw, model: current.model, usage: current.usage };
};
const conclusion = require('../../src/core/checkin/triage-conclusion');
const { cases } = require('./cases.cjs');
// The synthetic factory makes this fixed first record exactly 48h old.
const clock = new Date(
  new Date(previous.get('head-0').facts.chi_so_7_ngay[0].measured_at).getTime() + 48 * 3600000
);
const ActualDate = Date;
let replayTime = clock.getTime();
// Freeze only this offline process to each original evaluation time. Relative
// dates and the 24h window must not drift when replaying a saved report later.
global.Date = class ReplayDate extends ActualDate {
  constructor(...args) {
    super(...(args.length ? args : [replayTime]));
  }
  static now() {
    return replayTime;
  }
};
async function main() {
  for (const item of cases(clock)) {
    current = previous.get(item.id);
    replayTime = new ActualDate(current.facts.evaluated_at || clock).getTime();
    const started = performance.now();
    current.output = await conclusion.generateStructuredConclusion(
      item.state,
      item.profile,
      item.lang,
      item.context
    );
    const parsed = JSON.parse(current.raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    current.rejected = conclusion.BLOCKS.map((block) => ({
      block,
      reason: conclusion.validateBlock(block, parsed[block], current.facts),
    })).filter((r) => r.reason);
    current.offlineReplayMs = Math.round((performance.now() - started) * 100) / 100;
  }
  report.metrics.fallbackCases = report.cases.filter((r) => r.rejected.length).length;
  report.metrics.fallbackBlocks = report.cases.reduce((n, r) => n + r.rejected.length, 0);
  report.revalidatedAt = new ActualDate().toISOString();
  report.revalidationNote =
    'The same saved provider responses were replayed offline through the final generator at their original evaluation times. This rechecks strict value/type/date binding, grounded relative dates, leading timestamps and conditional red flags after guard fixes. No additional external calls. Latencies remain the original live measurements; offline replay times are separate. Clinical review remains pending.';
  report.implementationSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, '../../src/core/checkin/triage-conclusion.js')))
    .digest('hex');
  report.guardsSha256 = crypto
    .createHash('sha256')
    .update(
      fs.readFileSync(path.join(__dirname, '../../src/core/checkin/triage-conclusion-guards.js'))
    )
    .digest('hex');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report.metrics));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
