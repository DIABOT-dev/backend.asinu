'use strict';

const plain = (text) =>
  String(text || '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
function statements(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((text) =>
      [...segmenter.segment(text)].flatMap(({ segment }) =>
        segment.split(/;|\s+(?=so với|compared (?:with|to))/iu)
      )
    )
    .map((text) => text.trim())
    .filter(Boolean);
}
const TYPE_PATTERNS = [
  ['huyet_ap', /huyet ap|blood pressure/],
  ['duong_huyet', /duong huyet|blood (?:sugar|glucose)/],
];
const typesIn = (text) =>
  TYPE_PATTERNS.filter(([, pattern]) => pattern.test(plain(text))).map(([type]) => type);
function assertsVitalStatus(text, type) {
  const label =
    type === 'huyet_ap' ? '(?:huyet ap|blood pressure)' : '(?:duong huyet|blood (?:sugar|glucose))';
  const status = '(?:on dinh|binh thuong|cao|thap|tot|stable|normal|high|low|good)\\b';
  const owner = 'cua (?:anh|chi|bac|chu|co|ban|ong|ba)';
  // The status must predicate the named vital. An earlier "it is good to
  // consider" must not turn a later condition label into a measured result.
  const predicate =
    '(?:is|are|was|were|remains?|has been|have been|looks?|seems?|van|dang|hien tai|hien|con|rat|kha|hoi|khong|chua|hom nay|o muc) ';
  const modifiers =
    '(?:(?:still|currently|consistently|very|quite|slightly|too|not|at a|at the|van|dang|hien tai|hien|con|rat|kha|hoi|khong|chua|hom nay|o muc) )*';
  return (
    new RegExp(
      `${label}(?: (?:reading|readings|level|levels))?(?: ${owner})? ${predicate}${modifiers}${status}`
    ).test(text) || new RegExp(`${label} ${owner} ${modifiers}${status}`).test(text)
  );
}
const units = () => /(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?\s*(mmHg|mmol\/L|mg\/dL)/gi;
const containsVisit = (text) =>
  /đi khám|thăm khám|bệnh viện|phòng khám|gặp (?:bác sĩ|chuyên gia)|đặt lịch khám|seek (?:care|help)|assessment|clinic|hospital|(?:see|meet|consult|contact|speak (?:with|to)|talk (?:with|to))\s+(?:(?:a|your|the)\s+)?(?:doctor|professional|specialist|health expert|healthcare professional)\b/iu.test(
    text
  );
const conditional = (text) => /\b(?:neu|khi|if|when|trong truong hop)\b/.test(plain(text));
const negatedVisit = (text) =>
  /(?:khong|chua) (?:can|phai|nen) (?:di )?kham|\b(?:no need|do not need|don.t need|not necessary)\b/.test(
    plain(text)
  );
function visitFault(value, careLevel) {
  const direct = statements(value).filter((text) => containsVisit(text) && !conditional(text));
  if (careLevel === 'tu_theo_doi')
    return direct.some((text) => !negatedVisit(text)) ? 'upgraded_care_level' : null;
  if (direct.some(negatedVisit)) return 'contradicts_care_level';
  if (!direct.length) return 'required_referral_missing';
  const today = (text) => /hom nay|trong ngay|today|ngay lap tuc|immediately/.test(plain(text));
  if (careLevel === 'kham_trong_ngay' && !direct.some(today)) return 'same_day_referral_missing';
  if (careLevel === 'dat_lich_kham' && direct.some(today)) return 'unexpected_same_day_referral';
  return null;
}

function emergencyFault(value) {
  for (const statement of statements(value)) {
    if (!/gọi\s*115|call\s*115/iu.test(statement)) continue;
    const text = plain(statement);
    const call = text.search(/goi\s*115|call\s*115/);
    const before = text.slice(0, call);
    if (
      /bat ky (?:dau hieu|trieu chung)|any (?:other )?(?:abnormal |unusual )?(?:symptom|sign)/.test(
        before
      )
    )
      return 'nonspecific_emergency_condition';
    // A condition in a different item/sentence cannot qualify this instruction.
    if (!conditional(statement) && !/[:：]/.test(before)) return 'unconditional_emergency';
    if (
      !/dau nguc|tuc nguc.{0,50}(?:va mo hoi|choang|chong mat|khong het)|chest (?:discomfort|pressure|tightness).{0,50}(?:sweat|dizz|persist)|kho tho|ngat|bat tinh|tim moi|yeu.{0,18}(?:ben|tay|chan)|liet|kho noi|noi kho|non ra mau|phan den|dau dau.{0,15}du doi|dau bung.{0,15}du doi|tu tu|tu lam hai|chest pain|breath|faint|unconscious|blue lips|weakness|vomit.{0,8}blood|black stools|severe.{0,20}(?:headache|abdominal)|suicid/.test(
        text
      )
    )
      return 'nonsevere_emergency_condition';
  }
  return null;
}

function priorSymptomResolutionFault(value) {
  // A historical mention or an absent complaint today does not confirm that
  // a particular earlier symptom improved. No such confirmation is supplied
  // in the conclusion contract; a general "fine" check-in is not one either.
  const historical =
    /lan (?:check-in |checkin )?truoc|cac lan check-in|truoc do|trieu chung cu|previous (?:check-ins?|symptoms)|earlier symptoms/;
  const resolution =
    /(?:da |co ve |seems? |appears? |have |has )+(?:da )?(?:on dinh|do|het|khoi|cai thien|stable|resolved|improved)|khong con|no longer/;
  const refersBack =
    /\b(?:(?:nhung|cac) )?(?:trieu chung|bieu hien|con dau|tinh trang) (?:nay|do|cu)\b|\b(?:they|these symptoms|those symptoms|this pain|this discomfort)\b/;
  let previousHistorical = false;
  // Never join unrelated paragraphs into a claim. Preserve cross-sentence
  // checks when an explicit pronoun refers back to a historical complaint.
  for (const statement of statements(value)) {
    const text = plain(statement);
    const past = historical.test(text);
    const reference = refersBack.test(text);
    if (resolution.test(text) && (past || (previousHistorical && reference)))
      return 'unconfirmed_prior_symptom_resolution';
    previousHistorical = past || (previousHistorical && reference);
  }
  return null;
}

function measurementTimeMatches(text, record, asOf) {
  const time = record.luc?.match(/\b(\d{1,2}):(\d{2})\b/);
  const expected = record.luc?.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (!time || !expected) return false;
  if (
    ![...text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].some(
      (m) => Number(m[1]) === Number(time[1]) && Number(m[2]) === Number(time[2])
    )
  )
    return false;
  const fullYear = expected[3].length === 4 ? Number(expected[3]) : 2000 + Number(expected[3]);
  const dates = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)].filter(
    (m) => Number(m[1]) <= 31 && Number(m[2]) <= 12
  );
  if (!dates.length && record.measured_at && asOf) {
    const day = (date) => Math.floor((new Date(date).getTime() + 7 * 3600000) / 86400000);
    const difference = day(asOf) - day(record.measured_at);
    return (
      (/hom nay|\btoday\b/.test(plain(text)) && difference === 0) ||
      (/hom qua|\byesterday\b/.test(plain(text)) && difference === 1)
    );
  }
  return dates.some(
    (m) =>
      Number(m[1]) === Number(expected[1]) &&
      Number(m[2]) === Number(expected[2]) &&
      (!m[3] || (m[3].length === 4 ? Number(m[3]) === fullYear : Number(m[3]) === fullYear % 100))
  );
}

function withoutCalendarDates(text) {
  // Examine complete dates before looking for bare BP ratios. Otherwise
  // 4/11/26 is scanned starting at 11/26 and mistaken for an invented reading.
  // This applies only to the secondary ratio scan: unit/value/time grounding
  // continues to examine the original, unmodified text.
  return text.replace(
    /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/g,
    (match, day, month, year) => {
      const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
      const date = new Date(Date.UTC(fullYear, Number(month) - 1, Number(day)));
      const valid =
        date.getUTCFullYear() === fullYear &&
        date.getUTCMonth() === Number(month) - 1 &&
        date.getUTCDate() === Number(day);
      return valid ? ' '.repeat(match.length) : match;
    }
  );
}

function measurementFault(value, facts) {
  const records = [...facts.chi_so_24h, ...facts.chi_so_7_ngay];
  const current = new Set(facts.chi_so_24h.map((r) => r.loai));
  let previousTypes = [];
  const scopes = statements(value).flatMap((sentence) => {
    const separators =
      /,\s*(?=(?:(?:và|còn|and)\s+)?(?:huyết áp|đường huyết|blood pressure|blood glucose|blood sugar))|\s+(?:và|and)\s+(?=(?:huyết áp|đường huyết|blood pressure|blood glucose|blood sugar))/giu;
    const result = [];
    let start = 0;
    for (const match of sentence.matchAll(separators)) {
      // A leading time/date belongs to the reading after the comma. Split
      // only when both sides contain a different numerical reading.
      if (
        units().test(sentence.slice(start, match.index)) &&
        units().test(sentence.slice(match.index + match[0].length))
      ) {
        result.push(sentence.slice(start, match.index));
        start = match.index + match[0].length;
      }
    }
    result.push(sentence.slice(start));
    return result;
  });
  for (const scope of scopes) {
    const text = plain(scope);
    const named = typesIn(scope);
    const mentions = [...scope.matchAll(units())];
    if (mentions.length > 1) return 'ambiguous_measurement_reference';
    let mentionedTypes = named;
    for (const match of mentions) {
      const type = match[3].toLowerCase() === 'mmhg' ? 'huyet_ap' : 'duong_huyet';
      if (named.length && !named.includes(type)) return 'measurement_type_mismatch';
      const value = [match[1], match[2]]
        .filter(Boolean)
        .map((n) => String(Number(n.replace(',', '.'))))
        .join('/');
      const matching = records.filter(
        (r) =>
          current.has(type) &&
          r.loai === type &&
          r.don_vi.toLowerCase() === match[3].toLowerCase() &&
          r.gia_tri === value
      );
      if (!matching.length) return 'ungrounded_measurement';
      const sameDateWords = (record) => {
        if (!record.measured_at || !facts.evaluated_at) return true;
        const day = (date) => Math.floor((new Date(date).getTime() + 7 * 3600000) / 86400000);
        const difference = day(facts.evaluated_at) - day(record.measured_at);
        return (
          (!/hom nay|\btoday\b/.test(text) || difference === 0) &&
          (!/hom qua|\byesterday\b/.test(text) || difference === 1)
        );
      };
      if (
        !matching.some(
          (r) => measurementTimeMatches(scope, r, facts.evaluated_at) && sameDateWords(r)
        )
      )
        return 'measurement_time_not_exact';
      mentionedTypes = [type];
    }
    for (const match of withoutCalendarDates(scope).matchAll(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/g)) {
      if (Number(match[1]) <= 31 && Number(match[2]) <= 12) continue;
      const exact = `${Number(match[1])}/${Number(match[2])}`;
      if (
        !current.has('huyet_ap') ||
        !records.some((r) => r.loai === 'huyet_ap' && r.gia_tri === exact)
      )
        return 'ungrounded_measurement';
      if (!mentions.length) return 'measurement_unit_missing';
    }
    const comparative =
      /so voi (?:lan|hom) truoc|compared (?:with|to)|(?:van|still|remains|is).{0,12}(?:on dinh|stable)/.test(
        text
      ) ||
      ((named.length ||
        /(?:cac |nhung )?chi so (?:nay|hien tai)|these (?:readings|numbers|values)/.test(text)) &&
        /on dinh|stable/.test(text));
    const preventive =
      /(?:viec |de |can |nen |hay )?(?:giu|duy tri|kiem soat).{0,35}on dinh|(?:maintain|keep).{0,35}stable/.test(
        text
      );
    if (comparative && !preventive) {
      const types = mentionedTypes.length ? mentionedTypes : previousTypes;
      if (
        !types.length ||
        types.some(
          (type) => !current.has(type) || records.filter((r) => r.loai === type).length < 2
        )
      )
        return 'insufficient_comparison_data';
    }
    for (const type of named) {
      if (!current.has(type) && assertsVitalStatus(text, type)) return 'unmeasured_vital_claim';
    }
    if (mentionedTypes.length) previousTypes = mentionedTypes;
  }
  return null;
}

module.exports = {
  plain,
  statements,
  containsVisit,
  visitFault,
  emergencyFault,
  priorSymptomResolutionFault,
  measurementFault,
  measurementTimeMatches,
};
