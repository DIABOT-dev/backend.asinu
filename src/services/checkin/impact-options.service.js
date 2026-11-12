'use strict';

// These codes describe functioning, not a fixed menu or a diagnosis. Dr7 owns
// the visible choices; a separate review must agree with unfamiliar wording.
const IMPACT_CODES = ['normal', 'slowed', 'unable'];
const contextualImpact = (question) => question?.impactChoicesMode === 'patient_context';
const choiceCode = (choice) => choice.impactCode || choice.id;

function optionMeaning(label, literalMeaning) {
  const text = String(label).normalize('NFC').toLocaleLowerCase();
  // "Cannot sleep" alone never means loss of independent daily functioning.
  const literal = literalMeaning(text.replace(/\b(?:cannot|can't|unable to)\s+(?:sleep|concentrate)\b/gu, ''));
  if (literal === 'unable') return literal;
  const positive = text.replace(
    /(?:không|chưa)\s+(?:(?:bị|thấy|còn|hề)\s+)?(?:khó ngủ|mất ngủ|khó tập trung|mất tập trung|bị gián đoạn)|(?:không|chưa)\s+(?:bị\s+)?(?:đánh thức|thức giấc)|(?:no|not|without)\s+(?:sleep disruption|difficulty sleeping|trouble sleeping|difficulty concentrating)/gu,
    ''
  );
  if (/khó ngủ|mất ngủ|không ngủ được|ngủ không (?:được|yên|ngon)|thức giấc|khó tập trung|mất tập trung|phải (?:dừng|ngừng|gián đoạn).{0,30}(?:việc|hoạt động)|(?:giấc ngủ|công việc|việc đang làm).{0,25}(?:bị gián đoạn|gián đoạn)|(?:trouble|difficulty) (?:sleeping|concentrating)|(?:cannot|can't|unable to) (?:sleep|concentrate)|woken|waking|interrupted sleep|sleep.{0,20}disrupt|stop.{0,20}(?:work|activit)/u.test(positive)) return 'slowed';
  return literal;
}

function normalizeImpactChoices(choices, literalMeaning) {
  if (choices.length < 3 || choices.length > 6) return null;
  const normalized = choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    impactCode: choice.impact_code || choice.impactCode ||
      (IMPACT_CODES.includes(choice.id) ? choice.id : null),
  }));
  for (const choice of normalized) {
    if (!IMPACT_CODES.includes(choice.impactCode)) return null;
    const meaning = optionMeaning(choice.label, literalMeaning);
    if (meaning && meaning !== choice.impactCode) return null;
    // A sleep/concentration complaint cannot acquire the high severity floor
    // through an invented AI code. Dependence must be explicit in the label.
    if (choice.impactCode === 'unable' && meaning !== 'unable') return null;
  }
  if (normalized.filter((choice) => choice.impactCode === 'normal').length !== 1) return null;
  if (!normalized.some((choice) => choice.impactCode !== 'normal')) return null;
  return normalized;
}

function impactReviewAccepted(question, verdict, literalMeaning) {
  if (!contextualImpact(question)) return true;
  const reviewed = verdict.impact_codes;
  // Keep existing independently decoded scales compatible. New semantic
  // phrasing must have a complete, independent, matching reviewer mapping.
  if (!reviewed && question.choices.every((choice) => literalMeaning(choice.label) === choice.impactCode)) return true;
  return Array.isArray(reviewed) && reviewed.length === question.choices.length &&
    new Set(reviewed.map((item) => item?.id)).size === reviewed.length &&
    question.choices.every((choice) => reviewed.some((item) =>
      item?.id === choice.id && item.code === choice.impactCode));
}

module.exports = { contextualImpact, choiceCode, normalizeImpactChoices, impactReviewAccepted };
