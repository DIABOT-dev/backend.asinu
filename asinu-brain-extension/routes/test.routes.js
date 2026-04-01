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

  // ─── Test Free Triage (no strict rules) ───
  router.post('/free-triage', async (req, res) => {
    try {
      const { getHonorifics } = require('../../src/lib/honorifics');
      const { message, profile, history = [] } = req.body;
      const h = getHonorifics({
        birth_year: profile.birth_year,
        gender: profile.gender,
        full_name: profile.full_name,
        lang: 'vi',
      });
      const systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ AI bằng tiếng Việt.

CÁCH XƯNG HÔ:
- Gọi người dùng: "${h.callName}" (${h.honorific})
- Tự xưng: "${h.selfRef}"

THÔNG TIN NGƯỜI DÙNG:
- Tên: ${profile.full_name}
- Năm sinh: ${profile.birth_year} (${new Date().getFullYear() - profile.birth_year} tuổi)
- Giới tính: ${profile.gender}
- Bệnh nền: ${(profile.medical_conditions || []).join(', ') || 'Không'}
- Dùng thuốc hàng ngày: ${profile.daily_medication || 'Không'}
- Chiều cao: ${profile.height_cm}cm, Cân nặng: ${profile.weight_kg}kg

NHIỆM VỤ:
Bạn cần hiểu tình trạng sức khoẻ hiện tại của người dùng và đặt câu hỏi giúp làm rõ vấn đề nhanh nhất.

NGUYÊN TẮC:
- Hỏi ngắn gọn, tự nhiên, thân thiện
- Mỗi lần chỉ hỏi 1 câu
- Dựa vào câu trả lời trước để hỏi tiếp, không hỏi lại điều đã biết
- Khi đã đủ thông tin → đưa ra nhận định và lời khuyên
- Nói chuyện như người thật, không máy móc
- Xưng hô nhất quán: "${h.selfRef}" và "${h.honorific}"`;

      const messages = [{ role: 'system', content: systemPrompt }];
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: 'user', content: message });

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o', messages, max_completion_tokens: 1024, temperature: 0.8 }),
      });
      const data = await response.json();
      const reply = (data.choices?.[0]?.message?.content || 'Lỗi').trim();
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Test Chat AI (with memory support) ───
  router.post('/chat', async (req, res) => {
    try {
      const { buildSystemPrompt } = require('../../src/services/chat/chat.service');
      const { formatMemoriesForPrompt } = require('../../src/services/chat/memory.service');
      const { message, profile, history = [], memories = [] } = req.body;
      const formattedMemories = memories.map(m => ({ content: m.content, category: m.category, updated_at: m.updated_at || '' }));
      const systemPrompt = buildSystemPrompt(profile, history.length,
        { latest_glucose: { value: 195, unit: 'mg/dL' }, latest_bp: { systolic: 148, diastolic: 92, pulse: 78 } },
        history, 'vi', formattedMemories);
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

  // ─── Test Extract Memories (for test-chat localStorage) ───
  router.post('/extract-memories', async (req, res) => {
    try {
      const { messages = [], existingMemories = [] } = req.body;
      if (messages.length < 4) return res.json({ memories: [] });

      const conversation = messages.slice(-10).map(m =>
        `${m.sender === 'user' ? 'User' : 'AI'}: ${m.message}`
      ).join('\n');

      const existingText = existingMemories.length
        ? existingMemories.map(m => `- [${m.category}] ${m.content}`).join('\n')
        : 'Chưa có.';

      const prompt = `Phân tích đoạn chat và trích xuất điều QUAN TRỌNG cần nhớ về người dùng.

ĐÃ NHỚ:
${existingText}

CHAT:
${conversation}

RULES:
- Chỉ điều THỰC SỰ quan trọng, hữu ích cho lần chat sau
- KHÔNG lặp lại điều đã nhớ trừ khi cần cập nhật
- Mỗi memory 1 dòng ngắn gọn
- Categories: health, preference, concern, habit, medication, general
- Không có gì mới → trả []

JSON array:
[{"content":"...","category":"health","action":"add"}]
hoặc update: [{"content":"...","category":"health","action":"update","old_content":"..."}]
hoặc: []
CHỈ JSON.`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 512, temperature: 0.3 }),
      });
      const data = await response.json();
      const raw = (data.choices?.[0]?.message?.content || '').trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return res.json({ memories: [] });
      const items = JSON.parse(jsonMatch[0]);
      res.json({ memories: Array.isArray(items) ? items : [] });
    } catch (err) {
      res.status(500).json({ error: err.message, memories: [] });
    }
  });

  return router;
}

module.exports = testRoutes;
