/**
 * User Memory Service
 *
 * Sau mỗi cuộc chat, AI trích xuất những điều quan trọng về user
 * và lưu vào DB. Lần sau chat, AI đã biết sẵn.
 *
 * Categories: health, preference, concern, habit, medication, general
 */

const MAX_MEMORIES = 20;

/**
 * Lấy tất cả memories của user
 */
async function getUserMemories(pool, userId) {
  const { rows } = await pool.query(
    `SELECT content, category, updated_at FROM user_memories
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, MAX_MEMORIES]
  );
  return rows;
}

/**
 * Format memories thành text để inject vào system prompt
 */
function formatMemoriesForPrompt(memories) {
  if (!memories.length) return '';
  const lines = memories.map(m => `- [${m.category}] ${m.content}`);
  return `MEMORY (điều đã biết về người dùng từ các cuộc chat trước — dùng tự nhiên, KHÔNG nhắc lại y nguyên):\n${lines.join('\n')}`;
}

/**
 * Gọi AI để trích xuất memories mới từ cuộc chat vừa xong.
 * Chạy background, không block response.
 */
async function extractAndSaveMemories(pool, userId, recentMessages) {
  // Cần ít nhất 6 tin nhắn (3 lượt qua lại) mới trích xuất
  if (!recentMessages || recentMessages.length < 6) return;

  // Lấy 10 tin nhắn gần nhất để phân tích
  const last10 = recentMessages.slice(-10);
  const conversation = last10.map(m =>
    `${m.sender === 'user' ? 'User' : 'AI'}: ${m.message}`
  ).join('\n');

  // Lấy memories hiện tại để AI biết đã nhớ gì rồi
  const existing = await getUserMemories(pool, userId);
  const existingText = existing.length
    ? existing.map(m => `- [${m.category}] ${m.content}`).join('\n')
    : 'Chưa có memory nào.';

  const prompt = `Phân tích đoạn chat và trích xuất ONLY điều quan trọng cần nhớ về người dùng.

ĐÃ NHỚ:
${existingText}

CHAT:
${conversation}

CHỈ LƯU những điều sau (nếu có):
- Triệu chứng MỚI hoặc triệu chứng THAY ĐỔI (VD: "bị tê tay từ tuần trước")
- Thuốc đang dùng hoặc THAY ĐỔI thuốc
- Dị ứng, thực phẩm kiêng cữ
- Lo lắng cụ thể về bệnh (VD: "sợ biến chứng mắt")
- Thói quen ảnh hưởng sức khoẻ (VD: "hay quên thuốc tối", "không uống đủ nước")

KHÔNG LƯU:
- Lời chào, cảm ơn, hỏi thăm chung chung
- Điều đã có trong profile (tuổi, bệnh nền, chiều cao...)
- Điều đã nhớ rồi và không thay đổi
- Lời khuyên AI đưa ra
- Câu hỏi kiến thức chung (VD: "tiểu đường ăn gì")

Trả JSON array. Không có gì mới → trả [].
[{"content":"ngắn gọn 1 dòng","category":"health|medication|concern|habit|preference","action":"add"}]
Cập nhật: [{"content":"mới","category":"...","action":"update","old_content":"cũ"}]

CHỈ JSON.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 512,
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // Parse JSON từ response
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const items = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
      if (!item.content || !item.category) continue;

      if (item.action === 'update' && item.old_content) {
        // Cập nhật memory cũ
        await pool.query(
          `UPDATE user_memories SET content = $1, category = $2, updated_at = NOW()
           WHERE user_id = $3 AND content = $4`,
          [item.content, item.category, userId, item.old_content]
        );
      } else {
        // Thêm memory mới (skip nếu nội dung đã tồn tại)
        await pool.query(
          `INSERT INTO user_memories (user_id, content, category)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM user_memories WHERE user_id = $1 AND content = $2
           )`,
          [userId, item.content, item.category]
        );
      }
    }

    // Giới hạn tối đa MAX_MEMORIES — xóa cũ nhất
    await pool.query(
      `DELETE FROM user_memories WHERE id IN (
        SELECT id FROM user_memories WHERE user_id = $1
        ORDER BY updated_at DESC
        OFFSET $2
      )`,
      [userId, MAX_MEMORIES]
    );

    console.log(`[Memory] User ${userId}: extracted ${items.length} memories`);
  } catch (err) {
    console.error(`[Memory] Extract error for user ${userId}:`, err.message);
  }
}

module.exports = {
  getUserMemories,
  formatMemoriesForPrompt,
  extractAndSaveMemories,
};
