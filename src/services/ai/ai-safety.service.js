/**
 * AI Safety Service
 * Filters AI output to prevent medical misinformation.
 */

// Words/phrases AI must NEVER say.
//
// Nội dung trên nền tảng chỉ được cung cấp thông tin, sàng lọc và định hướng.
// Không cho AI chẩn đoán xác định, kê đơn, gọi tên thuốc hoặc chỉ định liều.
// Các cụm nguy hiểm được lọc ở đầu ra cuối cùng, kể cả khi prompt đã yêu cầu OTC.
const BANNED_PHRASES = [
  // Diagnosis (LLM không tự khẳng định bệnh)
  'bạn bị',
  'bạn mắc',
  'chẩn đoán',
  'xác định bệnh',
  'you have',
  'diagnosed with',
  'you are suffering from',
  // Treatment boundary: no prescribing, drug names or dosage instructions.
  'kê đơn',
  'đơn thuốc',
  'liều dùng',
  'liều lượng',
  'prescription',
  'dosage',
  'dose',
  'paracetamol',
  'acetaminophen',
  'ibuprofen',
  'aspirin',
  'amoxicillin',
  'metformin',
  'insulin',
  'kháng sinh',
  // Dangerous reassurance
  'không cần đi bác sĩ',
  'không cần lo',
  'chắc chắn không sao',
  'no need to see a doctor',
  'definitely fine',
  'nothing to worry about',
];

// Phrases that MUST be present when severity is high
const REQUIRED_HIGH_SEVERITY = ['chuyên gia', 'healthcare', 'y tế', 'medical'];

function filterAiOutput(text, severity = 'low') {
  let filtered = text;
  const warnings = [];
  const matchedPhrases = [];

  // Check banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (filtered.toLowerCase().includes(phrase.toLowerCase())) {
      matchedPhrases.push(phrase);
    }
  }

  // Fail closed: do not leave a diagnosis, medicine name or dosage fragment
  // visible after filtering one unsafe phrase.
  if (matchedPhrases.length > 0 || /\b\d+(?:[.,]\d+)?\s*(?:mg|g|ml|mcg|iu|viên|lần\/ngày)\b/i.test(filtered)) {
    filtered = 'Nội dung này cần được chuyên gia tư vấn sức khỏe hoặc cơ sở y tế đánh giá trực tiếp.';
    matchedPhrases.forEach((phrase) => warnings.push(`Blocked unsafe phrase: "${phrase}"`));
    warnings.push('Replaced unsafe AI output with a safe care-navigation message');
  }

  // For high severity, ensure a safe human-care recommendation is present.
  if (severity === 'high') {
    const hasCareRef = REQUIRED_HIGH_SEVERITY.some((p) => filtered.toLowerCase().includes(p));
    if (!hasCareRef) {
      filtered += '\n\nNếu có dấu hiệu bất thường, hãy liên hệ cơ sở y tế hoặc chuyên gia phù hợp.';
      warnings.push('Added healthcare recommendation for high severity');
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
