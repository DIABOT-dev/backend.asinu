/**
 * AI Health Assessment Service
 * 
 * Hệ thống câu hỏi động 100% do AI điều khiển:
 * - AI sinh câu hỏi đầu tiên
 * - Dựa vào câu trả lời, AI quyết định hỏi tiếp hay dừng
 * - Khi đủ thông tin → AI đánh giá và quyết định notify
 */

const { getOpenAIReply } = require('../../src/services/ai/providers/openai');
const { t } = require('../../src/i18n');

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
      conversationContext = `\n\n${t('context.conversation_title')}:`;
      conversationHistory.forEach((item, index) => {
        conversationContext += `\n${t('context.question_n', 'vi', { n: index + 1 })}: "${item.question}"`;
        conversationContext += `\n${t('context.answer')}: "${item.answerLabel || item.answer}"`;
      });
    }

    // Build health context
    let healthContext = '';
    if (logsSummary) {
      if (logsSummary.latest_glucose) {
        const g = logsSummary.latest_glucose;
        healthContext += `\n${t('context.latest_glucose')}: ${g.value} ${g.unit || 'mg/dL'}`;
      }
      if (logsSummary.latest_bp) {
        const bp = logsSummary.latest_bp;
        healthContext += `\n${t('context.latest_bp')}: ${bp.systolic}/${bp.diastolic} mmHg`;
      }
    }

    // Build mood history context
    let moodContext = '';
    if (moodHistory && moodHistory.total > 0) {
      moodContext = `\n\n${t('context.history_48h_title')}:`;
      moodContext += `\n- ${t('context.total_checkins')}: ${moodHistory.total}`;
      if (moodHistory.notOkCount > 0) moodContext += `\n- ${t('context.not_ok_count')}: ${moodHistory.notOkCount}`;
      if (moodHistory.tiredCount > 0) moodContext += `\n- ${t('context.tired_count')}: ${moodHistory.tiredCount}`;
      if (moodHistory.trend) moodContext += `\n- ${t('context.trend_label')}: ${moodHistory.trend}`;
    }

    // Build profile context
    let profileContext = '';
    if (profile) {
      if (profile.age) profileContext += `\n- ${t('context.age_label')}: ${profile.age}`;
      if (profile.medical_conditions && Array.isArray(profile.medical_conditions)) {
        const conditions = profile.medical_conditions
          .map(c => typeof c === 'string' ? c : c.label || c.other_text)
          .filter(Boolean);
        if (conditions.length > 0) {
          profileContext += `\n- ${t('context.conditions_label')}: ${conditions.join(', ')}`;
        }
      }
    }

    const questionCount = conversationHistory?.length || 0;

    const prompt = t('prompt.health_assessment', 'vi', { 
      profileContext: profileContext || `\n${t('context.no_detail_info')}`,
      healthContext: healthContext ? `\n${t('context.health_metrics_title')}:` + healthContext : '',
      moodContext,
      conversationContext,
      questionCount
    });

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
            text: textMatch ? textMatch[1] : t('question.how_feeling'),
            type: 'single_choice',
            options: [
              { value: 'good', label: t('option.good') },
              { value: 'ok', label: t('option.normal') },
              { value: 'not_good', label: t('option.not_good') }
            ]
          },
          reasoning: 'Extracted from partial response'
        };
      }
    }
    
    if (!parsed) {
      throw new Error(t('error.ai_invalid_json'));
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
            { value: 'good', label: t('option.good') },
            { value: 'ok', label: t('option.normal') },
            { value: 'not_good', label: t('option.not_good') }
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
          outcome_text: parsed.assessment.outcome_text || t('assessment.default_outcome'),
          recommended_action: parsed.assessment.recommended_action || t('assessment.default_action'),
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
          text: t('question.first_how_feeling'),
          options: [
            { value: 'good', label: t('option.healthy_normal') },
            { value: 'tired', label: t('option.little_tired') },
            { value: 'not_good', label: t('option.not_well') }
          ],
          step: 1,
          generated_by_ai: false
        },
        reasoning: 'Fallback: opening question'
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
          summary: hasNegativeAnswer ? t('assessment.tired_summary') : t('assessment.stable_summary'),
          outcome_text: hasNegativeAnswer 
            ? t('assessment.tired_advice')
            : t('assessment.stable_advice'),
          recommended_action: t('assessment.continue_monitoring'),
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
        text: t('question.followup_symptoms'),
        options: [
          { value: 'none', label: t('option.nothing') },
          { value: 'headache', label: t('option.headache') },
          { value: 'dizzy', label: t('option.dizziness') },
          { value: 'chest', label: t('option.chest_tightness') }
        ],
        step: questionCount + 1,
        generated_by_ai: false
      },
      reasoning: 'Fallback: asking more symptoms'
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
