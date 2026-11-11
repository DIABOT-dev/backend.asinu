'use strict';
const options = {
  symptoms: [
    ['joint_swelling', 'Sưng khớp'],
    ['numbness', 'Tê tay chân'],
    ['pain', 'Đau nhức'],
    ['stiffness', 'Cứng khớp'],
    ['warmth', 'Nóng đỏ'],
    ['weakness', 'Yếu cơ'],
  ],
  impact: [
    ['normal', 'Vẫn sinh hoạt bình thường'],
    ['slowed', 'Làm chậm hơn nhưng vẫn tự làm được'],
    ['unable', 'Có việc cần người giúp'],
  ],
  onset: [
    ['under_day', 'Dưới 24 giờ'],
    ['under_three_days', 'Từ 24 giờ đến dưới 3 ngày'],
    ['under_week', 'Từ 3 đến dưới 7 ngày'],
    ['week_or_more', 'Từ 7 ngày trở lên'],
  ],
  progression: [
    ['better', 'Đang đỡ dần'],
    ['same', 'Vẫn như cũ'],
    ['worse', 'Có vẻ nặng hơn'],
  ],
  pattern: [
    ['continuous', 'Liên tục'],
    ['episodic', 'Từng cơn'],
    ['once', 'Chỉ một lần'],
  ],
  episode_duration: [
    ['under_minute', 'Dưới 1 phút'],
    ['few_minutes', 'Từ 1 đến dưới 5 phút'],
    ['longer', 'Từ 5 phút trở lên'],
  ],
  aggravating: [
    ['movement', 'Khi vận động'],
    ['no_trigger', 'Chưa thấy điều gì làm tăng'],
  ],
  actions: [
    ['rest_helped', 'Nghỉ ngơi và thấy đỡ'],
    ['nothing', 'Chưa thử cách nào'],
  ],
  character: [
    ['left_knee', 'Ở khớp gối trái'],
    ['right_knee', 'Ở khớp gối phải'],
  ],
  clinical_context: [
    ['medication_as_planned', 'Đã dùng thuốc theo hướng dẫn'],
    ['medication_issue', 'Quên hoặc đổi thuốc gần đây'],
    ['no_medication', 'Hiện không có thuốc được kê'],
    ['reading_available', 'Đã đo chỉ số hôm nay'],
    ['not_measured', 'Hôm nay chưa đo chỉ số'],
  ],
  source: [
    ['chronic', 'Biểu hiện bệnh nền cũ tái xuất hiện'],
    ['medication', 'Quên thuốc hoặc mới đổi thuốc'],
    ['nutrition', 'Bỏ bữa hoặc ăn uống khác thường'],
    ['activity', 'Ngã hoặc vận động mạnh'],
    ['environment', 'Thiếu ngủ hoặc căng thẳng'],
    ['acute_illness', 'Mới sốt hoặc ho'],
  ],
  associated: [
    ['fever', 'Có sốt'],
    ['sleep', 'Khó ngủ hơn'],
  ],
};
const questions = {
  symptoms: 'Hiện giờ, {h} đang cảm thấy khó chịu như thế nào?',
  red_flags: '{H} có gặp dấu hiệu nào dưới đây ngay lúc này không?',
  impact: 'Những khó chịu này ảnh hưởng thế nào đến sinh hoạt hằng ngày của {h}?',
  onset: 'Những khó chịu này bắt đầu từ khi nào vậy?',
  progression: 'Từ lúc mới bị đến giờ, {h} thấy đỡ hơn, vẫn vậy hay nặng hơn?',
  pattern: 'Khó chịu này xảy ra liên tục, từng cơn hay chỉ một lần?',
  episode_duration: 'Mỗi cơn khó chịu kéo dài bao lâu vậy?',
  aggravating: 'Điều gì làm những khó chịu này tăng lên?',
  actions: '{H} đã thử cách nào và thấy có đỡ không?',
  character: '{H} đang khó chịu ở khớp nào vậy?',
  clinical_context: 'Hôm nay {h} dùng thuốc và đo chỉ số như thế nào?',
  source: 'Trước lúc khó chịu, {h} có gặp việc nào dưới đây không?',
  associated: 'Ngoài những điều đã kể, {h} có thay đổi nào khác không?',
};
function providerResponse(params) {
  if (
    params.system.startsWith('Review one health intake') ||
    params.system.startsWith('Review patient fact')
  )
    return { content: JSON.stringify({ valid: true, errors: [] }) };
  const context = JSON.parse(params.prompt).CONTEXT;
  const field = context.field;
  if (params.system.startsWith('Extract explicitly')) {
    const answerIndex = context.answer_index;
    const known = context.concerns;
    const new_concerns =
      field === 'symptoms' && !known.length
        ? [
            {
              id: 'new_1',
              label: context.answer.split(',')[0],
              quote: context.answer.split(',')[0],
              answer_index: answerIndex,
              region: null,
              detail_fields: ['character'],
            },
          ]
        : [];
    return {
      content: JSON.stringify({
        new_concerns,
        facts: [],
        global_answer: { relevant: true, quote: context.answer },
      }),
    };
  }
  if (['measurement', 'measurements'].includes(field))
    return {
      content: JSON.stringify({
        field,
        question: 'Kết quả đo hôm nay là bao nhiêu, đơn vị gì và đo lúc nào?',
        options: [],
      }),
    };
  if (field === 'clarify')
    return {
      content: JSON.stringify({
        field,
        question: 'Chú muốn ghi nhận theo mô tả nào dưới đây?',
        options: context.required_options,
      }),
    };
  const targets = context.target_concerns?.map((c) => c.label).join(' và ');
  let question = questions[field]
    .replaceAll('{h}', context.addressing.honorific)
    .replaceAll(
      '{H}',
      context.addressing.honorific[0].toUpperCase() + context.addressing.honorific.slice(1)
    );
  if (targets && field === 'onset')
    question = `${targets.length > 100 ? 'Những khó chịu này' : `Tình trạng ${targets}`} của ${context.addressing.honorific} bắt đầu từ khi nào vậy?`;
  if (targets && field === 'progression')
    question = `${targets} đỡ hơn, vẫn vậy hay nặng hơn so với lúc đầu?`;
  if (targets && field === 'character') question = `${targets} cụ thể ở chỗ nào vậy?`;
  const choices =
    field === 'red_flags'
      ? context.required_options
      : options[field].map(([id, label]) => ({ id, label }));
  if (context.allow_different)
    choices.push({
      id: 'different',
      label:
        field === 'onset'
          ? 'Mỗi triệu chứng bắt đầu một lúc khác nhau'
          : 'Mỗi triệu chứng thay đổi khác nhau',
    });
  return {
    content: JSON.stringify({
      field,
      question,
      options: context.required_option_ids
        ? choices.filter((c) => context.required_option_ids.includes(c.id))
        : choices,
    }),
  };
}
module.exports = { options, providerResponse };
