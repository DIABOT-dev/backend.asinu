/**
 * Triage AI Layer — Natural Vietnamese text generation for triage.
 *
 * Questions: TEMPLATE-based (no GPT). Personalised via honorifics.
 * Conclusions:
 *   - Emergency → FIXED templates (no GPT, instant, zero-cost)
 *   - Non-emergency → GPT with tight prompt for summary + recommendation
 */

const OpenAI = require('openai');
const { getHonorifics } = require('../../lib/honorifics');
const { filterTriageResult } = require('../../services/ai/ai-safety.service');
const { logAiInteraction } = require('../../services/ai/ai-logger.service');

// ─── OpenAI client (singleton) ───────────────────────────────────────────────

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const CONCLUSION_MODEL = process.env.TRIAGE_CONCLUSION_MODEL || 'gpt-4o';

// ─── Question Templates (có dấu tiếng Việt) ─────────────────────────────────

function formatQuestion(engineResult, profile, previousAnswers = []) {
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
    head: 'đầu', chest: 'ngực', abdomen: 'bụng', limbs: 'tay chân',
    skin: 'da', whole_body: 'toàn thân', mental: 'tinh thần',
  };
  const locKeys = Array.isArray(engineResult.bodyLocations) ? engineResult.bodyLocations : [];
  const locLabels = locKeys.map(k => LOCATION_LABEL_VI[k] || k).filter(Boolean);
  const locOther = (engineResult.bodyLocationOther || '').trim();
  // Build location phrase: "đầu" / "đầu, ngực" / "đầu, ngực, bụng" + " và '<other>'"
  let locPhrase = '';
  if (locLabels.length === 1) locPhrase = locLabels[0];
  else if (locLabels.length === 2) locPhrase = `${locLabels[0]} và ${locLabels[1]}`;
  else if (locLabels.length >= 3) locPhrase = `${locLabels.slice(0, -1).join(', ')} và ${locLabels[locLabels.length - 1]}`;
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
      question = `${CallName} ơi, hôm qua ${honorific} nói bị ${prev}. Hôm nay ${honorific} thấy thế nào?`;
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
    summary: (h) => `${h.Honorific} có triệu chứng nghi đột quỵ.`,
    recommendation: (h) =>
      `🚨 GỌI CẤP CỨU 115 NGAY. ${h.Honorific} cần đến phòng cấp cứu trong vòng vài phút. Trong khi chờ: nằm nghiêng, nới lỏng quần áo, không cho ăn uống.`,
    closeMessage: (h) =>
      `${h.selfRef} đã thông báo cho người thân. Gọi 115 ngay ${h.honorific} nhé.`,
  },
  mi: {
    summary: (h) => `${h.Honorific} có triệu chứng nghi nhồi máu cơ tim.`,
    recommendation: (h) =>
      `🚨 GỌI CẤP CỨU 115 NGAY. Trong khi chờ: ngồi nghỉ, nới lỏng quần áo, nhai 1 viên aspirin nếu có và không dị ứng.`,
    closeMessage: (h) =>
      `${h.selfRef} đã thông báo cho người thân. Gọi 115 ngay.`,
  },
  meningitis: {
    summary: () => `Sốt cao kèm cứng cổ, nghi viêm màng não.`,
    recommendation: () =>
      `🚨 ĐẾN BỆNH VIỆN NGAY. Viêm màng não cần điều trị khẩn cấp.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  pe: {
    summary: () => `Khó thở đột ngột kèm đau ngực, nghi tắc mạch phổi.`,
    recommendation: () =>
      `🚨 GỌI CẤP CỨU 115. Nằm nghỉ, không cử động nhiều.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  cauda_equina: {
    summary: () =>
      `Đau lưng kèm rối loạn tiểu tiện, nghi hội chứng chùm đuôi ngựa.`,
    recommendation: () =>
      `🚨 ĐẾN BỆNH VIỆN NGAY. Cần phẫu thuật khẩn cấp trong vòng 24-48h.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  hemorrhage: {
    summary: () => `Nôn ra máu hoặc phân đen, nghi xuất huyết tiêu hóa.`,
    recommendation: () =>
      `🚨 ĐẾN BỆNH VIỆN NGAY. Không ăn uống. Nằm nghỉ chờ xe cấp cứu.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  dengue: {
    summary: () => `Sốt kèm dấu hiệu xuất huyết, nghi sốt xuất huyết nặng.`,
    recommendation: () =>
      `🚨 ĐẾN BỆNH VIỆN NGAY. Uống nhiều nước, KHÔNG dùng aspirin hoặc ibuprofen. Chỉ dùng paracetamol nếu cần hạ sốt.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  dka: {
    summary: () =>
      `Tiểu đường kèm khát nước, buồn nôn, nghi nhiễm toan ceton.`,
    recommendation: () =>
      `🚨 ĐẾN BỆNH VIỆN NGAY. Uống nước, kiểm tra đường huyết nếu có máy.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  seizure: {
    summary: (h) => `${h.Honorific} bị co giật.`,
    recommendation: () =>
      `🚨 GỌI CẤP CỨU 115. Đặt nằm nghiêng, không đút gì vào miệng, dọn vật sắc nhọn xung quanh.`,
    closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
  },
  anaphylaxis: {
    summary: () => `Khó thở kèm sưng, nghi phản vệ.`,
    recommendation: () =>
      `🚨 GỌI CẤP CỨU 115 NGAY. Nếu có EpiPen, dùng ngay. Nằm ngửa, kê chân cao.`,
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

async function _generateConclusionWithGPT(state, profile, h, lang, pool) {
  const prompt = _buildConclusionPrompt(state, profile, h);
  const startMs = Date.now();
  let tokensUsed = 0;

  try {
    const response = await getClient().chat.completions.create({
      model: CONCLUSION_MODEL,
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý y tế Asinu. Chỉ trả về JSON. Không chẩn đoán. Không kê đơn. Luôn khuyên gặp bác sĩ khi cần. Trả lời có dấu tiếng Việt đầy đủ.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    tokensUsed = response.usage?.total_tokens || 0;
    const parsed = _parseJSON(raw);
    if (!parsed) throw new Error('GPT returned invalid JSON');

    return {
      summary: parsed.summary || '',
      recommendation: parsed.recommendation || '',
      closeMessage: parsed.closeMessage || `${h.selfRef} sẽ hỏi lại ${h.honorific} sau nhé.`,
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

function _buildFallbackConclusion(state, h) {
  const symptom = state.primarySymptom || 'triệu chứng';

  if (state.needsDoctor) {
    return {
      summary: `${h.Honorific} bị ${symptom} cần được bác sĩ đánh giá.`,
      recommendation: `${h.Honorific} nên đi khám bác sĩ hôm nay để được tư vấn cụ thể. Trong khi chờ, nghỉ ngơi và uống nhiều nước.`,
      closeMessage: `${h.selfRef} sẽ hỏi lại ${h.honorific} sau 3 tiếng nhé. Nếu nặng hơn, đi khám ngay ${h.honorific} nhé.`,
      isEmergency: false,
    };
  } else if (state.severity === 'medium') {
    return {
      summary: `${h.Honorific} bị ${symptom} mức độ vừa.`,
      recommendation: `Nghỉ ngơi, uống nhiều nước. Nếu không đỡ sau 24h, nên gặp bác sĩ.`,
      closeMessage: `${h.selfRef} sẽ hỏi lại ${h.honorific} sau 4 tiếng nhé 💙`,
      isEmergency: false,
    };
  } else {
    return {
      summary: `${h.Honorific} bị ${symptom} nhẹ.`,
      recommendation: `Nghỉ ngơi, uống đủ nước. Theo dõi trong 24h.`,
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
      try { return JSON.parse(match[0]); } catch { return null; }
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
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 1024,
      temperature: 0.2,
    });

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.associatedSymptoms) || !Array.isArray(parsed.redFlags) || !Array.isArray(parsed.causes)) return null;

    const result = {
      associatedSymptoms: parsed.associatedSymptoms,
      redFlags: parsed.redFlags,
      causes: parsed.causes,
    };

    _mappingCache.set(key, result);
    console.log(`[AI Mapping] Generated for "${symptom}": ${result.associatedSymptoms.length} associated, ${result.redFlags.length} redFlags, ${result.causes.length} causes`);
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
 * @returns {Promise<{severity: 'emergency'|'urgent'|'moderate'|'mild', reason: string, needsFamilyAlert: boolean, needsDoctor: boolean}>}
 */
async function classifySymptomSeverity(symptom, profile = {}) {
  if (!symptom) return { severity: 'mild', needsFamilyAlert: false, needsDoctor: false };

  const conditions = (profile.medical_conditions || []).join(', ') || 'không';
  const age = profile.age || (profile.birth_year ? new Date().getFullYear() - profile.birth_year : null);
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
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 200,
      temperature: 0.1,
    });

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fail-safe: nếu AI fail → treat as urgent để gọi bác sĩ (không dám
      // assume mild khi không chắc)
      return { severity: 'urgent', reason: 'AI unavailable', needsFamilyAlert: false, needsDoctor: true };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validSeverities = ['emergency', 'urgent', 'moderate', 'mild'];
    if (!validSeverities.includes(parsed.severity)) {
      return { severity: 'urgent', reason: 'invalid response', needsFamilyAlert: false, needsDoctor: true };
    }

    const result = {
      severity: parsed.severity,
      reason: String(parsed.reason || ''),
      needsFamilyAlert: !!parsed.needsFamilyAlert,
      needsDoctor: !!parsed.needsDoctor,
    };

    _severityCache.set(cacheKey, result);
    console.log(`[AI Safety] "${symptom}" → ${result.severity} (${result.reason})`);
    return result;
  } catch (err) {
    console.error(`[AI Safety] classify failed for "${symptom}":`, err.message);
    // Fail-safe: AI down → urgent (bắt user đi khám) thay vì silent miss
    return { severity: 'urgent', reason: 'AI error fail-safe', needsFamilyAlert: false, needsDoctor: true };
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
};
