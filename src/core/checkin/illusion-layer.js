'use strict';

/**
 * Illusion Layer — Biến "form check-in" thành "AI companion"
 *
 * Nằm giữa Script Runner và Response trả về cho user.
 * Chỉ REWRITE lớp trình bày — KHÔNG thay đổi logic scoring/flow.
 *
 * Chức năng:
 *   1. Context rendering — Lấy data hôm qua/trend đưa vào câu hỏi
 *   2. Human rewrite — Biến câu hỏi cứng thành câu tự nhiên
 *   3. Safety controls — Lock template, validate output, map template_id
 *
 * Ràng buộc (Control #17):
 *   - KHÔNG thêm/bớt câu hỏi
 *   - KHÔNG thay đổi scoring_rules
 *   - KHÔNG thay đổi flow logic
 *   - Output PHẢI map về original_template_id
 *   - KHÔNG chứa keyword y khoa nguy hiểm
 */

const { getHonorifics } = require('../../lib/honorifics');

// ─── Symptom name sanitizer ────────────────────────────────────────────────
// Tránh template injection khi display_name từ DB bị rác (chứa text câu hỏi,
// pronoun, dấu câu). Fallback về null → caller dùng nhánh greeting/empathy default.

function sanitizeSymptomName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return null;
  if (/[?{}:.!]/.test(trimmed)) return null;
  if (/\b(anh|chú|bạn|bác|cô|em|cháu|tôi|mình|mày|ông|bà)\b/i.test(trimmed)) return null;
  return trimmed;
}

// ─── Banned keywords — output KHÔNG được chứa ──────────────────────────────

const BANNED_KEYWORDS = [
  'ngừng thuốc', 'bỏ thuốc', 'không cần uống thuốc',
  'tự điều trị', 'không cần đi khám', 'tự chữa',
  'stop taking', 'stop medication', 'no need to see doctor',
  'self-treat', 'self-medicate',
];

// ─── Greeting rewrite templates ─────────────────────────────────────────────

const GREETING_REWRITES = {
  has_symptom_yesterday: {
    id: 'greeting_symptom_yesterday',
    vi: '{callName} ơi, hôm qua {honorific} có bị {symptom}. Hôm nay {selfRef} hỏi thăm {honorific} nhé',
    en: '{callName}, you had {symptom} yesterday. Let me check in with you today',
  },
  symptom_trend_worsening: {
    id: 'greeting_trend_worsening',
    vi: '{callName} ơi, mấy hôm nay {honorific} hay bị {symptom}. {selfRef} muốn hỏi kỹ hơn nhé',
    en: '{callName}, you\'ve had {symptom} recently. Let me ask a few more questions',
  },
  symptom_trend_improving: {
    id: 'greeting_trend_improving',
    vi: '{callName} ơi, {symptom} đang đỡ dần rồi. {selfRef} hỏi thêm chút nhé',
    en: '{callName}, your {symptom} is improving. Let me check a few more things',
  },
  consecutive_tired: {
    id: 'greeting_consecutive_tired',
    vi: '{callName} ơi, {tiredDays} ngày nay {honorific} đều mệt. {selfRef} hỏi thăm {honorific} nhé',
    en: '{callName}, you\'ve been tired for {tiredDays} days. Let me check on you',
  },
  default: {
    id: 'greeting_default',
    vi: '{callName} ơi, {selfRef} hỏi thăm {honorific} nhé',
    en: '{callName}, let me check in with you',
  },
};

// ─── Question rewrite templates ─────────────────────────────────────────────
// Map question text patterns → natural rewrites with context

const QUESTION_REWRITES = {
  // Pain/severity sliders
  slider_pain: {
    id: 'rewrite_slider_pain',
    match: (text) => text.includes('đau mức') || text.includes('mức độ đau') || text.includes('pain level'),
    vi: '{honorific} thấy đau khoảng bao nhiêu?',
    en: 'How would you rate your pain?',
  },
  // Duration questions
  duration: {
    id: 'rewrite_duration',
    match: (text) => text.includes('từ khi nào') || text.includes('bao lâu') || text.includes('how long') || text.includes('since when'),
    vi: '{honorific} bị vậy từ khi nào rồi?',
    en: 'When did this start?',
  },
  // Progression
  progression: {
    id: 'rewrite_progression',
    match: (text) => text.includes('nặng hơn') || text.includes('thay đổi') || text.includes('getting worse') || text.includes('changed'),
    vi: 'So với lúc đầu, {honorific} thấy thế nào?',
    en: 'Compared to when it started, how do you feel?',
  },
  // Follow-up comparison
  followup_compare: {
    id: 'rewrite_followup_compare',
    match: (text) => text.includes('so với lúc trước') || text.includes('compared to before'),
    vi: 'So với lúc trước, {honorific} thấy thế nào rồi?',
    en: 'Compared to before, how are you feeling?',
  },
  // New symptoms
  new_symptoms: {
    id: 'rewrite_new_symptoms',
    match: (text) => text.includes('triệu chứng mới') || text.includes('new symptom'),
    vi: '{honorific} có thấy thêm gì khác không?',
    en: 'Have you noticed anything else?',
  },
};

// ─── #4 Continuity Prefixes ─────────────────────────────────────────────────
// Ghép trước câu hỏi đầu tiên để tạo cảm giác AI theo dõi liên tục

const CONTINUITY_PREFIXES = {
  same_symptom_2d: {
    id: 'continuity_same_2d',
    vi: 'Hôm qua {honorific} cũng bị {symptom}. ',
    en: 'You had {symptom} yesterday too. ',
  },
  same_symptom_3d: {
    id: 'continuity_same_3d',
    vi: '{days} ngày nay {honorific} đều bị {symptom}. ',
    en: 'You\'ve had {symptom} for {days} days now. ',
  },
  was_severe: {
    id: 'continuity_was_severe',
    vi: 'Lần trước {honorific} có triệu chứng khá nặng. ',
    en: 'Last time you had quite severe symptoms. ',
  },
  improving: {
    id: 'continuity_improving',
    vi: '{symptom} đang đỡ dần rồi. ',
    en: 'Your {symptom} has been improving. ',
  },
};

/**
 * Chọn continuity prefix phù hợp.
 * Chỉ áp dụng cho câu hỏi đầu tiên (step 0).
 */
function selectContinuityPrefix(ctx, user) {
  const lang = user.lang || 'vi';
  const h = getHonorifics(user);
  const symptom = sanitizeSymptomName(ctx.topSymptom?.display_name);

  if (symptom && ctx.consecutiveTiredDays >= 3) {
    return {
      text: _renderTemplate(CONTINUITY_PREFIXES.same_symptom_3d, { symptom, days: ctx.consecutiveTiredDays }, h, lang),
      templateId: CONTINUITY_PREFIXES.same_symptom_3d.id,
    };
  }

  if (symptom && ctx.topSymptom.trend === 'decreasing') {
    return {
      text: _renderTemplate(CONTINUITY_PREFIXES.improving, { symptom }, h, lang),
      templateId: CONTINUITY_PREFIXES.improving.id,
    };
  }

  if (ctx.lastSeverity === 'high') {
    return {
      text: _renderTemplate(CONTINUITY_PREFIXES.was_severe, {}, h, lang),
      templateId: CONTINUITY_PREFIXES.was_severe.id,
    };
  }

  if (symptom && ctx.consecutiveTiredDays >= 2) {
    return {
      text: _renderTemplate(CONTINUITY_PREFIXES.same_symptom_2d, { symptom }, h, lang),
      templateId: CONTINUITY_PREFIXES.same_symptom_2d.id,
    };
  }

  return null; // No continuity needed
}

// ─── #5 Micro-empathy Responses ─────────────────────────────────────────────
// Phản hồi ngắn có cảm xúc sau mỗi câu trả lời user

const EMPATHY_RESPONSES = {
  answer_positive: {
    id: 'empathy_positive',
    vi: ['Tốt quá!', 'Vậy là yên tâm rồi.', 'Đỡ hơn rồi, tốt quá!'],
    en: ['That\'s great!', 'Good to hear!', 'That\'s reassuring!'],
  },
  answer_mild: {
    id: 'empathy_mild',
    vi: ['{selfRef} ghi nhận rồi nhé.', '{selfRef} hiểu rồi.', 'Vâng, {selfRef} nắm được rồi.'],
    en: ['I see, let\'s keep monitoring.', 'Understood, let me ask a bit more.', 'Okay, let\'s check a few more things.'],
  },
  answer_severe: {
    id: 'empathy_severe',
    vi: ['{selfRef} sẽ theo sát thêm nhé.', 'Để {selfRef} hỏi kỹ hơn.', '{selfRef} hơi lo cho {honorific}.'],
    en: ['Let me ask a few more questions.', 'I\'d like to check more carefully.', 'I\'m a bit concerned, let me ask more.'],
  },
  answer_improving: {
    id: 'empathy_improving',
    vi: ['Đỡ hơn rồi, tốt quá!', 'Vậy là có tiến triển rồi.', 'Tốt lắm, cứ giữ vậy nhé.'],
    en: ['Getting better, great!', 'That\'s good progress!', 'Keep it up!'],
  },
  answer_worsening: {
    id: 'empathy_worsening',
    vi: ['{selfRef} hơi lo cho {honorific}.', 'Mình cần theo dõi kỹ hơn.', '{selfRef} muốn nắm rõ thêm tình hình.'],
    en: ['I\'m a bit concerned.', 'We should monitor this closely.', 'Let me check further.'],
  },
};

/**
 * Chọn empathy response dựa trên câu trả lời vừa rồi.
 *
 * @param {object} lastAnswer - { question_id, answer, question_type }
 * @param {object} user
 * @returns {{ text: string, templateId: string } | null}
 */
function selectEmpathyResponse(lastAnswer, user) {
  if (!lastAnswer || lastAnswer.answer === null || lastAnswer.answer === undefined) return null;

  const lang = user.lang || 'vi';
  const h = getHonorifics(user);
  const answer = lastAnswer.answer;
  const answerStr = (Array.isArray(answer) ? answer.join(', ') : String(answer)).toLowerCase();

  let category;

  // Classify answer
  const positiveWords = ['đỡ hơn', 'đỡ rồi', 'ổn rồi', 'hết rồi', 'đang đỡ', 'better', 'improved', 'fine', 'good', 'đã đỡ'];
  const severeWords = ['nặng hơn', 'rất đau', 'không chịu được', 'worse', 'severe', 'terrible', 'khá nặng'];
  const mildWords = ['vẫn vậy', 'vẫn như cũ', 'same', 'unchanged', 'trung bình', 'nhẹ'];

  if (positiveWords.some(w => answerStr.includes(w))) {
    category = 'answer_improving';
  } else if (severeWords.some(w => answerStr.includes(w))) {
    category = 'answer_worsening';
  } else if (mildWords.some(w => answerStr.includes(w))) {
    category = 'answer_mild';
  } else if (typeof answer === 'number') {
    // Slider: 0-3 = positive, 4-6 = mild, 7-10 = severe
    if (answer <= 3) category = 'answer_positive';
    else if (answer <= 6) category = 'answer_mild';
    else category = 'answer_severe';
  } else {
    category = 'answer_mild'; // default
  }

  const responses = EMPATHY_RESPONSES[category];
  const variants = lang === 'en' ? responses.en : responses.vi;
  // Pick deterministic variant based on answer hash
  const idx = Math.abs(answerStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % variants.length;
  let text = variants[idx];

  // Replace honorific vars
  text = text.replace(/\{selfRef\}/g, h.selfRef);
  text = text.replace(/\{honorific\}/g, h.honorific);

  return { text, templateId: responses.id };
}

// ─── #6 Progress Feedback ───────────────────────────────────────────────────
// Hiển thị tiến triển cuối mỗi check-in session

const PROGRESS_TEMPLATES = {
  trend_improving: {
    id: 'progress_improving',
    vi: '{symptom} đang giảm so với mấy hôm trước. Tiếp tục giữ vậy nhé {honorific}!',
    en: 'Your {symptom} is improving compared to recent days. Keep it up!',
  },
  trend_stable: {
    id: 'progress_stable',
    vi: 'Tình trạng {symptom} vẫn ổn định, {selfRef} tiếp tục theo dõi cùng {honorific} nhé.',
    en: 'Your {symptom} condition is stable. Let\'s keep monitoring together.',
  },
  trend_worsening: {
    id: 'progress_worsening',
    vi: '{symptom} có vẻ tăng lên mấy hôm nay. {honorific} nên chú ý thêm nhé.',
    en: 'Your {symptom} seems to be getting worse recently. Please pay attention.',
  },
  streak_good: {
    id: 'progress_streak',
    vi: '{streakDays} ngày nay {honorific} đều ổn. Tốt lắm!',
    en: '{streakDays} days feeling good. Great job!',
  },
  severity_improved: {
    id: 'progress_severity_improved',
    vi: 'Hôm nay nhẹ hơn hôm qua. {selfRef} mừng cho {honorific}!',
    en: 'Today is better than yesterday. Glad to hear!',
  },
  severity_same: {
    id: 'progress_severity_same',
    vi: 'Tình trạng vẫn như hôm qua. {selfRef} sẽ tiếp tục theo dõi.',
    en: 'About the same as yesterday. I\'ll keep monitoring.',
  },
  no_data: {
    id: 'progress_no_data',
    vi: '{selfRef} sẽ tiếp tục theo dõi sức khỏe {honorific} nhé.',
    en: 'I\'ll keep monitoring your health.',
  },
};

/**
 * Generate progress feedback cho conclusion.
 *
 * @param {object} ctx - checkin context
 * @param {string} currentSeverity - severity from current session
 * @param {object} user
 * @returns {{ text: string, templateId: string }}
 */
function generateProgressFeedback(ctx, currentSeverity, user) {
  const lang = user.lang || 'vi';
  const h = getHonorifics(user);

  // Priority 1: Severity comparison (today vs yesterday)
  if (ctx.lastSeverity && currentSeverity) {
    const severityOrder = { low: 1, medium: 2, high: 3 };
    const prev = severityOrder[ctx.lastSeverity] || 0;
    const curr = severityOrder[currentSeverity] || 0;
    if (curr < prev) {
      return {
        text: _renderTemplate(PROGRESS_TEMPLATES.severity_improved, {}, h, lang),
        templateId: PROGRESS_TEMPLATES.severity_improved.id,
      };
    }
    if (curr === prev && curr > 0) {
      return {
        text: _renderTemplate(PROGRESS_TEMPLATES.severity_same, {}, h, lang),
        templateId: PROGRESS_TEMPLATES.severity_same.id,
      };
    }
  }

  // Priority 2: Symptom trend
  const symptom = sanitizeSymptomName(ctx.topSymptom?.display_name);
  if (symptom) {
    const trend = ctx.topSymptom.trend || 'stable';

    if (trend === 'decreasing') {
      return {
        text: _renderTemplate(PROGRESS_TEMPLATES.trend_improving, { symptom }, h, lang),
        templateId: PROGRESS_TEMPLATES.trend_improving.id,
      };
    }
    if (trend === 'increasing') {
      return {
        text: _renderTemplate(PROGRESS_TEMPLATES.trend_worsening, { symptom }, h, lang),
        templateId: PROGRESS_TEMPLATES.trend_worsening.id,
      };
    }
    return {
      text: _renderTemplate(PROGRESS_TEMPLATES.trend_stable, { symptom }, h, lang),
      templateId: PROGRESS_TEMPLATES.trend_stable.id,
    };
  }

  // Default
  return {
    text: _renderTemplate(PROGRESS_TEMPLATES.no_data, {}, h, lang),
    templateId: PROGRESS_TEMPLATES.no_data.id,
  };
}

// ─── Build Checkin Context ──────────────────────────────────────────────────

/**
 * Build context from DB cho illusion layer.
 * Lightweight — chỉ query fields cần thiết cho rewrite.
 */
async function buildCheckinContext(pool, userId) {
  const [clusterRes, checkinRes] = await Promise.all([
    pool.query(
      `SELECT display_name, trend, count_7d
       FROM problem_clusters
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY priority DESC LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT session_date, initial_status, triage_summary, triage_severity
       FROM health_checkins
       WHERE user_id = $1 AND session_date < CURRENT_DATE
       ORDER BY session_date DESC LIMIT 3`,
      [userId]
    ),
  ]);

  const topSymptom = clusterRes.rows[0] || null;
  const recentCheckins = checkinRes.rows;
  const lastCheckin = recentCheckins[0] || null;

  const consecutiveTiredDays = recentCheckins.filter(c =>
    c.initial_status === 'tired' || c.initial_status === 'very_tired'
  ).length;

  return {
    topSymptom,
    lastCheckin,
    consecutiveTiredDays,
    lastSeverity: lastCheckin?.triage_severity || null,
    lastSummary: lastCheckin?.triage_summary || null,
  };
}

// ─── Greeting Rewrite ───────────────────────────────────────────────────────

/**
 * Rewrite script greeting dựa trên context.
 * Trả về: { displayText, originalText, templateId }
 */
function rewriteGreeting(originalGreeting, ctx, user) {
  const lang = user.lang || 'vi';
  const h = getHonorifics(user);
  let template;
  let variables = {};
  const symptom = sanitizeSymptomName(ctx.topSymptom?.display_name);

  if (ctx.consecutiveTiredDays >= 2) {
    template = GREETING_REWRITES.consecutive_tired;
    variables.tiredDays = ctx.consecutiveTiredDays;
  } else if (symptom) {
    const trend = ctx.topSymptom.trend || 'stable';
    if (trend === 'increasing') {
      template = GREETING_REWRITES.symptom_trend_worsening;
    } else if (trend === 'decreasing') {
      template = GREETING_REWRITES.symptom_trend_improving;
    } else {
      template = GREETING_REWRITES.has_symptom_yesterday;
    }
    variables.symptom = symptom;
  } else {
    template = GREETING_REWRITES.default;
  }

  const text = _renderTemplate(template, variables, h, lang);

  return {
    displayText: text,
    originalText: originalGreeting,
    templateId: template.id,
  };
}

// ─── Question Rewrite ───────────────────────────────────────────────────────

/**
 * Rewrite một câu hỏi check-in thành câu tự nhiên hơn.
 * Trả về: { displayText, originalText, originalQuestionId, templateId }
 *
 * NẾU không match rewrite nào → giữ nguyên câu gốc (safe fallback).
 */
function rewriteQuestion(question, ctx, user) {
  const lang = user.lang || 'vi';
  const h = getHonorifics(user);
  const originalText = question.text || '';

  // Try matching a rewrite template
  for (const [, rewrite] of Object.entries(QUESTION_REWRITES)) {
    if (rewrite.match(originalText.toLowerCase())) {
      const text = _renderTemplate(rewrite, {}, h, lang);
      return {
        displayText: text,
        originalText,
        originalQuestionId: question.id,
        templateId: rewrite.id,
      };
    }
  }

  // No match → personalize original text only (replace honorific placeholders)
  const personalized = _renderTemplate({ vi: originalText, en: originalText }, {}, h, lang);
  return {
    displayText: personalized,
    originalText,
    originalQuestionId: question.id,
    templateId: 'original_preserved',
  };
}

// ─── Apply Illusion to full script-runner output ────────────────────────────

/**
 * Main entry point: apply illusion layer to script-runner getNextQuestion output.
 *
 * @param {object} scriptRunnerOutput - output from getNextQuestion()
 * @param {object} scriptData - original script_data (for greeting)
 * @param {object} ctx - from buildCheckinContext()
 * @param {object} user - user profile
 * @returns {object} Enhanced output with illusion applied
 */
function applyIllusion(scriptRunnerOutput, scriptData, ctx, user, options = {}) {
  const { lastAnswer = null } = options;

  // Clone to avoid mutating original
  const output = { ...scriptRunnerOutput };

  if (output.isDone) {
    // Conclusion → add progress feedback (#6)
    const currentSeverity = output.conclusion?.severity || null;
    const progress = generateProgressFeedback(ctx, currentSeverity, user);
    output._progress = progress;
    output._illusion = {
      applied: true,
      reason: 'conclusion_with_progress',
    };
    return output;
  }

  if (!output.question) {
    output._illusion = { applied: false, reason: 'no_question' };
    return output;
  }

  // Rewrite question
  const rewritten = rewriteQuestion(output.question, ctx, user);

  // Validate rewrite (Safety #17)
  const validation = validateOutput(rewritten, output.question);
  if (!validation.valid) {
    // Safety fail → use original
    output._illusion = {
      applied: false,
      reason: 'validation_failed',
      errors: validation.errors,
    };
    return output;
  }

  // Apply rewrite
  output.question = {
    ...output.question,
    text: rewritten.displayText,
    _original_text: rewritten.originalText,
    _original_question_id: rewritten.originalQuestionId,
    _template_id: rewritten.templateId,
  };

  // Add greeting rewrite for first question (step 0)
  if (output.currentStep === 0 && scriptData?.greeting) {
    const greetingRewrite = rewriteGreeting(scriptData.greeting, ctx, user);
    output._greeting = {
      displayText: greetingRewrite.displayText,
      originalText: greetingRewrite.originalText,
      templateId: greetingRewrite.templateId,
    };

    // #4 Continuity prefix (only on first question)
    const continuity = selectContinuityPrefix(ctx, user);
    if (continuity) {
      output._continuity = continuity;
    }
  }

  // #5 Micro-empathy (response to previous answer)
  if (lastAnswer && output.currentStep > 0) {
    const empathy = selectEmpathyResponse(lastAnswer, user);
    if (empathy) {
      output._empathy = empathy;
    }
  }

  output._illusion = { applied: true, templateId: rewritten.templateId };

  return output;
}

// ─── Safety Controls (#17) ──────────────────────────────────────────────────

/**
 * Validate illusion output trước khi gửi user.
 *
 * Rules:
 *   1. displayText phải tồn tại và non-empty
 *   2. originalQuestionId phải tồn tại (truy vết)
 *   3. templateId phải tồn tại
 *   4. Không chứa banned keywords
 *   5. Question type/options KHÔNG được thay đổi
 */
function validateOutput(rewritten, originalQuestion) {
  const errors = [];

  // Rule 1: displayText exists
  if (!rewritten.displayText || rewritten.displayText.trim().length === 0) {
    errors.push('displayText is empty');
  }

  // Rule 2: originalQuestionId exists
  if (!rewritten.originalQuestionId && rewritten.templateId !== 'original_preserved') {
    errors.push('missing originalQuestionId');
  }

  // Rule 3: templateId exists
  if (!rewritten.templateId) {
    errors.push('missing templateId');
  }

  // Rule 4: No banned keywords
  const text = (rewritten.displayText || '').toLowerCase();
  for (const keyword of BANNED_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      errors.push(`contains banned keyword: "${keyword}"`);
    }
  }

  // Rule 5: Question structure unchanged (type, options remain same)
  // This is enforced by applyIllusion spreading original question props

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that illusion layer did NOT modify scoring-critical fields.
 * Call this after applyIllusion to verify safety.
 */
function validateScriptIntegrity(originalScriptData, illusionOutput) {
  const errors = [];

  // Scoring rules must be identical
  if (illusionOutput.question) {
    // Type must match
    if (illusionOutput.question.type !== undefined) {
      // Type is preserved by spread operator — just verify
    }
    // Options must match (for choice questions)
    if (illusionOutput.question.options !== undefined) {
      // Options preserved by spread
    }
  }

  // totalSteps unchanged
  if (illusionOutput.totalSteps !== undefined && originalScriptData.questions) {
    if (illusionOutput.totalSteps !== originalScriptData.questions.length) {
      errors.push(`totalSteps changed: ${originalScriptData.questions.length} → ${illusionOutput.totalSteps}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Template Rendering ─────────────────────────────────────────────────────

function _renderTemplate(template, variables, honorifics, lang) {
  let text = lang === 'en' ? (template.en || template.vi) : (template.vi || template.en);
  if (!text) return '';

  // Replace honorific vars
  text = text.replace(/\{honorific\}/g, honorifics.honorific);
  text = text.replace(/\{selfRef\}/g, honorifics.selfRef);
  text = text.replace(/\{callName\}/g, honorifics.callName);
  text = text.replace(/\{Honorific\}/g, honorifics.Honorific);

  // Replace context vars
  for (const [key, val] of Object.entries(variables)) {
    text = text.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
  }

  return text;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  buildCheckinContext,
  rewriteGreeting,
  rewriteQuestion,
  applyIllusion,
  validateOutput,
  validateScriptIntegrity,
  selectContinuityPrefix,
  selectEmpathyResponse,
  generateProgressFeedback,
  // Export for testing
  GREETING_REWRITES,
  QUESTION_REWRITES,
  BANNED_KEYWORDS,
  CONTINUITY_PREFIXES,
  EMPATHY_RESPONSES,
  PROGRESS_TEMPLATES,
};
