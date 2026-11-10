'use strict';

// A fixed synthetic case only. No patient records, notifications, or DB writes.
const assert = require('node:assert/strict');
const { withPublicAiTemplate } = require('./src/services/ai/ai-consent.service');
const { generateConclusion } = require('./src/core/checkin/triage-ai-layer');
const { structuredConclusionEnabled } = require('./src/core/checkin/triage-conclusion-release');
const preflight = process.argv.includes('--preflight');
if (preflight) process.env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED = 'true';

(async () => {
  assert.equal(structuredConclusionEnabled(), true);
  const host = new URL(process.env.MEDGEMMA_ENDPOINT).hostname;
  assert.match(host, /(?:^|\.)dr7\.ai$/);
  const state = {
    allSymptoms: ['đầy hơi', 'khó tiêu'],
    currentSymptoms: ['đầy hơi', 'khó tiêu'],
    onset: 'Từ 1 đến dưới 3 ngày',
    progression: 'same',
    severity: 'medium',
    needsDoctor: false,
    followUpHours: 6,
    redFlagsFound: [],
    conditions: [],
  };
  const started = Date.now();
  const result = await withPublicAiTemplate(() =>
    generateConclusion(
      state,
      { age: 40, gender: 'male', full_name: 'Người thử nghiệm' },
      'vi',
      null,
      {},
      { conclusionFormat: 'narrative' }
    )
  );
  assert.equal(result.conclusionVersion, 2);
  assert.equal(result.conclusionFormat, 'narrative');
  assert.equal(result.conclusionSource, 'ai');
  assert.ok(
    result.narrative.length >= 2000 && result.narrative.length <= 2500,
    'The main conclusion must match the requested 2000–2500 character range'
  );
  assert.equal(
    result.speechText,
    require('./src/core/checkin/triage-conclusion-speech').conclusionSpeech(result),
    'Speech must contain the complete visible conclusion and advice'
  );
  assert.ok(result.disclaimer && result.aiNotice && result.speechText);
  console.log(
    JSON.stringify({
      synthetic: true,
      preflight,
      provider_host: host,
      conclusion_version: result.conclusionVersion,
      conclusion_format: result.conclusionFormat,
      source: result.conclusionSource,
      narrative_chars: result.narrative.length,
      speech_chars: result.speechText.length,
      duration_ms: Date.now() - started,
      disclaimer_present: true,
      database_writes: false,
      notifications_sent: false,
    })
  );
})().catch((error) => {
  console.error(JSON.stringify({ synthetic_probe_failed: true, code: error.code || error.name }));
  process.exitCode = 1;
});
