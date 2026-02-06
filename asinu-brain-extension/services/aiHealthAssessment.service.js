/**
 * AI Health Assessment Service
 * 
 * Hệ thống câu hỏi động 100% do AI điều khiển:
 * - AI sinh câu hỏi đầu tiên
 * - Dựa vào câu trả lời, AI quyết định hỏi tiếp hay dừng
 * - Khi đủ thông tin → AI đánh giá và quyết định notify
 */

const { getOpenAIReply } = require('../../src/services/ai/providers/openai');

/**
 * AI sinh câu hỏi tiếp theo hoặc đưa ra kết luận
 * 
 * @param {Object} params
 * @param {number} params.userId - User ID
 * @param {Array} params.conversationHistory - Lịch sử hội thoại [{question, answer, options}]
 * @param {Object} params.profile - Thông tin profile user (tuổi, bệnh nền...)
 * @param {Object} params.logsSummary - Chỉ số sức khỏe gần nhất
 * @param {Object} params.moodHistory - Lịch sử tâm trạng 48h
 * 
 * @returns {Promise<Object>} 
 *   - Nếu cần hỏi tiếp: { continue: true, question: {...} }
 *   - Nếu đủ thông tin: { continue: false, assessment: {...} }
 */
const generateNextStepOrAssess = async ({ userId, conversationHistory, profile, logsSummary, moodHistory }) => {
  try {
    // Build context từ conversation history
    let conversationContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      conversationContext = '\n\nHỘI THOẠI TRƯỚC ĐÓ:';
      conversationHistory.forEach((item, index) => {
        conversationContext += `\nCâu ${index + 1}: "${item.question}"`;
        conversationContext += `\nTrả lời: "${item.answerLabel || item.answer}"`;
      });
    }

    // Build health context
    let healthContext = '';
    if (logsSummary) {
      if (logsSummary.latest_glucose) {
        const g = logsSummary.latest_glucose;
        healthContext += `\nĐường huyết gần nhất: ${g.value} ${g.unit || 'mg/dL'}`;
      }
      if (logsSummary.latest_bp) {
        const bp = logsSummary.latest_bp;
        healthContext += `\nHuyết áp gần nhất: ${bp.systolic}/${bp.diastolic} mmHg`;
      }
    }

    // Build mood history context
    let moodContext = '';
    if (moodHistory && moodHistory.total > 0) {
      moodContext = `\n\nLỊCH SỬ 48H QUA:`;
      moodContext += `\n- Tổng số lần check-in: ${moodHistory.total}`;
      if (moodHistory.notOkCount > 0) moodContext += `\n- Số lần "không ổn": ${moodHistory.notOkCount}`;
      if (moodHistory.tiredCount > 0) moodContext += `\n- Số lần "mệt": ${moodHistory.tiredCount}`;
      if (moodHistory.trend) moodContext += `\n- Xu hướng: ${moodHistory.trend}`;
    }

    // Build profile context
    let profileContext = '';
    if (profile) {
      if (profile.age) profileContext += `\n- Tuổi: ${profile.age}`;
      if (profile.medical_conditions && Array.isArray(profile.medical_conditions)) {
        const conditions = profile.medical_conditions
          .map(c => typeof c === 'string' ? c : c.label || c.other_text)
          .filter(Boolean);
        if (conditions.length > 0) {
          profileContext += `\n- Bệnh nền: ${conditions.join(', ')}`;
        }
      }
    }

    const questionCount = conversationHistory?.length || 0;

    const prompt = `Bạn là bác sĩ AI đang khám sức khỏe cho bệnh nhân qua app.

THÔNG TIN BỆNH NHÂN:${profileContext || '\nChưa có thông tin chi tiết'}
${healthContext ? '\nCHỈ SỐ SỨC KHỎE:' + healthContext : ''}
${moodContext}
${conversationContext}

SỐ CÂU ĐÃ HỎI: ${questionCount}

NHIỆM VỤ CỦA BẠN:
1. Phân tích các câu trả lời đã có
2. Quyết định: CẦN HỎI THÊM hay ĐÃ ĐỦ THÔNG TIN để đánh giá

QUY TẮC:
- Câu hỏi phải TỰ NHIÊN, THÂN THIỆN như nói chuyện với người lớn tuổi
- KHÔNG đề cập đến chỉ số cụ thể trong câu hỏi (không nói "đường huyết 120...")
- Nếu chưa có câu nào: bắt đầu bằng câu hỏi chung về sức khỏe
- Nếu bệnh nhân nói "ổn" ngay từ đầu: có thể kết thúc sớm (1-2 câu)
- Nếu bệnh nhân nói "mệt/không ổn": hỏi thêm để hiểu rõ (2-5 câu)
- Nếu phát hiện triệu chứng nghiêm trọng (đau ngực, khó thở): đánh giá ngay
- Tối đa 7 câu hỏi, sau đó phải đánh giá

QUAN TRỌNG: Trả lời ĐÚNG JSON format, KHÔNG có text thừa.

Nếu CẦN HỎI THÊM, trả về:
{"action":"ask","question":{"text":"Câu hỏi","type":"single_choice","options":[{"value":"v1","label":"Lựa chọn 1"},{"value":"v2","label":"Lựa chọn 2"}]},"reasoning":"Lý do"}

Nếu ĐÃ ĐỦ THÔNG TIN, trả về:
{"action":"assess","assessment":{"risk_tier":"LOW","risk_score":20,"notify_caregiver":false,"summary":"có triệu chứng X và Y","outcome_text":"Lời nhắn cho bác","recommended_action":"Hành động"},"reasoning":"Lý do"}

Lưu ý:
- risk_tier chỉ được là "HIGH", "MEDIUM", hoặc "LOW"
- risk_score là số từ 0-100
- notify_caregiver là true hoặc false
- summary: KHÔNG viết "Bệnh nhân", chỉ viết triệu chứng (VD: "có triệu chứng khó thở và đau ngực")`;

    const aiResponse = await getOpenAIReply({
      message: prompt,
      userId: userId.toString(),
      sessionId: `health-assess-${userId}-${Date.now()}`,
      temperature: 0.4
    });

    // Parse AI response
    const responseText = aiResponse.reply.trim();
    
    // Thử nhiều cách parse JSON
    let parsed = null;
    
    // Cách 1: Tìm JSON object đầy đủ
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        // Clean up common issues
        let jsonStr = jsonMatch[0]
          .replace(/[\r\n\t]/g, ' ')  // Remove newlines/tabs
          .replace(/,\s*}/g, '}')      // Remove trailing commas
          .replace(/,\s*]/g, ']')      // Remove trailing commas in arrays
          .replace(/(['"])?([a-zA-Z_][a-zA-Z0-9_]*)\1\s*:/g, '"$2":'); // Ensure quoted keys
        
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        console.log('[AI Health Assessment] First parse attempt failed:', e.message);
      }
    }
    
    // Cách 2: Nếu cách 1 thất bại, thử parse từng phần
    if (!parsed) {
      // Check if AI wants to ask
      if (responseText.includes('"action"') && responseText.includes('"ask"')) {
        const textMatch = responseText.match(/"text"\s*:\s*"([^"]+)"/);
        parsed = {
          action: 'ask',
          question: {
            text: textMatch ? textMatch[1] : 'Bác thấy trong người thế nào?',
            type: 'single_choice',
            options: [
              { value: 'good', label: 'Tốt' },
              { value: 'ok', label: 'Bình thường' },
              { value: 'not_good', label: 'Không tốt' }
            ]
          },
          reasoning: 'Extracted from partial response'
        };
      }
    }
    
    if (!parsed) {
      throw new Error('AI response không chứa JSON hợp lệ');
    }

    console.log(`[AI Health Assessment] User ${userId}:`);
    console.log(`  - Action: ${parsed.action}`);
    console.log(`  - Question count: ${questionCount}`);
    console.log(`  - Reasoning: ${parsed.reasoning}`);

    if (parsed.action === 'ask') {
      // Cần hỏi thêm
      return {
        continue: true,
        question: {
          id: `q_${questionCount + 1}`,
          type: parsed.question.type || 'single_choice',
          text: parsed.question.text,
          options: parsed.question.options || [
            { value: 'good', label: 'Tốt' },
            { value: 'ok', label: 'Bình thường' },
            { value: 'not_good', label: 'Không tốt' }
          ],
          step: questionCount + 1,
          generated_by_ai: true
        },
        reasoning: parsed.reasoning
      };
    } else {
      // Đủ thông tin - đánh giá
      return {
        continue: false,
        assessment: {
          risk_tier: parsed.assessment.risk_tier || 'LOW',
          risk_score: parsed.assessment.risk_score || 0,
          notify_caregiver: parsed.assessment.notify_caregiver || false,
          summary: parsed.assessment.summary || '',
          outcome_text: parsed.assessment.outcome_text || 'Cảm ơn bác đã chia sẻ.',
          recommended_action: parsed.assessment.recommended_action || 'Tiếp tục theo dõi sức khỏe.',
          assessed_by: 'AI',
          total_questions: questionCount
        },
        reasoning: parsed.reasoning
      };
    }

  } catch (error) {
    console.error('[AI Health Assessment] Error:', error);
    
    // Fallback logic
    const questionCount = conversationHistory?.length || 0;
    
    if (questionCount === 0) {
      // Câu hỏi đầu tiên
      return {
        continue: true,
        question: {
          id: 'q_1',
          type: 'single_choice',
          text: 'Hôm nay bác thấy trong người thế nào?',
          options: [
            { value: 'good', label: 'Khỏe, bình thường' },
            { value: 'tired', label: 'Hơi mệt' },
            { value: 'not_good', label: 'Không được khỏe' }
          ],
          step: 1,
          generated_by_ai: false
        },
        reasoning: 'Fallback: câu hỏi mở đầu'
      };
    }

    // Phân tích câu trả lời cuối
    const lastAnswer = conversationHistory[questionCount - 1];
    const hasNegativeAnswer = conversationHistory.some(item => 
      ['tired', 'not_good', 'bad', 'NOT_OK', 'TIRED', 'yes_symptom'].includes(item.answer)
    );

    if (questionCount >= 3 || !hasNegativeAnswer) {
      // Đủ thông tin hoặc user ổn
      const riskTier = hasNegativeAnswer ? 'MEDIUM' : 'LOW';
      return {
        continue: false,
        assessment: {
          risk_tier: riskTier,
          risk_score: hasNegativeAnswer ? 40 : 10,
          notify_caregiver: false,
          summary: hasNegativeAnswer ? 'có dấu hiệu mệt mỏi, cần theo dõi' : 'sức khỏe ổn định',
          outcome_text: hasNegativeAnswer 
            ? 'Bác nhớ nghỉ ngơi và uống đủ nước nhé. Nếu không đỡ thì báo cho người thân.'
            : 'Tốt lắm bác! Bác giữ gìn sức khỏe nhé.',
          recommended_action: 'Tiếp tục theo dõi',
          assessed_by: 'fallback',
          total_questions: questionCount
        },
        reasoning: 'Fallback assessment'
      };
    }

    // Cần hỏi thêm
    return {
      continue: true,
      question: {
        id: `q_${questionCount + 1}`,
        type: 'single_choice',
        text: 'Bác có thấy triệu chứng gì khác không?',
        options: [
          { value: 'none', label: 'Không có gì' },
          { value: 'headache', label: 'Đau đầu' },
          { value: 'dizzy', label: 'Chóng mặt' },
          { value: 'chest', label: 'Tức ngực' }
        ],
        step: questionCount + 1,
        generated_by_ai: false
      },
      reasoning: 'Fallback: hỏi thêm triệu chứng'
    };
  }
};

/**
 * Bắt đầu session mới - lấy câu hỏi đầu tiên
 */
const startHealthCheck = async ({ userId, profile, logsSummary, moodHistory }) => {
  return generateNextStepOrAssess({
    userId,
    conversationHistory: [],
    profile,
    logsSummary,
    moodHistory
  });
};

/**
 * Xử lý câu trả lời và lấy bước tiếp theo
 */
const processAnswerAndGetNext = async ({ userId, conversationHistory, answer, answerLabel, profile, logsSummary, moodHistory }) => {
  // Thêm câu trả lời mới vào history
  const lastQuestion = conversationHistory[conversationHistory.length - 1];
  const updatedHistory = [
    ...conversationHistory.slice(0, -1),
    {
      ...lastQuestion,
      answer,
      answerLabel
    }
  ];

  return generateNextStepOrAssess({
    userId,
    conversationHistory: updatedHistory,
    profile,
    logsSummary,
    moodHistory
  });
};

module.exports = {
  generateNextStepOrAssess,
  startHealthCheck,
  processAnswerAndGetNext
};
