'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { postChatFeedback } = require('../../src/controllers/chat.controller');
const { getChatFeedbacks } = require('../../src/services/chat/chat-feedback.service');

const url = process.env.ASSISTANT_FEEDBACK_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// The migration and service run against a temporary copy of the table schema.
suite('assistant response feedback in PostgreSQL', () => {
  let db;
  const id = 'asinu-assistant:fixture';

  beforeAll(async () => {
    db = new Client({ connectionString: url, options: '-c statement_timeout=5000' });
    await db.connect();
    await db.query('BEGIN');
    await db.query(`
      CREATE TEMP TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1), (2);
    `);
    const readMigration = name => fs.readFileSync(path.join(__dirname, '../../db/migrations', name), 'utf8');
    // Publish the real migration's table in this session without touching the app table.
    await db.query(readMigration('043_chat_feedback.sql').replace('CREATE TABLE', 'CREATE TEMP TABLE'));
    await db.query(`
      INSERT INTO chat_feedback (user_id, message_id, message_text, feedback_type, updated_at)
      VALUES (1, $1, 'Older answer', 'like', '2026-09-01'),
             (1, $1, 'Newest answer', 'dislike', '2026-09-02'),
             (1, $1, 'Existing note', 'note', '2026-09-01'),
             (2, $1, 'Other user answer', 'like', '2026-09-01')
    `, [id]);
    await db.query(readMigration('138_assistant_response_feedback.sql'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  async function rate(userId, messageId, feedbackType, messageText) {
    let status = 200;
    let body;
    const response = {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    };
    await postChatFeedback(db, { user: { id: userId }, body: { messageId, messageText, feedbackType } }, response);
    return { status, ...body };
  }

  test('the migration keeps each user’s newest choice and any notes for that answer', async () => {
    expect(await getChatFeedbacks(db, 1)).toEqual([{ message_id: id, feedback_type: 'dislike' }]);
    expect(await getChatFeedbacks(db, 2)).toEqual([{ message_id: id, feedback_type: 'like' }]);
    const { rows } = await db.query(
      'SELECT feedback_type, message_text FROM chat_feedback WHERE user_id=1 ORDER BY id'
    );
    expect(rows).toEqual([
      { feedback_type: 'dislike', message_text: 'Newest answer' },
      { feedback_type: 'note', message_text: 'Existing note' },
    ]);
  });

  test('an authenticated selection replaces the previous choice and repeats leave one rating', async () => {
    await expect(rate(1, id, 'like', 'Newest answer')).resolves.toMatchObject({ status: 200, action: 'saved' });
    const { rows: [saved] } = await db.query(
      "SELECT id, updated_at FROM chat_feedback WHERE user_id=1 AND feedback_type='like'"
    );
    await expect(rate(1, id, 'like', 'Newest answer')).resolves.toMatchObject({ status: 200, action: 'saved' });
    const { rows } = await db.query(
      "SELECT id, updated_at FROM chat_feedback WHERE user_id=1 AND feedback_type IN ('like','dislike')"
    );
    expect(rows).toEqual([saved]);
    await expect(rate(1, id, 'dislike', 'Newest answer')).resolves.toMatchObject({ status: 200, action: 'saved' });
    expect(await getChatFeedbacks(db, 1)).toEqual([{ message_id: id, feedback_type: 'dislike' }]);
    expect(await getChatFeedbacks(db, 2)).toEqual([{ message_id: id, feedback_type: 'like' }]);
  });

  test('assistant rejects notes while legacy chat keeps its existing toggle', async () => {
    await expect(rate(1, id, 'note', 'This is an assistant answer')).resolves.toMatchObject({ status: 400, ok: false });
    await expect(rate(1, 'legacy-id', 'like', 'Legacy answer')).resolves.toMatchObject({ status: 200, action: 'saved' });
    await expect(rate(1, 'legacy-id', 'like', 'Legacy answer')).resolves.toMatchObject({ status: 200, action: 'removed' });
  });
});
