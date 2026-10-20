#!/usr/bin/env node
// Offline by default. --live sends only synthetic fixtures to the configured
// medical provider. No patient database, messages, notifications or approvals.
// Example: node scripts/eval-doctor-dialogue.js --live --models=medgemma-4b-it,medgemma-27b-it --max-cost=1
const fs = require('node:fs');
const path = require('node:path');
const allCases = require('../tests/fixtures/doctor-dialogue-cases');
const { gradeDialogueResult } = require('../src/services/integrations/doctor-dialogue-evaluation');
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || fallback;
const selectedIds = option('case-ids', '').split(',').filter(Boolean);
if (selectedIds.some((id) => !allCases.some((entry) => entry.id === id)))
  throw new Error('Unknown synthetic case ID.');
const cases = selectedIds.length
  ? allCases.filter((entry) => selectedIds.includes(entry.id))
  : allCases;
if (!args.includes('--live')) {
  process.stdout.write(
    `${JSON.stringify({ mode: 'offline', synthetic_cases: cases.length, case_ids: cases.map((entry) => entry.id) })}\n`
  );
} else {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const models = option('models', 'medgemma-4b-it,medgemma-27b-it').split(',');
  if (
    models.some(
      (model) =>
        !['medgemma-4b-it', 'medgemma-27b-it', 'baichuan-m3', 'clinical-camel'].includes(model)
    )
  )
    throw new Error('Select a medical model available on the configured provider.');
  const limit = Math.max(1, Math.min(cases.length, Number(option('limit', cases.length))));
  const maximumCost = Number(option('max-cost', 1));
  if (!Number.isFinite(maximumCost) || maximumCost <= 0 || maximumCost > 2)
    throw new Error('Set max-cost between 0 and 2 USD for this synthetic evaluation.');
  const outputFile = option('output', '/tmp/doctor-dialogue-evaluation.json');
  const contextPath = require.resolve('../src/services/integrations/doctor-context.service');
  const realContext = require(contextPath);
  let currentContext;
  require.cache[contextPath].exports = {
    ...realContext,
    loadDoctorClinicalContext: async () => currentContext,
  };
  const loggerPath = require.resolve('../src/services/ai/ai-logger.service');
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { logAiInteraction: async () => {} },
  };
  const { estimateCost } = require('../src/services/ai/ai-cost.service');
  const apiPath = require.resolve('../src/services/ai/ai.service');
  const api = require(apiPath);
  let spent = 0;
  let lastStart = 0;
  let calls = 0;
  let currentRaw;
  let creditRemaining;
  require.cache[apiPath].exports = {
    ...api,
    callTextAi: async (request) => {
      if (spent >= maximumCost) {
        const error = new Error('Evaluation budget reached.');
        error.code = 'EVALUATION_BUDGET_REACHED';
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 1500 - (Date.now() - lastStart)))
      );
      lastStart = Date.now();
      calls += 1;
      const response = await api.callTextAi(request);
      spent +=
        estimateCost({
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage?.prompt,
          outputTokens: response.usage?.completion,
        }) || 0;
      creditRemaining = response.credits_remaining;
      try {
        currentRaw = JSON.parse(
          response.content
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim()
        );
      } catch {
        currentRaw = null;
      }
      return response;
    },
  };
  const { createDoctorAiAssist } = require('../src/services/integrations/doctor-ai.service');
  const { AI_CONSENT_VERSION, AI_PROVIDERS } = require('../src/services/ai/ai-consent.service');
  const pool = {
    query: async (sql) => {
      if (!sql.includes('user_ai_consents'))
        throw new Error('Unexpected database query in synthetic evaluation');
      return { rows: [{ version: AI_CONSENT_VERSION, providers: AI_PROVIDERS, revoked_at: null }] };
    },
  };
  const run = async () => {
    const results = [];
    for (const model of models) {
      process.env.DOCTOR_AI_CHAT_MODEL = model;
      for (const entry of cases.slice(0, limit)) {
        if (spent >= maximumCost) break;
        const conversation = entry.turns.map(([role, message], i) => ({
          id: String(i + 1),
          role,
          message,
        }));
        currentContext = {
          profile: entry.profile,
          conversation,
          latest_patient_message: conversation.findLast((turn) => turn.role === 'patient'),
          blood_pressure: [],
          glucose: [],
          medications: [],
          symptoms: [],
          medical_records: [],
          checkins: [],
          missing_data: [],
          conflicts: [],
          health_timeline_markdown: '',
          context_version: String(
            conversation.findLast((turn) => turn.role === 'patient')?.id || '0'
          ),
          context_hash: 'a'.repeat(64),
        };
        const started = Date.now();
        const beforeCalls = calls;
        const beforeCost = spent;
        currentRaw = null;
        let result;
        try {
          const response = await createDoctorAiAssist(pool, {
            tenant_id: 'synthetic-evaluation',
            task_id: entry.id,
            app_user_id: '900000001',
            task_summary: conversation[0].message,
            touchpoint: entry.touchpoint,
            locale: 'vi',
            clinical_support: {
              rules: [],
              knowledge_chunks: [],
              retrieval_mode: 'none',
              policy_version: 'b'.repeat(64),
            },
          });
          const text = response.patient_reply || response.clarifying_questions.join(' ');
          const failures = gradeDialogueResult(entry, {
            text,
            understanding: currentRaw?.understanding,
            grounded: response.tools_used.includes('grounded_turn_understanding'),
          });
          result = {
            model,
            case_id: entry.id,
            ok: failures.length === 0,
            failures,
            text,
            understanding: currentRaw?.understanding || null,
            grounded: response.tools_used.includes('grounded_turn_understanding'),
            usage: response.usage,
          };
        } catch (error) {
          result = {
            model,
            case_id: entry.id,
            ok: false,
            failures: [error.code || 'unknown_error'],
            message: error.message,
          };
        }
        Object.assign(result, {
          model_calls: calls - beforeCalls,
          estimated_cost_usd: Number((spent - beforeCost).toFixed(6)),
          latency_ms: Date.now() - started,
        });
        results.push(result);
        const summary = models.map((name) => {
          const rows = results.filter((row) => row.model === name);
          return {
            model: name,
            total: rows.length,
            passed: rows.filter((row) => row.ok).length,
            calls: rows.reduce((sum, row) => sum + row.model_calls, 0),
            estimated_cost_usd: Number(
              rows.reduce((sum, row) => sum + row.estimated_cost_usd, 0).toFixed(6)
            ),
          };
        });
        fs.writeFileSync(
          outputFile,
          JSON.stringify(
            {
              scope: 'synthetic dialogue checks; clinical advice requires specialist review',
              checked_at: new Date().toISOString(),
              total_fixture_cases: cases.length,
              fixture_library_cases: allCases.length,
              maximum_cost_usd: maximumCost,
              estimated_cost_usd: Number(spent.toFixed(6)),
              credit_remaining: creditRemaining,
              summary,
              results,
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
        if (results.length % 10 === 0)
          process.stdout.write(
            `${JSON.stringify({ completed: results.length, model, last_case: entry.id, estimated_cost_usd: Number(spent.toFixed(6)) })}\n`
          );
        if (
          result.failures.includes('DOCTOR_AI_QUOTA_EXCEEDED') ||
          result.failures.includes('EVALUATION_BUDGET_REACHED')
        )
          break;
      }
    }
    process.stdout.write(
      `${JSON.stringify({ output: outputFile, estimated_cost_usd: Number(spent.toFixed(6)), cases: results.length })}\n`
    );
  };
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
