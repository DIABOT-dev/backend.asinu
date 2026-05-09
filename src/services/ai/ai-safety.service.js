/**
 * AI Safety Service
 * Filters AI output to prevent medical misinformation.
 */

// Words/phrases AI must NEVER say.
//
// Lưu ý: Các cụm về OTC + liều ("liều dùng", "kê đơn", "nên dùng thuốc") đã GỠ
// vì system prompt (chat.service.js) cho phép gợi ý OTC kèm disclaimer rõ ràng.
// Ban các cụm này gây bug strip giữa câu — vd "uống paracetamol 500mg, liều dùng
// 4-6 tiếng/lần" → bị thay thành "...". Giữ ban cho:
//   1. Tự khẳng định chẩn đoán (LLM không phải bác sĩ)
//   2. Trấn an sai ("không cần đi bác sĩ") — nguy hiểm cho user health app
const BANNED_PHRASES = [
  // Diagnosis (LLM không tự khẳng định bệnh)
  'bạn bị', 'bạn mắc', 'chẩn đoán', 'xác định bệnh',
  'you have', 'diagnosed with', 'you are suffering from',
  // Dangerous reassurance
  'không cần đi bác sĩ', 'không cần lo', 'chắc chắn không sao',
  'no need to see a doctor', 'definitely fine', 'nothing to worry about',
];

// Phrases that MUST be present when severity is high
const REQUIRED_HIGH_SEVERITY = [
  'bác sĩ', 'doctor', 'y tế', 'medical',
];

function filterAiOutput(text, severity = 'low') {
  let filtered = text;
  let warnings = [];

  // Check banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (filtered.toLowerCase().includes(phrase.toLowerCase())) {
      warnings.push(`Removed banned phrase: "${phrase}"`);
      // Replace with safe alternative
      filtered = filtered.replace(new RegExp(phrase, 'gi'), '...');
    }
  }

  // For high severity, ensure doctor recommendation is present
  if (severity === 'high') {
    const hasDocRef = REQUIRED_HIGH_SEVERITY.some(p => filtered.toLowerCase().includes(p));
    if (!hasDocRef) {
      filtered += '\n\nNếu tình trạng không cải thiện, nên liên hệ bác sĩ để được tư vấn.';
      warnings.push('Added doctor recommendation for high severity');
    }
  }

  return { text: filtered, warnings, modified: warnings.length > 0 };
}

function filterTriageResult(result) {
  if (!result) return result;

  const filtered = { ...result };

  // Filter recommendation text
  if (filtered.recommendation) {
    const { text, warnings } = filterAiOutput(filtered.recommendation, filtered.severity);
    filtered.recommendation = text;
    if (warnings.length > 0) {
      console.log('[AI Safety] Filtered triage recommendation:', warnings);
    }
  }

  // Filter summary text
  if (filtered.summary) {
    const { text, warnings } = filterAiOutput(filtered.summary, filtered.severity);
    filtered.summary = text;
    if (warnings.length > 0) {
      console.log('[AI Safety] Filtered triage summary:', warnings);
    }
  }

  // Enforce: high severity MUST have needsDoctor=true if hasRedFlag
  if (filtered.hasRedFlag && !filtered.needsDoctor) {
    filtered.needsDoctor = true;
    console.log('[AI Safety] Forced needsDoctor=true for red flag');
  }

  return filtered;
}

function filterChatResponse(text) {
  const { text: filtered, warnings } = filterAiOutput(text);
  if (warnings.length > 0) {
    console.log('[AI Safety] Filtered chat response:', warnings);
  }
  return filtered;
}

module.exports = { filterAiOutput, filterTriageResult, filterChatResponse, BANNED_PHRASES };
