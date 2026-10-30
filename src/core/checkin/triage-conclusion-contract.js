'use strict';

const { plain } = require('./triage-conclusion-guards');
const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const sentences = (text) =>
  [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean);
const words = (text) => text.trim().split(/\s+/).length;
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

function validatePresentation(block, value, facts) {
  const texts = Array.isArray(value) ? value : [value];
  const languageFault = conclusionLanguageFault(value, facts);
  if (languageFault) return languageFault;
  if (texts.some((text) => /(?:anh|chị|bác|chú|cô|ông|bà|bạn)\s+Asinu\b/iu.test(text)))
    return 'assistant_name_as_patient';
  if (texts.some((text) => /\p{Extended_Pictographic}/u.test(text))) return 'emoji_in_conclusion';
  if (texts.flatMap(sentences).some((text) => words(text) > 25)) return 'sentence_too_long';
  if (block === 'loi_nhan' && sentences(value).length > 2) return 'message_sentence_count';
  if (block === 'lien_quan' && (sentences(value).length < 2 || sentences(value).length > 3))
    return 'explanation_sentence_count';
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
  const parts = sentences(text);
  while (parts.length > 3) {
    let best = -1;
    let smallest = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const combined = words(parts[i]) + words(parts[i + 1]);
      if (combined <= 25 && combined < smallest) {
        best = i;
        smallest = combined;
      }
    }
    if (best < 0) break;
    // Keep every statement and value. Change punctuation only when the merged
    // sentence remains within the SRS word budget; never truncate medical facts.
    parts.splice(best, 2, parts[best].replace(/[.!?]$/, '') + '; ' + parts[best + 1]);
  }
  return parts.join(' ');
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
};
