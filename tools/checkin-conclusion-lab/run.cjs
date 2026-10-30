'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, prompts, root, sourceSha256 } = require('./prompts.cjs');
const { evaluate } = require('./guardrails.cjs');
const { buildReport } = require('./report.cjs');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const out = path.resolve(__dirname, '../../../..', 'preview/checkin-conclusion-20261029');
const model = 'medgemma-27b-it';
const settings = { model, temperature: 0.2, maxTokens: 700, timeoutMs: 60000, retries: 0 };
const digest = crypto
  .createHash('sha256')
  .update(JSON.stringify({ fixture, prompts, settings }))
  .digest('hex');

async function main() {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const resultsFile = path.join(out, 'results.json');
  const report = fs.existsSync(resultsFile)
    ? JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
    : {
        status: 'founder_review_pending',
        syntheticDataOnly: true,
        startedAt: new Date().toISOString(),
        digest,
        sourceSha256,
        endpoint: process.env.MEDGEMMA_ENDPOINT || null,
        settings,
        fixture,
        prompts,
        results: [],
      };
  if (report.digest !== digest)
    throw new Error('Lab input changed. Archive previous results before rerunning.');
  // Report-only mode makes no external request and never reads a patient record.
  if (!process.argv.includes('--live')) {
    buildReport(report, out);
    console.log('Report prepared. --live explicitly enables up to 15 fixed synthetic requests.');
    return;
  }
  const endpoint = new URL(process.env.MEDGEMMA_ENDPOINT || '');
  if (endpoint.protocol !== 'https:' || !process.env.MEDGEMMA_API_KEY)
    throw new Error('Configured HTTPS medical endpoint/key required.');
  const { callMedGemma } = require('../../src/services/ai/providers/medgemma');
  const { withPublicAiTemplate } = require('../../src/services/ai/ai-consent.service');
  fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture, null, 2));
  fs.writeFileSync(path.join(out, 'prompts.json'), JSON.stringify(prompts, null, 2));
  for (let run = 1; run <= 3; run++) {
    for (const prompt of prompts) {
      if (report.results.some((r) => r.promptId === prompt.id && r.run === run)) continue;
      const started = performance.now();
      const result = {
        promptId: prompt.id,
        run,
        requestedModel: model,
        startedAt: new Date().toISOString(),
      };
      try {
        // These prompts and the only fixture are fixed nonpersonal text. No
        // patient/user input, HTTP handlers, DB reads, or consent settings are
        // exposed here. Public-template context is limited to this exact call.
        const response = await withPublicAiTemplate(() =>
          callMedGemma({
            prompt: prompt.prompt,
            system: prompt.system,
            ...settings,
          })
        );
        Object.assign(result, {
          raw: response.reply,
          returnedModel: response.meta.model,
          usage: response.meta.tokens_used,
          creditsRemaining: response.meta.credits_remaining,
        });
        result.evaluation = evaluate(result.raw, fixture, prompt.id);
        if (result.returnedModel !== model) {
          result.evaluation.passed = false;
          result.evaluation.rejected.push({
            event: 'conclusion_rejected',
            block: 'response',
            reason: 'provider_model_mismatch',
          });
        }
      } catch (e) {
        result.error = { name: e.name, code: e.code || null, status: e.status || null };
        result.evaluation = {
          passed: false,
          rejected: [
            {
              event: 'conclusion_rejected',
              block: 'response',
              reason: e.name === 'AbortError' ? 'provider_timeout' : 'provider_error',
            },
          ],
          warnings: [],
        };
      }
      result.elapsedSeconds = Math.round((performance.now() - started) / 10) / 100;
      result.within10Seconds = result.elapsedSeconds <= 10;
      report.results.push(result);
      report.updatedAt = new Date().toISOString();
      // Persist after each request. Restart resumes; no implicit paid retries.
      fs.writeFileSync(resultsFile, JSON.stringify(report, null, 2), { mode: 0o600 });
      buildReport(report, out);
      console.log(
        JSON.stringify({
          prompt: prompt.id,
          run,
          seconds: result.elapsedSeconds,
          model: result.returnedModel || null,
          tokens: result.usage?.total || null,
          passed: result.evaluation.passed,
          reasons: result.evaluation.rejected.map((r) => r.reason),
          error: result.error || null,
        })
      );
      if ([401, 402, 403].includes(result.error?.status)) {
        console.log(
          'Stopped on authentication/credit error. No fallback to another provider/model.'
        );
        return;
      }
    }
  }
  console.log(
    `Completed ${report.results.length}/15. Founder selection and clinical review are still pending.`
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
