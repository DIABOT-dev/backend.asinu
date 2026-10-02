/**
 * Triage AI Layer — Natural Vietnamese text generation for triage.
 *
 * Questions: TEMPLATE-based (no GPT). Personalised via honorifics.
 * Conclusions:
 *   - Emergency → FIXED templates (no GPT, instant, zero-cost)
 *   - Non-emergency → GPT with tight prompt for summary + recommendation
 */

const { callTextAi } = require('../../services/ai/ai.service');
const { getHonorifics } = require('../../lib/honorifics');

// ─── Question Templates (có dấu tiếng Việt) ─────────────────────────────────

function formatQuestion(engineResult, profile, _previousAnswers = []) {
  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang: 'vi',
  });
  const { honorific, selfRef, callName, Honorific } = h;
  // CallName viết hoa chữ đầu (VD: "chú Hùng" → "Chú Hùng")
  const CallName = callName.charAt(0).toUpperCase() + callName.slice(1);
  const step = engineResult.step;
  let question;

  // Lấy bodyLocations từ engineResult để inject vào greeting (T2 → T3 awareness).
  // Map enum key → label tiếng Việt.
  const LOCATION_LABEL_VI = {
    head: 'đầu',
    chest: 'ngực',
    abdomen: 'bụng',
    limbs: 'tay chân',
    skin: 'da',
    whole_body: 'toàn thân',
    mental: 'tinh thần',
  };
  const locKeys = Array.isArray(engineResult.bodyLocations) ? engineResult.bodyLocations : [];
  const locLabels = locKeys.map((k) => LOCATION_LABEL_VI[k] || k).filter(Boolean);
  const locOther = (engineResult.bodyLocationOther || '').trim();
  // Build location phrase: "đầu" / "đầu, ngực" / "đầu, ngực, bụng" + " và '<other>'"
  let locPhrase = '';
  if (locLabels.length === 1) locPhrase = locLabels[0];
  else if (locLabels.length === 2) locPhrase = `${locLabels[0]} và ${locLabels[1]}`;
  else if (locLabels.length >= 3)
    locPhrase = `${locLabels.slice(0, -1).join(', ')} và ${locLabels[locLabels.length - 1]}`;
  if (locOther) locPhrase = locPhrase ? `${locPhrase}, ${locOther}` : locOther;

  switch (step) {
    case 'symptoms':
      // T3 question — aware T2 location nếu có. Nếu không có location (FE cũ) →
      // dùng template chung như cũ.
      if (locPhrase) {
        question = `${CallName} ơi, ${selfRef} biết ${honorific} đang khó chịu ở ${locPhrase}. ${Honorific} chọn (hoặc gõ thêm) triệu chứng cụ thể nhé 💙`;
      } else {
        question = `${CallName} ơi, ${selfRef} nghe ${honorific} đang không khoẻ. ${Honorific} cho ${selfRef} biết ${honorific} đang gặp triệu chứng gì nhé 💙`;
      }
      break;

    case 'associated': {
      const sym = engineResult.primarySymptom || 'vấn đề';
      question = `Ngoài ${sym}, ${honorific} có thấy triệu chứng nào dưới đây không?`;
      break;
    }

    case 'onset':
      question = `${Honorific} bị từ lúc nào vậy? ${Honorific} chọn hoặc gõ thời gian chính xác nhé 😊`;
      break;

    case 'progression':
      question = `Từ lúc bắt đầu đến giờ ${honorific} thấy đỡ hơn chưa, hay vẫn vậy? 💙`;
      break;

    case 'red_flags':
      question = `${CallName} ơi, ${honorific} có thấy dấu hiệu nào dưới đây không? 🩺`;
      break;

    case 'cause': {
      const sym = engineResult.primarySymptom || '';
      if (sym.includes('đau bụng') || sym.includes('bụng')) {
        question = `${Honorific} có ăn gì lạ, đồ cay, hay uống thuốc lúc đói không? 🤔`;
      } else if (sym.includes('đau đầu') || sym.includes('đầu')) {
        question = `${Honorific} có nhớ gần đây ngủ ít, quên thuốc hay làm việc căng thẳng không? 🤔`;
      } else if (sym.includes('đau vai') || sym.includes('đau lưng') || sym.includes('khớp')) {
        question = `${Honorific} có nhớ gần đây vận động nặng, ngồi sai tư thế hay bê vác gì không? 🤔`;
      } else if (sym.includes('chóng mặt')) {
        question = `${Honorific} có nhớ gần đây bỏ ăn, đứng dậy nhanh hay quên thuốc không? 🤔`;
      } else {
        question = `${Honorific} có nhớ gần đây có gì bất thường không? 🤔`;
      }
      break;
    }

    case 'action':
      question = `${Honorific} có nghỉ ngơi hay uống thuốc gì chưa? 💊`;
      break;

    case 'followup_status': {
      const prev = engineResult.previousSessionSummary || 'không khoẻ';
      question = `${CallName} ơi, lần check-in trước ${honorific} nói bị ${prev}. Bây giờ ${honorific} thấy thế nào?`;
      break;
    }

    case 'followup_detail':
      question = `${Honorific} có thêm triệu chứng gì mới không?`;
      break;

    default:
      question = `${Honorific} có thể cho ${selfRef} biết thêm không? 💙`;
      break;
  }

  return {
    question,
    options: engineResult.options || undefined,
    multiSelect: engineResult.multiSelect || false,
    allowFreeText: engineResult.allowFreeText || false,
  };
}

// ─── Emergency Conclusion Templates (có dấu tiếng Việt) ─────────────────────

const EMERGENCY_CONCLUSIONS = {
  stroke: {
    summary: (h) => `${h.Honorific} có dấu hiệu thần kinh cần được cấp cứu ngay.`,
    recommendation: (h) =>
      `🚨 GỌI CẤP CỨU 115 NGAY. ${h.Honorific} cần được nhân viên y tế đánh giá ngay.`,
    closeMessage: (h) =>
      `${h.selfRef} đã thông báo cho người thân. Gọi 115 ngay ${h.honorific} nhé.`,
  },
  mi: {
    summary: (h) => `${h.Honorific} có đau ngực kèm dấu hiệu nguy hiểm cần cấp cứu.`,
    recommendation: (_h) =>
      `🚨 GỌI CẤP CỨU 115 NGAY. Hạn chế vận động và chờ nhân viên y tế hướng dẫn.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân. Gọi 115 ngay.`,
  },
  meningitis: {
    summary: () => `Sốt cao kèm cứng cổ là dấu hiệu cần được đánh giá khẩn cấp.`,
    recommendation: () => `🚨 ĐẾN BỆNH VIỆN NGAY để được nhân viên y tế đánh giá.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  pe: {
    summary: () => `Khó thở đột ngột kèm đau ngực là dấu hiệu cần cấp cứu.`,
    recommendation: () => `🚨 GỌI CẤP CỨU 115. Hạn chế vận động và chờ nhân viên y tế hướng dẫn.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  cauda_equina: {
    summary: () => `Đau lưng kèm rối loạn tiểu tiện là dấu hiệu cần được đánh giá khẩn cấp.`,
    recommendation: () => `🚨 ĐẾN BỆNH VIỆN NGAY để được nhân viên y tế đánh giá.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  hemorrhage: {
    summary: () => `Nôn ra máu hoặc đi ngoài phân đen là dấu hiệu cần cấp cứu.`,
    recommendation: () => `🚨 ĐẾN BỆNH VIỆN NGAY hoặc gọi 115 để được hướng dẫn.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  dengue: {
    summary: () => `Sốt kèm dấu hiệu chảy máu cần được đánh giá khẩn cấp.`,
    recommendation: () => `🚨 ĐẾN BỆNH VIỆN NGAY và làm theo hướng dẫn của nhân viên y tế.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  dka: {
    summary: () =>
      `Người có bệnh nền tiểu đường kèm khát nhiều và buồn nôn cần được đánh giá khẩn cấp.`,
    recommendation: () => `🚨 ĐẾN BỆNH VIỆN NGAY hoặc gọi 115 nếu tình trạng nặng lên.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  seizure: {
    summary: (h) => `${h.Honorific} bị co giật.`,
    recommendation: () =>
      `🚨 GỌI CẤP CỨU 115. Đặt nằm nghiêng, không đút gì vào miệng, dọn vật sắc nhọn xung quanh.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  anaphylaxis: {
    summary: () => `Khó thở kèm sưng mặt, môi hoặc lưỡi là dấu hiệu cần cấp cứu.`,
    recommendation: () => `🚨 GỌI CẤP CỨU 115 NGAY và làm theo hướng dẫn của nhân viên y tế.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  trauma: {
    summary: (h) => `${h.Honorific} bị chấn thương cần can thiệp y tế ngay.`,
    recommendation: () =>
      `🚨 KHÔNG CỬ ĐỘNG vùng bị thương. Gọi cấp cứu 115 hoặc tới bệnh viện ngay. Nếu chảy máu nhiều, dùng vải sạch ép cầm máu.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
};

// ─── Conclusion Generator ────────────────────────────────────────────────────

async function generateConclusion(state, profile, lang = 'vi', pool = null) {
  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang,
  });

  if (state.emergencyType && EMERGENCY_CONCLUSIONS[state.emergencyType]) {
    const tpl = EMERGENCY_CONCLUSIONS[state.emergencyType];
    return {
      summary: tpl.summary(h),
      recommendation: tpl.recommendation(h),
      closeMessage: tpl.closeMessage(h),
      isEmergency: true,
    };
  }

  return _generateConclusionWithGPT(state, profile, h, lang, pool);
}

async function _generateConclusionWithGPT(state, profile, h, _lang, _pool) {
  const prompt = _buildConclusionPrompt(state, profile, h);

  try {
    const response = await callTextAi({
      system:
        'Bạn là trợ lý y tế Asinu. Chỉ trả về JSON. Không chẩn đoán, không nêu tên bệnh, không kê đơn, không nêu tên/liều thuốc và không khuyên đổi hoặc ngưng thuốc. Chỉ sàng lọc và định hướng đi khám. Trả lời có dấu tiếng Việt đầy đủ.',
      prompt,
      temperature: 0.3,
      maxTokens: 400,
    });

    const raw = response.content;
    const parsed = _parseJSON(raw);
    if (!parsed) throw new Error('GPT returned invalid JSON');

    const candidate = {
      summary: String(parsed.summary || '').trim(),
      recommendation: String(parsed.recommendation || '').trim(),
      closeMessage: String(parsed.closeMessage || '').trim(),
    };
    if (!isSafeConclusion(candidate)) {
      console.warn('[Triage AI] Rejected unsafe conclusion output');
      return _buildFallbackConclusion(state, h);
    }

    return {
      summary: candidate.summary,
      recommendation: candidate.recommendation,
      closeMessage: candidate.closeMessage || `${h.selfRef} sẽ hỏi lại ${h.honorific} sau nhé.`,
      isEmergency: false,
    };
  } catch (err) {
    console.error('[Triage AI] Conclusion GPT failed:', err.message);
    return _buildFallbackConclusion(state, h);
  }
}

function _buildConclusionPrompt(state, profile, h) {
  const symptoms = (state.allSymptoms || []).join(', ') || state.primarySymptom || 'không rõ';
  const causes = (state.causesFound || []).join(', ') || 'không rõ';
  const actions = (state.actionsFound || []).join(', ') || 'chưa làm gì';
  const conditions = (profile.medical_conditions || []).join(', ') || 'không';

  return `Viết kết luận triage ngắn gọn cho bệnh nhân. Trả lời bằng tiếng Việt CÓ DẤU đầy đủ.

THÔNG TIN:
- Triệu chứng chính: ${state.primarySymptom || 'không rõ'}
- Triệu chứng đi kèm: ${symptoms}
- Từ khi nào: ${state.onset || 'không rõ'}
- Diễn tiến: ${state.progression || 'không rõ'}
- Nguyên nhân có thể: ${causes}
- Đã làm: ${actions}
- Bệnh nền: ${conditions}
- Mức độ: ${state.severity || 'low'}
- Cần gặp bác sĩ: ${state.needsDoctor ? 'CÓ' : 'không'}

XƯNG HÔ: gọi "${h.honorific}", xưng "${h.selfRef}"

Trả về JSON:
{"summary":"tóm tắt 1-2 câu","recommendation":"1 hành động làm NGAY hôm nay + 1 thứ cần theo dõi, cụ thể","closeMessage":"${h.selfRef} sẽ hỏi lại ${h.honorific} sau X tiếng nhé."}

Nếu needsDoctor=CÓ: recommendation PHẢI nói rõ "đi khám bác sĩ" + lý do cụ thể.
CHỈ JSON. Tiếng Việt có dấu.`;
}

const FORBIDDEN_CONCLUSION_PATTERNS = [
  /(?:chẩn đoán|kết luận)/i,
  /(?:có thể là|khả năng là|nghi(?: ngờ)?|mắc)(?:\s|:)/i,
  /bị\s+(?:bệnh\s+)?(?:viêm|ung thư|đột quỵ|tai biến|nhồi máu|suy tim|tắc mạch|xuất huyết|nhiễm|hội chứng)/i,
  /(?:aspirin|ibuprofen|paracetamol|acetaminophen|epipen|kháng sinh|insulin)/i,
  /(?:uống|dùng|tiêm|bôi|ngưng|ngừng|giảm|tăng|thay đổi)\s+(?:liều\s+)?thuốc/i,
  /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|viên|liều)\b/i,
];

function isSafeConclusion(candidate) {
  if (!candidate || !candidate.summary || !candidate.recommendation) return false;
  const text = `${candidate.summary} ${candidate.recommendation} ${candidate.closeMessage || ''}`;
  return !FORBIDDEN_CONCLUSION_PATTERNS.some((pattern) => pattern.test(text));
}

function _buildFallbackConclusion(state, h) {
  const symptom = state.primarySymptom || 'triệu chứng';

  if (state.needsDoctor) {
    return {
      summary: `${h.Honorific} đã ghi nhận triệu chứng ${symptom}; triệu chứng này cần được bác sĩ đánh giá.`,
      recommendation: `${h.Honorific} nên đi khám bác sĩ hôm nay. Nếu triệu chứng nặng lên, hãy đi cấp cứu ngay.`,
      closeMessage: `${h.selfRef} sẽ hỏi lại ${h.honorific} sau 3 tiếng nhé. Nếu nặng hơn, đi khám ngay ${h.honorific} nhé.`,
      isEmergency: false,
    };
  } else if (state.severity === 'medium') {
    return {
      summary: `${h.Honorific} đã ghi nhận triệu chứng ${symptom} và cần tiếp tục theo dõi.`,
      recommendation: `Nếu không đỡ, kéo dài hoặc nặng lên, ${h.honorific} nên được bác sĩ đánh giá.`,
      closeMessage: `${h.selfRef} sẽ hỏi lại ${h.honorific} sau 4 tiếng nhé 💙`,
      isEmergency: false,
    };
  } else {
    return {
      summary: `${h.Honorific} đã ghi nhận triệu chứng ${symptom}.`,
      recommendation: `Tiếp tục theo dõi. Nếu kéo dài hoặc nặng lên, ${h.honorific} nên được bác sĩ đánh giá.`,
      closeMessage: `${h.selfRef} sẽ hỏi lại ${h.honorific} sau 6 tiếng nhé 💙`,
      isEmergency: false,
    };
  }
}

function _parseJSON(raw) {
  if (!raw) return null;
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── AI-generated mapping for unknown symptoms ─────────────────────────────

const _mappingCache = new Map();

async function generateMappingForSymptom(symptom) {
  if (!symptom) return null;
  const key = symptom.toLowerCase().trim();
  if (_mappingCache.has(key)) return _mappingCache.get(key);

  const prompt = `Bạn là bác sĩ triage. Bệnh nhân nói triệu chứng: "${symptom}".

Trả về JSON với 3 field. Tất cả bằng tiếng Việt CÓ DẤU đầy đủ.

1. "associatedSymptoms": 6-8 triệu chứng đi kèm để khoanh vùng. Mỗi item: {"text": "tên triệu chứng", "dangerLevel": "normal|warning|danger"}
   - "danger": triệu chứng nguy hiểm cần cấp cứu
   - "warning": cần chú ý
   - "normal": thông thường

2. "redFlags": 5-7 dấu hiệu nguy hiểm đặc trưng. Nếu bệnh nhân có BẤT KỲ dấu hiệu nào → cần đi bệnh viện ngay.

3. "causes": 5-7 nguyên nhân phổ biến nhất.

RULES:
- associatedSymptoms phải là TRIỆU CHỨNG (buồn nôn, sốt...), KHÔNG phải nguyên nhân
- redFlags phải là DẤU HIỆU NGUY HIỂM y khoa
- causes phải là NGUYÊN NHÂN (ăn đồ lạ, vận động...), KHÔNG phải triệu chứng
- Cuối associatedSymptoms thêm {"text": "không có", "dangerLevel": "normal"}
- TẤT CẢ tiếng Việt có dấu

CHỈ JSON.`;

  try {
    const response = await callTextAi({
      prompt,
      maxTokens: 1024,
      temperature: 0.2,
    });

    const raw = response.content;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (
      !Array.isArray(parsed.associatedSymptoms) ||
      !Array.isArray(parsed.redFlags) ||
      !Array.isArray(parsed.causes)
    )
      return null;

    const result = {
      associatedSymptoms: parsed.associatedSymptoms,
      redFlags: parsed.redFlags,
      causes: parsed.causes,
    };

    _mappingCache.set(key, result);
    console.log(
      `[AI Mapping] Generated for "${symptom}": ${result.associatedSymptoms.length} associated, ${result.redFlags.length} redFlags, ${result.causes.length} causes`
    );
    return result;
  } catch (err) {
    console.error(`[AI Mapping] Failed for "${symptom}":`, err.message);
    return null;
  }
}

// ─── AI Safety Classifier — chạy ngay sau khi user khai triệu chứng ─────────
// Mục đích: backup safety net cho các triệu chứng nặng KHÔNG có trong KB
// và KHÔNG match emergency-detector keywords. Cover các case "long tail"
// (khó nuốt, ho ra máu, không tiểu được, mất thị lực, ...).
//
// Cost: 1 GPT-4o-mini call ~150 tokens output = ~$0.0001/symptom.
// Cache theo symptom → mỗi symptom unique chỉ tốn 1 call lifetime.

const _severityCache = new Map();

/**
 * Classify mức độ nguy hiểm của triệu chứng.
 * @param {string} symptom - chuỗi triệu chứng user khai
 * @param {object} profile - { age, medical_conditions[] }
 * @returns {Promise<{severity: 'emergency'|'urgent'|'moderate'|'mild'|'unknown', reason?: string, needsFamilyAlert: boolean, needsDoctor: boolean}>}
 */
async function classifySymptomSeverity(symptom, profile = {}) {
  if (!symptom) return { severity: 'mild', needsFamilyAlert: false, needsDoctor: false };

  const conditions = (profile.medical_conditions || []).join(', ') || 'không';
  const age =
    profile.age || (profile.birth_year ? new Date().getFullYear() - profile.birth_year : null);
  const cacheKey = `${symptom.toLowerCase().trim()}|${conditions}|${age || '?'}`;

  if (_severityCache.has(cacheKey)) return _severityCache.get(cacheKey);

  const prompt = `Bạn là bác sĩ triage. Phân loại mức độ nguy hiểm của triệu chứng sau.

TRIỆU CHỨNG: "${symptom}"
TUỔI: ${age || 'không rõ'}
BỆNH NỀN: ${conditions}

Phân loại thành 1 trong 4 mức:
- "emergency": đe doạ tính mạng, cần cấp cứu 115 NGAY (vd. ngất, khó thở dữ dội, gãy xương lớn, đau ngực + vã mồ hôi, ho ra máu nhiều, không tiểu được 24h, mất thị lực đột ngột, co giật, chấn thương sọ não)
- "urgent": cần đi viện trong vài giờ (vd. sốt cao kéo dài, đau bụng dữ dội, tiểu ra máu, đau đầu dữ dội)
- "moderate": cần theo dõi + có thể đi khám trong 1-2 ngày (vd. sốt nhẹ, đau đầu thông thường, mệt mỏi)
- "mild": có thể tự chăm sóc, theo dõi (vd. mệt nhẹ, đau cơ thông thường)

Trả về JSON:
{
  "severity": "emergency|urgent|moderate|mild",
  "reason": "lý do ngắn 1 câu",
  "needsFamilyAlert": true|false,
  "needsDoctor": true|false
}

QUY TẮC AN TOÀN:
- Khi nghi ngờ → chọn mức cao hơn
- emergency → needsFamilyAlert=true, needsDoctor=true
- urgent → needsDoctor=true, needsFamilyAlert tuỳ tuổi/bệnh nền (>= 60 hoặc có bệnh nền nặng → true)
- Người >=60 hoặc có tiểu đường/tim mạch/cao HA → ngưỡng thấp hơn (dễ thành emergency/urgent hơn)

CHỈ JSON.`;

  try {
    const response = await callTextAi({
      prompt,
      maxTokens: 200,
      temperature: 0.1,
    });

    const raw = response.content;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // The deterministic detector remains authoritative when AI is unavailable.
      return {
        severity: 'unknown',
        reason: 'AI unavailable; deterministic triage continues',
        needsFamilyAlert: false,
        needsDoctor: false,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validSeverities = ['emergency', 'urgent', 'moderate', 'mild'];
    if (!validSeverities.includes(parsed.severity)) {
      return {
        severity: 'unknown',
        reason: 'invalid AI response; deterministic triage continues',
        needsFamilyAlert: false,
        needsDoctor: false,
      };
    }

    const result = {
      severity: parsed.severity,
      reason: String(parsed.reason || ''),
      needsFamilyAlert: !!parsed.needsFamilyAlert,
      needsDoctor: !!parsed.needsDoctor,
    };

    _severityCache.set(cacheKey, result);
    console.log(`[AI Safety] classification completed severity=${result.severity}`);
    return result;
  } catch (err) {
    console.error('[AI Safety] classify failed:', err.message);
    // The deterministic detector and question flow remain active when AI is
    // unavailable. Do not invent an urgent outcome from an infrastructure error.
    return {
      severity: 'unknown',
      reason: 'AI error; deterministic triage continues',
      needsFamilyAlert: false,
      needsDoctor: false,
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

function isEmergency(state) {
  return !!(state.emergencyType && EMERGENCY_CONCLUSIONS[state.emergencyType]);
}

function getEmergencyTypes() {
  return Object.keys(EMERGENCY_CONCLUSIONS);
}

module.exports = {
  formatQuestion,
  generateConclusion,
  generateMappingForSymptom,
  classifySymptomSeverity,
  isEmergency,
  getEmergencyTypes,
  EMERGENCY_CONCLUSIONS,
  isSafeConclusion,
};
