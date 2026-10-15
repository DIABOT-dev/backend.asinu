// Plan the next conversational turn from patient answers across the case.
// Keep safety gaps in order while allowing the model to phrase them naturally.
const { filterAiOutput } = require('../ai/ai-safety.service');

const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (items, maximum = 4) => [...new Set(items.filter(Boolean))].slice(0, maximum);

const latestText = (context) => String(context?.latest_patient_message?.message || '').trim();

const patientMessages = (context = {}) => {
  const messages = (context.conversation || [])
    .filter((turn) => turn.role === 'patient' && typeof turn.message === 'string')
    .map((turn) => turn.message.trim())
    .filter(Boolean);
  const latest = latestText(context);
  if (latest && messages.at(-1) !== latest) messages.push(latest);
  return messages.slice(-12);
};

const concernOf = (message) => {
  const patterns = [
    ['headache', /đau đầu|nặng đầu|headache/iu],
    ['stomach', /đau bụng|stomach/iu],
    ['chest', /đau ngực|chest pain/iu],
    ['cough', /(?:^|[^\p{L}])ho(?:[^\p{L}]|$)|cough/iu],
    ['fatigue', /mệt|fatigue/iu],
  ];
  const matches = patterns.filter(([, pattern]) => {
    const match = pattern.exec(message);
    if (!match) return false;
    const before = message.slice(Math.max(0, match.index - 20), match.index);
    return !/(?:không|chưa|hết|no)\s*(?:còn\s*)?$/iu.test(before);
  });
  // Only identify an unambiguous single concern here.
  return matches.length === 1 ? matches[0][0] : null;
};

const activeConcernMessages = (context = {}) => {
  const messages = patientMessages(context);
  const concern = [...messages].reverse().map(concernOf).find(Boolean);
  if (!concern) return messages;
  // Do not reuse a previous, different complaint's duration or negatives.
  const previousConcernIndex = messages.findLastIndex((message) => {
    const previousConcern = concernOf(message);
    return previousConcern && previousConcern !== concern;
  });
  return messages.slice(previousConcernIndex + 1);
};

const conversationIntent = (context = {}) => {
  const lastTurn = context.conversation?.at(-1);
  if (lastTurn?.role === 'doctor') return 'awaiting_patient';
  const text = normalize(latestText(context))
    .replace(/[.!?,…]+/g, '')
    .trim();
  if (!text) return 'no_message';
  if (
    /^(?:(?:vâng|dạ|ừ|ok(?:ay)?|được|rồi|tôi hiểu rồi|mình hiểu rồi|đã rõ|cảm ơn(?:\s+(?:bác sĩ|bạn|anh|chị|nhiều))?|thank(?:s| you)(?: doctor)?|i understand|got it)(?:\s+(?:ạ|nhé|vâng|rồi|dạ|tôi hiểu rồi|mình hiểu rồi))?[\s,]*)+$/.test(
      text
    )
  ) {
    return 'acknowledgement';
  }
  if (
    /^(?:(?:xin )?chào(?: bác sĩ| bạn| anh| chị)?(?: ạ)?|hello(?: doctor)?|hi(?: doctor)?)$/.test(
      text
    )
  ) {
    return 'greeting';
  }
  return 'clinical';
};

const hasAny = (text, terms) => terms.some((term) => text.includes(normalize(term)));

const planHeadacheQuestions = (text, locale) => {
  const vi = locale !== 'en';
  const signs = [
    {
      vi: 'yếu hoặc tê một bên',
      en: 'one-sided weakness or numbness',
      viParts: ['yếu một bên', 'tê một bên'],
      enParts: ['one-sided weakness', 'one-sided numbness'],
      terms: [
        ['yếu', 'weakness', 'weak'],
        ['tê', 'numbness', 'numb'],
      ],
    },
    {
      vi: 'khó nói',
      en: 'trouble speaking',
      terms: [['nói khó', 'khó nói', 'trouble speaking', 'speech']],
    },
    { vi: 'nhìn mờ', en: 'blurred vision', terms: [['nhìn mờ', 'nhìn đôi', 'thị lực', 'vision']] },
    { vi: 'lú lẫn', en: 'confusion', terms: [['lú lẫn', 'confusion', 'confused']] },
    { vi: 'cứng gáy', en: 'a stiff neck', terms: [['cứng gáy', 'stiff neck']] },
    { vi: 'ngất', en: 'fainting', terms: [['ngất', 'fainting', 'fainted']] },
    { vi: 'nôn liên tục', en: 'repeated vomiting', terms: [['nôn', 'vomiting', 'vomit']] },
  ];
  const unansweredSigns = signs.filter((sign) => !sign.terms.every((terms) => hasAny(text, terms)));
  const signLabel = (sign) => {
    const indexes = sign.terms
      .map((terms, index) => (hasAny(text, terms) ? -1 : index))
      .filter((index) => index >= 0);
    return indexes.length === 1 && sign.viParts
      ? vi
        ? sign.viParts[indexes[0]]
        : sign.enParts[indexes[0]]
      : vi
        ? sign.vi
        : sign.en;
  };
  const signQuestion = (group, id) => ({
    id,
    category: 'danger',
    text: vi
      ? `Ngoài đau đầu, bạn có ${group.map(signLabel).join(', ')} không?`
      : `Any ${group.map(signLabel).join(', ')} along with the headache?`,
    keywords: group.flatMap((sign) => sign.terms.filter((terms) => !hasAny(text, terms))),
    answered: group.length === 0,
  });
  const questions = [
    {
      id: 'headache_onset_safety',
      category: 'danger',
      text: vi
        ? 'Cơn đau đến đột ngột và dữ dội ngay từ đầu, hay tăng dần?'
        : 'Did the headache come on suddenly and severely, or build up gradually?',
      keywords: [
        ['đột ngột', 'bất ngờ', 'sudden'],
        ['dữ dội', 'nặng nhất', 'severe', 'worst'],
      ],
      answered: hasAny(text, [
        'đột ngột',
        'dữ dội nhất',
        'tăng dần',
        'từ từ',
        'worst headache',
        'sudden',
        'gradual',
      ]),
    },
    signQuestion(
      unansweredSigns.filter((sign) => signs.indexOf(sign) < 4),
      'headache_neurological_signs'
    ),
    signQuestion(
      unansweredSigns.filter((sign) => signs.indexOf(sign) >= 4),
      'headache_other_signs'
    ),
    {
      id: 'symptom_duration',
      category: 'cause',
      text: vi ? 'Bạn bắt đầu đau đầu từ khi nào?' : 'When did the headache first start?',
      keywords: [['từ khi', 'bao lâu', 'khi nào', 'bắt đầu', 'when', 'how long', 'start']],
      answered: hasDuration(text),
    },
    {
      id: 'headache_context',
      category: 'cause',
      text: vi
        ? 'Gần đây bạn ngủ thế nào, có phải nhìn màn hình nhiều không?'
        : 'How has your sleep been, and have you been spending a lot of time on screens?',
      keywords: [['ngủ', 'màn hình', 'sleep', 'screen']],
      answered: hasAny(text, [
        'màn hình',
        'thiếu ngủ',
        'ngủ',
        'căng thẳng',
        'tư thế',
        'ánh sáng',
        'screen',
        'stress',
        'sleep',
      ]),
    },
    {
      id: 'blood_pressure',
      category: 'risk',
      text: vi
        ? 'Bạn đã đo huyết áp gần đây chưa, nếu có thì chỉ số thế nào?'
        : 'Have you checked your blood pressure recently, and what was the reading if you did?',
      keywords: [['huyết áp', 'blood pressure']],
      answered: hasAny(text, ['huyết áp', 'blood pressure', 'mmhg']),
    },
    {
      id: 'self_care_response',
      category: 'follow_up',
      text: vi
        ? 'Lúc nghỉ ngơi, cảm giác đau đầu có giảm không?'
        : 'Does the headache ease when you rest?',
      keywords: [['nghỉ', 'đỡ', 'giảm', 'rest', 'ease', 'better']],
      answered: hasAny(text, [
        'đã thử',
        'đỡ',
        'không đỡ',
        'cải thiện',
        'tried',
        'improved',
        'better',
      ]),
    },
  ];
  return questions;
};

const planGenericQuestions = (text, locale) => {
  const vi = locale !== 'en';
  return [
    {
      id: 'symptom_progression',
      category: 'danger',
      text: vi
        ? 'So với lúc mới bắt đầu, hiện bạn thấy đỡ hơn hay nặng lên?'
        : 'Compared with when it started, is it getting better or worse?',
      keywords: [['đỡ', 'nặng', 'thay đổi', 'better', 'worse', 'worsen']],
      answered: hasAny(text, [
        'đột ngột',
        'nặng lên',
        'đỡ hơn',
        'không đỡ',
        'cải thiện',
        'sudden',
        'worsening',
        'better',
        'worse',
      ]),
    },
    {
      id: 'symptom_duration',
      category: 'cause',
      text: vi ? 'Tình trạng này bắt đầu từ khi nào?' : 'When did this first start?',
      keywords: [['từ khi', 'bao lâu', 'khi nào', 'bắt đầu', 'when', 'how long', 'start']],
      answered: hasDuration(text),
    },
    {
      id: 'medical_history',
      category: 'risk',
      text: vi
        ? 'Bạn đang theo dõi bệnh nào hoặc dùng thuốc hằng ngày không?'
        : 'Are you being treated for any ongoing conditions or taking regular medicines?',
      keywords: [['bệnh', 'thuốc', 'condition', 'medicine', 'medication']],
      answered: hasAny(text, ['bệnh nền', 'dị ứng', 'thuốc đang dùng', 'allerg', 'medication']),
    },
    {
      id: 'self_care_response',
      category: 'follow_up',
      text: vi
        ? 'Bạn đã thử cách gì để thấy dễ chịu hơn chưa?'
        : 'Have you tried anything that helped you feel better?',
      keywords: [['đã thử', 'cách', 'dễ chịu', 'tried', 'help', 'better']],
      answered: hasAny(text, ['đã thử', 'đáp ứng', 'cải thiện', 'tried', 'response', 'nghỉ ngơi']),
    },
  ];
};

const hasDuration = (text) =>
  /\b\d+\s*(?:ngày|giờ|phút|tuần|tháng|hôm|day|hour|minute|week|month)/u.test(
    // Hours of sleep are not the duration of the presenting symptom.
    text.replace(
      /(?:ngủ|sleep|slept|sleeping)\s*(?:(?:khoảng|chỉ|có|about|only|for)\s*)*\d+\s*(?:giờ|hours?)/giu,
      ''
    )
  ) ||
  hasAny(text, [
    'từ hôm',
    'từ sáng',
    'từ tối',
    'hôm qua',
    'sáng nay',
    'tối qua',
    'yesterday',
    'this morning',
    'since',
  ]);

const repeatedDurationQuestion = ({ context = {}, text = '' } = {}) => {
  if (!hasDuration(normalize(activeConcernMessages(context).join('\n')))) return false;
  const questions = String(text).match(/[^.!?\n]*\?/g) || [];
  return questions.some((question) => {
    const normalized = normalize(question);
    // Duration of each episode remains a valid distinct question.
    if (/mỗi lần|mỗi cơn|each episode|each time/.test(normalized)) return false;
    return /(?:bắt đầu|xuất hiện).{0,40}(?:khi nào|bao lâu)|(?:kéo dài|diễn ra).{0,30}bao lâu|when.{0,50}(?:start|begin)|how long.{0,45}(?:symptom|headache|this|it|been|feel)/iu.test(
      normalized
    );
  });
};

const buildQuestionPlan = ({ context = {}, locale = 'vi' } = {}) => {
  const intent = conversationIntent(context);
  if (['no_message', 'acknowledgement', 'awaiting_patient'].includes(intent)) return [];
  if (intent === 'greeting')
    return [
      {
        id: 'opening',
        category: 'opening',
        text:
          locale === 'en'
            ? 'What would you like help with today?'
            : 'Bạn đang cần mình hỗ trợ điều gì?',
        keywords: [['hỗ trợ', 'trao đổi', 'vấn đề', 'help', 'concern']],
      },
    ];
  const messages = activeConcernMessages(context);
  const text = normalize(messages.join('\n'));
  // A short answer keeps the current concern; an explicit new complaint takes
  // precedence over symptoms mentioned in an older turn.
  const currentConcern =
    [...messages].reverse().find((message) => concernOf(message)) || latestText(context);
  const headache = hasAny(normalize(currentConcern), ['đau đầu', 'nặng đầu', 'headache']);
  const candidates = headache
    ? planHeadacheQuestions(text, locale)
    : planGenericQuestions(text, locale);
  const profile = context.profile || {};
  return candidates
    .filter((candidate) => {
      if (candidate.answered) return false;
      if (candidate.id === 'blood_pressure' && context.blood_pressure?.length) return false;
      if (
        candidate.id === 'medical_history' &&
        profile.conditions?.length &&
        context.medications?.length
      )
        return false;
      return true;
    })
    .slice(0, 2);
};

const planClarifyingQuestions = (input) => buildQuestionPlan(input).map((item) => item.text);

const resolveClarifyingQuestions = ({ context = {}, locale = 'vi', generated = [] } = {}) => {
  const used = new Set();
  const documented = JSON.stringify({
    profile: context.profile,
    messages: patientMessages(context),
    blood_pressure: context.blood_pressure,
    glucose: context.glucose,
  });
  const knownNumbers = new Set(documented.match(/\d+(?:[.,]\d+)?/g) || []);
  return buildQuestionPlan({ context, locale }).map((item) => {
    const question = generated.find((value) => {
      if (
        typeof value !== 'string' ||
        used.has(value) ||
        value.length > 180 ||
        value.includes('\n') ||
        (value.match(/\?/g) || []).length > 1
      )
        return false;
      const text = normalize(value);
      if (
        /vui lòng cung cấp|yếu tố nguy cơ|đánh giá lâm sàng|as an ai|comprehensive assessment|provide detailed/i.test(
          text
        )
      )
        return false;
      if ((value.match(/\d+(?:[.,]\d+)?/g) || []).some((number) => !knownNumbers.has(number)))
        return false;
      if (!item.keywords.every((terms) => hasAny(text, terms))) return false;
      return !filterAiOutput(value, 'low', locale).modified;
    });
    if (question) used.add(question);
    return question?.trim() || item.text;
  });
};

const buildGroundingFacts = (context = {}) => {
  const facts = [];
  const message = latestText(context);
  if (message) facts.push(`Tin nhắn bệnh nhân gần nhất (nguyên văn): ${message.slice(0, 4_000)}`);
  const profile = context.profile || {};
  if (profile.birth_year) facts.push(`Năm sinh hồ sơ: ${profile.birth_year}`);
  if (profile.gender) facts.push(`Giới tính hồ sơ: ${profile.gender}`);
  if (Array.isArray(profile.conditions) && profile.conditions.length)
    facts.push(`Bệnh nền đã ghi nhận: ${profile.conditions.join(', ')}`);
  if (Array.isArray(profile.chronic_symptoms) && profile.chronic_symptoms.length)
    facts.push(`Triệu chứng mạn đã ghi nhận: ${profile.chronic_symptoms.join(', ')}`);
  if (Array.isArray(context.medications) && context.medications.length)
    facts.push(
      `Thuốc đã ghi nhận: ${context.medications.map((item) => [item.med_name, item.dose_text, item.frequency_text].filter(Boolean).join(' ')).join('; ')}`
    );
  if (Array.isArray(context.blood_pressure) && context.blood_pressure.length)
    facts.push(`Huyết áp gần nhất: ${JSON.stringify(context.blood_pressure[0])}`);
  if (Array.isArray(context.glucose) && context.glucose.length)
    facts.push(`Đường huyết gần nhất: ${JSON.stringify(context.glucose[0])}`);
  for (const message of patientMessages(context).slice(0, -1))
    facts.push(`Bệnh nhân đã trả lời trong ca này (nguyên văn): ${message.slice(0, 1000)}`);
  return unique(facts, 20);
};

const buildDeterministicClinicalSummary = ({ context = {}, locale = 'vi' } = {}) => {
  const facts = buildGroundingFacts(context);
  if (!facts.length)
    return locale === 'en'
      ? 'No documented clinical facts are available.'
      : 'Chưa có dữ kiện lâm sàng được ghi nhận.';
  return facts.join('\n').slice(0, 6_000);
};

module.exports = {
  buildGroundingFacts,
  buildDeterministicClinicalSummary,
  planClarifyingQuestions,
  buildQuestionPlan,
  resolveClarifyingQuestions,
  repeatedDurationQuestion,
  conversationIntent,
  __test__: { normalize, patientMessages },
};
