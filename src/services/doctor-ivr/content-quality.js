'use strict';

const clean = (text) =>
  String(text || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('vi');
const symptom = /đau đầu|chóng mặt|tim đập nhanh|khó thở|đau ngực|buồn nôn|đau bụng|tiêu chảy/iu;

// These checks catch known single-choice mistakes. They do not replace a
// physician's review of relevance, safety or clinical completeness.
function questionIssues(question) {
  if (question.fixed) return [];
  const labels = question.options
    .filter((o) => o.type === 'option' && !o.unknown)
    .map((o) => clean(o.label));
  const issues = [];
  if (/\shoặc\s/iu.test(question.text)) issues.push('compound_question');
  const symptomName =
    'đau đầu|chóng mặt|mờ mắt|tim đập nhanh|khó thở|đau ngực|buồn nôn|đau bụng|tiêu chảy|sốt|ớn lạnh';
  if (
    new RegExp(
      `(?:${symptomName})[^.?!]{0,24}\\s(?:và|hoặc|hay)\\s[^.?!]{0,24}(?:${symptomName})`,
      'iu'
    ).test(question.text)
  )
    issues.push('multiple_symptoms');
  if (
    labels.some((label) =>
      /(?:cả (?:hai|ba|bốn|2|3|4)|tất cả).*(?:cách|loại|trên|triệu chứng)|^cả (?:hai|ba|bốn|2|3|4)$/u.test(
        label
      )
    )
  )
    issues.push('combined_options');
  if (
    labels.some((label) =>
      /^(?:có[,\s:]+)?ảnh hưởng (?:nhiều|ít|vừa)(?: đến sinh hoạt)?$/u.test(label)
    )
  )
    issues.push('vague_impact');
  const dominant = /(?:chính|nổi bật|khó chịu|thường gặp|thường xảy ra|nhiều|rõ) nhất/iu.test(
    question.text
  );
  if (
    !dominant &&
    new Set(labels.map((label) => label.match(symptom)?.[0]).filter(Boolean)).size > 1
  )
    issues.push('multiple_symptoms');
  if (
    !dominant &&
    labels.filter((label) =>
      /đầu giấc|giữa giấc|cuối giấc|mới lên giường|giữa đêm|sáng.*(?:giấc|sớm)/u.test(label)
    ).length > 1
  )
    issues.push('multiple_symptoms');
  if (
    /các (?:triệu chứng|biểu hiện).*(?:sau|nào)|(?:triệu chứng|biểu hiện) (?:sau|nào|gì|khác)/iu.test(
      question.text
    ) &&
    !dominant
  )
    issues.push('multiple_symptoms');
  return [...new Set(issues)];
}
const questionMessages = {
  compound_question:
    'Mỗi câu chỉ hỏi một ý. Tách các nội dung nối bằng “hoặc” thành câu hỏi riêng.',
  combined_options:
    'Không dùng đáp án “cả hai/cả ba”. Hỏi riêng một ý để người bệnh chọn đúng trường hợp của mình.',
  vague_impact:
    'Thay “Ảnh hưởng nhiều/ít” bằng ảnh hưởng cụ thể, ví dụ vẫn sinh hoạt được hoặc phải ngừng việc đang làm.',
  multiple_symptoms:
    'Câu chọn một đang liệt kê các biểu hiện có thể cùng xảy ra. Hỏi riêng từng biểu hiện hoặc hỏi biểu hiện khó chịu nhất.',
};
function asksForMoreInformation(text) {
  return /[?？]|(?:cho (?:tôi|bác sĩ|mình) biết|chia sẻ thêm|cung cấp thêm (?:thông tin|chi tiết)|vui lòng trả lời|please (?:tell|share|answer)|could you|can you tell)/iu.test(
    String(text || '')
  );
}
function applyReportQuality(report, generated) {
  if (typeof generated?.summary !== 'string' || typeof generated?.draft_reply !== 'string')
    throw new Error('Invalid report');
  report.summary = generated.summary.split('\n').slice(0, 5).join('\n').slice(0, 2500);
  const incomplete = report.insufficient || report.completion !== 'full';
  report.needs_follow_up =
    incomplete ||
    generated.needs_follow_up === true ||
    asksForMoreInformation(generated.draft_reply);
  report.follow_up_reason = report.needs_follow_up
    ? typeof generated.follow_up_reason === 'string' && generated.follow_up_reason.trim()
      ? generated.follow_up_reason.trim().slice(0, 1000)
      : 'Bác sĩ cần kiểm tra thông tin còn thiếu và hỏi bổ sung trước khi gửi kết quả cuối.'
    : null;
  // A question asking for more information must never masquerade as a final reply.
  report.draft_reply = report.needs_follow_up
    ? ''
    : generated.draft_reply
        .trim()
        .replace(/\*\*([^]*?)\*\*/gu, '$1')
        .replace(/^#{1,6}\s+/gmu, '')
        .replace(/^\s*[-*]\s+/gmu, '• ')
        .slice(0, 5000);
  return report;
}
function reportFlags(history, answers, content) {
  const unique = new Map();
  for (const event of history) {
    const question = content.questions.find((q) => q.id === event.question_id);
    const label = event.label || question?.text || event.question_id;
    const answer = answers.find((a) => a.question_id === event.question_id);
    const option = question?.options.find((o) => o.id === answer?.option_id);
    const current = !!answer?.is_red_flag && (!event.label || option?.label === event.label);
    unique.set(`${event.question_id}:${clean(label)}`, { ...event, label, resolved: !current });
  }
  const all = [...unique.values()];
  return {
    red_flags: all.filter((flag) => !flag.resolved),
    red_flag_history: all.filter((flag) => flag.resolved),
  };
}
module.exports = {
  questionIssues,
  questionMessages,
  asksForMoreInformation,
  applyReportQuality,
  reportFlags,
};
