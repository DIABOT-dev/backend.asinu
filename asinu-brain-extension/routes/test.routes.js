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

  // ─── Test Triage Chat (conversational check-in) ───
  router.post('/triage-chat', async (req, res) => {
    try {
      const { processTriageChat } = require('../../src/core/checkin/triage-chat');
      const result = await processTriageChat(req.body);
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

      const prompt = `Phân tích đoạn chat và trích xuất ONLY điều quan trọng cần nhớ về người dùng.

ĐÃ NHỚ:
${existingText}

CHAT:
${conversation}

CHỈ LƯU:
- Triệu chứng MỚI hoặc THAY ĐỔI
- Thuốc đang dùng hoặc thay đổi thuốc
- Dị ứng, thực phẩm kiêng cữ
- Lo lắng cụ thể về bệnh
- Thói quen ảnh hưởng sức khoẻ

KHÔNG LƯU:
- Lời chào, cảm ơn, hỏi thăm chung
- Điều đã nhớ rồi và không đổi
- Lời khuyên AI đưa ra
- Câu hỏi kiến thức chung

Không có gì mới → [].
[{"content":"ngắn gọn","category":"health|medication|concern|habit|preference","action":"add"}]
Cập nhật: [{"content":"mới","category":"...","action":"update","old_content":"cũ"}]
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

  // ─── SSE Auto Check-in + Chat AI Demo ───
  router.get('/auto-checkin', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const { processTriageChat } = require('../../src/core/checkin/triage-chat');
    const { buildSystemPrompt } = require('../../src/services/chat/chat.service');

    const PROFILE = {
      full_name: 'Chú Hùng', birth_year: 1960, gender: 'nam',
      medical_conditions: ['tiểu đường', 'cao huyết áp'],
    };

    const LOGS_SUMMARY = {
      latest_glucose: { value: 195, unit: 'mg/dL' },
      latest_bp: { systolic: 148, diastolic: 92, pulse: 78 },
    };

    // ─── Helper: gọi Chat AI ───
    async function chatAI(message) {
      const systemPrompt = buildSystemPrompt(PROFILE, 0, LOGS_SUMMARY, [], 'vi', []);
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ];
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
        body: JSON.stringify({ model: 'gpt-4o', messages, max_completion_tokens: 4096, temperature: 0.75 }),
      });
      const data = await response.json();
      return (data.choices?.[0]?.message?.content || 'Lỗi')
        .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '').replace(/__(.+?)__/g, '$1').replace(/_(.+?)_/g, '$1').trim();
    }

    // ═══════════════════════════════════════════════════════════
    // PHẦN 1: CHECK-IN FLOWS
    // ═══════════════════════════════════════════════════════════
    const CHECKIN_SCENARIOS = [
      {
        name: '🏥 Luồng 1: Tôi ổn (fine)',
        steps: [
          { msg: '', label: 'Greeting' },
          { msg: 'Tôi cảm thấy ổn, không có triệu chứng gì', label: 'Status: fine', extra: { initialStatus: 'fine' } },
        ],
      },
      {
        name: '🏥 Luồng 2: Hơi mệt → Triage đầy đủ',
        steps: [
          { msg: '', label: 'Greeting' },
          { msg: 'Hơi mệt', label: 'Status: tired', extra: { initialStatus: 'tired' } },
          { msg: 'đau đầu', label: 'Triệu chứng', extra: { initialStatus: 'tired' } },
          { msg: 'Đau vùng trước trán, vẫn vậy không đỡ', label: 'Chi tiết + diễn tiến', extra: { initialStatus: 'tired' } },
          { msg: 'Từ sáng, khoảng 4 tiếng', label: 'Thời gian', extra: { initialStatus: 'tired' } },
          { msg: 'Chưa uống gì, chỉ nghỉ ngơi', label: 'Hành động', extra: { initialStatus: 'tired' } },
        ],
      },
      {
        name: '🚨 Luồng 3: Rất mệt → Red flag (cấp cứu)',
        steps: [
          { msg: '', label: 'Greeting' },
          { msg: 'Rất mệt', label: 'Status: very_tired', extra: { initialStatus: 'very_tired' } },
          { msg: 'Tôi bị đau ngực bên trái và khó thở', label: '🚨 Red flag', extra: { initialStatus: 'very_tired' } },
        ],
      },
      {
        name: '🔄 Luồng 4: Follow-up — đỡ hơn (3h sau)',
        steps: [
          { msg: '', label: 'Follow-up greeting', extra: { initialStatus: 'tired', previousSessionSummary: 'Đau đầu trước trán từ sáng, chưa uống thuốc', simulatedHour: 15 } },
          { msg: 'Đỡ nhiều rồi', label: 'Đỡ hơn', extra: { initialStatus: 'tired', previousSessionSummary: 'Đau đầu trước trán', simulatedHour: 15 } },
        ],
      },
      {
        name: '⚠️ Luồng 5: Follow-up — nặng hơn',
        steps: [
          { msg: '', label: 'Follow-up greeting', extra: { initialStatus: 'tired', previousSessionSummary: 'Đau đầu nặng, huyết áp 160/95', simulatedHour: 18 } },
          { msg: 'Nặng hơn, thêm chóng mặt và buồn nôn', label: 'Nặng hơn + triệu chứng mới', extra: { initialStatus: 'very_tired', previousSessionSummary: 'Đau đầu nặng', simulatedHour: 18 } },
        ],
      },
      {
        name: '🌙 Luồng 6: Check-in buổi tối (21h)',
        steps: [
          { msg: '', label: 'Evening greeting', extra: { initialStatus: 'fine', simulatedHour: 21 } },
          { msg: 'Tôi ổn rồi, đỡ nhiều', label: 'Ổn buổi tối', extra: { initialStatus: 'fine', simulatedHour: 21 } },
        ],
      },
    ];

    // ═══════════════════════════════════════════════════════════
    // PHẦN 2: CHAT AI QUESTIONS
    // ═══════════════════════════════════════════════════════════
    const CHAT_QUESTIONS = [
      { category: '🍽️ Ăn uống', q: 'Tôi bị tiểu đường, ăn chuối mỗi ngày được không?' },
      { category: '🍽️ Ăn uống', q: 'Buổi tối hay ăn mì gói vì tiện, có sao không?' },
      { category: '🍽️ Ăn uống', q: 'Gợi ý bữa trưa ngon mà an toàn cho tôi' },
      { category: '💊 Thuốc', q: 'Metformin 850mg uống ngày mấy lần, trước hay sau ăn?' },
      { category: '💊 Thuốc', q: 'Uống thuốc huyết áp xong bị chóng mặt có sao không?' },
      { category: '🩺 Sức khỏe', q: 'Đường huyết sáng nay 210, cao quá phải không?' },
      { category: '🩺 Sức khỏe', q: 'Tôi hay bị tê bàn chân, nhất là buổi tối' },
      { category: '🩺 Sức khỏe', q: 'Mắt tôi mờ dần, có phải do tiểu đường không?' },
      { category: '🧠 Tâm lý', q: 'Tôi chán nản không muốn đo đường huyết nữa' },
      { category: '🏃 Sinh hoạt', q: 'Đêm nào cũng đi tiểu 4-5 lần, ngủ không yên' },
      { category: '🏃 Sinh hoạt', q: 'Uống bia mỗi tối 1 lon có được không?' },
      { category: '🏃 Sinh hoạt', q: 'Uống cà phê có ảnh hưởng huyết áp không?' },
    ];

    const totalItems = CHECKIN_SCENARIOS.length + CHAT_QUESTIONS.length;
    send('start', { totalScenarios: totalItems, profile: PROFILE, sections: ['Check-in Flows', 'Chat AI'] });

    // ─── RUN CHECK-IN FLOWS ───
    send('section', { name: '═══ PHẦN 1: CHECK-IN FLOWS ═══', count: CHECKIN_SCENARIOS.length });

    for (const scenario of CHECKIN_SCENARIOS) {
      send('scenario', { name: scenario.name });
      let history = [];

      for (const step of scenario.steps) {
        send('user', { label: step.label, message: step.msg || '(greeting)' });

        try {
          const result = await processTriageChat({
            message: step.msg, profile: PROFILE, history, ...(step.extra || {}),
          });
          history.push(
            ...(step.msg ? [{ role: 'user', content: step.msg }] : []),
            { role: 'assistant', content: result.reply || '' }
          );
          send('ai', {
            reply: result.reply, isDone: result.isDone || false,
            severity: result.severity, options: result.options,
            summary: result.summary, recommendation: result.recommendation,
            needsDoctor: result.needsDoctor, hasRedFlag: result.hasRedFlag,
            followUpHours: result.followUpHours,
          });
        } catch (err) {
          send('error', { step: step.label, error: err.message });
        }
      }
      send('scenario_done', { name: scenario.name });
    }

    // ─── RUN CHAT AI ───
    send('section', { name: '═══ PHẦN 2: CHAT AI ═══', count: CHAT_QUESTIONS.length });

    for (const item of CHAT_QUESTIONS) {
      send('scenario', { name: item.category });
      send('user', { label: item.category, message: item.q });

      try {
        const reply = await chatAI(item.q);
        const sentences = reply.split(/[.!?]/).filter(s => s.trim()).length;
        send('ai', { reply, isDone: true, meta: `${sentences} câu | ${reply.length} ký tự` });
      } catch (err) {
        send('error', { step: item.category, error: err.message });
      }
      send('scenario_done', { name: item.category });
    }

    send('done', { message: 'Hoàn tất! ' + totalItems + ' tests (6 check-in + 12 chat AI)' });
    res.end();
  });

  return router;
}

module.exports = testRoutes;
