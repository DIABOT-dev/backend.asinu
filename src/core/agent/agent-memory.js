/**
 * Agent Check-in Memory Service
 *
 * Cross-session memory for the check-in agent.
 * Different from user_memories (which stores chat AI memories).
 *
 * Memory types:
 *   'pattern'    - "user has headaches on Monday mornings"
 *   'preference' - "user prefers short check-ins"
 *   'insight'    - "user's dizziness correlates with skipping medication"
 *   'warning'    - "user had high severity 3 times this week"
 *
 * Sources:
 *   'system'    - detected by code/rules
 *   'rnd_cycle' - detected by nightly R&D cycle
 *   'medgemma'  - detected by MedGemma AI (future)
 */

'use strict';

/**
 * Save a memory (upsert). If the same user+type+key exists, update it.
 * @param {object} pool
 * @param {number} userId
 * @param {string} type     - 'pattern' | 'preference' | 'insight' | 'warning'
 * @param {string} key      - unique key per user+type (e.g. 'headache_monday')
 * @param {object} content  - JSONB content
 * @param {string} [source] - 'system' | 'rnd_cycle' | 'medgemma'
 * @param {number} [confidence] - 0.00-1.00
 * @param {Date}   [expiresAt]  - optional expiry
 */
async function remember(pool, userId, type, key, content, source = 'system', confidence = 1.0, expiresAt = null) {
  const { rows } = await pool.query(
    `INSERT INTO agent_checkin_memory (user_id, memory_type, memory_key, content, confidence, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, memory_type, memory_key) DO UPDATE SET
       content = $4,
       confidence = $5,
       source = $6,
       is_active = TRUE,
       expires_at = $7,
       updated_at = NOW()
     RETURNING id`,
    [userId, type, key, JSON.stringify(content), confidence, source, expiresAt]
  );
  return rows[0];
}

/**
 * Get all active memories for a user, optionally filtered by type.
 * @param {object} pool
 * @param {number} userId
 * @param {string|null} [type] - filter by memory_type, or null for all
 * @returns {Promise<Array>}
 */
async function recall(pool, userId, type = null) {
  const params = [userId];
  let typeClause = '';
  if (type) {
    typeClause = ' AND memory_type = $2';
    params.push(type);
  }

  const { rows } = await pool.query(
    `SELECT memory_type, memory_key, content, confidence, source, updated_at
     FROM agent_checkin_memory
     WHERE user_id = $1 AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       ${typeClause}
     ORDER BY updated_at DESC`,
    params
  );
  return rows;
}

/**
 * Get a specific memory by user+type+key.
 * @param {object} pool
 * @param {number} userId
 * @param {string} type
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function recallOne(pool, userId, type, key) {
  const { rows } = await pool.query(
    `SELECT memory_type, memory_key, content, confidence, source, updated_at
     FROM agent_checkin_memory
     WHERE user_id = $1 AND memory_type = $2 AND memory_key = $3
       AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId, type, key]
  );
  return rows[0] || null;
}

/**
 * Forget (deactivate) a memory.
 * @param {object} pool
 * @param {number} userId
 * @param {string} type
 * @param {string} key
 * @returns {Promise<boolean>} true if a row was deactivated
 */
async function forget(pool, userId, type, key) {
  const { rowCount } = await pool.query(
    `UPDATE agent_checkin_memory
     SET is_active = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND memory_type = $2 AND memory_key = $3 AND is_active = TRUE`,
    [userId, type, key]
  );
  return rowCount > 0;
}

/**
 * Forget all memories of a specific type for a user.
 * @param {object} pool
 * @param {number} userId
 * @param {string} type
 * @returns {Promise<number>} count of deactivated rows
 */
async function forgetAll(pool, userId, type) {
  const { rowCount } = await pool.query(
    `UPDATE agent_checkin_memory
     SET is_active = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND memory_type = $2 AND is_active = TRUE`,
    [userId, type]
  );
  return rowCount;
}

module.exports = {
  remember,
  recall,
  recallOne,
  forget,
  forgetAll,
};
