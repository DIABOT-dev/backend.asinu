'use strict';

// Offline SRS audit: stored synthetic responses only. No dotenv, database,
// provider requests, notifications or clinical approval is performed here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8) || 'srs-acceptance';
if (!/^[a-z0-9-]{1,24}$/.test(round)) throw new Error('Invalid round');
const directory = path.resolve(
  __dirname,
  '../../../../preview/checkin-conclusion-implementation-20261029-' + round
);
const report = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
const previous = new Map(report.cases.map((item) => [item.id, item]));
const RealDate = Date;
const clock = new RealDate(
  new RealDate(previous.get('head-0').facts.chi_so_7_ngay[0].measured_at).getTime() + 48 * 3600000
);
let frozen = clock.getTime();
global.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [frozen]));
  }
  static now() {
    return frozen;
  }
};
let saved;
let rejected;
require('../../src/services/ai/ai.service').callTextAi = async () => {
  if (!saved?.raw) throw new Error('Offline response unavailable');
  return { content: saved.raw, model: saved.model, usage: saved.usage };
};
const logger = require('../../src/lib/logger');
logger.warn = (message, details) => {
  if (message === 'conclusion_rejected') rejected.push({ ...details });
};
logger.info = () => {};
const {
  generateStructuredConclusion,
  validateBlock,
} = require('../../src/core/checkin/triage-conclusion');
const { validatePresentation } = require('../../src/core/checkin/triage-conclusion-contract');
const { plain } = require('../../src/core/checkin/triage-conclusion-guards');
const { cases } = require('./cases.cjs');
function issuesFor(output, item, facts) {
  const issues = [];
  const fields = {
    loi_nhan: output.personalMessage,
    lien_quan: output.explanation,
    nen_lam: output.todo,
    di_kham_khi: output.seeDoctorWhen,
  };
  for (const [block, text] of Object.entries(fields)) {
    const issue = validateBlock(block, text, facts) || validatePresentation(block, text, facts);
    if (issue) issues.push({ requirement: 'FR-1 / §5 / §6', block, issue });
  }
  const expectedDisclaimer = require(`../../src/i18n/locales/${item.lang}.json`)[
    'checkin.conclusion.disclaimer'
  ];
  if (output.disclaimer !== expectedDisclaimer)
    issues.push({ requirement: 'FR-4', issue: 'disclaimer_not_exact' });
  if (output.followUpHours !== item.state.followUpHours)
    issues.push({ requirement: 'FR-1', issue: 'schedule_changed' });
  if (
    output.summary !== `${output.personalMessage} ${output.explanation}` ||
    output.recommendation !== [...output.todo, ...output.seeDoctorWhen].join('\n')
  )
    issues.push({ requirement: 'E9', issue: 'legacy_projection_changed' });
  if (
    output.speechText !==
      [output.personalMessage, ...output.seeDoctorWhen, output.closeMessage].join(' ') ||
    output.speechText.length > 1600
  )
    issues.push({ requirement: 'E7', issue: 'speech_blocks_or_budget' });
  if (item.lang === 'vi' && !plain(output.personalMessage).includes(plain(facts.xung_ho.goi)))
    issues.push({ requirement: 'E10 / §5', issue: 'patient_address_missing' });
  for (const condition of facts.benh_nen_da_khai) {
    const synonyms = /cao huyet ap/.test(plain(condition))
      ? ['cao huyet ap', 'tang huyet ap', 'hypertension']
      : /tieu duong/.test(plain(condition))
        ? ['tieu duong', 'dai thao duong', 'diabetes']
        : /mo mau cao/.test(plain(condition))
          ? ['mo mau cao', 'roi loan lipid mau', 'high cholesterol', 'dyslipidemia']
          : [plain(condition)];
    if (!synonyms.some((text) => plain(output.explanation).includes(text)))
      issues.push({ requirement: 'AC-2', issue: 'declared_condition_missing' });
  }
  return issues;
}
async function main() {
  const audited = [];
  for (const item of cases(clock)) {
    saved = previous.get(item.id);
    frozen = new RealDate(saved.facts.evaluated_at).getTime();
    rejected = [];
    const output = await generateStructuredConclusion(
      item.state,
      item.profile,
      item.lang,
      item.context
    );
    audited.push({
      id: item.id,
      lang: item.lang,
      state: item.state,
      facts: saved.facts,
      output,
      originalLiveRejections: saved.rejected,
      finalReplayRejections: rejected,
      issues: issuesFor(output, item, saved.facts),
      elapsedMs: saved.elapsedMs,
    });
  }
  const rejectedCases = audited.filter((item) => item.finalReplayRejections.length).length;
  const result = {
    auditedAt: new RealDate().toISOString(),
    offlineOnly: true,
    clinicalReview: 'pending',
    source:
      'Same saved live responses, replayed at the original evaluation time through current production generation and logging.',
    metrics: {
      cases: audited.length,
      finalOutputIssues: audited.reduce((n, item) => n + item.issues.length, 0),
      casesWithFinalOutputIssues: audited.filter((item) => item.issues.length).length,
      casesUsingFallback: rejectedCases,
      fallbackRate: rejectedCases / audited.length,
      ac4Pass: rejectedCases / audited.length < 0.1,
      p95Ms: report.metrics.p95Ms,
      within10s: report.metrics.within10s,
    },
    sourcesSha256: Object.fromEntries(
      [
        'triage-conclusion.js',
        'triage-conclusion-contract.js',
        'triage-conclusion-guards.js',
        'triage-conclusion-prompt.js',
      ].map((file) => [
        file,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.resolve(__dirname, '../../src/core/checkin', file)))
          .digest('hex'),
      ])
    ),
    cases: audited,
  };
  fs.writeFileSync(path.join(directory, 'srs-audit.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(result.metrics));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
