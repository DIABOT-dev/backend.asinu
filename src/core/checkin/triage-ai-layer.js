/**
 * Triage AI Layer — Natural Vietnamese text generation for triage.
 *
 * Questions: TEMPLATE-based (no GPT). Personalised via honorifics.
 * Conclusions:
 *   - Emergency → FIXED templates (no GPT, instant, zero-cost)
 *   - Non-emergency → recorded facts + bounded AI care guidance
 */

const { callTextAi } = require('../../services/ai/ai.service');
const { generateStructuredConclusion, isSafeConclusion } = require('./triage-conclusion');
const { getHonorifics } = require('../../lib/honorifics');
const { capitalizeSentences } = require('../../lib/text-format');
const { buildState } = require('./triage-engine');
const { t } = require('../../i18n');
const { LOCATION_LABELS } = require('../../services/checkin/body-location');
const { localizeOption, normalizeLang } = require('./triage-i18n');

const symptomListFormatters = {
  vi: new Intl.ListFormat('vi', { style: 'long', type: 'conjunction' }),
  en: new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }),
};

function formatSymptomList(values, lang) {
  const labels = (values || [])
    .slice(0, 3)
    .map((value) => localizeOption(value, lang).trim().toLowerCase())
    .filter(Boolean);
  return symptomListFormatters[lang].format(labels);
}

// ─── Question Templates (có dấu tiếng Việt) ─────────────────────────────────

function formatQuestion(engineResult, profile, _previousAnswers = [], lang = 'vi') {
  const resolvedLang = normalizeLang(lang);
  const h = getHonorifics({ ...profile, lang: resolvedLang });
  const { honorific, selfRef, callName, Honorific } = h;
  // CallName viết hoa chữ đầu (VD: "chú Hùng" → "Chú Hùng")
  const CallName = callName.charAt(0).toUpperCase() + callName.slice(1);
  const step = engineResult.step;
  let question;
  const facts = engineResult.state || buildState(_previousAnswers, profile);
  const reported = engineResult.symptoms || facts.allSymptoms;
  const reportedPhrase = formatSymptomList(reported, resolvedLang);
  const symptoms =
    reportedPhrase && reportedPhrase.length <= 160
      ? reportedPhrase
      : t('checkin.triage.symptom_generic', resolvedLang);
  const params = { ...h, CallName, symptoms, onset: facts.onset || '' };
  if (engineResult.clarification) {
    const key = engineResult.clarification === 'new_symptom' ? 'new_symptom_detail' : 'clarify';
    return {
      question: capitalizeSentences(t(`checkin.triage.question.${key}`, resolvedLang, params)),
      options: key === 'new_symptom_detail' ? [] : engineResult.options,
      multiSelect: key === 'new_symptom_detail' ? false : Boolean(engineResult.multiSelect),
      allowFreeText: true,
    };
  }

  // Lấy bodyLocations từ engineResult để inject vào greeting (T2 → T3 awareness).
  // Map enum key → label tiếng Việt.
  const locationLabels = LOCATION_LABELS[resolvedLang] || LOCATION_LABELS.vi;
  const locKeys = Array.isArray(engineResult.bodyLocations) ? engineResult.bodyLocations : [];
  const locLabels = locKeys
    .map((key) => locationLabels[key]?.label?.toLowerCase() || key)
    .filter(Boolean);
  const locOther = (engineResult.bodyLocationOther || '').trim();
  // Build location phrase: "đầu" / "đầu, ngực" / "đầu, ngực, bụng" + " và '<other>'"
  let locPhrase = '';
  if (locLabels.length === 1) locPhrase = locLabels[0];
  else if (locLabels.length === 2)
    locPhrase =
      resolvedLang === 'en'
        ? `${locLabels[0]} and ${locLabels[1]}`
        : `${locLabels[0]} và ${locLabels[1]}`;
  else if (locLabels.length >= 3)
    locPhrase = `${locLabels.slice(0, -1).join(', ')}${resolvedLang === 'en' ? ', and ' : ' và '}${locLabels[locLabels.length - 1]}`;
  if (locOther) locPhrase = locPhrase ? `${locPhrase}, ${locOther}` : locOther;

  switch (step) {
    case 'symptoms':
      // T3 question — aware T2 location nếu có. Nếu không có location (FE cũ) →
      // dùng template chung như cũ.
      if (locPhrase) {
        const locationQuestion = locKeys.length === 1 && locKeys[0] === 'mental' && !locOther
          ? 'symptoms_mental'
          : 'symptoms_with_location';
        question = t(`checkin.triage.question.${locationQuestion}`, resolvedLang, {
          CallName,
          selfRef,
          honorific,
          Honorific,
          locations: locPhrase,
        });
      } else {
        question = t('checkin.triage.question.symptoms_general', resolvedLang, {
          CallName,
          selfRef,
          honorific,
          Honorific,
        });
      }
      break;

    case 'associated': {
      const sym = engineResult.primarySymptom
        ? localizeOption(engineResult.primarySymptom, resolvedLang)
        : t('checkin.triage.symptom_unknown', resolvedLang);
      question = t('checkin.triage.question.associated', resolvedLang, {
        symptom: sym,
        honorific,
      });
      break;
    }

    case 'onset':
      question = t('checkin.triage.question.onset', resolvedLang, params);
      break;

    case 'progression':
      question = t('checkin.triage.question.progression', resolvedLang, params);
      break;

    case 'red_flags':
      question = t('checkin.triage.question.red_flags', resolvedLang, params);
      break;

    case 'cause': {
      const sym = engineResult.primarySymptom || '';
      if (sym.includes('đau bụng') || sym.includes('bụng')) {
        question = t('checkin.triage.question.cause_abdomen', resolvedLang, { Honorific });
      } else if (sym.includes('đau đầu') || sym.includes('đầu')) {
        question = t('checkin.triage.question.cause_head', resolvedLang, { Honorific });
      } else if (sym.includes('đau vai') || sym.includes('đau lưng') || sym.includes('khớp')) {
        question = t('checkin.triage.question.cause_musculoskeletal', resolvedLang, { Honorific });
      } else if (sym.includes('chóng mặt')) {
        question = t('checkin.triage.question.cause_dizziness', resolvedLang, { Honorific });
      } else {
        question = t('checkin.triage.question.cause_default', resolvedLang, { Honorific });
      }
      break;
    }

    case 'action':
      question = t('checkin.triage.question.action', resolvedLang, { Honorific });
      break;

    case 'followup_status': {
      const previousPhrase =
        formatSymptomList(
          engineResult.previousSymptoms ||
          (facts.allSymptoms.length
            ? facts.allSymptoms
            : engineResult.previousSessionSummary
              ? [engineResult.previousSessionSummary]
              : []),
          resolvedLang
        ) ||
        t('checkin.triage.previous_unknown', resolvedLang);
      const prev =
        previousPhrase.length <= 160
          ? previousPhrase
          : t('checkin.triage.previous_unknown', resolvedLang);
      question = t('checkin.triage.question.followup_status', resolvedLang, {
        CallName,
        honorific,
        previous: prev,
      });
      break;
    }

    case 'followup_detail':
      question = t('checkin.triage.question.followup_detail', resolvedLang, params);
      break;

    default:
      question = t('checkin.triage.question.default', resolvedLang, { Honorific, selfRef });
      break;
  }

  return {
    question: capitalizeSentences(question),
    options: engineResult.options || undefined,
    multiSelect: engineResult.multiSelect || false,
    allowFreeText: engineResult.allowFreeText || false,
  };
}

// ─── Emergency Conclusion Templates (có dấu tiếng Việt) ─────────────────────

const EMERGENCY_CONCLUSIONS = {
  stroke: {
    summary: 'checkin.triage.emergency.stroke.summary',
    recommendation: 'checkin.triage.emergency.stroke.recommendation',
    closeMessage: 'checkin.triage.emergency.close_call',
  },
  mi: {
    summary: 'checkin.triage.emergency.mi.summary',
    recommendation: 'checkin.triage.emergency.mi.recommendation',
    closeMessage: 'checkin.triage.emergency.close_call',
  },
  meningitis: {
    summary: 'checkin.triage.emergency.meningitis.summary',
    recommendation: 'checkin.triage.emergency.go_hospital',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  pe: {
    summary: 'checkin.triage.emergency.pe.summary',
    recommendation: 'checkin.triage.emergency.pe.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  cauda_equina: {
    summary: 'checkin.triage.emergency.cauda_equina.summary',
    recommendation: 'checkin.triage.emergency.cauda_equina.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  hemorrhage: {
    summary: 'checkin.triage.emergency.hemorrhage.summary',
    recommendation: 'checkin.triage.emergency.hemorrhage.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  dengue: {
    summary: 'checkin.triage.emergency.dengue.summary',
    recommendation: 'checkin.triage.emergency.dengue.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  dka: {
    summary: 'checkin.triage.emergency.dka.summary',
    recommendation: 'checkin.triage.emergency.dka.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  seizure: {
    summary: 'checkin.triage.emergency.seizure.summary',
    recommendation: 'checkin.triage.emergency.seizure.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  anaphylaxis: {
    summary: 'checkin.triage.emergency.anaphylaxis.summary',
    recommendation: 'checkin.triage.emergency.call_115',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
  trauma: {
    summary: 'checkin.triage.emergency.trauma.summary',
    recommendation: 'checkin.triage.emergency.trauma.recommendation',
    closeMessage: 'checkin.triage.emergency.close_family',
  },
};

// ─── Conclusion Generator ────────────────────────────────────────────────────

async function generateConclusion(state, profile, lang = 'vi', _pool = null, healthContext = {}) {
  const resolvedLang = normalizeLang(lang);
  const h = getHonorifics({ ...profile, lang: resolvedLang });

  if (state.emergencyType && EMERGENCY_CONCLUSIONS[state.emergencyType]) {
    const tpl = EMERGENCY_CONCLUSIONS[state.emergencyType];
    return {
      summary: t(tpl.summary, resolvedLang, h),
      recommendation: t(tpl.recommendation, resolvedLang, h),
      closeMessage: t(tpl.closeMessage, resolvedLang, h),
      isEmergency: true,
    };
  }

  return generateStructuredConclusion(state, profile, resolvedLang, healthContext);
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
      timeoutMs: 3000,
      maxRetries: 0,
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

  const prompt = `Bạn là bộ phân loại sàng lọc sức khỏe. Phân loại mức độ khẩn cấp của triệu chứng sau, không chẩn đoán bệnh.

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
      timeoutMs: 3000,
      maxRetries: 0,
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
