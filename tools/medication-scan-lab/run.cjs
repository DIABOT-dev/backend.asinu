'use strict';

// Isolated evaluation of a manually inspected, fixed set of public packaging
// photos. No DB, patient uploads, runtime provider changes or clinical writeback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { evaluate } = require('./evaluate.cjs');
const argument = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const out = path.resolve(argument('out') || path.resolve(__dirname, '../../../../preview/medication-scan-20261030'));
const model = argument('model') || 'med-gemini';
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const prompt = fs.readFileSync(path.join(out, 'prompt.txt'), 'utf8');
  if (manifest.length !== 20 || new Set(manifest.map(x => x.sha256)).size !== 20)
    throw Error('Exactly 20 distinct inspected public images required.');
  const catalog = JSON.parse(fs.readFileSync(path.join(out, 'sources/provider-model-catalog.json')));
  if (!catalog.data.some(m => m.id === model && m.supports_image === true))
    throw Error('Selected model is not listed as vision capable.');
  for (const image of manifest) {
    const file = path.resolve(out, image.file);
    if (!file.startsWith(out + path.sep) || image.groundTruthStatus !== 'visually_reviewed' ||
        image.visualReview?.patientDataPresent !== false ||
        !/^https:\/\//.test(image.sourcePage) || sha(fs.readFileSync(file)) !== image.sha256)
      throw Error('Unapproved or changed public image: ' + image.id);
  }
  const digest = sha(Buffer.from(JSON.stringify({ manifest, prompt, model })));
  const file = path.join(out, 'results-' + model + '.json');
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {
    model, digest, startedAt: new Date().toISOString(), publicPackagingOnly: true,
    settings: { temperature: 0.1, maxTokens: 700, timeoutMs: 45000, retries: 0 }, results: [],
  };
  if (report.digest !== digest) throw Error('Inputs changed; preserve and start a separate report.');
  if (!process.argv.includes('--live')) {
    console.log(JSON.stringify({ ready: true, images: manifest.length, model, paidCalls: 0 }));
    return;
  }
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const endpoint = new URL(process.env.MEDGEMMA_ENDPOINT || '');
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'dr7.ai' ||
      endpoint.pathname !== '/api/v1/medical/chat/completions' || !process.env.MEDGEMMA_API_KEY)
    throw Error('Configured HTTPS Dr7 medical endpoint/key required.');
  if (report.pendingRequest)
    throw Error('Previous request outcome unknown; reconcile it before another paid call.');
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const image of manifest) {
    if (report.results.some(r => r.imageId === image.id)) continue;
    const result = { imageId: image.id, imageSha256: image.sha256,
      requestedModel: model, startedAt: new Date().toISOString() };
    // Reuse the already completed smoke request only when the actual input and
    // settings match; never count another source image or a text-only answer.
    const smokeFile = path.join(out, 'smoke-' + model + '.json');
    if (image.id === 'image-01' && fs.existsSync(smokeFile)) {
      const smoke = JSON.parse(fs.readFileSync(smokeFile));
      if (smoke.imageSha256 !== image.sha256 || smoke.promptSha256 !== sha(Buffer.from(prompt)) ||
          smoke.requestedModel !== model || smoke.httpStatus !== 200 ||
          smoke.settings?.temperature !== 0.1 || smoke.settings?.max_tokens !== 700)
        throw Error('Smoke request inputs/settings cannot be verified.');
      Object.assign(result, { httpStatus: smoke.httpStatus, body: smoke.body,
        elapsedMs: smoke.elapsedMs, creditsRemaining: smoke.creditsRemaining,
        reusedSmokeRequest: true });
    } else {
      report.pendingRequest = { imageId: image.id, startedAt: result.startedAt };
      save();
      const started = performance.now();
      try {
        const data = fs.readFileSync(path.resolve(out, image.file));
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env.MEDGEMMA_API_KEY },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: 'data:' + image.mimeType + ';base64,' + data.toString('base64') } },
          ] }], temperature: 0.1, max_tokens: 700 }),
          signal: AbortSignal.timeout(45000),
        });
        result.httpStatus = response.status;
        result.creditsRemaining = response.headers.get('x-dr7-credit-remaining');
        result.body = await response.json();
        result.elapsedMs = Math.round(performance.now() - started);
      } catch (error) {
        result.error = { name: error.name, code: error.code || null };
        result.elapsedMs = Math.round(performance.now() - started);
        // Keep a timeout uncertain and never silently replay or switch vendors.
        report.results.push(result); save();
        console.log(JSON.stringify({ image: image.id, error: result.error }));
        return;
      }
    }
    result.evaluation = evaluate(result.body?.choices?.[0]?.message?.content || '', image);
    if (result.body?.model !== model) {
      result.evaluation.passed = false;
      result.evaluation.reasons.push('provider_model_mismatch');
    }
    report.results.push(result);
    delete report.pendingRequest;
    report.updatedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ image: image.id, status: result.httpStatus,
      tokens: result.body?.usage?.total_tokens, ms: result.elapsedMs,
      passed: result.evaluation.passed, reasons: result.evaluation.reasons }));
    if ([401, 402, 403, 429].includes(result.httpStatus)) return;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
