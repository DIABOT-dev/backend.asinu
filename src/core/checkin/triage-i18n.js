'use strict';

const { t } = require('../../i18n');

const normalizeLang = (lang) => (String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'vi');

const TRIAGE_OPTION_KEYS = Object.freeze({
  'mệt mỏi': 'fatigue',
  fatigue: 'fatigue',
  'đau đầu': 'headache',
  headache: 'headache',
  'đau bụng': 'abdominal_pain',
  'stomach pain': 'abdominal_pain',
  'abdominal pain': 'abdominal_pain',
  sốt: 'fever',
  fever: 'fever',
  ho: 'cough',
  cough: 'cough',
  'khó thở': 'shortness_of_breath',
  'shortness of breath': 'shortness_of_breath',
  'đau ngực': 'chest_pain',
  'chest pain': 'chest_pain',
  'chóng mặt': 'dizziness',
  dizziness: 'dizziness',
  'buồn nôn': 'nausea',
  nausea: 'nausea',
  'mất ngủ': 'insomnia',
  insomnia: 'insomnia',
  'đau họng': 'sore_throat',
  'sore throat': 'sore_throat',
  'tiêu chảy': 'diarrhea',
  diarrhea: 'diarrhea',
  'đau vai': 'shoulder_pain',
  'shoulder pain': 'shoulder_pain',
  'tê tay chân': 'limb_numbness',
  'numbness in limbs': 'limb_numbness',
  'vừa mới': 'just_now',
  'just now': 'just_now',
  'vài giờ trước': 'hours_ago',
  'a few hours ago': 'hours_ago',
  'từ sáng': 'since_morning',
  'since this morning': 'since_morning',
  'từ hôm qua': 'since_yesterday',
  'since yesterday': 'since_yesterday',
  'vài ngày nay': 'past_few_days',
  'for a few days': 'past_few_days',
  'đang đỡ dần': 'improving',
  improving: 'improving',
  'vẫn như cũ': 'same',
  'about the same': 'same',
  'có vẻ nặng hơn': 'worsening',
  'getting worse': 'worsening',
  'nghỉ ngơi': 'rested',
  rested: 'rested',
  'uống thuốc': 'took_prescribed_medicine',
  'took prescribed medicine': 'took_prescribed_medicine',
  'uống nước': 'drank_water',
  'drank water': 'drank_water',
  'chưa làm gì': 'no_action',
  'nothing yet': 'no_action',
  'đỡ hơn nhiều': 'much_better',
  'much better': 'much_better',
  'đỡ hơn một chút': 'slightly_better',
  'slightly better': 'slightly_better',
  'không có triệu chứng mới': 'no_new_symptoms',
  'no new symptoms': 'no_new_symptoms',
  'có thêm triệu chứng mới': 'new_symptoms',
  'new symptoms': 'new_symptoms',
  'triệu chứng cũ nặng hơn': 'old_symptoms_worse',
  'existing symptoms are worse': 'old_symptoms_worse',
  'không có': 'none',
  none: 'none',
  'không rõ': 'unknown',
  unsure: 'unknown',
});

const OPTION_KEY_TO_VI = Object.freeze(
  Object.entries(TRIAGE_OPTION_KEYS).reduce((result, [label, key]) => {
    if (/[À-ỹ]/u.test(label) || ['sốt', 'ho'].includes(label)) result[key] = label;
    return result;
  }, {})
);

function optionKey(value) {
  return TRIAGE_OPTION_KEYS[String(value || '').trim().toLowerCase()] || null;
}

function localizeOption(value, lang = 'vi') {
  const key = optionKey(value);
  return key ? t(`checkin.triage.option.${key}`, normalizeLang(lang)) : String(value || '');
}

function normalizeOption(value) {
  const key = optionKey(value);
  return key ? OPTION_KEY_TO_VI[key] || String(value || '') : String(value || '');
}

function normalizeAnswer(answer) {
  return Array.isArray(answer) ? answer.map(normalizeOption) : normalizeOption(answer);
}

function localizeOptions(options, lang = 'vi') {
  return (options || []).map((option) => localizeOption(option, lang));
}

module.exports = {
  localizeOption,
  localizeOptions,
  normalizeAnswer,
  normalizeLang,
  optionKey,
};
