'use strict';

/**
 * AI Symptom Analyzer
 *
 * Analyzes user's free-text symptom input using AI.
 * Currently: GPT-4o / GPT-4o-mini
 * Future: MedGemma (swap the model + prompt, keep the interface)
 *
 * ONLY called when:
 *   1. Symptom not found in cache/DB
 *   2. Need to understand what user means
 *
 * After AI responds -> result is cached -> next time no AI needed
 */

const OpenAI = require('openai');
const { cacheGet, cacheSet } = require('../../lib/redis');
const { isRedFlag, detectEmergency } = require('../../services/checkin/emergency-detector');

// ─── Provider config ────────────────────────────────────────────────────────

const AI_PROVIDER = process.env.SYMPTOM_AI_PROVIDER || 'openai'; // 'openai' | 'medgemma' (future)
const AI_MODEL = process.env.SYMPTOM_AI_MODEL || 'gpt-4o-mini';

// Cache TTL: 7 days (analysis result rarely changes)
const ANALYSIS_CACHE_TTL = 7 * 24 * 60 * 60;
// Quick urgency cache: 1 day
const URGENCY_CACHE_TTL = 24 * 60 * 60;

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── Cache key builders ─────────────────────────────────────────────────────

function analysisCacheKey(rawInput) {
  // Normalize: lowercase, trim, collapse whitespace
  const normalized = rawInput.toLowerCase().trim().replace(/\s+/g, ' ');
  return `sym:analysis:${normalized}`;
}

function urgencyCacheKey(rawInput) {
  const normalized = rawInput.toLowerCase().trim().replace(/\s+/g, ' ');
  return `sym:urgency:${normalized}`;
}

// ─── System prompts ─────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `Bạn là bác sĩ phân loại triệu chứng (triage). Phân tích triệu chứng bệnh nhân mô tả bằng tiếng Việt.

Trả về JSON duy nhất, KHÔNG giải thích thêm. Format:
{
  "understood": "Tên y khoa chuẩn hóa bằng tiếng Việt (vd: Đại tiện ra máu)",
  "category": "gastrointestinal|neurological|respiratory|cardiovascular|musculoskeletal|dermatological|urological|endocrine|psychiatric|ophthalmological|ent|general",
  "urgency": "emergency|urgent|moderate|mild|unknown",
  "possibleCauses": ["nguyên nhân 1", "nguyên nhân 2", "nguyên nhân 3"],
  "needsMoreInfo": true,
  "suggestedQuestions": [
    {
      "id": "aq1",
      "text": "Câu hỏi bằng tiếng Việt, dùng {honorific} thay cho đại từ",
      "type": "single_choice|slider|free_text",
      "options": ["lựa chọn 1", "lựa chọn 2"],
      "min": 0,
      "max": 10
    }
  ],
  "scoringRules": [
    {
      "conditions": [{"field": "aq1", "op": "eq|neq|gte|lte|gt|lt|contains", "value": "..."}],
      "combine": "and",
      "severity": "high|medium|low",
      "follow_up_hours": 1,
      "needs_doctor": true,
      "needs_family_alert": false
    }
  ],
  "conclusionTemplates": {
    "low": {
      "summary": "{Honorific} có triệu chứng nhẹ...",
      "recommendation": "Khuyến nghị...",
      "close_message": "{selfRef} sẽ hỏi lại {honorific}..."
    },
    "medium": {
      "summary": "...",
      "recommendation": "...",
      "close_message": "..."
    },
    "high": {
      "summary": "...",
      "recommendation": "...",
      "close_message": "..."
    }
  },
  "clusterKey": "english_snake_case",
  "displayName": "Tên tiếng Việt có dấu",
  "confidence": 0.85
}

QUY TẮC:
1. suggestedQuestions: 3-5 câu, đủ để phân loại mức độ nghiêm trọng
2. Câu hỏi đầu tiên nên là slider (mức đau 0-10) hoặc single_choice về mức độ
3. Câu hỏi tiếp: thời gian xuất hiện, diễn tiến, triệu chứng kèm theo
4. scoringRules phải tham chiếu đúng question id (aq1, aq2, ...)
5. scoringRules sắp xếp từ nghiêm trọng nhất đến nhẹ nhất
6. conclusionTemplates dùng placeholder {Honorific}, {honorific}, {selfRef}, {CallName}
7. clusterKey phải là English snake_case (vd: rectal_bleeding, headache)
8. Nếu bệnh nhân có bệnh nền, TĂNG mức urgency phù hợp
9. Tất cả text hiển thị bằng tiếng Việt có dấu
10. CHỈ trả về JSON, không có text khác`;

const URGENCY_SYSTEM_PROMPT = `Bạn là bác sĩ cấp cứu. Đánh giá nhanh mức độ nguy hiểm của triệu chứng.

Trả về JSON duy nhất:
{
  "urgency": "emergency|urgent|moderate|mild",
  "reason": "lý do ngắn gọn bằng tiếng Việt"
}

emergency = đe dọa tính mạng, cần cấp cứu ngay
urgent = cần khám trong vài giờ
moderate = cần theo dõi, khám trong 24h
mild = theo dõi tại nhà

CHỈ JSON, KHÔNG giải thích.`;

// ─── Main analyzer ──────────────────────────────────────────────────────────

/**
 * Analyze a symptom input from user.
 * Returns structured understanding of what the user means.
 *
 * @param {string} rawInput - what user typed
 * @param {object} context - { age, gender, medical_conditions, medications, history }
 * @returns {Promise<object>} structured analysis result
 */
async function analyzeSymptom(rawInput, context = {}) {
  if (!rawInput || typeof rawInput !== 'string') {
    return _emptyAnalysis(rawInput);
  }

  const input = rawInput.trim();
  if (!input) return _emptyAnalysis(rawInput);

  // 1. Check cache first (exact match on normalized input)
  const cacheKey = analysisCacheKey(input);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log(`[AIAnalyzer] Cache hit for: "${input}"`);
    return cached;
  }

  // 2. Call AI
  const startTime = Date.now();
  try {
    const userPrompt = _buildAnalysisPrompt(input, context);

    const response = await getClient().chat.completions.create({
      model: AI_MODEL,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const duration = Date.now() - startTime;
    const usage = response.usage || {};

    console.log(`[AIAnalyzer] AI call: model=${AI_MODEL}, tokens=${usage.total_tokens || '?'}, duration=${duration}ms, input="${input}"`);

    // Parse response
    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[AIAnalyzer] AI returned non-JSON:', raw.slice(0, 200));
      return _emptyAnalysis(rawInput);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const result = _normalizeAnalysis(parsed, input);

    // 3. Cache the result
    await cacheSet(cacheKey, result, ANALYSIS_CACHE_TTL);

    return result;
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[AIAnalyzer] AI call failed (${duration}ms):`, err.message);
    return _emptyAnalysis(rawInput);
  }
}

// ─── Quick urgency check ────────────────────────────────────────────────────

/**
 * Quick urgency check - is this potentially life-threatening?
 * Faster than full analyzeSymptom, used as first-pass filter.
 *
 * Checks BOTH hardcoded keywords (safety net) AND AI understanding.
 *
 * @param {string} rawInput
 * @param {object} context - { age, gender, medical_conditions, birth_year }
 * @returns {Promise<{ urgency: string, reason: string, source: 'keyword'|'ai'|'cache' }>}
 */
async function quickUrgencyCheck(rawInput, context = {}) {
  if (!rawInput || typeof rawInput !== 'string') {
    return { urgency: 'unknown', reason: 'Empty input', source: 'keyword' };
  }

  const input = rawInput.trim();

  // 1. Hardcoded keyword check FIRST (instant, free, safety net)
  const emergency = detectEmergency([input], {
    birth_year: context.birth_year || (context.age ? new Date().getFullYear() - context.age : null),
    gender: context.gender,
    medical_conditions: context.medical_conditions || [],
  });

  if (emergency.isEmergency) {
    return {
      urgency: 'emergency',
      reason: `Keyword match: ${emergency.type}`,
      source: 'keyword',
      emergency,
    };
  }

  // Sub-critical but concerning
  if (emergency.severity === 'high') {
    return {
      urgency: 'urgent',
      reason: `Keyword match: ${emergency.type}`,
      source: 'keyword',
      emergency,
    };
  }

  if (emergency.severity === 'moderate') {
    return {
      urgency: 'moderate',
      reason: `Keyword match: ${emergency.type}`,
      source: 'keyword',
      emergency,
    };
  }

  // 2. Check urgency cache
  const cacheKey = urgencyCacheKey(input);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...cached, source: 'cache' };
  }

  // 3. AI quick classification (only for inputs not caught by keywords)
  try {
    const contextStr = _buildContextString(context);
    const userPrompt = `Bệnh nhân${contextStr}: "${input}"`;

    const startTime = Date.now();
    const response = await getClient().chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 100,
      messages: [
        { role: 'system', content: URGENCY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const duration = Date.now() - startTime;
    const usage = response.usage || {};
    console.log(`[AIAnalyzer] Quick urgency: model=${AI_MODEL}, tokens=${usage.total_tokens || '?'}, duration=${duration}ms`);

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const result = {
        urgency: ['emergency', 'urgent', 'moderate', 'mild'].includes(parsed.urgency)
          ? parsed.urgency : 'mild',
        reason: parsed.reason || 'AI classification',
        source: 'ai',
      };
      // Cache
      await cacheSet(cacheKey, result, URGENCY_CACHE_TTL);
      return result;
    }
  } catch (err) {
    console.error('[AIAnalyzer] Quick urgency failed:', err.message);
  }

  // 4. Fallback: mild
  return { urgency: 'mild', reason: 'Default (no keyword match, AI unavailable)', source: 'keyword' };
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function _buildAnalysisPrompt(input, context) {
  let prompt = `Bệnh nhân nói: "${input}"`;

  const parts = [];
  if (context.age) parts.push(`${context.age} tuổi`);
  if (context.gender) parts.push(`giới tính: ${context.gender}`);
  if (context.medical_conditions && context.medical_conditions.length > 0) {
    parts.push(`bệnh nền: ${context.medical_conditions.join(', ')}`);
  }
  if (context.medications) {
    const meds = Array.isArray(context.medications) ? context.medications.join(', ') : context.medications;
    parts.push(`đang dùng thuốc: ${meds}`);
  }

  if (parts.length > 0) {
    prompt += `\nThông tin bệnh nhân: ${parts.join('; ')}`;
  }

  // History context
  if (context.history && context.history.length > 0) {
    const historyStr = context.history
      .slice(0, 3)
      .map(h => `- ${h.cluster || h.symptom}: ${h.severity || 'unknown'}`)
      .join('\n');
    prompt += `\nLịch sử gần đây:\n${historyStr}`;
  }

  prompt += '\n\nPhân tích và trả về JSON.';
  return prompt;
}

function _buildContextString(context) {
  const parts = [];
  if (context.age) parts.push(` ${context.age} tuổi`);
  if (context.gender) parts.push(` ${context.gender}`);
  if (context.medical_conditions && context.medical_conditions.length > 0) {
    parts.push(` có bệnh nền ${context.medical_conditions.join(', ')}`);
  }
  return parts.length > 0 ? ` (${parts.join(',').trim()})` : '';
}

// ─── Normalize / validate AI response ───────────────────────────────────────

function _normalizeAnalysis(parsed, rawInput) {
  // Ensure all required fields exist with sane defaults
  const result = {
    understood: parsed.understood || rawInput,
    category: parsed.category || 'general',
    urgency: ['emergency', 'urgent', 'moderate', 'mild', 'unknown'].includes(parsed.urgency)
      ? parsed.urgency : 'unknown',
    possibleCauses: Array.isArray(parsed.possibleCauses) ? parsed.possibleCauses : [],
    needsMoreInfo: parsed.needsMoreInfo !== false, // default true
    suggestedQuestions: _normalizeQuestions(parsed.suggestedQuestions),
    scoringRules: _normalizeScoringRules(parsed.scoringRules),
    conclusionTemplates: _normalizeConclusionTemplates(parsed.conclusionTemplates),
    clusterKey: parsed.clusterKey || _slugify(parsed.understood || rawInput),
    displayName: parsed.displayName || parsed.understood || rawInput,
    confidence: typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
  };

  return result;
}

function _normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    // Return default questions if AI didn't provide any
    return [
      { id: 'aq1', text: '{Honorific} bị mức nào (0-10)?', type: 'slider', min: 0, max: 10 },
      { id: 'aq2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ trước', 'Từ sáng', 'Từ hôm qua', 'Vài ngày'] },
      { id: 'aq3', text: 'Nặng hơn không?', type: 'single_choice', options: ['Đang đỡ', 'Vẫn vậy', 'Nặng hơn'] },
    ];
  }

  return questions.map((q, i) => {
    const normalized = {
      id: q.id || `aq${i + 1}`,
      text: q.text || `Câu hỏi ${i + 1}`,
      type: ['single_choice', 'multi_choice', 'slider', 'free_text'].includes(q.type)
        ? q.type : 'single_choice',
    };

    if (normalized.type === 'slider') {
      normalized.min = typeof q.min === 'number' ? q.min : 0;
      normalized.max = typeof q.max === 'number' ? q.max : 10;
    }

    if (['single_choice', 'multi_choice'].includes(normalized.type)) {
      normalized.options = Array.isArray(q.options) && q.options.length > 0
        ? q.options : ['Có', 'Không'];
    }

    return normalized;
  });
}

function _normalizeScoringRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    // Default scoring rules matching default questions
    return [
      {
        conditions: [{ field: 'aq1', op: 'gte', value: 7 }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: true,
      },
      {
        conditions: [{ field: 'aq3', op: 'eq', value: 'Nặng hơn' }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'aq1', op: 'gte', value: 4 }],
        combine: 'and',
        severity: 'medium',
        follow_up_hours: 3,
        needs_doctor: false,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'aq1', op: 'lt', value: 4 }],
        combine: 'and',
        severity: 'low',
        follow_up_hours: 6,
        needs_doctor: false,
        needs_family_alert: false,
      },
    ];
  }

  return rules.map(r => ({
    conditions: Array.isArray(r.conditions) ? r.conditions.map(c => ({
      field: c.field || 'aq1',
      op: c.op || 'eq',
      value: c.value,
    })) : [],
    combine: r.combine || 'and',
    severity: ['critical', 'high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium',
    follow_up_hours: typeof r.follow_up_hours === 'number' ? r.follow_up_hours : 6,
    needs_doctor: !!r.needs_doctor,
    needs_family_alert: !!r.needs_family_alert,
  }));
}

function _normalizeConclusionTemplates(templates) {
  const defaults = {
    low: {
      summary: '{Honorific} có triệu chứng nhẹ.',
      recommendation: 'Nghỉ ngơi, uống đủ nước. Theo dõi trong 24h.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} tối nay nhé.',
    },
    medium: {
      summary: '{Honorific} có triệu chứng mức trung bình, cần theo dõi.',
      recommendation: 'Nghỉ ngơi, uống thuốc nếu có. Nếu không đỡ sau 24h nên đi khám.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} sau 3 tiếng nhé.',
    },
    high: {
      summary: '{Honorific} có triệu chứng nặng, cần được bác sĩ đánh giá.',
      recommendation: '{Honorific} nên đi khám bác sĩ hôm nay.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} sau 1 tiếng. Đi khám sớm nhé.',
    },
  };

  if (!templates || typeof templates !== 'object') return defaults;

  const result = {};
  for (const level of ['low', 'medium', 'high']) {
    if (templates[level] && typeof templates[level] === 'object') {
      result[level] = {
        summary: templates[level].summary || defaults[level].summary,
        recommendation: templates[level].recommendation || defaults[level].recommendation,
        close_message: templates[level].close_message || defaults[level].close_message,
      };
    } else {
      result[level] = defaults[level];
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _slugify(text) {
  return (text || 'unknown')
    .toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 50);
}

function _emptyAnalysis(rawInput) {
  return {
    understood: rawInput || '',
    category: 'unknown',
    urgency: 'unknown',
    possibleCauses: [],
    needsMoreInfo: true,
    suggestedQuestions: [
      { id: 'aq1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
      { id: 'aq2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ trước', 'Từ sáng', 'Từ hôm qua', 'Vài ngày'] },
      { id: 'aq3', text: 'Nặng hơn không?', type: 'single_choice', options: ['Đang đỡ', 'Vẫn vậy', 'Nặng hơn'] },
    ],
    scoringRules: [
      { conditions: [{ field: 'aq1', op: 'gte', value: 7 }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
      { conditions: [{ field: 'aq3', op: 'eq', value: 'Nặng hơn' }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: false },
      { conditions: [{ field: 'aq1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium', follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
      { conditions: [{ field: 'aq1', op: 'lt', value: 4 }], combine: 'and', severity: 'low', follow_up_hours: 6, needs_doctor: false, needs_family_alert: false },
    ],
    conclusionTemplates: {
      low: { summary: '{Honorific} có triệu chứng nhẹ.', recommendation: 'Nghỉ ngơi, uống đủ nước.', close_message: '{selfRef} sẽ hỏi lại {honorific} tối nay nhé.' },
      medium: { summary: '{Honorific} có triệu chứng trung bình.', recommendation: 'Theo dõi, nếu không đỡ nên đi khám.', close_message: '{selfRef} sẽ hỏi lại {honorific} sau 3 tiếng.' },
      high: { summary: '{Honorific} có triệu chứng nặng.', recommendation: '{Honorific} nên đi khám bác sĩ.', close_message: '{selfRef} sẽ hỏi lại {honorific} sau 1 tiếng.' },
    },
    clusterKey: _slugify(rawInput),
    displayName: rawInput || '',
    confidence: 0,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  analyzeSymptom,
  quickUrgencyCheck,
  AI_PROVIDER,
  AI_MODEL,
};
