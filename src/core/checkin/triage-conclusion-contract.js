'use strict';

const { plain, containsVisit } = require('./triage-conclusion-guards');
const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const sentences = (text) =>
  [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean);
const vietnameseLetters = /[ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂĐĨŨƠƯàáâãèéêìíòóôõùúýăđĩũơưẠ-ỹ]/u;
const englishProseWords = new Set(
  'i you your we our please if when and the this that with for can may should understand sleep daily routines feel simple diary help describe changes record details discomfort starts keep regular bedtime poor disrupts activities seek assessment symptoms worsen speak health expert rest comfortably drink water avoid triggers measure pressure glucose fatigue better'.split(
    ' '
  )
);

function conclusionLanguageFault(value, facts) {
  if (!['en', 'vi'].includes(facts.language)) return null;
  const texts = Array.isArray(value) ? value : [value];
  for (let text of texts) {
    // An untranslated custom condition can be quoted as a recorded label. It
    // must not make Vietnamese prose elsewhere in an English block acceptable.
    for (const label of facts.benh_nen_da_khai || []) {
      if (label) text = text.replaceAll(label, ' ');
    }
    if (facts.language === 'vi') {
      // Catch clear untranslated English sentences without rejecting recorded
      // English condition labels, numeric readings or unaccented Vietnamese.
      if (/\b(?:please|you|your|i (?:understand|will|am|have))\b/i.test(text))
        return 'wrong_output_language';
      if (
        sentences(text).some(
          (sentence) =>
            !vietnameseLetters.test(sentence) &&
            ((sentence.toLowerCase().match(/[a-z]+/g) || []).filter((word) =>
              englishProseWords.has(word)
            ).length >= 2 ||
              /^(?:rest|record|measure|monitor|keep|avoid|drink|seek|please)\b/i.test(sentence))
        )
      )
        return 'wrong_output_language';
      continue;
    }
    if (
      vietnameseLetters.test(text) ||
      /\b(?:toi hieu|ban nen|neu ban|chung ta|cam thay|trieu chung|di kham|giac ngu)\b/i.test(text)
    )
      return 'wrong_output_language';
  }
  return null;
}

function requiredMeasurementTypes(facts) {
  const conditions = plain(facts.benh_nen_da_khai.join(' '));
  // A prediabetes declaration does not become a diabetes declaration.
  const withoutPrediabetes = conditions.replace(
    /tien (?:tieu duong|dai thao duong)|pre-?diabetes/g,
    ''
  );
  return [
    /(?:cao|tang) huyet ap|huyet ap cao|hypertension/.test(conditions) && 'huyet_ap',
    /tieu duong|dai thao duong|\bdiabetes\b/.test(withoutPrediabetes) && 'duong_huyet',
  ].filter(Boolean);
}

function conditionalWarningMissingAction(text) {
  if (!/^(?:neu|khi|trong truong hop|if|when)\b/.test(plain(text))) return false;
  return !(
    containsVisit(text) ||
    /\b(?:gọi|call)\s+115\b/iu.test(text) ||
    /(?:liên hệ|trao đổi với)\s+(?:bác sĩ|chuyên gia)|\b(?:contact|consult|speak (?:with|to))\s+(?:(?:a|your|the)\s+)?(?:doctor|health expert|healthcare professional)\b/iu.test(
      text
    ) ||
    /(?:[,;:]|\bthi\b|\bthen\b)\s*(?:(?:anh|chi|bac|chu|co|ong|ba|ban|you)\s+)?(?:hay|nen|can|phai|dung|vui long|please|should|must)\b/.test(
      plain(text)
    )
  );
}

function normalizeConditionalWarnings(value, lang = 'vi') {
  if (!Array.isArray(value)) return value;
  return value.map((text) => {
    if (typeof text !== 'string' || !conditionalWarningMissingAction(text)) return text;
    // Complete only a single conditional fragment. Preserve its exact trigger,
    // numbers and urgency; all safety/care-level/length checks still run after.
    if (sentences(text).length !== 1 || /\?\s*$/.test(text)) return text;
    const pattern = lang === 'en' ? /^(if|when)\s+/i : /^(nếu|khi|trong trường hợp)\s+/iu;
    const trimmed = text.trim();
    const prefix = trimmed.match(pattern);
    if (!prefix) return text;
    const action = lang === 'en' ? 'Seek an assessment' : 'Hãy đi khám';
    const completed = `${action} ${prefix[1].toLowerCase()} ${trimmed.slice(prefix[0].length)}`;
    return /[.!]$/.test(completed) ? completed : completed + '.';
  });
}

function validatePresentation(block, value, facts) {
  const texts = Array.isArray(value) ? value : [value];
  const languageFault = conclusionLanguageFault(value, facts);
  if (languageFault) return languageFault;
  if (texts.some((text) => /(?:anh|chị|bác|chú|cô|ông|bà|bạn)\s+Asinu\b/iu.test(text)))
    return 'assistant_name_as_patient';
  if (texts.some((text) => /\p{Extended_Pictographic}/u.test(text))) return 'emoji_in_conclusion';
  if (block === 'loi_nhan' && sentences(value).length > 3) return 'message_sentence_count';
  if (block === 'di_kham_khi' && texts.some(conditionalWarningMissingAction))
    return 'conditional_warning_missing_action';
  if (block !== 'nen_lam') return null;
  // Require a usable quantity in at least one action, without inventing doses,
  // exercise intensity or medical cutoffs. A concrete symptom/time diary counts.
  if (
    !texts.some((text) =>
      /\b(?:\d+(?:[.,]\d+)?|hai|ba|two|three)\s+(?:moc|dieu|muc|phut|gio|tieng|bua|lan|ngay|minutes?|hours?|meals?|details?|times?|entries|time|points?)\b/.test(
        plain(text)
      )
    )
  )
    return 'missing_quantified_action';
  for (const type of requiredMeasurementTypes(facts)) {
    const label =
      type === 'huyet_ap' ? /huyet ap|blood pressure/ : /duong huyet|blood (?:sugar|glucose)/;
    if (
      !texts.some(
        (item) => /(?:\bdo\b|measure|check|monitor)/.test(plain(item)) && label.test(plain(item))
      )
    )
      return 'measurement_reminder_missing';
  }
  return null;
}

function compactExplanation(text) {
  // V3 lets the model explain naturally. Keep its statements; the character
  // bounds and medical guards, rather than a 2–3 sentence template, apply.
  return sentences(text).join(' ');
}

function normalizeMeasurementSentences(text) {
  const parts = sentences(text).flatMap((sentence) => {
    const readings = [
      ...sentence.matchAll(/\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*(?:mmHg|mmol\/L|mg\/dL)/giu),
    ];
    if (readings.length < 2) return [sentence];
    const types = new Set(readings.map((reading) => (/mmHg/i.test(reading[0]) ? 'bp' : 'glucose')));
    if (types.size > 1) return [sentence];
    // Punctuation only: each explicitly introduced historical clause keeps its
    // own numbers, units, date and time. Grounding still checks every clause.
    return sentence
      .split(/,\s*(?=(?:còn\s+lúc|trước đó(?:\s+lúc|\s+ngày)|previously\s+at|whereas\s+at))/iu)
      .map((part, index) => {
        const sentencePart = index ? part.charAt(0).toUpperCase() + part.slice(1) : part;
        return /[.!?]$/.test(sentencePart) ? sentencePart : sentencePart + '.';
      });
  });
  return compactExplanation(parts.join(' '));
}

module.exports = {
  conclusionLanguageFault,
  requiredMeasurementTypes,
  validatePresentation,
  compactExplanation,
  normalizeMeasurementSentences,
  conditionalWarningMissingAction,
  normalizeConditionalWarnings,
};
