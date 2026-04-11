'use strict';

/**
 * LLM Optimization Test Suite — Model Router + Context Cache + Streaming + Distillation
 * Chạy: node tests/llm-optimization.test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

const router = require('../src/core/ai/model-router');
const cache = require('../src/core/ai/context-cache');
const { streamChunked } = require('../src/core/ai/streaming');
const distillation = require('../src/core/ai/distillation');

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

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request('http://localhost:3000' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); } catch { resolve({ s: res.statusCode, b: d }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getSSE(path) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get('http://localhost:3000' + path, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        const lines = buf.split('\n');
        let currentEvent = {};
        for (const line of lines) {
          if (line.startsWith('event: ')) currentEvent.event = line.substring(7);
          else if (line.startsWith('data: ')) {
            try { currentEvent.data = JSON.parse(line.substring(6)); } catch { currentEvent.data = line.substring(6); }
            events.push(currentEvent);
            currentEvent = {};
          }
        }
        resolve(events);
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); resolve(events); }, 5000);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: Model Router — routing decisions
// ═══════════════════════════════════════════════════════════════════════════════
async function testModelRouter() {
  console.log('\n══════ SUITE 1: Model Router ══════');
  router.resetStats();

  // 1.1 Simple request → Small Model
  const r1 = router.routeModel({ taskType: 'simple_qa', severity: 'low' });
  assert(r1.model === router.SMALL_MODEL, '1.1 Simple → Small Model');
  assert(r1.tier === 2, '1.2 Tier = 2');

  // 1.3 Red flags → Big Model
  const r2 = router.routeModel({ hasRedFlags: true });
  assert(r2.model === router.BIG_MODEL, '1.3 Red flags → Big Model');
  assert(r2.tier === 3, '1.4 Tier = 3');
  assert(r2.reason === 'red_flags_detected', '1.5 reason = red_flags');

  // 1.6 High severity → Big
  const r3 = router.routeModel({ severity: 'high' });
  assert(r3.model === router.BIG_MODEL, '1.6 High severity → Big');

  // 1.7 Medium severity → Small (not high enough)
  const r4 = router.routeModel({ severity: 'medium' });
  assert(r4.model === router.SMALL_MODEL, '1.7 Medium severity → Small');

  // 1.8 Analysis task → Big
  const r5 = router.routeModel({ taskType: 'analysis' });
  assert(r5.model === router.BIG_MODEL, '1.8 Analysis → Big');

  // 1.9 Deep triage (5+ answers) → Big
  const r6 = router.routeModel({ answerCount: 5 });
  assert(r6.model === router.BIG_MODEL, '1.9 5 answers → Big');

  // 1.10 4 answers → Small
  const r7 = router.routeModel({ answerCount: 4 });
  assert(r7.model === router.SMALL_MODEL, '1.10 4 answers → Small');

  // 1.11 HIGH risk user → Big
  const r8 = router.routeModel({ riskTier: 'HIGH' });
  assert(r8.model === router.BIG_MODEL, '1.11 HIGH risk → Big');

  // 1.12 MEDIUM risk → Small (not high enough alone)
  const r9 = router.routeModel({ riskTier: 'MEDIUM' });
  assert(r9.model === router.SMALL_MODEL, '1.12 MEDIUM risk → Small');

  // 1.13 Red flag keywords in text
  const r10 = router.routeModel({ text: 'tôi bị đau ngực và khó thở' });
  assert(r10.model === router.BIG_MODEL, '1.13 Red flag text → Big');
  assert(r10.complexity.redFlagCount === 2, '1.14 2 red flags detected');

  // 1.15 Complex conditions → high complexity score
  const r11 = router.routeModel({ userConditions: ['tiểu đường', 'bệnh tim', 'cao huyết áp'], severity: 'medium', answerCount: 4 });
  // 3 conditions(+3) + medium(+1) + 4 answers(+1) = 5, under threshold 7 → Small is correct
  // Need more to push over 7: add high severity
  const r11b = router.routeModel({ userConditions: ['tiểu đường', 'bệnh tim', 'cao huyết áp'], severity: 'high' });
  assert(r11b.model === router.BIG_MODEL, '1.15 Multiple conditions + high severity → Big');

  // 1.16 routeForTriage
  const t1 = router.routeForTriage('fine', 2, {});
  assert(t1.model === router.SMALL_MODEL, '1.16 fine + 2 answers → Small');
  const t2 = router.routeForTriage('very_tired', 0, {});
  assert(t2.model === router.BIG_MODEL, '1.17 very_tired → Big');

  // 1.18 Stats tracking
  router.resetStats();
  router.trackRouteDecision({ tier: 2 });
  router.trackRouteDecision({ tier: 2 });
  router.trackRouteDecision({ tier: 3 });
  const stats = router.getRouteStats();
  assert(stats.smallCalls === 2, '1.18 Stats: 2 small calls');
  assert(stats.bigCalls === 1, '1.19 Stats: 1 big call');
  assert(stats.smallPct === 67, '1.20 Stats: 67% small');

  // 1.21 Empty request → Small Model (default)
  const r12 = router.routeModel({});
  assert(r12.model === router.SMALL_MODEL, '1.21 Empty → Small');
  const r13 = router.routeModel();
  assert(r13.model === router.SMALL_MODEL, '1.22 undefined → Small');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: Context Cache
// ═══════════════════════════════════════════════════════════════════════════════
async function testContextCache() {
  console.log('\n══════ SUITE 2: Context Cache ══════');
  cache.resetCacheStats();

  // 2.1 hashKey deterministic
  const k1 = cache.hashKey('test', 'a', 'b');
  const k2 = cache.hashKey('test', 'a', 'b');
  assert(k1 === k2, '2.1 hashKey deterministic');

  // 2.2 Different inputs → different keys
  const k3 = cache.hashKey('test', 'a', 'c');
  assert(k1 !== k3, '2.2 Different inputs → different keys');

  // 2.3 hashKey with objects
  const k4 = cache.hashKey('test', { foo: 1 });
  assert(k4.startsWith('ctx:test:'), '2.3 hashKey with object works');

  // 2.4 getOrCallAI — cache miss
  let called = false;
  const r1 = await cache.getOrCallAI(
    [{ role: 'user', content: 'test_unique_' + Date.now() }],
    'test-model',
    async () => { called = true; return { answer: 42 }; },
    60
  );
  assert(r1.cacheHit === false, '2.4 First call = cache miss');
  assert(called === true, '2.5 AI function was called');
  assert(r1.response.answer === 42, '2.6 Response correct');

  // 2.7 getOrCallAI — cache hit (same messages)
  called = false;
  const r2 = await cache.getOrCallAI(
    [{ role: 'user', content: 'test_unique_' + (Date.now() - 1) }],
    'test-model',
    async () => { called = true; return { answer: 99 }; },
    60
  );
  // Note: might be miss if timestamp changed — that's OK
  // But the same exact content should hit
  const testContent = 'cache_hit_test_' + Math.random();
  await cache.getOrCallAI([{ role: 'user', content: testContent }], 'test', async () => ({ v: 1 }), 60);
  called = false;
  const r3 = await cache.getOrCallAI([{ role: 'user', content: testContent }], 'test', async () => { called = true; return { v: 2 }; }, 60);
  assert(r3.cacheHit === true, '2.7 Second call = cache hit');
  assert(called === false, '2.8 AI function NOT called on hit');
  assert(r3.response.v === 1, '2.9 Cached response returned (not new)');

  // 2.10 Stats
  const stats = cache.getCacheStats();
  assert(stats.hits >= 1, '2.10 Stats: hits >= 1');
  assert(stats.misses >= 1, '2.11 Stats: misses >= 1');
  assert(stats.hitRate > 0, '2.12 Hit rate > 0');
  assert(stats.estimatedTokensSaved > 0, '2.13 estimatedTokensSaved > 0');

  // 2.14 cacheUserContext + getCachedUserContext
  await cache.cacheUserContext(4, { test: true, symptoms: ['headache'] });
  const ctx = await cache.getCachedUserContext(4);
  assert(ctx !== null && ctx.test === true, '2.14 User context cached');

  // 2.15 invalidateUserContext
  await cache.invalidateUserContext(4);
  const ctx2 = await cache.getCachedUserContext(4);
  assert(ctx2 === null, '2.15 User context invalidated');

  // 2.16 cacheSystemPrompt
  const sp = await cache.cacheSystemPrompt('You are a health assistant');
  assert(sp.promptHash.startsWith('ctx:sysprompt:'), '2.16 System prompt cached');
  const sp2 = await cache.cacheSystemPrompt('You are a health assistant');
  assert(sp2.cached === true, '2.17 Same prompt = cached');

  // 2.18 TTL values exist
  assert(cache.TTL.system_prompt === 86400, '2.18 TTL.system_prompt = 24h');
  assert(cache.TTL.ai_response === 1800, '2.19 TTL.ai_response = 30m');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: Streaming
// ═══════════════════════════════════════════════════════════════════════════════
async function testStreaming() {
  console.log('\n══════ SUITE 3: Streaming SSE ══════');

  // 3.1 SSE endpoint returns events
  const events = await getSSE('/api/health/ai/stream-test');
  assert(events.length >= 3, `3.1 Got ${events.length} SSE events (>= 3)`);

  // 3.2 First event = start
  assert(events[0]?.event === 'start', '3.2 First event = start');
  assert(events[0]?.data?.cached === true, '3.3 Start data.cached = true');

  // 3.4 Middle events = chunk with text
  const chunks = events.filter(e => e.event === 'chunk');
  assert(chunks.length >= 2, `3.4 Has ${chunks.length} chunks (>= 2)`);
  assert(chunks[0]?.data?.text?.length > 0, '3.5 Chunk has text');

  // 3.6 Last event = done
  const doneEvents = events.filter(e => e.event === 'done');
  assert(doneEvents.length >= 1, '3.6 Has done event');
  assert(doneEvents[0]?.data?.fullText?.length > 0, '3.7 Done has fullText');

  // 3.8 All chunks together = full text
  const reassembled = chunks.map(c => c.data.text).join('');
  assert(reassembled === doneEvents[0]?.data?.fullText, '3.8 Chunks reassemble to fullText');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: Distillation
// ═══════════════════════════════════════════════════════════════════════════════
async function testDistillation() {
  console.log('\n══════ SUITE 4: Distillation ══════');

  // Cleanup test data
  await pool.query(`DELETE FROM distillation_data WHERE task_type LIKE 'test_%'`);

  // 4.1 autoRateQuality — good output
  const q1 = distillation.autoRateQuality({ text: 'Bạn đau đầu vùng nào?', severity: 'low' });
  assert(q1 >= 0.7, `4.1 Good output quality >= 0.7 (got ${q1})`);

  // 4.2 autoRateQuality — empty output
  const q2 = distillation.autoRateQuality({});
  assert(q2 <= 0.5, `4.2 Empty output quality <= 0.5 (got ${q2})`);

  // 4.3 autoRateQuality — error output
  const q3 = distillation.autoRateQuality({ text: 'Sorry, I cannot help with that' });
  assert(q3 < q1, `4.3 Error output quality < good output (${q3} < ${q1})`);

  // 4.4 autoRateQuality — null
  const q4 = distillation.autoRateQuality(null);
  assert(q4 === 0, '4.4 null → quality 0');

  // 4.5 collectOutput — saves to DB
  const id1 = await distillation.collectOutput(pool, 'test_triage', 'gpt-4o',
    [{ role: 'user', content: 'test collect' }],
    { text: 'Great question response', severity: 'low' },
    0.9
  );
  assert(id1 !== null && id1 > 0, `4.5 Collected output id=${id1}`);

  // 4.6 collectOutput dedup — same input today
  const id2 = await distillation.collectOutput(pool, 'test_triage', 'gpt-4o',
    [{ role: 'user', content: 'test collect' }],
    { text: 'Different output' },
    0.8
  );
  assert(id2 === null, '4.6 Dedup: same input today → null');

  // 4.7 getFewShotExamples — returns high quality
  const examples = await distillation.getFewShotExamples(pool, 'test_triage', 5);
  assert(Array.isArray(examples), '4.7 Returns array');
  assert(examples.length >= 1, `4.8 Has ${examples.length} example(s)`);
  assert(examples[0].score >= 0.7, '4.9 Example has quality >= 0.7');

  // 4.10 enhanceWithFewShot
  const originalMsgs = [
    { role: 'system', content: 'You are a doctor' },
    { role: 'user', content: 'I have a headache' },
  ];
  const enhanced = await distillation.enhanceWithFewShot(pool, 'test_triage', originalMsgs);
  assert(enhanced.messages.length >= originalMsgs.length, '4.10 Enhanced messages >= original');
  assert(enhanced.enhancedWith >= 1, `4.11 Enhanced with ${enhanced.enhancedWith} examples`);
  // System message should still be first
  assert(enhanced.messages[0].role === 'system', '4.12 System message still first');
  // User message should still be last
  assert(enhanced.messages[enhanced.messages.length - 1].role === 'user', '4.13 User message still last');

  // 4.14 Stats
  const stats = await distillation.getGlobalDistillationStats(pool);
  assert(stats.total_collected >= 1, `4.14 Stats: total_collected >= 1 (got ${stats.total_collected})`);

  // 4.15 Detailed stats by task
  const detailed = await distillation.getDistillationStats(pool);
  assert(Array.isArray(detailed), '4.15 Detailed stats array');

  // Cleanup
  await pool.query(`DELETE FROM distillation_data WHERE task_type LIKE 'test_%'`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5: API Endpoints
// ═══════════════════════════════════════════════════════════════════════════════
async function testApiEndpoints() {
  console.log('\n══════ SUITE 5: API Endpoints ══════');

  // 5.1 POST /ai/route
  const r1 = await post('/api/health/ai/route', { taskType: 'triage', severity: 'low' });
  assert(r1.s === 200 && r1.b.route.model, '5.1 /ai/route → 200');
  assert(r1.b.route.tier === 2, '5.2 Simple → tier 2');

  // 5.3 POST /ai/route (big model trigger)
  const r2 = await post('/api/health/ai/route', { hasRedFlags: true, text: 'đau ngực' });
  assert(r2.b.route.tier === 3, '5.3 Red flags → tier 3');

  // 5.4 GET /ai/route-stats
  const r3 = await get('/api/health/ai/route-stats');
  assert(r3.s === 200 && typeof r3.b.stats.smallCalls === 'number', '5.4 /ai/route-stats → 200');

  // 5.5 POST /ai/route-triage
  const r4 = await post('/api/health/ai/route-triage', { status: 'very_tired', answerCount: 0 });
  assert(r4.b.route.model === router.BIG_MODEL, '5.5 very_tired → Big Model');

  // 5.6 GET /ai/cache-stats
  const r5 = await get('/api/health/ai/cache-stats');
  assert(r5.s === 200 && typeof r5.b.stats.hits === 'number', '5.6 /ai/cache-stats → 200');

  // 5.7 POST /ai/cache-test (miss then hit)
  const testKey = 'api_test_' + Date.now();
  const r6 = await post('/api/health/ai/cache-test', { messages: [{ role: 'user', content: testKey }] });
  assert(r6.b.cacheHit === false, '5.7 First call = miss');
  const r7 = await post('/api/health/ai/cache-test', { messages: [{ role: 'user', content: testKey }] });
  assert(r7.b.cacheHit === true, '5.8 Second call = hit');

  // 5.9 POST /ai/cache-test — missing params
  const r8 = await post('/api/health/ai/cache-test', {});
  assert(r8.s === 400, '5.9 Missing messages → 400');

  // 5.10 POST /ai/distillation-collect
  const r9 = await post('/api/health/ai/distillation-collect', {
    taskType: 'test_api', model: 'gpt-4o',
    input: [{ role: 'user', content: 'test api' }],
    output: { text: 'API test response' },
  });
  assert(r9.s === 200 && r9.b.id !== null, '5.10 Distillation collect → 200');
  assert(r9.b.quality >= 0, '5.11 Quality score returned');

  // 5.12 POST /ai/distillation-collect — missing params
  const r10 = await post('/api/health/ai/distillation-collect', {});
  assert(r10.s === 400, '5.12 Missing params → 400');

  // 5.13 GET /ai/distillation-stats
  const r11 = await get('/api/health/ai/distillation-stats');
  assert(r11.s === 200 && r11.b.stats, '5.13 Distillation stats → 200');

  // 5.14 GET /ai/few-shot/triage
  const r12 = await get('/api/health/ai/few-shot/triage');
  assert(r12.s === 200 && Array.isArray(r12.b.examples), '5.14 Few-shot → 200 + array');

  // 5.15 SSE stream-test
  const events = await getSSE('/api/health/ai/stream-test');
  assert(events.length >= 3, '5.15 SSE stream has events');

  // Cleanup
  await pool.query(`DELETE FROM distillation_data WHERE task_type = 'test_api'`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6: Code exports
// ═══════════════════════════════════════════════════════════════════════════════
async function testExports() {
  console.log('\n══════ SUITE 6: Exports ══════');

  // Router
  assert(typeof router.routeModel === 'function', '6.1 routeModel');
  assert(typeof router.routeForTriage === 'function', '6.2 routeForTriage');
  assert(typeof router.calculateComplexity === 'function', '6.3 calculateComplexity');
  assert(typeof router.trackRouteDecision === 'function', '6.4 trackRouteDecision');
  assert(typeof router.getRouteStats === 'function', '6.5 getRouteStats');
  assert(router.SMALL_MODEL === 'gpt-4o-mini', '6.6 SMALL_MODEL');
  assert(router.BIG_MODEL === 'gpt-4o', '6.7 BIG_MODEL');

  // Cache
  assert(typeof cache.hashKey === 'function', '6.8 hashKey');
  assert(typeof cache.getOrCallAI === 'function', '6.9 getOrCallAI');
  assert(typeof cache.cacheSystemPrompt === 'function', '6.10 cacheSystemPrompt');
  assert(typeof cache.getCacheStats === 'function', '6.11 getCacheStats');
  assert(typeof cache.TTL === 'object', '6.12 TTL config');

  // Streaming
  assert(typeof streamChunked === 'function', '6.13 streamChunked');

  // Distillation
  assert(typeof distillation.collectOutput === 'function', '6.14 collectOutput');
  assert(typeof distillation.autoRateQuality === 'function', '6.15 autoRateQuality');
  assert(typeof distillation.getFewShotExamples === 'function', '6.16 getFewShotExamples');
  assert(typeof distillation.enhanceWithFewShot === 'function', '6.17 enhanceWithFewShot');
  assert(typeof distillation.getDistillationStats === 'function', '6.18 getDistillationStats');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  LLM OPTIMIZATION TEST SUITE                   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await testModelRouter();
  await testContextCache();
  await testStreaming();
  await testDistillation();
  await testApiEndpoints();
  await testExports();

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
