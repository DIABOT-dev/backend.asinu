/**
 * Question Generator Service
 * Sử dụng AI (OpenAI) để sinh câu hỏi động dựa trên context của bệnh nhân
 */

const { getOpenAIReply } = require('../../src/services/ai/providers/openai');
const { t } = require('../../src/i18n');

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
      let status = t('context.status_normal');
      
      if (value > 180) status = t('context.status_very_high');
      else if (value > 140) status = t('context.status_slightly_high');
      else if (value < 70) status = t('context.status_low');
      else if (value < 100) status = t('context.status_good');
      
      parts.push(t('context.glucose_status', 'vi', { value, unit: g.unit || 'mg/dL', status }));
    }
    
    if (logsSummary.latest_bp) {
      const bp = logsSummary.latest_bp;
      const sys = bp.systolic;
      const dia = bp.diastolic;
      let status = t('context.status_normal');
      
      if (sys >= 180 || dia >= 110) status = t('context.status_very_high');
      else if (sys >= 140 || dia >= 90) status = t('context.status_high');
      else if (sys >= 130 || dia >= 85) status = t('context.status_slightly_high');
      else if (sys < 90 || dia < 60) status = t('context.status_low');
      else status = t('context.status_good');
      
      parts.push(t('context.bp_status', 'vi', { sys, dia, status }));
    }
  }

  // Thông tin bệnh nhân (thứ yếu)
  if (profile && profile.medical_conditions) {
    const conditions = extractConditionsList(profile.medical_conditions);
    if (conditions.length > 0) {
      parts.push(t('context.conditions', 'vi', { conditions: conditions.slice(0, 2).join(', ') }));
    }
  }

  return parts.length > 0 ? parts.join(' ') : t('context.no_health_info');
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
      return t('prompt.mood', 'vi', { healthContext });

    case 'followup':
      return t('prompt.followup', 'vi', { healthContext });

    case 'symptom':
      return t('prompt.symptom', 'vi', { healthContext });

    default:
      return t('prompt.default', 'vi', { healthContext });
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
      text: questionText || t('question.how_are_you_today'), // Fallback
      options: [
        { value: 'OK', label: t('brain.mood_ok') },
        { value: 'TIRED', label: t('brain.mood_tired') },
        { value: 'NOT_OK', label: t('brain.mood_not_ok') }
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
      text: t('question.how_are_you_today'),
      options: [
        { value: 'OK', label: t('brain.mood_ok') },
        { value: 'TIRED', label: t('brain.mood_tired') },
        { value: 'NOT_OK', label: t('brain.mood_not_ok') }
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
      text: questionText || t('question.feeling_better'), // Fallback
      options: [
        { value: 'OK', label: t('brain.mood_ok') },
        { value: 'TIRED', label: t('brain.mood_tired') },
        { value: 'NOT_OK', label: t('brain.mood_not_ok') }
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
      text: t('question.feeling_better'),
      options: [
        { value: 'OK', label: t('brain.mood_ok') },
        { value: 'TIRED', label: t('brain.mood_tired') },
        { value: 'NOT_OK', label: t('brain.mood_not_ok') }
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
      healthContext += ` ${t('context.previous_answer', 'vi', { text: previousMoodText })}`;
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
      text: questionText || t('question.symptoms_severity'),
      symptoms: [
        { value: 'none', label: t('brain.symptom_none') },
        { value: 'chest_pain', label: t('brain.symptom_chest_pain') },
        { value: 'shortness_of_breath', label: t('brain.symptom_shortness_of_breath') },
        { value: 'dizziness', label: t('brain.symptom_dizziness') },
        { value: 'fever', label: t('brain.symptom_fever') },
        { value: 'headache', label: t('brain.symptom_headache') },
        { value: 'nausea', label: t('brain.symptom_nausea') },
        { value: 'other', label: t('brain.symptom_other') }
      ],
      severity_options: [
        { value: 'mild', label: t('brain.severity_mild') },
        { value: 'moderate', label: t('brain.severity_moderate') },
        { value: 'severe', label: t('brain.severity_severe') }
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
      text: t('question.symptoms_severity'),
      symptoms: [
        { value: 'none', label: t('brain.symptom_none') },
        { value: 'chest_pain', label: t('brain.symptom_chest_pain') },
        { value: 'shortness_of_breath', label: t('brain.symptom_shortness_of_breath') },
        { value: 'dizziness', label: t('brain.symptom_dizziness') },
        { value: 'fever', label: t('brain.symptom_fever') },
        { value: 'headache', label: t('brain.symptom_headache') },
        { value: 'nausea', label: t('brain.symptom_nausea') },
        { value: 'other', label: t('brain.symptom_other') }
      ],
      severity_options: [
        { value: 'mild', label: t('brain.severity_mild') },
        { value: 'moderate', label: t('brain.severity_moderate') },
        { value: 'severe', label: t('brain.severity_severe') }
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
      healthContext += `\n\n${t('context.mood_history_title')}:`;
      healthContext += `\n- ${t('context.total_responses')}: ${moodHistory.total}`;
      healthContext += `\n- ${t('context.not_ok_count')}: ${moodHistory.notOkCount}`;
      healthContext += `\n- ${t('context.tired_count')}: ${moodHistory.tiredCount}`;
      healthContext += `\n- ${t('context.trend')}: ${moodHistory.trend || t('context.unknown')}`;
    }
    
    // Current session
    healthContext += `\n\n${t('context.current_session')}:`;
    healthContext += `\n- ${t('context.current_mood')}: ${currentMood === 'OK' ? t('brain.mood_ok') : currentMood === 'TIRED' ? t('brain.mood_tired') : currentMood === 'NOT_OK' ? t('brain.mood_not_ok') : t('brain.not_answered')}`;
    
    if (symptoms && symptoms.length > 0) {
      const symptomLabels = {
        'chest_pain': t('brain.symptom_chest_pain'),
        'shortness_of_breath': t('brain.symptom_shortness_of_breath'),
        'dizziness': t('brain.symptom_dizziness'),
        'fever': t('brain.symptom_fever'),
        'headache': t('brain.symptom_headache'),
        'nausea': t('brain.symptom_nausea'),
        'none': t('brain.symptom_none_short'),
        'other': t('brain.symptom_other')
      };
      healthContext += `\n- ${t('context.symptoms_label')}: ${symptoms.map(s => symptomLabels[s] || s).join(', ')}`;
      healthContext += `\n- ${t('context.severity_label')}: ${symptomSeverity === 'severe' ? t('brain.severity_severe') : symptomSeverity === 'moderate' ? t('brain.severity_moderate') : t('brain.severity_mild')}`;
    }
    
    // Profile info
    if (profile) {
      if (profile.age) healthContext += `\n- ${t('context.age_label')}: ${profile.age}`;
      if (profile.medical_conditions) {
        const conditions = extractConditionsList(profile.medical_conditions);
        if (conditions.length > 0) {
          healthContext += `\n- ${t('context.conditions_label')}: ${conditions.join(', ')}`;
        }
      }
    }
    
    const prompt = t('prompt.risk_assessment', 'vi', { healthContext });

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
      throw new Error(t('error.ai_invalid_json'));
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
      outcome_text: parsed.outcome_text || t('outcome.thanks'),
      recommended_action: parsed.recommended_action || t('outcome.continue_monitoring'),
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
        reasons.push(t('fallback.not_ok_48h', 'vi', { count: moodHistory.notOkCount }));
      } else if (moodHistory.notOkCount >= 1) {
        score += 20;
        reasons.push(t('fallback.not_ok_recent'));
      }
      
      if (moodHistory.tiredCount >= 2) {
        score += 30;
        reasons.push(t('fallback.tired_48h', 'vi', { count: moodHistory.tiredCount }));
      } else if (moodHistory.tiredCount >= 1) {
        score += 15;
        reasons.push(t('fallback.tired_recent'));
      }
    }
    
    // Current mood
    if (currentMood === 'NOT_OK') {
      score += 20;
      reasons.push(t('fallback.current_not_ok'));
    } else if (currentMood === 'TIRED') {
      score += 10;
      reasons.push(t('fallback.current_tired'));
    }
    
    // Symptoms - QUAN TRỌNG
    if (symptoms && symptoms.length > 0) {
      if (symptoms.includes('chest_pain') && symptoms.includes('shortness_of_breath')) {
        score += 50; // Critical
        reasons.push(t('fallback.chest_shortness'));
      } else if (symptoms.includes('chest_pain')) {
        score += 30;
        reasons.push(t('fallback.chest_pain'));
      } else if (symptoms.includes('shortness_of_breath')) {
        score += 25;
        reasons.push(t('fallback.shortness_of_breath'));
      } else if (symptoms.includes('dizziness')) {
        score += 15;
        reasons.push(t('fallback.dizziness'));
      }
      
      // Severity multiplier
      if (symptomSeverity === 'severe') {
        score = Math.min(100, score * 1.5);
        reasons.push(t('fallback.severity_severe'));
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
        ? t('outcome.high_risk')
        : tier === 'MEDIUM'
        ? t('outcome.medium_risk')
        : t('outcome.low_risk'),
      recommended_action: tier === 'HIGH'
        ? t('outcome.action_contact_now')
        : t('outcome.action_continue_rest'),
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
