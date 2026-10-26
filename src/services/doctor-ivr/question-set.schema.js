'use strict';
const { z } = require('zod');
const { questionIssues, questionMessages } = require('./content-quality');
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const words = (value) => value.trim().split(/\s+/u).filter(Boolean).length;
const phrase = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(600)
    .refine((value) => words(value) <= max, `Maximum ${max} words`);
const range = z
  .object({
    min: z.number().finite().nullable(),
    max: z.number().finite().nullable(),
    include_min: z.boolean(),
    include_max: z.boolean(),
  })
  .strict();
const option = z
  .object({
    id: identifier,
    key: z.number().int().min(1).max(6),
    label: phrase(8),
    type: z.enum(['option', 'voice']),
    max_record_s: z.number().int().optional(),
    next: identifier.optional(),
    red_flag: z.boolean().optional(),
    suggested_red_flag: z.boolean().optional(),
    unknown: z.boolean().optional(),
    range: range.optional(),
  })
  .strict();
const question = z
  .object({
    id: identifier,
    text: phrase(25),
    fixed: z.boolean().optional(),
    unit: z.string().max(30).optional(),
    options: z.array(option).min(2).max(6),
  })
  .strict();
const base = z
  .object({
    title: phrase(15),
    est_duration_s: z.number().int().positive().max(180),
    greeting: z.string().max(400),
    questions: z.array(question).min(2).max(8),
    closing: z.string().max(400),
  })
  .strict();
const normalize = (value) =>
  value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('vi')
    .replace(/[.,!?;]+/gu, '')
    .replace(/\s+/gu, ' ');
function estimateDuration(content) {
  const spoken = [
    content.greeting,
    content.closing,
    ...content.questions.flatMap((q) => [q.text, ...q.options.map((o) => `${o.key} ${o.label}`)]),
  ].join(' ');
  return Math.ceil(words(spoken) / 2.7 + content.questions.length * 5);
}
function validateQuestionSet(value, { supplement = false } = {}) {
  const content = base.parse(value);
  const fail = (message) => {
    throw Object.assign(new Error(message), { statusCode: 400, code: 'IVR_INVALID_QUESTION_SET' });
  };
  const count = content.questions.length - 1;
  if (count < (supplement ? 1 : 3) || count > (supplement ? 3 : 7))
    fail('Cần 3–7 câu nội dung; phiên bổ sung có 1–3 câu.');
  const ids = new Set(),
    texts = new Set(),
    allOptions = new Set();
  for (const [index, q] of content.questions.entries()) {
    if (ids.has(q.id)) fail('Mã câu hỏi bị trùng.');
    ids.add(q.id);
    if (texts.has(normalize(q.text)))
      fail('Câu hỏi bị lặp. Mỗi câu chỉ khai thác một thông tin còn thiếu.');
    texts.add(normalize(q.text));
    const issue = questionIssues(q)[0];
    if (issue) fail(`Câu ${index + 1}: ${questionMessages[issue]}`);
    const final = index === content.questions.length - 1;
    const labels = new Set();
    for (const [i, o] of q.options.entries()) {
      if (
        o.type === 'option' &&
        /^(?:không rõ|không biết|không nhớ|chưa rõ)$/u.test(normalize(o.label))
      )
        o.unknown = true;
      if (allOptions.has(o.id) || labels.has(normalize(o.label))) fail('Đáp án bị trùng.');
      allOptions.add(o.id);
      labels.add(normalize(o.label));
      if (o.key !== i + 1) fail('Phím đáp án phải liên tục từ 1.');
      if (o.next && (final || content.questions.findIndex((item) => item.id === o.next) <= index))
        fail('Nhánh tiếp theo phải trỏ tới một câu phía sau, không tạo vòng lặp.');
    }
    const voice = q.options.filter((o) => o.type === 'voice');
    if (final) {
      if (
        q.id !== 'q_final' ||
        !q.fixed ||
        !/^(?:anh\/chị|anh|chị|ông|bà|cô|chú|bác) có muốn hỏi bác sĩ điều gì không\?$/iu.test(
          q.text
        )
      )
        fail('Câu kết cố định không hợp lệ.');
      if (
        q.options.length !== 2 ||
        q.options[0].type !== 'option' ||
        normalize(q.options[0].label) !== 'không' ||
        q.options.some((o) => o.red_flag) ||
        voice.length !== 1 ||
        q.options[1].type !== 'voice' ||
        q.options[1].max_record_s !== 60
      )
        fail('Câu kết cần Không / Có, ghi âm tối đa 60 giây.');
    } else {
      if (
        q.fixed ||
        voice.length !== 1 ||
        q.options.at(-1).type !== 'voice' ||
        voice[0].max_record_s !== 30 ||
        !/^khác\b/iu.test(voice[0].label)
      )
        fail('Mỗi câu phải kết thúc bằng Khác, nói câu trả lời (30 giây).');
      const ordinary = q.options.filter((o) => o.type === 'option' && !o.unknown);
      if (ordinary.length < 2 || ordinary.length > 4) fail('Mỗi câu cần 2–4 đáp án nội dung.');
      const measurement = /đường huyết|huyết áp|cân nặng|nhiệt độ/iu.test(q.text);
      if (
        q.unit ||
        ordinary.some((o) => o.range) ||
        /bao lâu|bao nhiêu (?:phút|giờ|ngày|tuần|tháng)|số ngày/iu.test(q.text) ||
        ordinary.some((o) => /\d.*(?:phút|giờ|ngày|tuần|tháng)/iu.test(o.label)) ||
        (measurement &&
          (/bao nhiêu|khoảng nào|chỉ số|số đo|đo được|mức nào/iu.test(q.text) ||
            ordinary.some((o) => /\d/u.test(o.label))))
      ) {
        if (!q.unit || ordinary.some((o) => !o.range))
          fail('Câu hỏi số đo cần đơn vị và khoảng số cho từng đáp án.');
        const ranges = ordinary.map((o) => o.range);
        if (ranges[0].min !== null || ranges.at(-1).max !== null)
          fail('Khoảng số phải bao phủ cả hai đầu.');
        for (const [i, r] of ranges.entries()) {
          if (r.min !== null && r.max !== null && r.min >= r.max) fail('Khoảng số không hợp lệ.');
          if (
            i &&
            (ranges[i - 1].max === null ||
              r.min !== ranges[i - 1].max ||
              r.include_min === ranges[i - 1].include_max)
          )
            fail('Khoảng số không được hở hoặc chồng lấn.');
        }
      }
    }
  }
  const duration = estimateDuration(content);
  if (duration > 180) fail('Nội dung đọc quá dài cho phiên 3 phút.');
  return { ...content, est_duration_s: duration };
}
function nextQuestion(content, questionId, optionId) {
  const index = content.questions.findIndex((q) => q.id === questionId);
  if (index < 0)
    throw Object.assign(new Error('Question not found'), {
      statusCode: 400,
      code: 'IVR_INVALID_ANSWER',
    });
  const option = content.questions[index].options.find((o) => o.id === optionId);
  return option?.next || content.questions[index + 1]?.id || null;
}
function fixedFinal(address = 'Anh/chị') {
  return {
    id: 'q_final',
    fixed: true,
    text: `${address} có muốn hỏi bác sĩ điều gì không?`,
    options: [
      { id: 'qf_no', key: 1, label: 'Không', type: 'option' },
      { id: 'qf_yes', key: 2, label: 'Có, tôi muốn hỏi', type: 'voice', max_record_s: 60 },
    ],
  };
}
// IDs, keypad numbers and mandatory voice/final choices are application rules.
// Let the model spend its output on clinical questions, then add these rules once.
function generatedOptions(q) {
  const fixed = {
    yes_no: ['Có', 'Không'],
    frequency: ['Thường xuyên', 'Thỉnh thoảng', 'Không'],
    impact: [
      'Vẫn sinh hoạt như thường',
      'Cần nghỉ rồi mới làm tiếp',
      'Không làm được việc thường ngày',
    ],
  };
  let options;
  if (fixed[q.answer_kind]) {
    if (q.options || q.thresholds || q.unit)
      throw new Error(
        'Dạng Có/Không, tần suất, ảnh hưởng không cần options, unit hoặc thresholds.'
      );
    options = fixed[q.answer_kind].map((label) => ({ label }));
  } else if (q.answer_kind === 'numeric') {
    if (
      !q.unit?.trim() ||
      !q.thresholds?.length ||
      q.options ||
      q.thresholds.some((n, i, list) => i > 0 && n <= list[i - 1])
    )
      throw new Error('Dạng numeric cần unit ở câu hỏi và thresholds tăng dần, không cần options.');
    const bounds = [null, ...q.thresholds, null];
    const number = (n) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 6 }).format(n);
    options = bounds.slice(0, -1).map((min, index) => {
      const max = bounds[index + 1];
      return {
        label:
          min === null
            ? `Dưới ${number(max)} ${q.unit}`
            : max === null
              ? `Từ ${number(min)} ${q.unit} trở lên`
              : `Từ ${number(min)} đến dưới ${number(max)} ${q.unit}`,
        range: { min, max, include_min: min !== null, include_max: false },
      };
    });
  } else {
    if (!q.options || q.thresholds)
      throw new Error('Câu chọn một cần options, hoặc dùng answer_kind có sẵn.');
    options = q.options;
  }
  if (q.suggested_red_flag_keys?.some((key) => key > options.length))
    throw new Error('Gợi ý cần chú ý phải trỏ tới một đáp án có thật.');
  return options.map((o, index) => ({
    ...o,
    ...(q.suggested_red_flag_keys?.includes(index + 1) ? { suggested_red_flag: true } : {}),
  }));
}
function materializeGeneratedQuestions(value, address = 'Anh/chị') {
  if (value?.questions?.at?.(-1)?.id === 'q_final') return value;
  const generated = z
    .object({
      title: phrase(15),
      questions: z
        .array(
          z
            .object({
              text: phrase(25),
              focus: z
                .enum(['symptom', 'onset', 'course', 'impact', 'context', 'safety'])
                .optional(),
              answer_kind: z
                .enum(['yes_no', 'frequency', 'impact', 'numeric', 'single_choice'])
                .optional(),
              unit: z.string().max(30).optional(),
              thresholds: z.array(z.number().finite()).min(1).max(3).optional(),
              suggested_red_flag_keys: z.array(z.number().int().min(1).max(4)).max(4).optional(),
              options: z
                .array(
                  z
                    .object({
                      label: phrase(8),
                      unknown: z.boolean().optional(),
                      range: range.optional(),
                      suggested_red_flag: z.boolean().optional(),
                    })
                    .strict()
                )
                .min(2)
                .max(5)
                .optional(),
            })
            .strict()
        )
        .min(1)
        .max(7),
    })
    .strict()
    .parse(value);
  const focuses = generated.questions.map((q) => q.focus).filter(Boolean);
  if (new Set(focuses).size !== focuses.length)
    throw new Error('Các câu phải có focus khác nhau; không hỏi nhiều câu cùng khai thác một ý.');
  if (generated.questions.some((q) => q.answer_kind && !q.focus))
    throw new Error('Mỗi câu dùng answer_kind cần focus để tránh hỏi trùng ý.');
  return {
    title: generated.title,
    est_duration_s: 150,
    greeting: `Chào ${address.toLocaleLowerCase('vi')}. Bác sĩ cần hỏi thêm một vài câu.`,
    closing: `Cảm ơn ${address.toLocaleLowerCase('vi')}. Bác sĩ sẽ trả lời trên ứng dụng Asinu.`,
    questions: generated.questions
      .map((q, index) => {
        const choices = generatedOptions(q);
        return {
          id: `q${index + 1}`,
          // The impact choices measure daily functioning; their question must
          // ask about that same dimension, rather than sleep, pain or frequency.
          text:
            q.answer_kind === 'impact'
              ? `Tình trạng này ảnh hưởng đến sinh hoạt của ${address.toLocaleLowerCase('vi')} thế nào?`
              : q.text.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase('vi')),
          ...(q.unit ? { unit: q.unit } : {}),
          options: choices
            .map((o, optionIndex) => ({
              ...o,
              label: o.label.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase('vi')),
              id: `q${index + 1}_${optionIndex + 1}`,
              key: optionIndex + 1,
              type: 'option',
            }))
            .concat({
              id: `q${index + 1}_x`,
              key: choices.length + 1,
              label: 'Khác, nói câu trả lời',
              type: 'voice',
              max_record_s: 30,
            }),
        };
      })
      .concat(fixedFinal(address)),
  };
}
module.exports = {
  validateQuestionSet,
  estimateDuration,
  nextQuestion,
  fixedFinal,
  normalize,
  materializeGeneratedQuestions,
};
