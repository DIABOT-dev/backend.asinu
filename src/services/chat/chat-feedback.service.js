/**
 * Chat Feedback Service
 * Database operations for chat feedback (like/dislike/note)
 */

/**
 * Check if a note already exists for a message
 */
async function checkExistingNote(pool, userId, messageId) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_feedback WHERE user_id=$1 AND message_id=$2 AND feedback_type='note'`,
    [userId, messageId]
  );
  return rows;
}

/**
 * Save a chat note
 */
async function saveChatNote(pool, userId, messageId, messageText) {
  await pool.query(
    `INSERT INTO chat_feedback (user_id, message_id, message_text, feedback_type) VALUES ($1,$2,$3,'note')`,
    [userId, messageId, messageText]
  );
}

/**
 * Get existing like/dislike feedback for a message
 */
async function getExistingFeedback(pool, userId, messageId) {
  const { rows } = await pool.query(
    `SELECT id, feedback_type FROM chat_feedback WHERE user_id=$1 AND message_id=$2 AND feedback_type IN ('like','dislike')`,
    [userId, messageId]
  );
  return rows;
}

/**
 * Delete a feedback record by id
 */
async function deleteFeedback(pool, feedbackId) {
  await pool.query('DELETE FROM chat_feedback WHERE id=$1', [feedbackId]);
}

/**
 * Update feedback type for an existing record
 */
async function updateFeedbackType(pool, feedbackId, newType) {
  await pool.query(
    'UPDATE chat_feedback SET feedback_type=$1, updated_at=NOW() WHERE id=$2',
    [newType, feedbackId]
  );
}

/**
 * Save a new feedback (like/dislike)
 */
async function saveFeedback(pool, userId, messageId, messageText, feedbackType) {
  await pool.query(
    `INSERT INTO chat_feedback (user_id, message_id, message_text, feedback_type) VALUES ($1,$2,$3,$4)`,
    [userId, messageId, messageText, feedbackType]
  );
}

/**
 * Get chat notes with pagination
 * Returns { notes, total }
 */
async function getChatNotes(pool, userId, page, limit) {
  const offset = (page - 1) * limit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT id, message_text, created_at FROM chat_feedback WHERE user_id=$1 AND feedback_type='note' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int as total FROM chat_feedback WHERE user_id=$1 AND feedback_type='note'`,
      [userId]
    ),
  ]);

  return { notes: rows, total: countRows[0]?.total || 0 };
}

/**
 * Delete a note by id and user_id
 */
async function deleteNote(pool, noteId, userId) {
  await pool.query(
    `DELETE FROM chat_feedback WHERE id=$1 AND user_id=$2 AND feedback_type='note'`,
    [noteId, userId]
  );
}

/**
 * Get like/dislike feedback map for a user
 * Returns array of { message_id, feedback_type }
 */
async function getChatFeedbacks(pool, userId) {
  const { rows } = await pool.query(
    `SELECT message_id, feedback_type FROM chat_feedback WHERE user_id=$1 AND feedback_type IN ('like','dislike')`,
    [userId]
  );
  return rows;
}

/**
 * Get noted message IDs for a user
 * Returns array of { message_id }
 */
async function getChatNotedIds(pool, userId) {
  const { rows } = await pool.query(
    `SELECT message_id FROM chat_feedback WHERE user_id=$1 AND feedback_type='note'`,
    [userId]
  );
  return rows;
}

module.exports = {
  checkExistingNote,
  saveChatNote,
  getExistingFeedback,
  deleteFeedback,
  updateFeedbackType,
  saveFeedback,
  getChatNotes,
  deleteNote,
  getChatFeedbacks,
  getChatNotedIds,
};
