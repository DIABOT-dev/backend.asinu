const express = require('express');
const {
  testMoodQuestion,
  testFollowupQuestion,
  testSymptomQuestion,
  testAllQuestions,
  testHealth
} = require('../controllers/test.controller');
const { sendPushNotification } = require('../../src/services/notification/push.notification.service');
const { generateEngagementNotification, getUserContext } = require('../../src/services/notification/engagement.notification.service');

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

  // ─── Test Chat UI ───
  const path = require('path');
  router.get('/chat-ui', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/test-chat.html'));
  });

  // ─── Test Triage AI ───
  router.post('/triage', async (req, res) => {
    try {
      const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.ai.service');
      const result = await getNextTriageQuestion(req.body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Test Chat AI ───
  router.post('/chat', async (req, res) => {
    try {
      const { buildSystemPrompt } = require('../../src/services/chat/chat.service');
      const { message, profile, history = [] } = req.body;
      const systemPrompt = buildSystemPrompt(profile, history.length,
        { latest_glucose: { value: 195, unit: 'mg/dL' }, latest_bp: { systolic: 148, diastolic: 92, pulse: 78 } },
        history, 'vi');
      const messages = [{ role: 'system', content: systemPrompt }];
      for (const turn of history) messages.push({ role: turn.sender === 'user' ? 'user' : 'assistant', content: turn.message });
      messages.push({ role: 'user', content: message });
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o', messages, max_completion_tokens: 4096, temperature: 0.75, frequency_penalty: 0.2, presence_penalty: 0.2 }),
      });
      const data = await response.json();
      const reply = (data.choices?.[0]?.message?.content || 'Lỗi')
        .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '').replace(/__(.+?)__/g, '$1').replace(/_(.+?)_/g, '$1').trim();
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = testRoutes;
