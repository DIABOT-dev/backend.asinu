'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { hasAiConsent } = require('../ai/ai-consent.service');
const { getClinicalConfig } = require('../ai/providers/clinical-config');
const { localDate } = require('../v21/common');
const domains = require('./domain-tools.service');
const tools = require('./app-tools.service');
const commandScope = require('./skill-router.service');
const { manager } = require('./skills');
const { requestSchema, canonicalRequest, fingerprint } = require('./assistant-request.schema');

const AUDIENCE = 'asinu:assistant-read-cache';
const TTL_SECONDS = 15 * 60;
const miss = () => Object.assign(new Error('Cached read plan is no longer applicable'), {
  code: 'APP_ASSISTANT_READ_CACHE_MISS', statusCode: 409,
});
// Some legacy "readTools" write/reset rows or issue navigation. Only audited
// data reads are eligible. Replay also runs in a PostgreSQL read-only transaction.
const READ_TOOLS = new Set([
  'notifications.list', 'coins.history', 'coins.rules', 'coins.rewards',
  'family.list', 'family.invitations', 'family.health', 'checkin.conclusion',
  'calls.settings', 'calls.voice', 'medication.history', 'medication.drafts',
  'subscription.members', 'subscription.compare', 'wallet.status', 'wallet.history', 'feed.search',
]);
const READ_QUERIES = new Set(['water', 'blood_pressure', 'glucose', 'meal', 'profile', 'checkin']);
const query = tools.querySchema.omit({ evidence: true }).strict();
const actionSchema = z.union([
  z.object({ type: z.literal('app_tool'), tool: z.enum([...READ_TOOLS]), parameters: z.record(z.string(), z.unknown()) }).strict(),
  query,
]);
const tokenSchema = z.object({
  kind: z.literal('assistant_read'), key: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.string().regex(/^[a-f0-9]{64}$/), day: z.string(), lang: z.enum(['vi', 'en']),
  actions: z.array(actionSchema).min(1).max(5), sub: z.string(), aud: z.literal(AUDIENCE),
  iat: z.number().int(), exp: z.number().int(),
}).strict();

function implementationHash() {
  const files = [
    __filename, 'assistant-request.schema.js', 'app-assistant.service.js', 'app-actions.schema.js',
    'app-tools.service.js', 'skill-manager.service.js', 'skill-router.service.js',
    'domain-tools.schema.js', 'domain-tools.service.js', 'domain-tools.read.js', 'management-tools.service.js',
  ].map(file => path.isAbsolute(file) ? file : path.join(__dirname, file));
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (/\.(?:md|json)$/i.test(entry.name)) files.push(filename);
    }
  };
  walk(path.join(__dirname, 'skills'));
  const hash = createHash('sha256').update('assistant-read-cache:v1');
  for (const filename of files) hash.update(path.relative(__dirname, filename)).update('\0').update(fs.readFileSync(filename)).update('\0');
  return hash.digest('hex');
}
const IMPLEMENTATION = implementationHash();

function policy() {
  const config = getClinicalConfig({ model: process.env.APP_ASSISTANT_MODEL || 'medgemma-27b-it' });
  return createHash('sha256').update(JSON.stringify({ implementation: IMPLEMENTATION,
    provider: config.provider, endpoint: config.endpoint, model: config.model,
    version: process.env.APP_ASSISTANT_READ_CACHE_POLICY_VERSION || '1' })).digest('hex');
}

function eligibleRequest(request) {
  return !request.clarification && !commandScope.inputForModel(request, []).READ_CONTEXT;
}

function unsignedReads(actions, evidence) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 5) return null;
  try {
    return actions.map(original => {
      const { evidence: _evidence, ...unsigned } = original;
      const action = actionSchema.parse(unsigned);
      if (action.type === 'app_tool') {
        const parsed = domains.parse({ ...action, evidence });
        if (!READ_TOOLS.has(parsed.tool) || parsed.parameters.speak === true) throw miss();
        return { type: parsed.type, tool: parsed.tool, parameters: parsed.parameters };
      }
      if (!READ_QUERIES.has(action.topic)) throw miss();
      // Keep each query skill's stricter date/statistic contract on replay.
      const { type: _type, topic: _topic, ...args } = action;
      manager.forAction(action).inputSchema.parse({ ...args, evidence });
      return action;
    });
  } catch { return null; }
}

function metadata(token, key, expiry) {
  return { token, key, expiresAt: new Date(expiry * 1000).toISOString() };
}

function issue(requestInput, approvedActions, result, userId, lang = 'vi') {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 || !process.env.JWT_SECRET ||
      result?.status !== 'answer' || !Array.isArray(result.actions) || result.actions.length ||
      typeof result.answer !== 'string' || !result.answer.trim()) return null;
  const checked = requestSchema.safeParse(requestInput);
  if (!checked.success || !eligibleRequest(checked.data)) return null;
  const actions = unsignedReads(approvedActions, checked.data.text);
  if (!actions) return null;
  const key = fingerprint(checked.data), now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ kind: 'assistant_read', key, policy: policy(), day: localDate(), lang,
    actions, iat: now, exp: now + TTL_SECONDS }, process.env.JWT_SECRET,
  { algorithm: 'HS256', subject: String(userId), audience: AUDIENCE });
  if (token.length > 12000) return null;
  return metadata(token, key, now + TTL_SECONDS);
}

async function replay(input, lang = 'vi', { pool, userId, signal } = {}) {
  const requireConsent = async () => {
    signal?.throwIfAborted();
    if (!(await hasAiConsent(pool, userId))) throw Object.assign(new Error('AI consent is required'), {
      code: 'AI_CONSENT_REQUIRED', statusCode: 403,
    });
    signal?.throwIfAborted();
  };
  await requireConsent();
  let request, claims, actions;
  try {
    const envelope = z.object({ token: z.string().min(1).max(12000), request: requestSchema }).strict().parse(input);
    request = envelope.request;
    if (!eligibleRequest(request) || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 || !process.env.JWT_SECRET) throw miss();
    claims = tokenSchema.parse(jwt.verify(envelope.token, process.env.JWT_SECRET, {
      algorithms: ['HS256'], subject: String(userId), audience: AUDIENCE, maxAge: TTL_SECONDS,
    }));
    const now = Math.floor(Date.now() / 1000);
    if (claims.iat > now || claims.exp <= claims.iat || claims.exp - claims.iat > TTL_SECONDS ||
        claims.key !== fingerprint(request) || claims.policy !== policy() ||
        claims.day !== localDate() || claims.lang !== lang) throw miss();
    actions = unsignedReads(claims.actions, request.text);
    if (!actions) throw miss();
  } catch { throw miss(); }

  const db = await pool.connect();
  let answer;
  try {
    await db.query('BEGIN READ ONLY');
    const answers = [];
    for (const cached of actions) {
      signal?.throwIfAborted();
      const action = { ...cached, evidence: request.text };
      if (action.type === 'query') answers.push(await tools.query(db, userId, action, lang));
      else {
        const result = await domains.prepare(db, userId, action, lang, {
          hiddenArticles: request.hiddenArticles || [], allowCuratedArticles: request.allowCuratedArticles !== false,
          ...(signal ? { signal } : {}),
        });
        if (!result || result.clarify || result.action || result.native || result.screen || result.speech ||
            typeof result.answer !== 'string' || !result.answer.trim()) throw miss();
        answers.push(result.answer);
      }
    }
    answer = answers.join('\n\n');
    if (!answer.trim()) throw miss();
    signal?.throwIfAborted();
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error.code === '25006') throw miss();
    throw error;
  } finally { db.release(); }
  await requireConsent();
  return { status: 'answer', question: '', actions: [], answer,
    readCache: metadata(input.token, claims.key, claims.exp) };
}

module.exports = { issue, replay, canonicalRequest, fingerprint, policy, AUDIENCE, TTL_SECONDS };
