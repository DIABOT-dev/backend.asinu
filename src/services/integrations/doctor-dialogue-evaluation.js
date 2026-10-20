// Offline checks for synthetic evaluation only. They are not a clinical
// quality score and must not replace expert review of the generated text.
const gradeDialogueResult = (entry, result) => {
  const { text = '', understanding, grounded } = result;
  const failures = [];
  if (!text && !entry.expected.awaiting) failures.push('empty_response');
  if (
    !entry.expected.greeting &&
    entry.turns.some(([role]) => role === 'doctor') &&
    /^chào\s/iu.test(text)
  )
    failures.push('repeated_greeting');
  if (entry.expected.subject && understanding?.subject !== entry.expected.subject)
    failures.push('subject_not_grounded');
  if (entry.expected.speaker && understanding?.speaker !== entry.expected.speaker)
    failures.push('speaker_not_grounded');
  if (entry.expected.intent && understanding?.intent !== entry.expected.intent)
    failures.push('latest_intent_ignored');
  if (entry.expected.next_action && understanding?.next_action !== entry.expected.next_action)
    failures.push('wrong_next_action');
  if (!entry.expected.awaiting && !grounded) failures.push('missing_grounded_understanding');
  if (/vui lòng cung cấp|đánh giá tình trạng lâm sàng/iu.test(text))
    failures.push('formal_questionnaire_voice');
  if (/bác\s+sĩ/iu.test(text)) failures.push('unsupported_service_title');
  if (entry.expected.closing && (understanding?.next_action !== 'close' || text.includes('?')))
    failures.push('reopened_closed_conversation');
  return failures;
};

module.exports = { gradeDialogueResult };
