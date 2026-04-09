'use strict';

/**
 * AI Answer Parser
 *
 * When user types a free-text answer instead of selecting an option,
 * this parser extracts the structured answer.
 *
 * Layer 1: Local keyword/fuzzy matching (instant, free)
 * Layer 2: AI parsing (GPT-4o-mini, only when Layer 1 fails)
 * Future: MedGemma replaces GPT-4o-mini
 *
 * Example:
 *   Question: "Muc do dau?" Options: ["nhe", "trung binh", "nang"]
 *   User types: "dau qua troi luon, nang lam"
 *   -> Layer 1: keyword "nang" found -> return "nang"
 *   -> No AI needed
 */

const OpenAI = require('openai');
const { cacheGet, cacheSet } = require('../../lib/redis');

// ─── Provider config ────────────────────────────────────────────────────────

const AI_MODEL = process.env.ANSWER_PARSER_MODEL || process.env.SYMPTOM_AI_MODEL || 'gpt-4o-mini';
const PARSE_CACHE_TTL = 24 * 60 * 60; // 1 day

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── Vietnamese diacritics removal ──────────────────────────────────────────

function removeDiacritics(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd');
}

// ─── Vietnamese synonym map ─────────────────────────────────────────────────

const SYNONYMS = {
  // Nausea
  'ói': 'buồn nôn',
  'nôn': 'buồn nôn',
  'muốn ói': 'buồn nôn',
  'muốn nôn': 'buồn nôn',
  'lợm giọng': 'buồn nôn',
  // Fainting
  'xỉu': 'ngất',
  'ngất xỉu': 'ngất',
  'choáng': 'chóng mặt',
  'hoa mắt': 'chóng mặt',
  // Pain
  'nhức': 'đau',
  'nhức đầu': 'đau đầu',
  'đau': 'đau',
  // Vision
  'mờ': 'mờ mắt',
  'nhìn mờ': 'mờ mắt',
  'mờ mờ': 'mờ mắt',
  'nhìn không rõ': 'mờ mắt',
  // Fever
  'nóng': 'sốt',
  'nóng sốt': 'sốt',
  'nóng người': 'sốt',
  // Stiff
  'cứng': 'cứng cổ',
  'cứng gáy': 'cứng cổ',
  // Light sensitivity
  'sợ sáng': 'sợ ánh sáng',
  'chói mắt': 'sợ ánh sáng',
  'nhạy sáng': 'sợ ánh sáng',
  // General
  'mệt': 'mệt mỏi',
  'kiệt sức': 'mệt mỏi',
};

// ─── Severity words ─────────────────────────────────────────────────────────

const SEVERITY_LOW = [
  'nhẹ', 'ít', 'bình thường', 'hơi hơi', 'chút chút', 'tí xíu', 'tí', 'không nhiều', 'nhẹ nhàng',
  // Không dấu
  'nhe', 'it', 'binh thuong', 'hoi hoi', 'chut chut', 'ti xiu', 'khong nhieu', 'nhe nhang',
];
const SEVERITY_MID = [
  'vừa', 'trung bình', 'tàm tạm', 'cũng được', 'vừa vừa', 'không nhẹ không nặng', 'hơi nặng', 'hơi đau',
  // Không dấu
  'vua', 'trung binh', 'tam tam', 'cung duoc', 'hoi nang', 'hoi dau',
];
const SEVERITY_HIGH = [
  'nặng', 'nhiều', 'dữ dội', 'kinh khủng', 'quá trời', 'ghê lắm', 'khủng khiếp',
  'nặng lắm', 'đau lắm', 'dữ lắm', 'khó chịu lắm', 'chịu không nổi', 'rất nặng',
  'rất nhiều', 'rất đau', 'cực kỳ', 'chết luôn', 'không chịu nổi', 'quá sức chịu đựng',
  // Không dấu
  'nang', 'nhieu', 'du doi', 'kinh khung', 'qua troi', 'ghe lam', 'khung khiep',
  'nang lam', 'dau lam', 'du lam', 'kho chiu lam', 'chiu khong noi', 'rat nang',
  'rat nhieu', 'rat dau', 'cuc ky', 'chet luon', 'khong chiu noi', 'dau chet di duoc',
];

// ─── Vietnamese number words ────────────────────────────────────────────────

const VN_NUMBERS = {
  // Có dấu
  'không': 0, 'một': 1, 'hai': 2, 'ba': 3, 'bốn': 4, 'tư': 4,
  'năm': 5, 'sáu': 6, 'bảy': 7, 'bẩy': 7, 'tám': 8, 'chín': 9, 'mười': 10,
  // Không dấu
  'khong': 0, 'mot': 1, 'bon': 4, 'tu': 4,
  'nam': 5, 'sau': 6, 'bay': 7, 'tam': 8, 'chin': 9, 'muoi': 10,
  // Casual
  'zero': 0, 'max': 10,
};

// ─── Layer 1: Local matching ────────────────────────────────────────────────

/**
 * Try to match raw answer against a list of options using local heuristics.
 *
 * @param {string} rawAnswer
 * @param {string[]} options
 * @param {string} questionType - 'single_choice' | 'multi_choice'
 * @returns {{ matched: string[]|null, method: string, confidence: number }}
 */
function localMatch(rawAnswer, options, questionType = 'single_choice') {
  if (!rawAnswer || !options || options.length === 0) {
    return { matched: null, method: 'none', confidence: 0 };
  }

  const input = rawAnswer.trim().toLowerCase();
  const inputNoDiac = removeDiacritics(input);
  const isMulti = questionType === 'multi_choice';

  // ── 1a. Exact match ──
  for (const opt of options) {
    if (input === opt.toLowerCase()) {
      return { matched: [opt], method: 'exact', confidence: 1.0 };
    }
  }

  // ── 1b-pre. Follow-up specific matching — MUST run first to avoid "hơn" confusion ──
  // "tệ hơn"/"đau hơn"/"nặng hơn" must NOT match "Đỡ hơn"
  const isFollowUpQ = options.length <= 4 && options.some(o =>
    o.includes('Đỡ') || o.includes('đỡ') || o.includes('Nặng') || o.includes('nặng') ||
    o.includes('Vẫn') || o.includes('vẫn')
  );
  if (isFollowUpQ) {
    const WORSE_WORDS = ['nặng', 'tệ', 'đau hơn', 'dữ hơn', 'xấu hơn', 'tồi hơn', 'nang', 'te',
      'nặng hơn', 'tệ hơn', 'đau dữ', 'nhiều hơn', 'nhieu hon', 'nang hon', 'te hon'];
    const BETTER_WORDS = ['đỡ', 'tốt', 'khỏe', 'bớt', 'hết', 'giảm', 'khá hơn', 'ổn hơn',
      'do', 'tot', 'khoe', 'bot', 'het', 'giam', 'on hon', 'đỡ hơn', 'tốt hơn', 'do hon', 'tot hon'];
    const SAME_WORDS = ['vẫn', 'y như', 'giống', 'không đổi', 'không thay đổi', 'cũng thế', 'như cũ',
      'van', 'y nhu', 'giong', 'khong doi', 'khong thay doi', 'cung the', 'nhu cu', 'vẫn vậy', 'van vay'];

    const worseOpt = options.find(o => o.includes('Nặng') || o.includes('nặng'));
    const betterOpt = options.find(o => o.includes('Đỡ') || o.includes('đỡ'));
    const sameOpt = options.find(o => o.includes('Vẫn') || o.includes('vẫn'));

    if (WORSE_WORDS.some(w => input.includes(w))) {
      return { matched: [worseOpt || options[options.length - 1]], method: 'followup_specific', confidence: 0.9 };
    }
    if (BETTER_WORDS.some(w => input.includes(w))) {
      return { matched: [betterOpt || options[0]], method: 'followup_specific', confidence: 0.9 };
    }
    if (SAME_WORDS.some(w => input.includes(w))) {
      return { matched: [sameOpt || options[1]], method: 'followup_specific', confidence: 0.85 };
    }
  }

  // ── 1b. Keyword match — input CONTAINS an option or option CONTAINS input ──
  const keywordMatches = [];
  for (const opt of options) {
    const optLower = opt.toLowerCase();
    // Skip generic options for keyword matching
    if (optLower === 'không có' || optLower === 'không') continue;

    if (input.includes(optLower)) {
      keywordMatches.push({ option: opt, confidence: 0.9 });
    } else {
      // Check significant words (3+ chars to avoid "hơn" false matches)
      const optWords = optLower.split(/[\s,]+/).filter(w => w.length >= 3);
      const matchedWords = optWords.filter(w => input.includes(w));
      if (matchedWords.length > 0 && matchedWords.length >= optWords.length * 0.4) {
        const conf = 0.6 + (0.3 * matchedWords.length / optWords.length);
        keywordMatches.push({ option: opt, confidence: Math.min(0.9, conf) });
      }
    }
  }

  if (keywordMatches.length > 0) {
    keywordMatches.sort((a, b) => b.confidence - a.confidence);
    if (isMulti) {
      return {
        matched: keywordMatches.map(m => m.option),
        method: 'keyword',
        confidence: keywordMatches[0].confidence,
      };
    }
    return {
      matched: [keywordMatches[0].option],
      method: 'keyword',
      confidence: keywordMatches[0].confidence,
    };
  }

  // ── 1c. No-diacritics match ──
  const noDiacMatches = [];
  for (const opt of options) {
    const optNoDiac = removeDiacritics(opt);
    if (optNoDiac === 'khong co' || optNoDiac === 'khong') continue;

    if (inputNoDiac.includes(optNoDiac)) {
      noDiacMatches.push({ option: opt, confidence: 0.8 });
    } else {
      const optWords = optNoDiac.split(/[\s,]+/).filter(w => w.length >= 2);
      const matchedWords = optWords.filter(w => inputNoDiac.includes(w));
      if (matchedWords.length > 0 && matchedWords.length >= optWords.length * 0.4) {
        const conf = 0.5 + (0.3 * matchedWords.length / optWords.length);
        noDiacMatches.push({ option: opt, confidence: Math.min(0.8, conf) });
      }
    }
  }

  if (noDiacMatches.length > 0) {
    noDiacMatches.sort((a, b) => b.confidence - a.confidence);
    if (isMulti) {
      return {
        matched: noDiacMatches.map(m => m.option),
        method: 'no_diacritics',
        confidence: noDiacMatches[0].confidence,
      };
    }
    return {
      matched: [noDiacMatches[0].option],
      method: 'no_diacritics',
      confidence: noDiacMatches[0].confidence,
    };
  }

  // ── 1d. Synonym match ──
  const synonymMatches = [];
  for (const [synonym, canonical] of Object.entries(SYNONYMS)) {
    if (input.includes(synonym)) {
      // Find option that contains the canonical form
      for (const opt of options) {
        const optLower = opt.toLowerCase();
        if (optLower.includes(canonical) || canonical.includes(optLower)) {
          synonymMatches.push({ option: opt, confidence: 0.75 });
        }
      }
    }
  }

  if (synonymMatches.length > 0) {
    // Deduplicate
    const unique = [...new Map(synonymMatches.map(m => [m.option, m])).values()];
    unique.sort((a, b) => b.confidence - a.confidence);
    if (isMulti) {
      return {
        matched: unique.map(m => m.option),
        method: 'synonym',
        confidence: unique[0].confidence,
      };
    }
    return {
      matched: [unique[0].option],
      method: 'synonym',
      confidence: unique[0].confidence,
    };
  }

  // ── 1e. Severity inference ──
  // For choice questions where options represent severity levels (ordered mild → severe)
  if (options.length >= 2) {
    // Check severity — longer/more-specific patterns checked first within each level
    const isHighSeverity = SEVERITY_HIGH.some(w => input.includes(w));
    const isLowSeverity = SEVERITY_LOW.some(w => input.includes(w));
    const isMidSeverity = SEVERITY_MID.some(w => input.includes(w));

    if (isHighSeverity && !isLowSeverity) {
      return {
        matched: [options[options.length - 1]],
        method: 'severity_inference',
        confidence: 0.7,
      };
    }
    if (isLowSeverity && !isHighSeverity) {
      return {
        matched: [options[0]],
        method: 'severity_inference',
        confidence: 0.6,
      };
    }
    if (isMidSeverity && options.length >= 3) {
      const midIdx = Math.floor(options.length / 2);
      return {
        matched: [options[midIdx]],
        method: 'severity_inference',
        confidence: 0.6,
      };
    }
  }

  // ── 1f. "không" / negation handling ──
  const negWords = ['không', 'ko', 'k ', 'hông', 'hem', 'chưa', 'chẳng', 'không có gì', 'không có'];
  if (negWords.some(w => input.includes(w) || input === w.trim())) {
    // Find "không có" or "không" or "không rõ" option
    const negOption = options.find(o => {
      const ol = o.toLowerCase();
      return ol.includes('không có') || ol === 'không' || ol.includes('không rõ') || ol.includes('bình thường');
    });
    if (negOption) {
      return {
        matched: [negOption],
        method: 'negation',
        confidence: 0.7,
      };
    }
  }

  return { matched: null, method: 'none', confidence: 0 };
}

// ─── Slider parsing ─────────────────────────────────────────────────────────

/**
 * Parse a slider answer from free text.
 *
 * @param {string} rawAnswer
 * @param {number} min
 * @param {number} max
 * @returns {{ value: number|null, confidence: number, method: string }}
 */
function parseSliderFromText(rawAnswer, min = 0, max = 10) {
  if (rawAnswer == null) return { value: null, confidence: 0, method: 'none' };

  const input = String(rawAnswer).trim().toLowerCase();
  const range = max - min;

  // 1. Range check first: "tam 5-6" -> 5.5 (before single number extraction)
  const rangeMatch = input.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) {
    const avg = (parseInt(rangeMatch[1]) + parseInt(rangeMatch[2])) / 2;
    return { value: Math.max(min, Math.min(max, avg)), confidence: 0.9, method: 'range_extract' };
  }

  // 2. Check for actual numbers
  const numMatch = input.match(/(\d+([.,]\d+)?)/);
  if (numMatch) {
    let num = parseFloat(numMatch[1].replace(',', '.'));
    num = Math.max(min, Math.min(max, num));
    return { value: num, confidence: 0.95, method: 'number_extract' };
  }

  // 3. Vietnamese number words
  for (const [word, num] of Object.entries(VN_NUMBERS)) {
    if (input === word || input.startsWith(word + ' ') || input.endsWith(' ' + word)) {
      const val = Math.max(min, Math.min(max, num));
      return { value: val, confidence: 0.9, method: 'vn_number' };
    }
  }

  // 4. Severity-based inference (có dấu + không dấu)
  const extremeHigh = ['cực kỳ', 'chết luôn', 'không chịu nổi', 'quá sức chịu đựng', 'tột cùng', 'max',
    'cuc ky', 'chet luon', 'khong chiu noi', 'qua suc chiu dung', 'dau chet di duoc', 'dau chet'];
  const high = ['nặng', 'dữ dội', 'kinh khủng', 'quá trời', 'ghê lắm', 'nặng lắm', 'đau lắm',
    'chịu không nổi', 'rất nặng', 'rất đau', 'rất nhiều', 'khủng khiếp', 'dữ lắm', 'nhiều lắm',
    'nang', 'du doi', 'kinh khung', 'qua troi', 'ghe lam', 'nang lam', 'dau lam',
    'chiu khong noi', 'rat nang', 'rat dau', 'rat nhieu', 'khung khiep', 'du lam', 'nhieu lam'];
  const medHigh = ['nhiều', 'khá', 'hơi nặng', 'khá nhiều', 'khá nặng', 'khá đau',
    'nhieu', 'kha', 'hoi nang', 'kha nhieu', 'kha nang'];
  const mid = ['vừa', 'trung bình', 'vừa vừa', 'tàm tạm', 'bình thường',
    'vua', 'trung binh', 'vua vua', 'tam tam', 'binh thuong'];
  const low = ['nhẹ', 'ít', 'hơi hơi', 'chút chút', 'tí', 'tí xíu', 'hơi', 'nhẹ nhàng', 'ít ít',
    'nhe', 'it', 'hoi hoi', 'chut chut', 'ti', 'ti xiu', 'hoi', 'nhe nhang', 'it it', 'hoi thoi'];
  const none = ['không', 'không đau', 'không có', 'ko', 'hông', 'hem', 'zero', 'ko đau',
    'khong', 'khong dau', 'khong co', 'hong', 'ko dau'];

  if (none.some(w => input.includes(w))) {
    return { value: min, confidence: 0.85, method: 'severity_word' };
  }
  if (extremeHigh.some(w => input.includes(w))) {
    return { value: max, confidence: 0.85, method: 'severity_word' };
  }
  if (high.some(w => input.includes(w))) {
    return { value: Math.round(min + range * 0.85), confidence: 0.75, method: 'severity_word' };
  }
  if (medHigh.some(w => input.includes(w))) {
    return { value: Math.round(min + range * 0.7), confidence: 0.7, method: 'severity_word' };
  }
  if (mid.some(w => input.includes(w))) {
    return { value: Math.round(min + range * 0.5), confidence: 0.7, method: 'severity_word' };
  }
  if (low.some(w => input.includes(w))) {
    return { value: Math.round(min + range * 0.2), confidence: 0.7, method: 'severity_word' };
  }

  return { value: null, confidence: 0, method: 'none' };
}

// ─── Layer 2: AI parsing ────────────────────────────────────────────────────

const AI_PARSE_SYSTEM_PROMPT = `Bạn là hệ thống phân tích câu trả lời y tế. Khi bệnh nhân trả lời tự do thay vì chọn đáp án, bạn tìm đáp án phù hợp nhất.

Trả về JSON duy nhất, KHÔNG giải thích:
{
  "matched_options": ["option1"],
  "confidence": 0.85,
  "reasoning": "short reason"
}

Nếu type = multi_choice, matched_options có thể chứa nhiều phần tử.
Nếu type = single_choice, matched_options chỉ có 1 phần tử.
Nếu type = slider, trả về:
{
  "value": 7,
  "confidence": 0.85,
  "reasoning": "short reason"
}

CHỈ JSON, KHÔNG text khác.`;

/**
 * Use AI to parse a free-text answer when local matching fails.
 *
 * @param {string} rawAnswer
 * @param {object} question
 * @returns {Promise<{ matched: string[]|null, value: number|null, confidence: number, method: string }>}
 */
async function aiParse(rawAnswer, question) {
  // Build cache key
  const cacheKey = `ansparse:${removeDiacritics(rawAnswer).replace(/\s+/g, '_').slice(0, 80)}:${question.id || 'q'}`;

  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return { ...cached, method: 'ai_cached' };
    }
  } catch (_) { /* cache miss, continue */ }

  try {
    const userPrompt = `Câu hỏi: "${question.text || ''}"
Type: ${question.type}
${question.options ? `Options: ${JSON.stringify(question.options)}` : ''}
${question.type === 'slider' ? `Range: ${question.min || 0}-${question.max || 10}` : ''}

Bệnh nhân trả lời: "${rawAnswer}"

Tìm đáp án phù hợp nhất. Trả về JSON.`;

    const startTime = Date.now();
    const response = await getClient().chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 200,
      messages: [
        { role: 'system', content: AI_PARSE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const duration = Date.now() - startTime;
    const usage = response.usage || {};
    console.log(`[AnswerParser] AI parse: model=${AI_MODEL}, tokens=${usage.total_tokens || '?'}, duration=${duration}ms`);

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { matched: null, value: null, confidence: 0, method: 'ai_failed' };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    let result;
    if (question.type === 'slider') {
      const val = typeof parsed.value === 'number' ? parsed.value : null;
      result = {
        matched: null,
        value: val != null ? Math.max(question.min || 0, Math.min(question.max || 10, val)) : null,
        confidence: parsed.confidence || 0.7,
        method: 'ai',
      };
    } else {
      const matchedOpts = Array.isArray(parsed.matched_options) ? parsed.matched_options : [];
      // Validate that AI returned options that actually exist
      const validOpts = matchedOpts.filter(m =>
        (question.options || []).some(o => o.toLowerCase() === m.toLowerCase())
      );
      // Map back to exact option casing
      const exactOpts = validOpts.map(m =>
        (question.options || []).find(o => o.toLowerCase() === m.toLowerCase()) || m
      );
      result = {
        matched: exactOpts.length > 0 ? exactOpts : null,
        value: null,
        confidence: exactOpts.length > 0 ? (parsed.confidence || 0.7) : 0,
        method: 'ai',
      };
    }

    // Cache result
    try {
      await cacheSet(cacheKey, result, PARSE_CACHE_TTL);
    } catch (_) { /* cache write failure is non-fatal */ }

    return result;
  } catch (err) {
    console.error('[AnswerParser] AI parse failed:', err.message);
    return { matched: null, value: null, confidence: 0, method: 'ai_failed' };
  }
}

// ─── Main parseAnswer function ──────────────────────────────────────────────

/**
 * Parse a free-text answer against a question's options.
 *
 * @param {string} rawAnswer - what user typed
 * @param {object} question - { id, text, type, options, min, max }
 * @param {object} context - { profile, previousAnswers }
 * @returns {Promise<{
 *   parsed: any,
 *   method: string,
 *   confidence: number,
 *   extracted: string[],
 *   original: string,
 * }>}
 */
async function parseAnswer(rawAnswer, question, context = {}) {
  const original = rawAnswer;

  if (rawAnswer == null || rawAnswer === '') {
    return { parsed: rawAnswer, method: 'original', confidence: 0, extracted: [], original };
  }

  const strAnswer = String(rawAnswer).trim();

  // ── Slider questions: extract a number ──
  if (question.type === 'slider') {
    // If already a number, pass through
    if (!isNaN(rawAnswer) && rawAnswer !== '') {
      return {
        parsed: Number(rawAnswer),
        method: 'exact',
        confidence: 1.0,
        extracted: [],
        original,
      };
    }

    const sliderResult = parseSliderFromText(strAnswer, question.min, question.max);
    if (sliderResult.value != null && sliderResult.confidence >= 0.5) {
      return {
        parsed: sliderResult.value,
        method: sliderResult.method,
        confidence: sliderResult.confidence,
        extracted: [],
        original,
      };
    }

    // AI fallback for slider
    const aiResult = await aiParse(strAnswer, question);
    if (aiResult.value != null && aiResult.confidence > 0.3) {
      return {
        parsed: aiResult.value,
        method: aiResult.method,
        confidence: aiResult.confidence,
        extracted: [],
        original,
      };
    }

    // Return original if nothing works
    return { parsed: rawAnswer, method: 'original', confidence: 0, extracted: [], original };
  }

  // ── Choice questions ──
  if (question.type === 'single_choice' || question.type === 'multi_choice') {
    const options = question.options || [];

    // If answer is already one of the options, pass through
    if (options.includes(rawAnswer)) {
      return {
        parsed: question.type === 'multi_choice' ? [rawAnswer] : rawAnswer,
        method: 'exact',
        confidence: 1.0,
        extracted: [rawAnswer],
        original,
      };
    }

    // Layer 1: Local matching
    const localResult = localMatch(strAnswer, options, question.type);
    if (localResult.matched && localResult.confidence >= 0.5) {
      const extracted = localResult.matched;
      return {
        parsed: question.type === 'multi_choice' ? extracted : extracted[0],
        method: localResult.method,
        confidence: localResult.confidence,
        extracted,
        original,
      };
    }

    // Layer 2: AI parsing (only when local confidence < 0.5)
    const aiResult = await aiParse(strAnswer, question);
    if (aiResult.matched && aiResult.confidence > 0.3) {
      const extracted = aiResult.matched;
      return {
        parsed: question.type === 'multi_choice' ? extracted : extracted[0],
        method: aiResult.method,
        confidence: aiResult.confidence,
        extracted,
        original,
      };
    }

    // Nothing matched — return original with confidence 0
    return {
      parsed: rawAnswer,
      method: 'original',
      confidence: 0,
      extracted: [],
      original,
    };
  }

  // ── free_text or unknown type — pass through ──
  return {
    parsed: rawAnswer,
    method: 'original',
    confidence: 1.0,
    extracted: [],
    original,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  parseAnswer,
  parseSliderFromText,
  localMatch,
  removeDiacritics,
};
