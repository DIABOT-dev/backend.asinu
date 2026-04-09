'use strict';

/**
 * Fallback Service — Handle unknown symptoms
 *
 * When user enters a symptom not in their clusters/scripts:
 *   1. Run fallback questions (generic, no AI)
 *   2. Score with generic rules
 *   3. Log to fallback_logs for R&D cycle processing
 *   4. KHÔNG gọi AI ngay — R&D cycle ban đêm sẽ xử lý
 *
 * Ban đêm R&D cycle:
 *   - AI đọc fallback log → gắn nhãn → tạo cluster mới hoặc gộp vào cluster cũ
 *   - Ngày mai user có script sẵn cho triệu chứng đó
 */

const { evaluateScript } = require('../../core/checkin/scoring-engine');
const { getHonorifics } = require('../../lib/honorifics');

// ─── Standard fallback questions ────────────────────────────────────────────

const FALLBACK_QUESTIONS = [
  {
    id: 'fb1',
    text: 'Đau mức nào?',
    type: 'slider',
    min: 0,
    max: 10,
  },
  {
    id: 'fb2',
    text: 'Từ khi nào?',
    type: 'single_choice',
    options: ['Vừa mới', 'Vài giờ trước', 'Từ sáng', 'Từ hôm qua', 'Vài ngày'],
  },
  {
    id: 'fb3',
    text: 'Nặng hơn không?',
    type: 'single_choice',
    options: ['Đang đỡ', 'Vẫn vậy', 'Nặng hơn'],
  },
];

// Scoring rules for fallback
const FALLBACK_SCORING_RULES = [
  {
    conditions: [{ field: 'fb1', op: 'gte', value: 7 }],
    combine: 'and',
    severity: 'high',
    follow_up_hours: 1,
    needs_doctor: true,
    needs_family_alert: true,
  },
  {
    conditions: [{ field: 'fb3', op: 'eq', value: 'Nặng hơn' }],
    combine: 'and',
    severity: 'high',
    follow_up_hours: 1,
    needs_doctor: true,
    needs_family_alert: false,
  },
  {
    conditions: [{ field: 'fb1', op: 'gte', value: 4 }],
    combine: 'and',
    severity: 'medium',
    follow_up_hours: 3,
    needs_doctor: false,
    needs_family_alert: false,
  },
  {
    conditions: [{ field: 'fb1', op: 'lt', value: 4 }],
    combine: 'and',
    severity: 'low',
    follow_up_hours: 6,
    needs_doctor: false,
    needs_family_alert: false,
  },
];

const FALLBACK_CONCLUSION_TEMPLATES = {
  low: {
    summary: '{Honorific} có triệu chứng nhẹ.',
    recommendation: 'Nghỉ ngơi, uống đủ nước. Theo dõi trong 24h.',
    close_message: '{selfRef} sẽ hỏi lại {honorific} tối nay nhé 💙',
  },
  medium: {
    summary: '{Honorific} có triệu chứng mức trung bình, cần theo dõi.',
    recommendation: 'Nghỉ ngơi, uống thuốc nếu có. Nếu không đỡ sau 24h nên đi khám.',
    close_message: '{selfRef} sẽ hỏi lại {honorific} sau 3 tiếng nhé.',
  },
  high: {
    summary: '{Honorific} có triệu chứng nặng, cần được bác sĩ đánh giá.',
    recommendation: '🏥 {Honorific} nên đi khám bác sĩ hôm nay.',
    close_message: '{selfRef} sẽ hỏi lại {honorific} sau 1 tiếng. Đi khám sớm nhé.',
  },
};

/**
 * Get the fallback script data (used like a regular script).
 * This is a static script — no DB calls needed.
 */
function getFallbackScriptData() {
  return {
    greeting: '{CallName} ơi, {selfRef} hỏi thăm {honorific} thêm nhé 💙',
    questions: FALLBACK_QUESTIONS,
    scoring_rules: FALLBACK_SCORING_RULES,
    condition_modifiers: [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: 'fb1', op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
    ],
    conclusion_templates: FALLBACK_CONCLUSION_TEMPLATES,
    followup_questions: [
      {
        id: 'fu1',
        text: 'So với lúc trước, {honorific} thấy thế nào?',
        type: 'single_choice',
        options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'],
      },
      {
        id: 'fu2',
        text: 'Có triệu chứng mới không?',
        type: 'single_choice',
        options: ['Không', 'Có'],
      },
    ],
    fallback_questions: FALLBACK_QUESTIONS,
  };
}

// ─── Log fallback for R&D cycle ─────────────────────────────────────────────

/**
 * Log an unknown symptom input for nightly R&D processing.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} rawInput - nguyên văn user nhập
 * @param {number|null} checkinId
 * @param {Array} fallbackAnswers - answers from fallback questions
 */
async function logFallback(pool, userId, rawInput, checkinId = null, fallbackAnswers = []) {
  try {
    await pool.query(
      `INSERT INTO fallback_logs (user_id, checkin_id, raw_input, fallback_answers)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, checkinId, rawInput, JSON.stringify(fallbackAnswers)]
    );
    console.log(`[Fallback] Logged unknown symptom for user ${userId}: "${rawInput}"`);
  } catch (err) {
    console.error('[Fallback] Failed to log:', err.message);
  }
}

/**
 * Check if a symptom input matches any of user's existing clusters.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} symptomInput
 * @returns {Promise<{ matched: boolean, cluster?: object }>}
 */
/**
 * Remove Vietnamese diacritics from a string.
 * "đau đầu" → "dau dau", "chóng mặt" → "chong mat"
 */
function removeDiacritics(str) {
  return str
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]/g, 'A')
    .replace(/[ÈÉẸẺẼÊỀẾỆỂỄ]/g, 'E')
    .replace(/[ÌÍỊỈĨ]/g, 'I')
    .replace(/[ÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, 'O')
    .replace(/[ÙÚỤỦŨƯỪỨỰỬỮ]/g, 'U')
    .replace(/[ỲÝỴỶỸ]/g, 'Y')
    .replace(/Đ/g, 'D');
}

async function matchCluster(pool, userId, symptomInput) {
  // Guard: ensure string input (handles true, {}, [], numbers, etc.)
  if (symptomInput == null || typeof symptomInput !== 'string') return { matched: false };
  const input = symptomInput.toLowerCase().trim();
  if (!input) return { matched: false };

  // Prepare no-diacritics version for fallback matching
  const inputNoDiac = removeDiacritics(input);

  // Get user's active clusters
  const { rows: clusters } = await pool.query(
    `SELECT * FROM problem_clusters
     WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );

  // Multi-level matching: exact → no-diacritics → token overlap
  for (const cluster of clusters) {
    const displayLower = cluster.display_name.toLowerCase();
    const keyLower = cluster.cluster_key.toLowerCase().replace(/_/g, ' ');
    const displayNoDiac = removeDiacritics(displayLower);

    // Level 1: substring match (exact, with diacritics)
    if (input.includes(displayLower) || displayLower.includes(input) ||
        input.includes(keyLower) || keyLower.includes(input)) {
      return { matched: true, cluster };
    }

    // Level 2: no-diacritics match
    // "dau dau" matches "đau đầu", "chong mat" matches "chóng mặt"
    if (inputNoDiac.includes(displayNoDiac) || displayNoDiac.includes(inputNoDiac) ||
        inputNoDiac.includes(keyLower) || keyLower.includes(inputNoDiac)) {
      return { matched: true, cluster };
    }

    // Level 3: token overlap — meaningful tokens must match
    const GENERIC_TOKENS = new Set(['đau', 'bị', 'hơi', 'rất', 'hay', 'có', 'mỗi', 'khi', 'lúc', 'sau', 'của', 'trong', 'này',
                                     'dau', 'bi', 'hoi', 'rat', 'hay', 'co', 'moi', 'khi', 'luc', 'sau', 'cua', 'trong', 'nay']);
    const inputTokens = input.split(/\s+/).filter(t => t.length >= 2 && !GENERIC_TOKENS.has(t));
    // No-diacritics tokens need >= 3 chars to avoid false positives ("ho"→2 chars, too short)
    const inputTokensNoDiac = inputNoDiac.split(/\s+/).filter(t => t.length >= 3 && !GENERIC_TOKENS.has(t));
    const displayTokens = displayLower.split(/\s+/).filter(t => t.length >= 2 && !GENERIC_TOKENS.has(t));
    const displayTokensNoDiac = displayNoDiac.split(/\s+/).filter(t => t.length >= 3 && !GENERIC_TOKENS.has(t));
    const keyTokens = keyLower.split(/\s+/).filter(t => t.length >= 2);

    // Level 4: synonym expansion
    // User says "ói" but cluster is "buồn nôn", "nhức" but cluster is "đau"
    const SYNONYMS = {
      'ói': ['buồn nôn', 'nôn', 'nausea'], 'nôn': ['buồn nôn', 'nausea'],
      'nhức': ['đau đầu', 'headache'], 'xỉu': ['ngất', 'chóng mặt', 'dizziness'],
      'mờ': ['mắt mờ', 'mờ mắt'], 'tê': ['tê tay', 'tê chân', 'tê bì'],
      'run': ['run tay', 'sốt'], 'ngứa': ['ngứa da', 'phát ban', 'rash'],
      'oi': ['buon non', 'nausea'], 'nhuc': ['dau dau', 'headache'],
      'xiu': ['ngat', 'chong mat'], 'te': ['te tay', 'te chan'],
    };

    // Check with diacritics first, then without, then synonyms
    let hasTokenOverlap = inputTokens.some(t =>
      displayTokens.includes(t) || keyTokens.includes(t)
    ) || inputTokensNoDiac.some(t =>
      displayTokensNoDiac.includes(t) || keyTokens.includes(t)
    );

    // Synonym check: expand input tokens and match
    if (!hasTokenOverlap) {
      for (const t of [...inputTokens, ...inputTokensNoDiac]) {
        const syns = SYNONYMS[t];
        if (syns) {
          hasTokenOverlap = syns.some(syn =>
            displayLower.includes(syn) || displayNoDiac.includes(removeDiacritics(syn)) || keyLower.includes(syn)
          );
          if (hasTokenOverlap) break;
        }
      }
    }

    if (hasTokenOverlap) {
      return { matched: true, cluster };
    }
  }

  return { matched: false };
}

/**
 * Get pending fallback logs for R&D cycle.
 */
async function getPendingFallbacks(pool, limit = 100) {
  const { rows } = await pool.query(
    `SELECT fl.*, u.id as uid
     FROM fallback_logs fl
     JOIN users u ON u.id = fl.user_id
     WHERE fl.status = 'pending'
     ORDER BY fl.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Mark fallback as processed.
 */
async function markFallbackProcessed(pool, fallbackId, label, clusterKey, confidence, mergedClusterId = null) {
  await pool.query(
    `UPDATE fallback_logs SET
       status = $2,
       ai_label = $3,
       ai_cluster_key = $4,
       ai_confidence = $5,
       merged_to_cluster_id = $6,
       processed_at = NOW()
     WHERE id = $1`,
    [fallbackId, mergedClusterId ? 'merged' : 'processed', label, clusterKey, confidence, mergedClusterId]
  );
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getFallbackScriptData,
  logFallback,
  matchCluster,
  getPendingFallbacks,
  markFallbackProcessed,
  FALLBACK_QUESTIONS,
};
