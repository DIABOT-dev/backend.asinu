'use strict';

const { resolveComplaint } = require('../../services/checkin/clinical-mapping');
const { getUserAge } = require('../../lib/honorifics');
const { normalizeAnswer } = require('./triage-i18n');
const { normalizeSymptomForEngine } = require('../../services/checkin/body-location');

const textOf = (value) =>
  (Array.isArray(value) ? value.join(', ') : String(value ?? '')).normalize('NFC').trim();
const lower = (value) =>
  textOf(value)
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .trim();
const isUnknown = (value) =>
  /^(?:(?:tôi|mình|em|cháu)\s+)?(?:không rõ(?: nữa)?|không biết(?: nữa)?|không nhớ(?: rõ)?|chưa rõ|khó nói|khác(?: \(mô tả thêm\))?|unsure|unknown|not sure|i don.t know|i don.t remember)$/.test(
    lower(value)
  );
const isNone = (value) =>
  /^(?:không(?: có)?(?: gì)?|không có triệu chứng mới|không có dấu hiệu nào|none|no(?: new symptoms)?|nothing)$/.test(
    lower(value)
  );

function affirmativeParts(value) {
  const parts = [];
  for (const answer of Array.isArray(value) ? value : [value]) {
    // Carry a negation across a list ("không đau đầu và buồn nôn"), but
    // reset it at an explicit contrast or affirmative clause.
    let negatedList = false;
    for (const token of textOf(answer).split(
      /(\s+(?:nhưng|chỉ|but|only)\s+|[,;\n]+|\s+(?:và|and)\s+)/i
    )) {
      if (/^\s*(?:nhưng|chỉ|but|only)\s*$/i.test(token)) {
        negatedList = false;
        continue;
      }
      const part = token.trim();
      if (!part || /^(?:[,;]+|và|and)$/.test(part) || isNone(part) || isUnknown(part)) continue;
      const negative = /(?:^|\s)(?:không|chưa|ko|khong|no|not)(?:\s+(?:có|bị|thấy))?\s+/i.test(
        part
      );
      const describesAbilityOrProgress =
        /(?:không|chưa|not)\s+(?:chịu|thở|nhấc|cử động|tiểu|nuốt|nói|nhìn|nghe|đứng được|đi được|able|đỡ|giảm|nặng hơn|rõ|biết|nhớ)/i.test(
          part
        );
      if (negative && !describesAbilityOrProgress) {
        negatedList = true;
        continue;
      }
      if (/^(?:tôi\s+)?(?:có|bị|đang|i have|i am)\s+/i.test(part)) negatedList = false;
      if (!negatedList) parts.push(part);
    }
  }
  return parts;
}

function progressionOf(value) {
  const text = lower(value);
  if (!text || isUnknown(text)) return null;
  const affirmative = text.replace(
    /(?:không|chưa|not|no)\s+(?:có\s+)?(?:nặng hơn|tệ hơn|xấu hơn|worse|worsening|đỡ(?: hơn| nhiều| dần| rồi)?|better|improving)/g,
    ''
  );
  if (/nặng hơn|tệ hơn|xấu hơn|càng đau|đau[^,;]{0,25}hơn|wors(?:e|ening)/i.test(affirmative))
    return 'worse';
  if (/đỡ(?: hơn| nhiều| dần| rồi)?|giảm dần|hết rồi|ổn rồi|better|improv/i.test(affirmative))
    return 'better';
  if (
    /(?:không|chưa)\s+(?:đỡ|giảm|nặng hơn)|(?:not|no)\s+(?:better|improv|worse)|vẫn (?:như cũ|vậy)|không thay đổi|same|unchanged/i.test(
      text
    )
  )
    return 'same';
  return null;
}

function onsetOf(value) {
  return (
    lower(value).match(
      /(?:vừa mới|vài giờ trước|từ (?:sáng|chiều|tối)(?: hôm qua)?|từ hôm qua|hôm qua|vài ngày nay|\d+\s*(?:phút|giờ|ngày|tuần|tháng)\s*(?:trước|nay|rồi)?)/
    )?.[0] || null
  );
}

function complaintsOf(value) {
  const complaints = [];
  for (const part of affirmativeParts(value)) {
    if (
      /^(?:có thêm triệu chứng mới|triệu chứng cũ nặng hơn|new symptoms|existing symptoms are worse)$/i.test(
        part
      )
    )
      continue;
    // Ignore a standalone timeline/progression clause, but preserve an
    // unfamiliar complaint that happens to include its onset ("ngứa da từ sáng").
    const embeddedOnset = onsetOf(part);
    const remainder = embeddedOnset ? lower(part).replace(embeddedOnset, '').trim() : lower(part);
    if (
      !remainder ||
      /^(?:giờ |hiện tại |now )?(?:đang |đã |không |chưa )?(?:đỡ|giảm|nặng hơn|vẫn như cũ|better|worse)/i.test(
        remainder
      )
    )
      continue;
    const normalized = normalizeSymptomForEngine(normalizeAnswer(part));
    const resolved = resolveComplaint(String(normalized));
    // Keep an unknown complaint verbatim; it must not turn into a diagnosis
    // or be discarded merely because it isn't in the mapping dictionary.
    const text = part
      .replace(/^(?:tôi|mình|em|cháu)\s+(?:bị|thấy|có)\s+/i, '')
      .replace(
        /\s+(?:từ (?:sáng|chiều|tối|hôm qua)|vài ngày nay|\d+\s*(?:giờ|ngày|tuần|tháng)).*$/i,
        ''
      )
      .trim();
    if (text)
      complaints.push({ text, key: resolved?.key || null, mapping: resolved?.data || null });
  }
  return complaints;
}

function conditionsOf(value) {
  return (Array.isArray(value) ? value : []).filter(
    (condition) => !isNone(condition) && !isUnknown(condition)
  );
}

function normalizeProfile(profile = {}) {
  return {
    ...profile,
    age: getUserAge(profile),
    medical_conditions: conditionsOf(profile.medical_conditions),
  };
}

function normalizeAnswers(answers = []) {
  return answers.map((entry) => ({
    ...entry,
    answer: Array.isArray(entry.answer)
      ? entry.answer.map((value) => normalizeSymptomForEngine(normalizeAnswer(value)))
      : normalizeSymptomForEngine(normalizeAnswer(entry.answer)),
  }));
}

module.exports = {
  textOf,
  isUnknown,
  isNone,
  affirmativeParts,
  progressionOf,
  onsetOf,
  complaintsOf,
  conditionsOf,
  normalizeProfile,
  normalizeAnswers,
};
