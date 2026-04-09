'use strict';

/**
 * Multi-Symptom Service
 *
 * Handles multi-symptom input: parsing, combo detection, cluster matching,
 * and severity aggregation across multiple scripts.
 *
 * Used when user reports multiple symptoms at once (e.g. "đau đầu, chóng mặt và buồn nôn").
 */

const { detectEmergency } = require('./emergency-detector');
const { detectCombo } = require('../../core/checkin/combo-detector');
const { matchCluster } = require('./fallback.service');
const { getScript } = require('./script.service');

// ─── Severity helpers ───────────────────────────────────────────────────────

const SEVERITY_ORDER = { critical: 3, high: 2, medium: 1, low: 0 };

function severityRank(s) {
  return SEVERITY_ORDER[s] || 0;
}

function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

// ─── Parse symptoms ─────────────────────────────────────────────────────────

/**
 * Parse raw input into individual symptom strings.
 * Splits by common Vietnamese connectors: ",", "+", "và", "kèm", "với"
 *
 * @param {string} rawInput — user's free-form symptom text
 * @returns {string[]} — array of trimmed, non-empty symptom strings
 */
function parseSymptoms(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];

  // Split by delimiters: comma, plus, "và", "kèm", "với"
  // Use regex with word boundaries for Vietnamese connectors to avoid splitting mid-word
  const parts = rawInput
    .split(/[,+]|\s+và\s+|\s+kèm\s+|\s+với\s+/i)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return parts;
}

// ─── Multi-symptom analysis ─────────────────────────────────────────────────

/**
 * Run multi-symptom analysis: emergency detection, combo detection, cluster matching.
 *
 * @param {object} pool — DB pool
 * @param {number} userId
 * @param {string[]} symptomTexts — parsed symptom strings
 * @param {object} profile — user profile { medical_conditions, birth_year, ... }
 * @returns {Promise<{
 *   isEmergency: boolean,
 *   emergency?: object,
 *   combos: Array,
 *   matched: Array<{ symptom: string, cluster: object, script: object }>,
 *   unmatched: string[],
 *   primaryCluster: object|null,
 *   aggregatedSeverity: string|null,
 *   extraQuestions: Array
 * }>}
 */
async function analyzeMultiSymptom(pool, userId, symptomTexts, profile = {}) {
  profile = profile || {};

  // 1. Run emergency detection on ALL symptoms together
  const emergency = detectEmergency(symptomTexts, profile);
  if (emergency.isEmergency) {
    return {
      isEmergency: true,
      emergency,
      combos: [],
      matched: [],
      unmatched: [],
      primaryCluster: null,
      aggregatedSeverity: 'critical',
      extraQuestions: [],
    };
  }

  // 2. Run combo detection
  const comboResult = detectCombo(symptomTexts, profile);

  // 3. Match each symptom to clusters
  const matched = [];
  const unmatched = [];
  const seenClusterKeys = new Set();

  for (const symptom of symptomTexts) {
    const { matched: isMatched, cluster } = await matchCluster(pool, userId, symptom);
    if (isMatched && cluster && !seenClusterKeys.has(cluster.cluster_key)) {
      seenClusterKeys.add(cluster.cluster_key);
      // Try to load the script for this cluster
      const script = await getScript(pool, userId, cluster.cluster_key, 'initial');
      matched.push({ symptom, cluster, script });
    } else if (!isMatched) {
      unmatched.push(symptom);
    }
  }

  // 4. Determine primary cluster (first matched, highest priority)
  const primaryCluster = matched.length > 0 ? matched[0].cluster : null;

  // 5. Collect extra questions from combos
  const extraQuestions = [];
  for (const combo of comboResult.combos) {
    if (combo.extraQuestions) {
      extraQuestions.push(...combo.extraQuestions);
    }
  }

  return {
    isEmergency: false,
    combos: comboResult.combos,
    matched,
    unmatched,
    primaryCluster,
    aggregatedSeverity: null, // will be calculated after scripts run
    extraQuestions,
  };
}

// ─── Aggregate severity ─────────────────────────────────────────────────────

/**
 * After all scripts run, aggregate severity from all results.
 *
 * @param {Array<{
 *   severity: string,
 *   followUpHours?: number,
 *   needsDoctor?: boolean,
 *   needsFamilyAlert?: boolean
 * }>} results — individual script results
 * @param {Array<{ severity: string, followUpHours: number, needsDoctor: boolean, needsFamilyAlert: boolean }>} combos — matched combos
 * @returns {{
 *   severity: string,
 *   followUpHours: number,
 *   needsDoctor: boolean,
 *   needsFamilyAlert: boolean
 * }}
 */
function aggregateSeverity(results = [], combos = []) {
  const allItems = [...results, ...combos];

  if (allItems.length === 0) {
    return {
      severity: 'low',
      followUpHours: 6,
      needsDoctor: false,
      needsFamilyAlert: false,
    };
  }

  // Take MAX severity from all script results + combo severity
  let worstSeverity = 'low';
  let minFollowUp = Infinity;
  let needsDoctor = false;
  let needsFamilyAlert = false;

  for (const item of allItems) {
    worstSeverity = maxSeverity(worstSeverity, item.severity || 'low');
    if (item.followUpHours != null && item.followUpHours < minFollowUp) {
      minFollowUp = item.followUpHours;
    }
    if (item.needsDoctor) needsDoctor = true;
    if (item.needsFamilyAlert) needsFamilyAlert = true;
  }

  // Default followUpHours if none provided
  if (minFollowUp === Infinity) {
    minFollowUp = worstSeverity === 'critical' ? 0.5
      : worstSeverity === 'high' ? 1
      : worstSeverity === 'medium' ? 3
      : 6;
  }

  return {
    severity: worstSeverity,
    followUpHours: minFollowUp,
    needsDoctor,
    needsFamilyAlert,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  parseSymptoms,
  analyzeMultiSymptom,
  aggregateSeverity,
};
