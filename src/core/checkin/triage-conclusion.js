'use strict';

const { callTextAi } = require('../../services/ai/ai.service');
const { getHonorifics, getUserAge } = require('../../lib/honorifics');
const { t } = require('../../i18n');
const logger = require('../../lib/logger');
const { conditionsOf } = require('./triage-facts');
const { localizeOption } = require('./triage-i18n');

const BLOCKS = ['loi_nhan', 'lien_quan', 'nen_lam', 'di_kham_khi'];
const { buildConclusionPrompt, buildConclusionSystem } = require('./triage-conclusion-prompt');
const {
  normalizeConclusionCandidate,
  CONCLUSION_PROMPT_VERSION,
  CONCLUSION_RENDER_VERSION,
} = require('./triage-conclusion-normalize');
const {
  requiredMeasurementTypes,
  validatePresentation,
  compactExplanation,
  normalizeMeasurementSentences,
  normalizeConditionalWarnings,
} = require('./triage-conclusion-contract');
const {
  plain: normalize,
  statements,
  containsVisit,
  visitFault,
  emergencyFault,
  priorSymptomResolutionFault,
  measurementFault,
  measurementTimeMatches,
} = require('./triage-conclusion-guards');
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const accentSensitiveNames = new Set(['chàm', 'cúm']);
const phraseText = (text, phrase) =>
  accentSensitiveNames.has(phrase)
    ? String(text || '')
        .normalize('NFKC')
        .replace(/\p{Cf}/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    : normalize(text);
const phrasePattern = (phrase) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapePattern(phraseText(phrase, phrase))}(?![\\p{L}\\p{N}])`,
    'giu'
  );
const hasPhrase = (text, phrase) => phrasePattern(phrase).test(phraseText(text, phrase));
const short = (value, max = 240) =>
  String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const list = (value, max = 10) =>
  (Array.isArray(value) ? value : [])
    .map((v) => short(v))
    .filter(Boolean)
    .slice(0, max);
const DISEASES = [
  ['tiền tiểu đường', 'tiền đái tháo đường', 'prediabetes', 'pre-diabetes'],
  ['tiểu đường', 'đái tháo đường', 'diabetes'],
  ['cao huyết áp', 'tăng huyết áp', 'huyết áp cao', 'hypertension', 'high blood pressure'],
  ['mỡ máu cao', 'rối loạn lipid máu', 'high cholesterol', 'dyslipidemia'],
  ['gout', 'gút'],
  ['trầm cảm', 'depression'],
  ['rối loạn lo âu', 'anxiety disorder'],
  ['thiếu máu', 'anemia'],
  ['suy giáp', 'hypothyroidism'],
  ['cường giáp', 'hyperthyroidism'],
  ['suy tim', 'heart failure'],
  ['suy thận', 'kidney failure'],
  ['ung thư', 'cancer'],
  ['viêm dạ dày', 'gastritis'],
  ['viêm phổi', 'pneumonia'],
  ['viêm khớp', 'arthritis'],
  ['viêm đại tràng', 'colitis'],
  ['viêm ruột thừa', 'appendicitis'],
  ['đột quỵ', 'tai biến', 'stroke'],
  ['nhồi máu', 'heart attack'],
  ['hội chứng chuyển hóa', 'metabolic syndrome'],
  ['ngưng thở khi ngủ', 'sleep apnea'],
  ['thoát vị đĩa đệm', 'herniated disc'],
  ['đau thần kinh tọa', 'sciatica'],
  ['sốt xuất huyết', 'dengue'],
  ['viêm gan', 'hepatitis'],
  ['bệnh mạch vành', 'coronary disease'],
  // Common everyday labels are still disease names. A mild presentation does
  // not authorize naming one that the person has never declared.
  ['cảm lạnh', 'common cold'],
  ['cúm', 'influenza', 'flu'],
  ['covid', 'covid-19', 'covid 19'],
  ['hen suyễn', 'hen phế quản', 'asthma'],
  ['bệnh phổi tắc nghẽn mạn tính', 'copd'],
  ['viêm phế quản', 'bronchitis'],
  ['viêm xoang', 'sinusitis'],
  ['viêm họng', 'pharyngitis'],
  ['viêm amidan', 'tonsillitis'],
  ['viêm đường hô hấp', 'respiratory infection'],
  ['trào ngược dạ dày', 'trào ngược axit', 'acid reflux', 'gerd'],
  ['viêm dạ dày ruột', 'gastroenteritis'],
  ['hội chứng ruột kích thích', 'irritable bowel syndrome', 'ibs'],
  ['loét dạ dày', 'peptic ulcer', 'stomach ulcer'],
  ['ngộ độc thực phẩm', 'food poisoning'],
  ['viêm đường tiết niệu', 'urinary tract infection', 'uti'],
  ['sỏi thận', 'kidney stones'],
  ['chàm', 'bệnh chàm', 'chàm da', 'eczema'],
  ['vảy nến', 'psoriasis'],
  ['viêm da', 'dermatitis'],
  ['zona', 'shingles'],
  ['đau nửa đầu', 'migraine'],
  ['loãng xương', 'osteoporosis'],
  ['thoái hóa khớp', 'osteoarthritis'],
  ['rối loạn nhịp tim', 'arrhythmia'],
];
// Match longer disease names first so prediabetes never authorizes diabetes.
const diseasePatterns = DISEASES.flatMap((group) =>
  group.map((name) => ({ group, name, pattern: phrasePattern(name) }))
);
function diseaseGroups(text) {
  const spans = diseasePatterns.flatMap(({ group, name, pattern }) =>
    [...phraseText(text, name).matchAll(pattern)].map((match) => ({
      group,
      start: match.index,
      end: match.index + match[0].length,
    }))
  );
  return [
    ...new Set(
      spans
        .filter(
          (span) =>
            !spans.some(
              (other) =>
                other.group !== span.group &&
                other.start <= span.start &&
                other.end >= span.end &&
                other.end - other.start > span.end - span.start
            )
        )
        .map((span) => span.group)
    ),
  ];
}
const HARD_PATTERNS = [
  ['diagnosis', /chẩn đoán|\b(?:diagnosis|diagnosed|likely has|probably has)\b/iu],
  [
    'speculative_diagnosis',
    /(?:có thể là|khả năng là|nghi ngờ|nghi (?:viêm|mắc|bệnh))(?:\s|[.,:;!?]|$)/iu,
  ],
  [
    'drug_name_or_class',
    /aspirin|ibuprofen|paracetamol|acetaminophen|epipen|insulin|metformin|amoxicillin|predniso(?:ne|lone)|amlodipine|losartan|atorvastatin|rosuvastatin|simvastatin|clopidogrel|warfarin|rivaroxaban|hydrochlorothiazide|bisoprolol|gliclazide|glibenclamide|allopurinol|colchicine|corticoid|statin|kháng sinh|thuốc (?:an thần|ngủ|hạ mỡ máu|giảm đau|chống trầm cảm)|\b(?:antibiotics?|painkillers?|sedatives?)\b/iu,
  ],
  [
    'treatment_change',
    /(?:tăng|giảm|ngưng|ngừng|đổi|thay(?: đổi)?|bỏ|dừng)\s+(?:(?:uống|dùng|sử dụng|tiêm|bôi)\s+)?(?:liều\s+|loại\s+)?thuốc|(?:tăng|giảm|đổi)\s+liều|uống thêm\s+(?:\S+\s+){0,3}thuốc|\b(?:start|stop|increase|decrease|change|switch)\s+(?:(?:the|your)\s+)?(?:dose|medicine|medication|drug)\b/iu,
  ],
  ['drug_dose', /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|viên|liều|tablets?|pills?)(?![\p{L}/])/iu],
  ['markup', /<\/?[a-z][^>]*>/iu],
];

function hardConclusionFault(text) {
  const original = text.normalize('NFKC').replace(/\s+/g, ' ');
  // A general sign that the body needs care/rest is not a proposed disease.
  // Remove only that neutral prefix from the speculation check. Every drug,
  // dose, disease, measurement and treatment check still sees the full text.
  const speculationText = original.replace(
    /(?:có thể là|khả năng là)\s+(?:một\s+)?(?:dấu hiệu|tín hiệu)\s+(?:cho thấy\s+)?(?:cơ thể|mình)\s+(?:đang\s+)?(?:cần|muốn)\b/giu,
    'neutral possibility'
  );
  return HARD_PATTERNS.find(([reason, pattern]) =>
    pattern.test(reason === 'speculative_diagnosis' ? speculationText : original)
  );
}

function measurements(context, now) {
  const result = [];
  const add = (row, type, value, unit) => {
    const at = new Date(row.occurred_at);
    const age = now.getTime() - at.getTime();
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) return;
    result.push({
      loai: type,
      gia_tri: value,
      don_vi: unit,
      measured_at: at.toISOString(),
      luc: new Intl.DateTimeFormat('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(at),
      within24h: age <= 86400000,
    });
  };
  for (const row of (context.recentBP || []).slice(0, 5)) {
    if ([row.systolic, row.diastolic].every((v) => Number.isFinite(Number(v)) && Number(v) > 0))
      add(row, 'huyet_ap', `${Number(row.systolic)}/${Number(row.diastolic)}`, 'mmHg');
  }
  for (const row of (context.recentGlucose || []).slice(0, 5)) {
    if (
      Number.isFinite(Number(row.value)) &&
      Number(row.value) > 0 &&
      /^(mg\/dL|mmol\/L)$/i.test(row.unit || '')
    )
      add(row, 'duong_huyet', String(Number(row.value)), row.unit);
  }
  return result;
}

function buildConclusionFacts(state, profile, context = {}, lang = 'vi', now = new Date()) {
  const h = getHonorifics({ ...profile, lang });
  const records = measurements(context, now);
  return {
    language: lang,
    xung_ho: { goi: h.honorific, tu_xung: h.selfRef },
    evaluated_at: now.toISOString(),
    tuoi: getUserAge(profile),
    gioi: short(profile.gender, 20),
    benh_nen_da_khai: list(
      state.detailedAssessmentVersion === 2 && state.conditions?.length
        ? state.conditions
        : conditionsOf(profile.medical_conditions).length
          ? conditionsOf(profile.medical_conditions)
          : conditionsOf(context.medical_conditions)
    ),
    trieu_chung: list(
      state.newSymptoms && state.currentSymptoms?.length ? state.currentSymptoms : state.allSymptoms
    ),
    ...(state.regionDetails?.length
      ? {
          chi_tiet_tung_vung: state.regionDetails,
          khai_bao_chi_tiet_da_hoan_tat: Boolean(state.detailedAssessmentComplete),
          tinh_trang_khai_bao_benh_nen: state.historyAssessment,
        }
      : {}),
    ...(Array.isArray(state.bodyLocations) && state.bodyLocations.length
      ? { vung_kho_chiu: state.bodyLocations }
      : {}),
    ...(short(state.bodyLocationOther, 2000)
      ? { vi_tri_kho_chiu: short(state.bodyLocationOther, 2000) }
      : {}),
    ...(state.newSymptoms
      ? {
          trieu_chung_truoc_do: list(state.baselineSymptoms).filter(
            (symptom) => !state.currentSymptoms?.includes(symptom)
          ),
        }
      : {}),
    bat_dau: short(state.onset) || null,
    dien_bien:
      { same: 'vẫn như cũ', better: 'đang đỡ dần', worse: 'nặng hơn' }[state.progression] ||
      short(state.progression) ||
      null,
    dau_hieu_nguy_hiem_da_hoi: Boolean(state.completedSteps?.has('red_flags')),
    dau_hieu_nguy_hiem_gap: list(state.redFlagsFound),
    assessment_incomplete: Boolean(state.assessmentIncomplete),
    ...(state.adaptiveAnswers?.length ? { khai_bao_bo_sung: state.adaptiveAnswers } : {}),
    care_level: !state.needsDoctor
      ? 'tu_theo_doi'
      : state.severity === 'high'
        ? 'kham_trong_ngay'
        : 'dat_lich_kham',
    chi_so_24h: records.filter((r) => r.within24h),
    chi_so_7_ngay: records.filter((r) => !r.within24h),
    uong_thuoc_hom_nay:
      context.tookMedicationToday === true ? 'đã có bản ghi uống thuốc' : 'chưa ghi',
    tuan_thu_thuoc_7_ngay: short(context.medicationAdherenceContext, 700) || null,
    check_in_truoc: (context.previousCheckins || []).slice(0, 3).map((c) => ({
      ngay: short(c.session_date, 30),
      trang_thai: short(c.initial_status, 30),
      tom_tat: short(c.triage_summary, 350),
    })),
    trieu_chung_lap_lai: short(context.symptomFrequencyContext, 1000) || null,
    viec_da_ke: list(state.actionsFound),
  };
}

function validateBlock(block, value, facts, { skipCareLevel = false } = {}) {
  const isArray = block === 'nen_lam' || block === 'di_kham_khi';
  if (
    isArray
      ? !Array.isArray(value) ||
        value.length < 2 ||
        value.length > (block === 'nen_lam' ? 6 : 4) ||
        value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 240)
      : typeof value !== 'string' ||
        !value.trim() ||
        (block !== 'narrative' && value.length > (block === 'loi_nhan' ? 450 : 1200))
  )
    return 'invalid_block';
  const text = isArray ? value.join('. ') : value;
  if ([...text].some((char) => char.charCodeAt(0) <= 8) || /\p{Cf}/u.test(text))
    return 'invalid_text';
  const plain = normalize(text);
  if ((['none_reported', 'profile', 'answered'].includes(facts.tinh_trang_khai_bao_benh_nen) ||
    facts.benh_nen_da_khai?.length) &&
    /(?:chua|khong).{0,12}(?:co|duoc cung cap|nhan duoc).{0,12}(?:thong tin|biet).{0,40}(?:benh nen|tien su)|(?:missing|not (?:provided|reported)|no information).{0,45}(?:medical history|underlying conditions?|medical conditions?)/u.test(plain))
    return 'recorded_history_claimed_missing';
  const hard = hardConclusionFault(text);
  if (hard) return hard[0];
  const knownGroups = new Set(facts.benh_nen_da_khai.flatMap(diseaseGroups));
  if (diseaseGroups(text).some((group) => !knownGroups.has(group))) return 'undeclared_disease';
  const historyFault = priorSymptomResolutionFault(text);
  if (historyFault) return historyFault;
  const medicationMention =
    /\bthuoc\b|tuan thu dieu tri|\b(?:medication|medicine|treatment adherence)\b/.test(plain);
  const medicationStatements = statements(value).filter((segment) => {
    if (facts.uong_thuoc_hom_nay !== 'chưa ghi') return true;
    const normalized = normalize(segment);
    return ![
      /^(?:chau|em|minh|toi|asinu) (?:cung )?(?:chua|khong) co thong tin ve (?:viec )?(?:anh|chi|bac|chu|co|ban|ong|ba) (?:uong|dung) thuoc(?: hom nay)?[.!]?$/,
      /^(?:chau|em|minh|toi|asinu) (?:cung )?(?:chua|khong) co thong tin ve (?:viec )?(?:uong|dung) thuoc(?: hom nay)? cua (?:anh|chi|bac|chu|co|ban|ong|ba)[.!]?$/,
    ].some((pattern) => pattern.test(normalized));
  });
  for (const segment of medicationStatements) {
    if (
      /(?:uống|dùng|sử dụng|tiêm|bôi)\s+thuốc|\b(?:take|use)\s+(?:(?:your|the)\s+)?(?:medicine|medication)\b/iu.test(
        segment
      ) &&
      !/(?:đúng giờ|đúng (?:theo|như)|theo đơn|đã kê|đã được kê|as prescribed|existing prescription)/iu.test(
        segment
      )
    )
      return 'medication_instruction';
  }
  if (
    /(?:uống|dùng|sử dụng)\s+thuốc|\b(?:take|use)\s+(?:(?:your|the)\s+)?(?:medicine|medication)\b/iu.test(
      medicationStatements.join(' ')
    ) &&
    facts.uong_thuoc_hom_nay === 'chưa ghi' &&
    !facts.tuan_thu_thuoc_7_ngay
  )
    return 'unconfirmed_prescription';
  if (block === 'nen_lam' && medicationMention) return 'nonmedication_actions_only';
  if (
    /(?:đã (?:báo|thông báo|liên hệ)).{0,35}(?:người thân|gia đình)|(?:người thân|gia đình).{0,20}đã (?:được )?(?:báo|thông báo|liên hệ)|family (?:has been|was) notified/iu.test(
      text
    )
  )
    return 'invented_family_notification';
  if (
    /hỏi lại|nhắc lại sau|sẽ (?:nhắn|gọi|liên hệ|kiểm tra|nhắc).{0,25}lại|check (?:on you|back|in) (?:again|in)|follow.up in|I(?:[’']ll| will).{0,20}(?:message|call|contact).{0,20}(?:again|in \d)/iu.test(
      text
    )
  )
    return 'ai_followup';
  if (
    (!facts.dau_hieu_nguy_hiem_da_hoi || facts.assessment_incomplete) &&
    /không có (?:dấu hiệu|triệu chứng).{0,20}(?:nguy hiểm|cảnh báo)|no (?:warning signs|red flags)/iu.test(
      text
    )
  )
    return 'unconfirmed_absence_of_red_flags';
  if (
    facts.uong_thuoc_hom_nay === 'chưa ghi' &&
    /(?:anh|chị|bác|chú|cô|bạn|ông|bà) (?:chưa|đã) (?:uống|dùng) thuốc|you (?:have|haven.t) taken/iu.test(
      text
    )
  )
    return 'invented_medication_history';
  if (
    !facts.viec_da_ke.length &&
    /chưa (?:làm gì|xử lý|có biện pháp)|chưa dùng|haven.t (?:done|taken)|no action/iu.test(text)
  )
    return 'invented_action_history';
  if (!['di_kham_khi', 'narrative'].includes(block) && containsVisit(text))
    return 'referral_outside_block';
  if ((block === 'di_kham_khi' || block === 'narrative') && !skipCareLevel) {
    const reason = visitFault(value, facts.care_level);
    if (reason) return reason;
  }
  if (/cấp cứu/iu.test(text)) return 'nonurgent_emergency_word';
  const emergencyReason = emergencyFault(value);
  if (emergencyReason) return emergencyReason;
  const measurementReason = measurementFault(value, facts);
  if (measurementReason) return measurementReason;
  const assertions = plain.replace(/(?:giu|duy tri|kiem soat) mo mau on dinh/g, 'preventive_goal');
  if (
    /(?:mo mau|cholesterol|lipid) (?:cua (?:anh|chi|bac|chu|co|ban|ong|ba) )?(?:van |dang |hien |hien tai |con |gan day |lai )+(?:cao|thap|on dinh|binh thuong)|(?:mo mau|cholesterol|lipid) cua (?:anh|chi|bac|chu|co|ban|ong|ba) (?:cao|thap|on dinh|binh thuong)/.test(
      assertions
    )
  )
    return 'unmeasured_lipid_claim';
  if (
    /(?:mo mau|cholesterol|lipid)(?: cua \w+)? (?:van |dang |hien |rat |kha )*(?:on dinh|binh thuong|thap)|(?:chi so|muc|luong) (?:mo mau|cholesterol|lipid).{0,15}(?:cao|thap|on dinh)|cholesterol (?:is|remains|has been) (?:stable|high|low|normal)/.test(
      assertions
    )
  )
    return 'unmeasured_lipid_claim';
  if (
    block === 'loi_nhan' &&
    facts.assessment_incomplete &&
    !/chưa (?:hỏi|đủ|rõ)|thông tin.{0,10}(?:thiếu|chưa)|not enough|incomplete|more information|haven.t.*(?:asked|information)/iu.test(
      text
    )
  )
    return 'incomplete_assessment_not_acknowledged';
  return null;
}

const sentenceSegmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const repairableContentFaults = new Set([
  'recorded_history_claimed_missing',
  'treatment_change',
  'medication_instruction',
  'unconfirmed_prescription',
  'unconfirmed_prior_symptom_resolution',
  'insufficient_comparison_data',
  'ambiguous_measurement_reference',
  'unmeasured_vital_claim',
  'measurement_time_not_exact',
  'ungrounded_measurement',
  'measurement_type_mismatch',
  'measurement_unit_missing',
]);

function repairConclusionContent(block, value, facts) {
  if (block === 'nen_lam' && Array.isArray(value)) {
    return value.filter((item) => {
      if (typeof item !== 'string') return true;
      const reason = validateBlock(block, [item, item], facts);
      if (
        ![
          'nonmedication_actions_only',
          'unconfirmed_prescription',
          'medication_instruction',
        ].includes(reason)
      )
        return true;
      logger.warn('conclusion_rejected', { block, reason, scope: 'item' });
      return false;
    });
  }
  if (block === 'di_kham_khi' && Array.isArray(value)) {
    return value.filter((item) => {
      if (typeof item !== 'string') return true;
      // Drop a vague emergency trigger rather than rewriting it into a new
      // clinical recommendation. Whole-block validation still checks urgency.
      const reason = emergencyFault([item]);
      if (reason !== 'nonspecific_emergency_condition') return true;
      logger.warn('conclusion_rejected', { block, reason, scope: 'item' });
      return false;
    });
  }
  if (typeof value !== 'string' || !repairableContentFaults.has(validateBlock(block, value, facts)))
    return value;
  const kept = [];
  for (const { segment } of sentenceSegmenter.segment(value)) {
    const text = segment.trim();
    const reason = validateBlock(block, text, facts);
    if (!reason) {
      kept.push(text);
      continue;
    }
    if (!repairableContentFaults.has(reason)) return value;
    logger.warn('conclusion_rejected', { block, reason, scope: 'sentence' });
    if (reason === 'unconfirmed_prior_symptom_resolution') {
      // Preserve an accurate acknowledgement before "but ... resolved".
      const prefix = text.split(/,?\s+(?:nhưng|but)\s+/iu)[0];
      if (prefix !== text && !validateBlock(block, prefix + '.', facts)) kept.push(prefix + '.');
    }
  }
  return kept.join(' ');
}

function symptomGroup(symptoms) {
  const text = normalize(symptoms.join(' '));
  if (/nguc|tim dap|chest|palpitation/.test(text)) return 'chest';
  if (/kho tho|\b(?:ho|sot|hong|breath|cough|fever|throat)\b/.test(text)) return 'respiratory';
  if (/bung|non|tieu chay|stomach|abdom|nause|vomit|diarr/.test(text)) return 'digestive';
  if (/dau dau|chong mat|hoa mat|headache|dizz/.test(text)) return 'head';
  if (/vai|lung|khop|co |dau nhuc|back|neck|joint|muscle/.test(text)) return 'musculoskeletal';
  if (/met|ngu|buon|an kem|an khong|tired|fatigue|sleep|sad|appetite/.test(text)) return 'fatigue';
  return 'other';
}

function localizeConclusionText(value, lang) {
  // Display aliases stay local to conclusions: never change the question
  // engine's canonical answers just to translate a fallback sentence.
  const aliases = {
    'khó ngủ': 'notification.topic.symptom.insomnia',
    'mất ngủ': 'notification.topic.symptom.insomnia',
    'ngủ ko ngon giấc': 'notification.topic.symptom.insomnia',
    'ngủ không ngon giấc': 'notification.topic.symptom.insomnia',
    'nặng hơn': 'checkin.triage.option.worsening',
  };
  const key = aliases[String(value).trim().toLowerCase()];
  return lang === 'en' && key ? t(key, lang) : localizeOption(value, lang);
}

function localizeConclusionCondition(value, lang) {
  if (lang !== 'en') return value;
  const group = DISEASES.find((aliases) =>
    aliases.some((alias) => normalize(alias) === normalize(value))
  );
  return group?.find((alias) => /^[a-z][a-z -]*$/i.test(alias)) || value;
}

function fallbackBlocks(state, facts, lang) {
  const h = getHonorifics({ age: facts.tuoi, gender: facts.gioi, lang });
  const params = {
    ...h,
    symptoms:
      facts.trieu_chung
        .slice(0, 3)
        .map((s) => short(localizeConclusionText(s, lang), 80))
        .join(', ') || t('checkin.triage.symptom_unknown', lang),
    timeline: [facts.bat_dau, facts.dien_bien]
      .filter(Boolean)
      .map((s) => `, ${short(localizeConclusionText(s, lang), 80)}`)
      .join(''),
    baseline: (facts.trieu_chung_truoc_do || [])
      .slice(0, 2)
      .map((symptom) => short(localizeConclusionText(symptom, lang), 80))
      .join(', '),
    conditions: facts.benh_nen_da_khai
      .map((value) => localizeConclusionCondition(value, lang))
      .join(', '),
    measurements: requiredMeasurementTypes(facts)
      .map((type) => t(`checkin.conclusion.metric.${type}`, lang))
      .join(lang === 'en' ? ' and ' : ' và '),
  };
  const group = symptomGroup(facts.trieu_chung);
  const key = (suffix) => t(`checkin.conclusion.fallback.${suffix}`, lang, params);
  const visit =
    facts.care_level === 'tu_theo_doi'
      ? 'self'
      : facts.care_level === 'kham_trong_ngay'
        ? 'today'
        : 'soon';
  const todo = [key(`${group}.action1`), key(`${group}.action2`)];
  if (requiredMeasurementTypes(facts).length) todo.push(key('measure'));
  return {
    loi_nhan: key(
      facts.assessment_incomplete
        ? 'incomplete'
        : params.baseline
          ? 'message_with_baseline'
          : 'message'
    ),
    lien_quan: facts.benh_nen_da_khai.length ? key('conditions') : key(`${group}.explanation`),
    nen_lam: todo,
    di_kham_khi: [key(`visit.${visit}`), key(`${group}.warning`)],
  };
}

function composeConclusion(blocks, state, profile, lang) {
  const h = getHonorifics({ ...profile, lang });
  const hours =
    Number(state.followUpHours) > 0 ? Number(state.followUpHours) : state.isElderly ? 4 : 6;
  const closeMessage = t('checkin.conclusion.followup', lang, { ...h, hours });
  const aiNotice = t('checkin.conclusion.ai_notice', lang);
  return {
    conclusionVersion: 2,
    personalMessage: blocks.loi_nhan,
    explanation: blocks.lien_quan,
    todo: blocks.nen_lam,
    seeDoctorWhen: blocks.di_kham_khi,
    disclaimer: t('checkin.conclusion.disclaimer', lang),
    aiNotice,
    summary: `${blocks.loi_nhan} ${blocks.lien_quan}`,
    recommendation: [...blocks.nen_lam, ...blocks.di_kham_khi].join('\n'),
    closeMessage,
    followUpHours: hours,
    isEmergency: false,
    speechText: [blocks.loi_nhan, ...blocks.di_kham_khi, closeMessage, aiNotice].join(' '),
  };
}

function includeRecordedFacts(blocks, facts, lang) {
  // Numeric facts come from the existing query results, never model inference.
  // Keep them in block 2 even when the model only suggested measuring in block 3.
  const details = [];
  const missingConditions = facts.benh_nen_da_khai.filter((condition) => {
    const groups = diseaseGroups(condition);
    return groups.length
      ? !groups.every((group) => group.some((name) => hasPhrase(blocks.lien_quan, name)))
      : !hasPhrase(blocks.lien_quan, condition);
  });
  if (missingConditions.length)
    details.push(
      t('checkin.conclusion.recorded_conditions', lang, {
        conditions: missingConditions
          .map((value) => localizeConclusionCondition(value, lang))
          .join(', '),
      })
    );
  for (const type of ['huyet_ap', 'duong_huyet']) {
    const record = facts.chi_so_24h
      .filter((r) => r.loai === type)
      .sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at))[0];
    if (
      record &&
      !(
        blocks.lien_quan.includes(record.gia_tri) &&
        measurementTimeMatches(blocks.lien_quan, record, facts.evaluated_at)
      )
    ) {
      details.push(
        t(`checkin.conclusion.reading.${type}`, lang, {
          time: record.luc,
          value: record.gia_tri,
          unit: record.don_vi,
        })
      );
    }
  }
  return { ...blocks, lien_quan: compactExplanation([blocks.lien_quan, ...details].join('\n')) };
}

async function generateStructuredConclusion(state, profile, lang = 'vi', context = {}) {
  const facts = buildConclusionFacts(state, profile, context, lang);
  const blocks = fallbackBlocks(state, facts, lang);
  const started = Date.now();
  const rejected = [];
  let generationMeta;
  const repairs = [];
  try {
    const response = await callTextAi({
      system: buildConclusionSystem(facts, lang),
      prompt: buildConclusionPrompt(facts, lang),
      provider: 'medgemma',
      strictProvider: true,
      model: process.env.CHECKIN_CONCLUSION_MODEL || 'medgemma-27b-it',
      temperature: 0.2,
      maxTokens: 700,
      timeoutMs: 10000,
      maxRetries: 0,
    });
    const raw = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const normalized = normalizeConclusionCandidate(JSON.parse(raw), facts, lang);
    const candidate = normalized.candidate;
    repairs.push(...normalized.repairs);
    if (typeof candidate?.lien_quan === 'string') {
      candidate.lien_quan = normalizeMeasurementSentences(candidate.lien_quan);
    }
    if (Array.isArray(candidate?.di_kham_khi)) {
      candidate.di_kham_khi = normalizeConditionalWarnings(candidate.di_kham_khi, lang);
    }
    for (const block of BLOCKS) {
      if (candidate && typeof candidate === 'object')
        candidate[block] = repairConclusionContent(block, candidate[block], facts);
      const reason =
        validateBlock(block, candidate?.[block], facts) ||
        validatePresentation(block, candidate?.[block], facts);
      if (reason) rejected.push({ block, reason });
      else
        blocks[block] = Array.isArray(candidate[block])
          ? candidate[block].map((s) => s.trim())
          : candidate[block].trim();
    }
    generationMeta = {
      model: response.model,
      tokens: response.usage?.total,
    };
  } catch (error) {
    rejected.push({
      block: 'response',
      reason: error instanceof SyntaxError ? 'invalid_json' : 'provider_unavailable',
    });
  }
  if (
    (facts.trieu_chung_truoc_do || [])
      .slice(0, 2)
      .some((symptom) => !hasPhrase(blocks.loi_nhan, localizeConclusionText(symptom, lang)))
  ) {
    blocks.loi_nhan = fallbackBlocks(state, facts, lang).loi_nhan;
    rejected.push({ block: 'loi_nhan', reason: 'baseline_context_missing' });
  }
  let completed = includeRecordedFacts(blocks, facts, lang);
  const explanationFormat = validatePresentation('lien_quan', completed.lien_quan, facts);
  if (explanationFormat) {
    // Completion can add verified facts. If the text no longer fits the SRS,
    // replace only this block with the concise fallback before adding them.
    rejected.push({ block: 'lien_quan', reason: explanationFormat });
    blocks.lien_quan = fallbackBlocks(state, facts, lang).lien_quan;
    completed = includeRecordedFacts(blocks, facts, lang);
  }
  for (const item of rejected) logger.warn('conclusion_rejected', item);
  if (repairs.length) logger.info('conclusion_normalized', { repairs });
  if (generationMeta)
    logger.info('conclusion_generated', {
      durationMs: Date.now() - started,
      ...generationMeta,
      fallbackBlocks: new Set(rejected.map((item) => item.block)).size,
    });
  const final = normalizeConclusionCandidate(completed, facts, lang).candidate;
  return {
    ...composeConclusion(final, state, profile, lang),
    conclusionPromptVersion: CONCLUSION_PROMPT_VERSION,
    conclusionRenderVersion: CONCLUSION_RENDER_VERSION,
    conclusionSource: !generationMeta ? 'fallback' : rejected.length ? 'partial_fallback' : 'ai',
  };
}

// Legacy exported predicate remains available for old callers/tests. The fixed
// disclaimer and server follow-up are intentionally not scanned as AI content.
function isSafeConclusion(candidate, profile = {}) {
  if (!candidate?.summary || !candidate?.recommendation) return false;
  const text = `${candidate.summary} ${candidate.recommendation}`;
  if (hardConclusionFault(text)) return false;
  const declared = new Set(list(profile.medical_conditions).flatMap(diseaseGroups));
  return !diseaseGroups(text).some((group) => /(?:bị|mắc)\s/iu.test(text) && !declared.has(group));
}

module.exports = {
  generateStructuredConclusion,
  buildConclusionFacts,
  buildConclusionPrompt,
  buildConclusionSystem,
  validateBlock,
  fallbackBlocks,
  composeConclusion,
  isSafeConclusion,
  symptomGroup,
  BLOCKS,
};
