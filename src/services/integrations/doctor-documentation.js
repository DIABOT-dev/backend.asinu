const { clinicalConversation } = require('./doctor-conversation-context');

// SOAP is a draft chart entry. Keep observations, an established assessment
// and actions already communicated traceable to their actual source. Model
// hypotheses belong in decision support, never in the documented assessment.
const documentedSoap = (context, subjective, locale = 'vi') => {
  const en = locale === 'en';
  const measurements = [];
  for (const row of (context.blood_pressure || []).slice(0, 5)) {
    if (
      ![row.systolic, row.diastolic].every(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0
      )
    )
      continue;
    measurements.push(`${row.occurred_at || '?'}: ${row.systolic}/${row.diastolic} mmHg`);
  }
  for (const row of (context.glucose || []).slice(0, 5)) {
    if (!Number.isFinite(Number(row.value)) || Number(row.value) <= 0) continue;
    measurements.push(`${row.occurred_at || '?'}: ${row.value} ${row.unit || ''}`.trim());
  }
  const summary = context.consultation_summary;
  const completedPlan = summary
    ? [summary.next_steps, summary.warning_signs, summary.follow_up_recommendation]
        .filter(Boolean)
        .join('\n')
    : '';
  const sentAdvice = clinicalConversation(context)
    .filter(
      (turn) => turn.role === 'doctor' && ['consultation', 'follow_up'].includes(turn.message_type)
    )
    .slice(-5)
    .map(
      (turn) =>
        `[${turn.created_at || turn.id || '?'}] ${
          turn.message.length <= 800
            ? turn.message
            : en
              ? `See the full clinician message ${turn.id || ''} in the conversation.`
              : `Xem nguyên văn tin tư vấn ${turn.id || ''} trong hội thoại.`
        }`
    )
    .join('\n');
  return {
    subjective,
    objective: measurements.length
      ? `${en ? 'Measurements recorded in the app; not verified by examination' : 'Số đo lưu trên ứng dụng; chưa được xác minh khi khám'}:\n${measurements.join('\n')}`.slice(
          0,
          5000
        )
      : '',
    assessment: summary?.assessment || '',
    plan: summary
      ? completedPlan.length <= 5000
        ? completedPlan
        : en
          ? 'See the full completed consultation plan, warning signs and review instructions in the signed consultation summary; the plan is too long to reproduce in this field.'
          : 'Xem đầy đủ kế hoạch, dấu hiệu cảnh báo và hướng dẫn tái tư vấn trong bản kết luận đã chốt của ca; nội dung dài nên không chép lại vào mục này.'
      : sentAdvice
        ? `${en ? 'Recent advice already sent in this consultation; clinician to confirm the plan' : 'Trích các tin tư vấn gần nhất đã gửi trong ca; bác sĩ cần xác nhận kế hoạch'}:\n${sentAdvice}`
        : '',
  };
};

const requiresKnowledgeCitation = (touchpoint) =>
  ['consultation_draft', 'follow_up_draft'].includes(touchpoint);

const reviewIntervals = (text) =>
  [
    ...String(text || '').matchAll(/(\d+(?:[.,]\d+)?)\s*(giờ|ngày|tuần|hours?|days?|weeks?)/giu),
  ].map(
    (match) =>
      Number(match[1].replace(',', '.')) *
      (/ngày|day/iu.test(match[2]) ? 24 : /tuần|week/iu.test(match[2]) ? 168 : 1)
  );
const missingPlannedFollowup = (plan, draft) => {
  const actual = new Set(reviewIntervals(draft));
  return reviewIntervals(plan).some((hours) => !actual.has(hours));
};

module.exports = { documentedSoap, requiresKnowledgeCitation, missingPlannedFollowup };
