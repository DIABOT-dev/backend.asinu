/**
 * Question Generator Service
 * Sử dụng AI (OpenAI) để sinh câu hỏi động dựa trên context của bệnh nhân
 */

const { getOpenAIReply } = require('../../src/services/ai/providers/openai');

/**
 * Extract conditions từ profile array/object
 */
const extractConditionsList = (items) => {
  if (!Array.isArray(items)) return [];
  
  return items
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return item.other_text || item.label || item.key || '';
      }
      return '';
    })
    .filter(Boolean);
};

/**
 * Build health context string từ logs và profile
 * @param {Object} params - { logsSummary, profile, riskLevel, mood }
 * @returns {string} - Health context description
 */
const buildHealthContext = (params) => {
  const { logsSummary, profile, riskLevel, mood } = params || {};
  const parts = [];

  // **ƯU TIÊN CAO NHẤT: Chỉ số sức khỏe gần nhất**
  if (logsSummary) {
    if (logsSummary.latest_glucose) {
      const g = logsSummary.latest_glucose;
      const value = g.value;
      let status = 'bình thường';
      
      if (value > 180) status = 'rất cao';
      else if (value > 140) status = 'hơi cao';
      else if (value < 70) status = 'thấp';
      else if (value < 100) status = 'tốt';
      
      parts.push(`Đường huyết ${value} ${g.unit || 'mg/dL'} ${status}.`);
    }
    
    if (logsSummary.latest_bp) {
      const bp = logsSummary.latest_bp;
      const sys = bp.systolic;
      const dia = bp.diastolic;
      let status = 'bình thường';
      
      if (sys >= 180 || dia >= 110) status = 'rất cao';
      else if (sys >= 140 || dia >= 90) status = 'cao';
      else if (sys >= 130 || dia >= 85) status = 'hơi cao';
      else if (sys < 90 || dia < 60) status = 'thấp';
      else status = 'tốt';
      
      parts.push(`Huyết áp ${sys}/${dia} mmHg ${status}.`);
    }
  }

  // Thông tin bệnh nhân (thứ yếu)
  if (profile && profile.medical_conditions) {
    const conditions = extractConditionsList(profile.medical_conditions);
    if (conditions.length > 0) {
      parts.push(`Bệnh lý: ${conditions.slice(0, 2).join(', ')}.`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'Chưa có đủ thông tin sức khỏe.';
};

/**
 * Build prompt để AI sinh câu hỏi theo dạng
 * @param {string} questionType - 'mood' | 'followup' | 'symptom'
 * @param {string} healthContext - Context về sức khỏe bệnh nhân
 * @returns {string} - AI prompt
 */
const buildQuestionPrompt = (questionType, healthContext) => {
  switch (questionType) {
    case 'mood':
      return `Bạn là bác sĩ. Tạo câu hỏi cho bệnh nhân.

THÔNG TIN:
${healthContext}

QUY TẮC: Câu hỏi PHẢI bắt đầu bằng chỉ số sức khỏe (đường huyết hoặc huyết áp).

VÍ DỤ:
Input: "Đường huyết 180 mg/dL hơi cao. Huyết áp 140/90 mmHg."
Output: "Đường huyết 180 mg/dL hơi cao, bác có thấy mệt hay chóng mặt không?"

Input: "Huyết áp 150/95 mmHg cao."
Output: "Huyết áp 150/95 mmHg cao hơn bình thường, bác có đau đầu không?"

Bây giờ tạo câu hỏi dựa trên thông tin trên:`;

    case 'followup':
      return `Bạn là bác sĩ. Tạo câu hỏi theo dõi.

THÔNG TIN:
${healthContext}

QUY TẮC: Câu hỏi PHẢI bắt đầu bằng chỉ số.

VÍ DỤ:
Input: "Đường huyết 195 mg/dL. Lần trước bệnh nhân mệt."
Output: "Đường huyết 195 mg/dL, bác thấy cơn mệt lúc sáng có giảm chưa?"

Tạo câu hỏi:`;

    case 'symptom':
      return `Bạn là bác sĩ. Hỏi về triệu chứng.

THÔNG TIN:
${healthContext}

QUY TẮC: Câu hỏi PHẢI bắt đầu bằng chỉ số + liệt kê triệu chứng.

VÍ DỤ:
Input: "Đường huyết 250 mg/dL rất cao."
Output: "Đường huyết 250 mg/dL rất cao - bác có run tay, đổ mồ hôi hay chóng mặt không?"

Tạo câu hỏi:`;

    default:
      return `Tạo câu hỏi y tế dựa trên: ${healthContext}`;
  }
};

/**
 * Clean AI response để lấy câu hỏi
 */
const cleanQuestionText = (text) => {
  if (!text) return '';
  
  let cleaned = text.trim();
  
  // Remove common prefixes
  cleaned = cleaned.replace(/^(CÂU HỎI:|Câu hỏi:|Question:)\s*/i, '');
  cleaned = cleaned.replace(/^["']|["']$/g, ''); // Remove quotes
  
  // Take only first line if multiple lines
  const firstLine = cleaned.split('\n')[0].trim();
  
  return firstLine || text.trim();
};

/**
 * Generate câu hỏi mood động bằng AI
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} phase - 'MORNING' | 'NOON' | 'NIGHT'
 * @param {Object} context - { logsSummary, profile, riskLevel }
 * @returns {Promise<Object>} - Question object
 */
const generateMoodQuestion = async (pool, userId, phase, context) => {
  try {
    const healthContext = buildHealthContext(context);
    const prompt = buildQuestionPrompt('mood', healthContext);
    
    const aiResponse = await getOpenAIReply({
      message: prompt,
      userId: userId.toString(),
      sessionId: `question-gen-${userId}-${Date.now()}`,
      temperature: 0.7 // Balanced creativity for questions
    });

    const questionText = cleanQuestionText(aiResponse.reply);

    return {
      id: 'mood',
      type: 'single_choice',
      text: questionText || 'Hôm nay bác cảm thấy thế nào?', // Fallback
      options: [
        { value: 'OK', label: 'Ổn' },
        { value: 'TIRED', label: 'Mệt' },
        { value: 'NOT_OK', label: 'Không ổn' }
      ],
      phase_in_day: phase || null,
      generated_by_ai: true,
      ai_provider: 'openai'
    };
  } catch (error) {
    console.error('[questionGenerator] Error generating mood question:', error);
    
    // Fallback to default
    return {
      id: 'mood',
      type: 'single_choice',
      text: 'Hôm nay bác cảm thấy thế nào?',
      options: [
        { value: 'OK', label: 'Ổn' },
        { value: 'TIRED', label: 'Mệt' },
        { value: 'NOT_OK', label: 'Không ổn' }
      ],
      phase_in_day: phase || null,
      generated_by_ai: false
    };
  }
};

/**
 * Generate câu hỏi followup động bằng AI
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} phase - 'MORNING' | 'NOON' | 'NIGHT'
 * @param {Object} context - { logsSummary, profile, riskLevel, previousMood }
 * @returns {Promise<Object>} - Question object
 */
const generateFollowupQuestion = async (pool, userId, phase, context) => {
  try {
    const healthContext = buildHealthContext({
      ...context,
      mood: context.previousMood
    });
    const prompt = buildQuestionPrompt('followup', healthContext);
    
    const aiResponse = await getOpenAIReply({
      message: prompt,
      userId: userId.toString(),
      sessionId: `question-gen-${userId}-${Date.now()}`,
      temperature: 0.7
    });

    const questionText = cleanQuestionText(aiResponse.reply);

    return {
      id: 'mood',
      type: 'single_choice',
      text: questionText || 'Bác thấy ổn hơn chưa?', // Fallback
      options: [
        { value: 'OK', label: 'Ổn' },
        { value: 'TIRED', label: 'Mệt' },
        { value: 'NOT_OK', label: 'Không ổn' }
      ],
      phase_in_day: phase || null,
      generated_by_ai: true,
      ai_provider: 'openai'
    };
  } catch (error) {
    console.error('[questionGenerator] Error generating followup question:', error);
    
    // Fallback to default
    return {
      id: 'mood',
      type: 'single_choice',
      text: 'Bác thấy ổn hơn chưa?',
      options: [
        { value: 'OK', label: 'Ổn' },
        { value: 'TIRED', label: 'Mệt' },
        { value: 'NOT_OK', label: 'Không ổn' }
      ],
      phase_in_day: phase || null,
      generated_by_ai: false
    };
  }
};

/**
 * Generate câu hỏi về triệu chứng động bằng AI
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} context - { logsSummary, profile, riskLevel, mood, previousAnswer }
 * @returns {Promise<Object>} - Question object
 */
const generateSymptomQuestion = async (pool, userId, context) => {
  try {
    // Thêm context từ previous answer
    let healthContext = buildHealthContext(context);
    const previousMoodText = context.previousAnswer?.text || '';
    
    if (previousMoodText) {
      healthContext += ` Lần trước bệnh nhân trả lời: "${previousMoodText}".`;
    }

    const prompt = buildQuestionPrompt('symptom', healthContext);
    
    const aiResponse = await getOpenAIReply({
      message: prompt,
      userId: userId.toString(),
      sessionId: `question-gen-${userId}-${Date.now()}`,
      temperature: 0.7
    });

    const questionText = cleanQuestionText(aiResponse.reply);

    // Symptom question vẫn giữ options cố định vì cần structured data
    return {
      id: 'symptom_severity',
      type: 'symptom_severity',
      text: questionText || 'Bác có triệu chứng nào và mức độ như thế nào?',
      symptoms: [
        { value: 'none', label: 'Không có triệu chứng' },
        { value: 'chest_pain', label: 'Đau ngực' },
        { value: 'shortness_of_breath', label: 'Khó thở' },
        { value: 'dizziness', label: 'Chóng mặt' },
        { value: 'fever', label: 'Sốt' },
        { value: 'headache', label: 'Đau đầu' },
        { value: 'nausea', label: 'Buồn nôn' },
        { value: 'other', label: 'Khác' }
      ],
      severity_options: [
        { value: 'mild', label: 'Nhẹ' },
        { value: 'moderate', label: 'Trung bình' },
        { value: 'severe', label: 'Nặng' }
      ],
      generated_by_ai: true,
      ai_provider: 'openai',
      context_from: previousMoodText ? 'previous_mood' : 'health_data'
    };
  } catch (error) {
    console.error('[questionGenerator] Error generating symptom question:', error);
    
    // Fallback to default
    return {
      id: 'symptom_severity',
      type: 'symptom_severity',
      text: 'Bác có triệu chứng nào và mức độ như thế nào?',
      symptoms: [
        { value: 'none', label: 'Không có triệu chứng' },
        { value: 'chest_pain', label: 'Đau ngực' },
        { value: 'shortness_of_breath', label: 'Khó thở' },
        { value: 'dizziness', label: 'Chóng mặt' },
        { value: 'fever', label: 'Sốt' },
        { value: 'headache', label: 'Đau đầu' },
        { value: 'nausea', label: 'Buồn nôn' },
        { value: 'other', label: 'Khác' }
      ],
      severity_options: [
        { value: 'mild', label: 'Nhẹ' },
        { value: 'moderate', label: 'Trung bình' },
        { value: 'severe', label: 'Nặng' }
      ],
      generated_by_ai: false
    };
  }
};

/**
 * AI đánh giá rủi ro và quyết định có gửi thông báo cho người thân không
 * @param {Object} context - Toàn bộ context: logs, mood history, symptoms, profile
 * @returns {Promise<Object>} - { risk_tier, risk_score, notify_caregiver, ai_reasoning, outcome_text, recommended_action }
 */
const aiAssessRiskAndDecision = async (pool, userId, context) => {
  try {
    const { logsSummary, profile, moodHistory, currentMood, symptoms, symptomSeverity } = context;
    
    // Build comprehensive context for AI
    let healthContext = buildHealthContext({ logsSummary, profile });
    
    // Add mood history
    if (moodHistory) {
      healthContext += `\n\nLỊCH SỬ TÂM TRẠNG (48h qua):`;
      healthContext += `\n- Tổng số lần trả lời: ${moodHistory.total}`;
      healthContext += `\n- Số lần "Không ổn": ${moodHistory.notOkCount}`;
      healthContext += `\n- Số lần "Mệt": ${moodHistory.tiredCount}`;
      healthContext += `\n- Trend: ${moodHistory.trend || 'Chưa rõ'}`;
    }
    
    // Current session
    healthContext += `\n\nPHIÊN HIỆN TẠI:`;
    healthContext += `\n- Tâm trạng hiện tại: ${currentMood === 'OK' ? 'Ổn' : currentMood === 'TIRED' ? 'Mệt' : currentMood === 'NOT_OK' ? 'Không ổn' : 'Chưa trả lời'}`;
    
    if (symptoms && symptoms.length > 0) {
      const symptomLabels = {
        'chest_pain': 'Đau ngực',
        'shortness_of_breath': 'Khó thở',
        'dizziness': 'Chóng mặt',
        'fever': 'Sốt',
        'headache': 'Đau đầu',
        'nausea': 'Buồn nôn',
        'none': 'Không có',
        'other': 'Khác'
      };
      healthContext += `\n- Triệu chứng: ${symptoms.map(s => symptomLabels[s] || s).join(', ')}`;
      healthContext += `\n- Mức độ: ${symptomSeverity === 'severe' ? 'Nặng' : symptomSeverity === 'moderate' ? 'Trung bình' : 'Nhẹ'}`;
    }
    
    // Profile info
    if (profile) {
      if (profile.age) healthContext += `\n- Tuổi: ${profile.age}`;
      if (profile.medical_conditions) {
        const conditions = extractConditionsList(profile.medical_conditions);
        if (conditions.length > 0) {
          healthContext += `\n- Bệnh nền: ${conditions.join(', ')}`;
        }
      }
    }
    
    const prompt = `Bạn là bác sĩ AI phân tích sức khỏe bệnh nhân. Dựa trên thông tin sau, hãy đánh giá và quyết định:

${healthContext}

QUAN TRỌNG - QUY TẮC ĐÁNH GIÁ:
1. Nếu bệnh nhân trả lời "Mệt" hoặc "Không ổn" từ 2 lần trở lên trong 48h → Cần cảnh giác
2. Nếu bệnh nhân có triệu chứng nguy hiểm (đau ngực, khó thở) → PHẢI thông báo người thân
3. Nếu bệnh nhân liên tục mệt (≥2 lần) + có triệu chứng → PHẢI thông báo người thân
4. Nếu chỉ số sinh tồn bất thường (đường huyết/huyết áp) → Cân nhắc thông báo

TRẢ LỜI THEO FORMAT JSON CHÍNH XÁC (không có text khác):
{
  "risk_tier": "HIGH" hoặc "MEDIUM" hoặc "LOW",
  "risk_score": số từ 0-100,
  "notify_caregiver": true hoặc false,
  "reasoning": "Giải thích ngắn gọn tại sao",
  "outcome_text": "Câu nói với bệnh nhân (tự nhiên, thân thiện)",
  "recommended_action": "Hành động khuyến nghị"
}`;

    const aiResponse = await getOpenAIReply({
      message: prompt,
      userId: userId.toString(),
      sessionId: `risk-assess-${userId}-${Date.now()}`,
      temperature: 0.3 // Low temperature for consistent decisions
    });

    // Parse AI response
    const responseText = aiResponse.reply.trim();
    
    // Try to extract JSON from response
    let jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response không chứa JSON hợp lệ');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    console.log(`[aiAssessRiskAndDecision] AI Decision for userId ${userId}:`);
    console.log(`  - Risk: ${parsed.risk_tier} (score: ${parsed.risk_score})`);
    console.log(`  - Notify caregiver: ${parsed.notify_caregiver}`);
    console.log(`  - Reasoning: ${parsed.reasoning}`);
    
    return {
      risk_tier: parsed.risk_tier || 'LOW',
      risk_score: parsed.risk_score || 0,
      notify_caregiver: parsed.notify_caregiver || false,
      ai_reasoning: parsed.reasoning || '',
      outcome_text: parsed.outcome_text || 'Cảm ơn bác đã chia sẻ.',
      recommended_action: parsed.recommended_action || 'Tiếp tục theo dõi.',
      assessed_by: 'AI',
      ai_provider: 'openai'
    };
  } catch (error) {
    console.error('[aiAssessRiskAndDecision] Error:', error);
    
    // Fallback: Rule-based với logic mạnh hơn cho mood history
    const { moodHistory, currentMood, symptoms, symptomSeverity } = context;
    
    let score = 0;
    let reasons = [];
    
    // Mood history impact - QUAN TRỌNG
    if (moodHistory) {
      if (moodHistory.notOkCount >= 2) {
        score += 40;
        reasons.push(`${moodHistory.notOkCount} lần không ổn trong 48h`);
      } else if (moodHistory.notOkCount >= 1) {
        score += 20;
        reasons.push('Có lần không ổn gần đây');
      }
      
      if (moodHistory.tiredCount >= 2) {
        score += 30;
        reasons.push(`${moodHistory.tiredCount} lần mệt trong 48h`);
      } else if (moodHistory.tiredCount >= 1) {
        score += 15;
        reasons.push('Có lần mệt gần đây');
      }
    }
    
    // Current mood
    if (currentMood === 'NOT_OK') {
      score += 20;
      reasons.push('Hiện tại không ổn');
    } else if (currentMood === 'TIRED') {
      score += 10;
      reasons.push('Hiện tại mệt');
    }
    
    // Symptoms - QUAN TRỌNG
    if (symptoms && symptoms.length > 0) {
      if (symptoms.includes('chest_pain') && symptoms.includes('shortness_of_breath')) {
        score += 50; // Critical
        reasons.push('Đau ngực + khó thở');
      } else if (symptoms.includes('chest_pain')) {
        score += 30;
        reasons.push('Đau ngực');
      } else if (symptoms.includes('shortness_of_breath')) {
        score += 25;
        reasons.push('Khó thở');
      } else if (symptoms.includes('dizziness')) {
        score += 15;
        reasons.push('Chóng mặt');
      }
      
      // Severity multiplier
      if (symptomSeverity === 'severe') {
        score = Math.min(100, score * 1.5);
        reasons.push('Mức độ nặng');
      } else if (symptomSeverity === 'moderate') {
        score = Math.min(100, score * 1.2);
      }
    }
    
    score = Math.min(100, Math.max(0, score));
    
    let tier = 'LOW';
    if (score >= 60) tier = 'HIGH';
    else if (score >= 35) tier = 'MEDIUM';
    
    const shouldNotify = tier === 'HIGH' || (tier === 'MEDIUM' && moodHistory?.notOkCount >= 2);
    
    return {
      risk_tier: tier,
      risk_score: score,
      notify_caregiver: shouldNotify,
      ai_reasoning: `Fallback assessment: ${reasons.join(', ')}`,
      outcome_text: tier === 'HIGH' 
        ? 'Asinu lo lắng cho sức khỏe của bác. Người thân sẽ được thông báo để hỗ trợ bác.' 
        : tier === 'MEDIUM'
        ? 'Bác cần nghỉ ngơi và theo dõi sức khỏe. Nếu không đỡ, hãy báo cho người thân.'
        : 'Cảm ơn bác đã chia sẻ. Bác nhớ nghỉ ngơi và uống nước nhé.',
      recommended_action: tier === 'HIGH'
        ? 'Liên hệ người thân hoặc bác sĩ ngay.'
        : 'Tiếp tục theo dõi và nghỉ ngơi.',
      assessed_by: 'fallback-rules',
      ai_provider: null
    };
  }
};

module.exports = {
  generateMoodQuestion,
  generateFollowupQuestion,
  generateSymptomQuestion,
  buildHealthContext,
  aiAssessRiskAndDecision,
  extractConditionsList
};
