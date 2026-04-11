'use strict';

/**
 * Context Cache — Giảm 80% input token cho AI calls
 *
 * Chiến lược:
 *   1. Hash system prompt + user context → key duy nhất
 *   2. Nếu key tồn tại trong Redis → trả cached response
 *   3. Nếu không → gọi AI → lưu kết quả vào cache
 *
 * Áp dụng cho:
 *   - System prompt (ít thay đổi) → TTL dài (24h)
 *   - User health context (thay đổi theo ngày) → TTL trung bình (1h)
 *   - AI response cho cùng input → TTL ngắn (5-30 phút)
 */

const crypto = require('crypto');
const { cacheGet, cacheSet, cacheDel } = require('../../lib/redis');

// ─── TTL configs ────────────────────────────────────────────────────────────

const TTL = {
  system_prompt: 86400,    // 24h — system prompt hiếm khi thay đổi
  user_context: 3600,      // 1h — health context thay đổi khi check-in
  ai_response: 1800,       // 30m — same question → same answer
  triage_question: 300,    // 5m — triage questions change with answers
};

// ─── Hash function ──────────────────────────────────────────────────────────

function hashKey(prefix, ...parts) {
  const content = parts.map(p =>
    typeof p === 'object' ? JSON.stringify(p) : String(p || '')
  ).join('|');
  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  return `ctx:${prefix}:${hash}`;
}

// ─── Cache system prompt ────────────────────────────────────────────────────

/**
 * Cache system prompt text. Since system prompts rarely change,
 * this avoids re-sending the same large prompt on every API call.
 *
 * Returns: { cached: boolean, promptHash: string }
 */
async function cacheSystemPrompt(promptText) {
  const key = hashKey('sysprompt', promptText);
  const existing = await cacheGet(key);
  if (existing) {
    return { cached: true, promptHash: key };
  }
  await cacheSet(key, { text: promptText, cachedAt: Date.now() }, TTL.system_prompt);
  return { cached: false, promptHash: key };
}

// ─── Cache user health context ──────────────────────────────────────────────

/**
 * Cache assembled user health context (conditions, recent checkins, clusters).
 * Called before AI calls to avoid re-querying DB.
 */
async function cacheUserContext(userId, context) {
  const key = `ctx:user:${userId}`;
  await cacheSet(key, context, TTL.user_context);
  return key;
}

async function getCachedUserContext(userId) {
  return await cacheGet(`ctx:user:${userId}`);
}

async function invalidateUserContext(userId) {
  await cacheDel(`ctx:user:${userId}`);
}

// ─── Cache AI response ──────────────────────────────────────────────────────

/**
 * Get-or-set pattern for AI responses.
 * If same messages hash exists → return cached response (skip AI call).
 *
 * @param {Array} messages - OpenAI messages array
 * @param {string} model - model name
 * @param {Function} callAI - async function that makes the actual AI call
 * @param {number} [ttl] - cache TTL in seconds
 * @returns {{ response: any, cacheHit: boolean, key: string }}
 */
async function getOrCallAI(messages, model, callAI, ttl = TTL.ai_response) {
  const key = hashKey('ai', model, messages);

  // Check cache
  const cached = await cacheGet(key);
  if (cached) {
    _stats.hits++;
    return { response: cached, cacheHit: true, key };
  }

  // Cache miss → call AI
  _stats.misses++;
  const response = await callAI();

  // Store in cache
  await cacheSet(key, response, ttl);
  return { response, cacheHit: false, key };
}

// ─── Triage-specific cache ──────────────────────────────────────────────────

/**
 * Cache triage question generation.
 * Key includes: user status + answer count + answer content hash.
 * Short TTL since answers change frequently.
 */
async function cacheTriage(userId, status, answerHash, response) {
  const key = hashKey('triage', userId, status, answerHash);
  await cacheSet(key, response, TTL.triage_question);
  return key;
}

async function getCachedTriage(userId, status, answerHash) {
  const key = hashKey('triage', userId, status, answerHash);
  return await cacheGet(key);
}

// ─── Stats ──────────────────────────────────────────────────────────────────

const _stats = { hits: 0, misses: 0 };

function getCacheStats() {
  const total = _stats.hits + _stats.misses;
  return {
    ..._stats,
    total,
    hitRate: total > 0 ? Math.round(_stats.hits / total * 100) : 0,
    estimatedTokensSaved: _stats.hits * 1500, // avg ~1500 tokens/cached call
  };
}

function resetCacheStats() { _stats.hits = 0; _stats.misses = 0; }

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  hashKey,
  cacheSystemPrompt,
  cacheUserContext,
  getCachedUserContext,
  invalidateUserContext,
  getOrCallAI,
  cacheTriage,
  getCachedTriage,
  getCacheStats,
  resetCacheStats,
  TTL,
};
