'use strict';

const VERSION = 1;
const OWNED_FIELDS = new Set(['red_flags', 'timeline', 'clinical_context', 'clarify']);
const FOCUS = {
  symptoms: 'current_symptom', impact: 'daily_effect', onset: 'onset', progression: 'progression',
  location: 'location', character: 'sensation', pattern: 'pattern', episode_duration: 'episode_duration',
  aggravating: 'aggravating_event', actions: 'action_and_result', source: 'prior_event', associated: 'additional_change',
  measurement: 'measured_value', measurements: 'measured_value',
};
const ANSWER_KINDS = {
  current_symptom: ['current_symptom', 'symptom_description', 'sensation', 'appearance', 'observable_sign'],
  sensation: ['sensation', 'appearance'],
  additional_change: ['additional_change', 'associated_symptom'],
};
const RULES = {
  current_symptom: 'Describe what the person feels or sees NOW at the selected region/spot. Cover distinct ordinary possibilities, not several near-synonyms of one sensation padded to meet a count. Do not ask where, when, how severe, what caused it or what accompanies an already-known complaint.',
  daily_effect: 'Report a concrete effect of the current complaints on ordinary activities, sleep or concentration. Do not answer with symptom qualities, duration or causes. Do not default to walking for unrelated complaints.',
  location: 'Answer WHERE the target complaint is felt, with relevant places or distribution. Sensations such as burning/tingling, time intervals and associated symptoms do not answer where. Do not repeat an exact location already recorded.',
  sensation: 'Describe HOW the already-reported complaint feels or looks. Do not substitute other complaints, associated symptoms, locations alone, onset, causes or effects on activities. For example, adding nausea or a new pain is an associated complaint rather than the character of existing bloating.',
  onset: 'Answer when the overall problem began, not how long one episode lasts or how often it happens.',
  progression: 'Answer whether the reported problem is improving, unchanged or worsening since it began, not its onset or absolute severity.',
  pattern: 'Answer how the complaint occurs (continuous/episodes/once). Do not mix onset, episode length or severity.',
  episode_duration: 'Answer the length of ONE episode. Do not give the date the whole problem started, frequency, sensations or causes.',
  aggravating_event: 'Report an observed situation in which the complaint gets worse, or no observed trigger. Do not provide the onset, a new symptom or a diagnosis.',
  action_and_result: 'Report what was tried AND the observed result, or that nothing was tried. Do not offer instructions or doses, and do not ask only what helped then supply an unsuccessful action.',
  prior_event: 'Report a remembered event or change BEFORE onset, not a symptom list, a question addressed back to the patient, or an asserted medical cause. Keep the six required directions but tailor their everyday examples to the current complaints.',
  additional_change: 'Report another CURRENT change not already stated. Do not repeat the primary complaints, their character, an already-known negative answer, their onset/course or prior-event screening.',
  measured_value: 'The person supplies their actual device reading. Do not invent numeric patient values for a multiple-choice menu.',
};
const normalized = value => String(value || '').normalize('NFC').toLocaleLowerCase().trim()
  .replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');

function buildAnswerContract(context) {
  if (OWNED_FIELDS.has(context.field)) return null;
  let detail;
  if (context.field === 'character' && context.bundled_details) {
    const missing = context.missing_details || [];
    detail = missing.find(item => item.required === true)?.field || missing[0]?.field || 'character';
  }
  const focus = FOCUS[detail || context.field];
  if (!focus) return null;
  let targetIds = detail
    ? [...new Set((context.missing_details || []).filter(item => item.field === detail).map(item => item.concern_id))]
    : (context.target_concerns || []).map(item => item.id);
  if (!targetIds.length) targetIds = (context.target_concerns || []).map(item => item.id);
  return { version: VERSION, focus, allowed_answer_kinds: ANSWER_KINDS[focus] || [focus], ...(detail ? { detail_field: detail } : {}), target_ids: targetIds, rule: RULES[focus] };
}

// High-confidence cross-dimension mistakes fail even if a reviewer approves.
// This guard does not supply a symptom menu or infer a medical conclusion.
function obviousMismatch(question, choices, field, context) {
  const q = normalized(question);
  const focus = context.answer_contract?.focus;
  const asksWhere = /ở (?:đâu|chỗ nào|vùng nào)|vùng da nào|vị trí (?:nào|ở đâu)|cụ thể.{0,15}(?:chỗ nào|ở đâu)|\bwhere\b|which (?:area|part|spot)/iu.test(q);
  const asksWhen = /bắt đầu.{0,18}(?:khi nào|lúc nào)|từ (?:khi|lúc|bao giờ)|\bwhen\b.{0,30}(?:start|began)/iu.test(q);
  const pureTime = /^(?:(?:từ|khoảng|đã|since|for|about)\s+)?(?:sáng nay|trưa nay|tối qua|hôm nay|hôm qua|hôm kia|today|yesterday|this morning|last night|(?:chưa đến|dưới|từ|under|less than)?\s*\d[\d\s.,]*(?:đến|to|dưới|under)?\s*\d*\s*(?:phút|giờ|ngày|tuần|tháng|minutes?|hours?|days?|weeks?|months?)(?:\s+(?:rồi|nay|trở lên|ago|or more))?)$/iu;
  const pureSensation = /^(?:(?:cảm giác|thấy|hơi|rất|feels?)\s+)?(?:âm ỉ|đau âm ỉ|đau nhói|nhói|châm chích|nóng rát|bỏng rát|tê bì|ngứa|căng tức|tingling|burning|aching|sharp|itching)$/iu;
  const known = new Set([...(context.target_concerns || []), ...(context.current_complaints || [])].map(item => normalized(item.label)));
  for (const choice of choices) {
    const label = normalized(choice.label);
    if (field !== 'clarify' && /[?？]\s*$/u.test(String(choice.label || '').trim())) return 'answer_is_a_question_instead_of_a_patient_report';
    const detail = label.includes(':') ? label.slice(label.indexOf(':') + 1).trim() : label;
    if (asksWhere && pureSensation.test(detail)) return 'location_question_has_sensation_answers';
    if (['symptoms', 'character', 'location', 'impact', 'associated', 'source'].includes(field) && !asksWhen && pureTime.test(detail))
      return 'answer_is_time_but_question_is_not';
    if (field === 'symptoms' && asksWhen) return 'symptom_question_asks_onset';
    if (['source', 'associated'].includes(field) && known.has(label)) return 'repeats_primary_complaint_as_another_dimension';
    if (focus === 'location' && !asksWhere) return 'question_does_not_ask_the_requested_location';
  }
  return null;
}

function questionReviewAccepted(question, verdict, context) {
  const contract = context.answer_contract;
  if (!contract) return true;
  const checks = verdict.choice_checks;
  return verdict.question_focus === contract.focus && verdict.ordinary_answers_covered === true &&
    Array.isArray(checks) && checks.length === question.choices.length &&
    new Set(checks.map(item => item?.id)).size === checks.length &&
    question.choices.every(choice => checks.some(item => item?.id === choice.id &&
      (contract.allowed_answer_kinds || [contract.focus]).includes(item.answer_kind) && item.answers_question === true && item.context_relevant === true && item.not_repeated === true));
}

function reviewInstruction(context) {
  if (!context.answer_contract) return '';
  const vocabulary = [...new Set([...Object.values(FOCUS), ...Object.values(ANSWER_KINDS).flat(), 'unrelated', 'unclear'])];
  return `REQUIRED PER-CHOICE REVIEW: First independently infer what QUESTION actually asks, not what its field name claims. Then classify every answer independently. Compare both with CONTEXT.answer_contract; never simply copy the expected focus when the actual wording asks something else.\nReturn ONE JSON object with this EXACT schema: {"valid":true|false,"errors":["short reason"],"question_focus":"one actual intent","ordinary_answers_covered":true|false,"choice_checks":[{"id":"exact existing option ID","answer_kind":"independently classified kind","answers_question":true|false,"context_relevant":true|false,"not_repeated":true|false,"reason":"short reason or null"}]}. Include any independently required impact_codes as well. ordinary_answers_covered MUST be a BOOLEAN, never a list or explanation. The three check flags MUST be BOOLEANS. Use question_focus/answer_kind from ${JSON.stringify(vocabulary)}. choice_checks must contain EVERY offered option exactly once, no missing or duplicate IDs.\nFor each option decide whether it directly answers the VISIBLE question, fits the CURRENT target complaint/location, and avoids re-asking known information. allowed_answer_kinds in the contract specifies which classified kinds are acceptable, not what you must claim the answer means. A true valid flag alone is NOT approval. For a sensation question reject a list of associated symptoms; nausea or a new pain does not describe what existing bloating feels like. For a location question reject sensations or dates. For a prior-event question reject symptoms, diagnoses or follow-up questions. For associated changes reject repeated primary complaints. Distinct wording is not enough: reject near-synonyms padding a generic menu when it misses ordinary alternatives. Explain failures briefly; valid must be false if any required check fails. ${context.answer_contract.rule}\n`;
}

module.exports = { VERSION, buildAnswerContract, obviousMismatch, questionReviewAccepted, reviewInstruction, needsReview: field => Boolean(FOCUS[field]) };
