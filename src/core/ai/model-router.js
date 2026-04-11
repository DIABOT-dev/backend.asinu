'use strict';

/**
 * Model Router — Phân tầng Small/Big Model tự động
 *
 * Kiến trúc 3 lớp theo tài liệu khách hàng:
 *   Lớp 1: Cache (đã có — script system + Redis)
 *   Lớp 2: Small Model (gpt-4o-mini) — phân loại, trích xuất, Q&A đơn giản
 *   Lớp 3: Big Model (gpt-4o) — suy luận sâu, phân tích phức tạp
 *
 * Router quyết định model dựa trên:
 *   - Complexity score: đếm red flags, severity, số câu hỏi, medical conditions
 *   - Task type: classification vs reasoning vs generation
 *   - User risk tier: HIGH risk → always Big Model
 */

const SMALL_MODEL = process.env.SMALL_MODEL || 'gpt-4o-mini';
const BIG_MODEL = process.env.BIG_MODEL || 'gpt-4o';

// ─── Task type classification ───────────────────────────────────────────────

const TASK_TYPES = {
  classification: 'classification',   // phân loại triệu chứng, sentiment
  extraction: 'extraction',           // trích xuất entity (symptom, drug name)
  simple_qa: 'simple_qa',             // Q&A đơn giản
  triage: 'triage',                   // triage câu hỏi y khoa
  analysis: 'analysis',               // phân tích bệnh án phức tạp
  generation: 'generation',           // tạo nội dung (script, report)
};

// ─── Complexity indicators ──────────────────────────────────────────────────

const RED_FLAG_KEYWORDS = [
  'khó thở', 'đau ngực', 'tức ngực', 'ngất', 'co giật', 'vã mồ hôi',
  'chest pain', 'difficulty breathing', 'fainting', 'seizure',
  'tim đập nhanh', 'không thở được', 'mất ý thức',
];

const COMPLEX_CONDITIONS = [
  'tiểu đường', 'diabetes', 'bệnh tim', 'heart disease',
  'cao huyết áp', 'hypertension', 'ung thư', 'cancer',
  'suy thận', 'kidney', 'đột quỵ', 'stroke',
];

// ─── Route decision ─────────────────────────────────────────────────────────

/**
 * Determine which model to use for a given request.
 *
 * @param {object} request
 *   - taskType: string (from TASK_TYPES)
 *   - text: string (user input / symptom description)
 *   - severity: string (low/medium/high) — from prior scoring
 *   - answerCount: number — how many answers collected so far
 *   - userConditions: string[] — user's medical conditions
 *   - riskTier: string (LOW/MEDIUM/HIGH) — from risk engine
 *   - hasRedFlags: boolean — from prior detection
 * @returns {{ model: string, reason: string, tier: number }}
 */
function routeModel(request = {}) {
  const {
    taskType = 'simple_qa',
    text = '',
    severity = null,
    answerCount = 0,
    userConditions = [],
    riskTier = null,
    hasRedFlags = false,
  } = request;

  const score = calculateComplexity(request);

  // ─── Tier 3 (Big Model) triggers ─────────────────────────
  // Red flags → always Big
  if (hasRedFlags || score.redFlagCount > 0) {
    return { model: BIG_MODEL, reason: 'red_flags_detected', tier: 3, complexity: score };
  }

  // High severity → Big
  if (severity === 'high') {
    return { model: BIG_MODEL, reason: 'high_severity', tier: 3, complexity: score };
  }

  // High risk tier user → Big
  if (riskTier === 'HIGH') {
    return { model: BIG_MODEL, reason: 'high_risk_user', tier: 3, complexity: score };
  }

  // Complex analysis tasks → Big
  if (taskType === 'analysis') {
    return { model: BIG_MODEL, reason: 'analysis_task', tier: 3, complexity: score };
  }

  // Many answers collected (deep triage) → Big
  if (answerCount >= 5) {
    return { model: BIG_MODEL, reason: 'deep_triage', tier: 3, complexity: score };
  }

  // High complexity score → Big
  if (score.total >= 7) {
    return { model: BIG_MODEL, reason: 'high_complexity', tier: 3, complexity: score };
  }

  // ─── Tier 2 (Small Model) — everything else ─────────────
  return { model: SMALL_MODEL, reason: 'standard_request', tier: 2, complexity: score };
}

// ─── Complexity scoring ─────────────────────────────────────────────────────

function calculateComplexity(request) {
  const { text = '', severity, answerCount = 0, userConditions = [], riskTier } = request;
  const textLower = (text || '').toLowerCase();

  let total = 0;

  // Red flags in text (+3 each)
  const redFlagCount = RED_FLAG_KEYWORDS.filter(kw => textLower.includes(kw)).length;
  total += redFlagCount * 3;

  // User medical conditions (+1 each complex condition)
  const condText = (Array.isArray(userConditions) ? userConditions.join(' ') : String(userConditions || '')).toLowerCase();
  const conditionCount = COMPLEX_CONDITIONS.filter(c => condText.includes(c)).length;
  total += conditionCount;

  // Severity score
  if (severity === 'high') total += 3;
  else if (severity === 'medium') total += 1;

  // Answer depth (more answers = more complex situation)
  if (answerCount >= 5) total += 2;
  else if (answerCount >= 3) total += 1;

  // Risk tier
  if (riskTier === 'HIGH') total += 3;
  else if (riskTier === 'MEDIUM') total += 1;

  // Text length (longer = potentially more complex)
  if (textLower.length > 200) total += 1;

  return { total, redFlagCount, conditionCount };
}

// ─── Convenience: route for triage ──────────────────────────────────────────

function routeForTriage(status, answerCount, profile = {}) {
  const isUrgent = status === 'very_tired';
  const conditions = profile.medical_conditions || [];
  const riskTier = profile.risk_tier || null;

  return routeModel({
    taskType: isUrgent ? 'analysis' : 'triage',
    severity: isUrgent ? 'high' : (status === 'tired' ? 'medium' : 'low'),
    answerCount,
    userConditions: conditions,
    riskTier,
    hasRedFlags: false,
  });
}

// ─── Stats helper ───────────────────────────────────────────────────────────

// In-memory counters (reset on restart)
const _stats = { smallCalls: 0, bigCalls: 0 };

function trackRouteDecision(route) {
  if (route.tier === 2) _stats.smallCalls++;
  else if (route.tier === 3) _stats.bigCalls++;
}

function getRouteStats() {
  const total = _stats.smallCalls + _stats.bigCalls;
  return {
    ..._stats,
    total,
    smallPct: total > 0 ? Math.round(_stats.smallCalls / total * 100) : 0,
    bigPct: total > 0 ? Math.round(_stats.bigCalls / total * 100) : 0,
    estimatedSavings: `${_stats.smallCalls} calls at 1/10 cost`,
  };
}

function resetStats() { _stats.smallCalls = 0; _stats.bigCalls = 0; }

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  routeModel,
  routeForTriage,
  calculateComplexity,
  trackRouteDecision,
  getRouteStats,
  resetStats,
  TASK_TYPES,
  SMALL_MODEL,
  BIG_MODEL,
  RED_FLAG_KEYWORDS,
};
