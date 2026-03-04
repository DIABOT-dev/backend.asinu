const express = require('express');
const {
  testMoodQuestion,
  testFollowupQuestion,
  testSymptomQuestion,
  testAllQuestions,
  testHealth
} = require('../controllers/test.controller');
const { sendPushNotification } = require('../../src/services/push.notification.service');
const { generateEngagementNotification, getUserContext } = require('../../src/services/engagement.notification.service');

/**
 * Public Test Routes - No Authentication Required
 * ONLY FOR TESTING OpenAI question generation
 */
function testRoutes(pool) {
  const router = express.Router();

  // Health check
  router.get('/health', (req, res) => testHealth(pool, req, res));

  // Test individual question types
  router.get('/question/mood', (req, res) => testMoodQuestion(pool, req, res));
  router.get('/question/followup', (req, res) => testFollowupQuestion(pool, req, res));
  router.get('/question/symptom', (req, res) => testSymptomQuestion(pool, req, res));

  // Test all questions at once
  router.get('/question/all', (req, res) => testAllQuestions(pool, req, res));

  /**
   * POST /api/test/push
   * Gửi push notification test đến user.
   * Body: { userId?, token?, title?, body? }
   * - Dùng token trực tiếp HOẶC userId để lấy token từ DB
   * - Nếu không truyền title/body → AI tự sinh nội dung
   */
  router.post('/push', async (req, res) => {
    const { userId, token, title, body } = req.body || {};

    try {
      let pushToken = token;

      // Lấy token từ DB nếu không truyền trực tiếp
      if (!pushToken && userId) {
        const result = await pool.query(
          'SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL',
          [userId]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ ok: false, error: `User ${userId} không có push token trong DB` });
        }
        pushToken = result.rows[0].push_token;
      }

      if (!pushToken) {
        return res.status(400).json({ ok: false, error: 'Cần truyền token hoặc userId' });
      }

      // Nếu không có nội dung → AI sinh
      let finalTitle = title || 'Asinu Test';
      let finalBody = body;

      if (!finalBody && userId) {
        const userRow = await pool.query(
          `SELECT COALESCE(full_name, display_name) AS name, language_preference FROM users WHERE id = $1`,
          [userId]
        );
        const user = { id: userId, name: userRow.rows[0]?.name, hours_inactive: 26, language_preference: userRow.rows[0]?.language_preference };
        const context = await getUserContext(pool, userId);
        const decision = await generateEngagementNotification(user, context, user.language_preference || 'vi');
        finalTitle = decision.title || finalTitle;
        finalBody = decision.body || '👋 Đây là thông báo test từ Asinu!';
      } else if (!finalBody) {
        finalBody = '👋 Đây là thông báo test từ Asinu!';
      }

      const result = await sendPushNotification([pushToken], finalTitle, finalBody, { type: 'engagement' });

      return res.status(200).json({
        ok: result.ok,
        pushToken,
        title: finalTitle,
        body: finalBody,
        expoResponse: result.data,
        error: result.error,
      });
    } catch (err) {
      console.error('[test/push] Error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = testRoutes;
