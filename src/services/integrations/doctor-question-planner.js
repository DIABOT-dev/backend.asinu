// Plan the next conversational turn from patient answers across the case.
// Keep safety gaps in order while allowing the model to phrase them naturally.
const { filterAiOutput } = require('../ai/ai-safety.service');
const { clinicalConversation } = require('./doctor-conversation-context');
const {
  resolveCommunicationStyle,
  addressQuestionTemplate,
} = require('./doctor-communication-style');

const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (items, maximum = 4) => [...new Set(items.filter(Boolean))].slice(0, maximum);

const latestText = (context) =>
  String(
    context?.latest_patient_message?.message || context?.initial_patient_statement?.message || ''
  ).trim();

const patientMessages = (context = {}) => {
  const messages = clinicalConversation(context)
    .filter((turn) => turn.role === 'patient' && typeof turn.message === 'string')
    .map((turn) => turn.message.trim())
    .filter(Boolean);
  const latest = latestText(context);
  if (latest && messages.at(-1) !== latest) messages.push(latest);
  return messages;
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
  const lastTurn = clinicalConversation(context).at(-1);
  if (lastTurn?.role === 'doctor') return 'awaiting_patient';
  const text = normalize(latestText(context))
    .replace(/[.!?,…]+/g, '')
    .trim();
  if (!text) return 'no_message';
  if (
    /^(?:(?:vâng|dạ|ừ|ok(?:ay)?|được|rồi|tôi hiểu rồi|mình hiểu rồi|đã rõ|cảm ơn(?:\s+(?:chuyên gia|bác sĩ|bạn|anh|chị|nhiều))?|thank(?:s| you)(?: doctor)?|i understand|got it)(?:\s+(?:ạ|nhé|vâng|rồi|dạ|tôi hiểu rồi|mình hiểu rồi))?[\s,]*)+$/.test(
      text
    )
  ) {
    return 'acknowledgement';
  }
  if (
    /^(?:(?:xin )?chào(?: chuyên gia| bác sĩ| bạn| anh| chị)?(?: ạ)?|hello(?: doctor)?|hi(?: doctor)?)$/.test(
      text
    )
  ) {
    return 'greeting';
  }
  return 'clinical';
};

const hasAny = (text, terms) => terms.some((term) => text.includes(normalize(term)));

const questionTopics = (question) => {
  const text = normalize(question);
  return Object.entries({
    onset: /đột ngột|bất ngờ|sudden/iu,
    weakness: /(?:^|[^\p{L}])yếu(?!\s+tố)(?:[^\p{L}]|$)|weak/iu,
    numbness: /(?:^|[^\p{L}])tê(?:[^\p{L}]|$)|numb/iu,
    speech: /khó nói|nói khó|trouble speaking|speech/iu,
    vision: /nhìn mờ|nhìn đôi|thị lực|vision/iu,
    confusion: /lú lẫn|confus/iu,
    stiff_neck: /cứng gáy|stiff neck/iu,
    fainting: /ngất|faint/iu,
    vomiting: /nôn|vomit/iu,
    duration: /khi nào|bao lâu|từ lúc|when.*(?:start|begin)|how long/iu,
    location: /(?:đau|khó chịu).{0,25}(?:ở đâu|vùng nào|chỗ nào)|where.{0,30}(?:pain|hurt)/iu,
    progression: /đỡ hơn|nặng lên|so với|better|worse/iu,
    blood_pressure: /huyết áp|blood pressure/iu,
  })
    .filter(([, pattern]) => pattern.test(text))
    .map(([topic]) => topic);
};

const uncertainAnswer = (text) =>
  /không (?:biết|rõ|nhớ|chắc|hiểu)|chưa (?:biết|rõ|nhớ|chắc|hiểu)|(?:not|don't|do not) (?:know|sure|remember|understand)|unsure/iu.test(
    text
  );

const questionSegments = (text) =>
  String(text)
    .split(/(?<=[?？])/u)
    .filter((part) => /[?？]$/u.test(part))
    .map((part) => part.trim());

const contextualAnswers = (context) => {
  const turns = clinicalConversation(context);
  const answers = [];
  let questions = [];
  let previousRole;
  for (const turn of turns) {
    if (turn.role === 'doctor') {
      if (previousRole !== 'doctor') questions = [];
      questions.push(turn);
    } else if (questions.length && !uncertainAnswer(turn.message)) {
      const answer = normalize(turn.message);
      const denial =
        /^(?:(?:dạ|vâng)\s+)?(?:không|ko|khong|no)(?:\s+(?:có|bị))?(?:\s+(?:(?:các|những|hai|ba|cả hai|cả ba|\d+)\s+)?(?:dấu hiệu|triệu chứng|biểu hiện)(?:\s+(?:đó|này|nào))?)?(?:\s+(?:nào|cả|hết|đâu|ạ|nhé))*[.!?,…]*$/u.test(
          answer
        );
      const affirmation =
        /^(?:(?:dạ|vâng)\s+)?(?:có|yes)(?:\s+(?:ạ|nhé|đúng rồi|i do))*[.!?,…]*$/u.test(answer);
      const questionParts = questions.flatMap((turn) =>
        questionSegments(turn.message).map((message) => ({
          ...turn,
          message: message.trim(),
        }))
      );
      const multipleQuestions = questionParts.length > 1;
      for (const question of questionParts) {
        const topics = questionTopics(question.message);
        const ambiguous =
          affirmation &&
          (multipleQuestions ||
            topics.length > 1 ||
            /(?:^|[^\p{L}])(?:hay|hoặc|or)(?:[^\p{L}]|$)/iu.test(question.message));
        const resolved = topics.filter((topic) => {
          if (denial) {
            if (['duration', 'location', 'blood_pressure', 'progression'].includes(topic))
              return false;
            if (topic === 'onset' && /hay|\bor\b/iu.test(question.message)) return false;
            return true;
          }
          if (
            affirmation &&
            !ambiguous &&
            !['duration', 'location', 'blood_pressure', 'progression'].includes(topic)
          )
            return true;
          // A short specific answer can resolve an open question. Never treat
          // an ambiguous "yes" to a list of symptoms as answering all of them.
          if (topic === 'duration') return hasDuration(answer);
          if (topic === 'location')
            return /rốn|bụng|ngực|trán|thái dương|sau gáy|bên (?:trái|phải)|navel|abdomen|left|right|forehead/iu.test(
              answer
            );
          if (topic === 'progression')
            return hasAny(answer, [
              'đỡ',
              'nặng hơn',
              'nặng lên',
              'như cũ',
              'better',
              'worse',
              'same',
            ]);
          return false;
        });
        answers.push({
          question: question.message,
          answer: turn.message,
          topics: resolved,
          ...(ambiguous ? { ambiguous: true } : {}),
        });
      }
    }
    previousRole = turn.role;
  }
  return answers;
};

const answeredTopics = (context) => {
  const activeMessages = new Set(activeConcernMessages(context));
  return new Set(
    contextualAnswers(context)
      .filter((item) => activeMessages.has(item.answer))
      .flatMap((item) => item.topics)
  );
};

const buildAnsweredQuestionEvidence = (context = {}) => {
  const activeMessages = activeConcernMessages(context);
  const activeAnswers = new Set(activeMessages);
  const evidence = contextualAnswers(context)
    .filter((item) => activeAnswers.has(item.answer) && item.topics.length)
    .map(({ question, answer, topics }) => ({ question, patient_answer: answer, topics }));
  const durationStatement = activeMessages.find(
    (message) => concernOf(message) && hasDuration(normalize(message))
  );
  if (durationStatement)
    evidence.unshift({
      question: 'When did the current symptom start or how long has it been present?',
      patient_answer: durationStatement,
      topics: ['duration'],
    });
  return evidence;
};

const planHeadacheQuestions = (text, locale, answered = new Set()) => {
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
      topics: ['weakness', 'numbness'],
    },
    {
      vi: 'khó nói',
      en: 'trouble speaking',
      terms: [['nói khó', 'khó nói', 'trouble speaking', 'speech']],
      topics: ['speech'],
    },
    {
      vi: 'nhìn mờ',
      en: 'blurred vision',
      terms: [['nhìn mờ', 'nhìn đôi', 'thị lực', 'vision']],
      topics: ['vision'],
    },
    {
      vi: 'lú lẫn',
      en: 'confusion',
      terms: [['lú lẫn', 'confusion', 'confused']],
      topics: ['confusion'],
    },
    {
      vi: 'cứng gáy',
      en: 'a stiff neck',
      terms: [['cứng gáy', 'stiff neck']],
      topics: ['stiff_neck'],
    },
    { vi: 'ngất', en: 'fainting', terms: [['ngất', 'fainting', 'fainted']], topics: ['fainting'] },
    {
      vi: 'nôn liên tục',
      en: 'repeated vomiting',
      terms: [['nôn', 'vomiting', 'vomit']],
      topics: ['vomiting'],
    },
  ];
  const isKnown = (sign, index) =>
    hasAny(text, sign.terms[index]) || answered.has(sign.topics[index]);
  const unansweredSigns = signs.filter(
    (sign) => !sign.terms.every((_, index) => isKnown(sign, index))
  );
  const signLabel = (sign) => {
    const indexes = sign.terms
      .map((_, index) => (isKnown(sign, index) ? -1 : index))
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
    keywords: group.flatMap((sign) => sign.terms.filter((_, index) => !isKnown(sign, index))),
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
      answered:
        answered.has('onset') ||
        hasAny(text, [
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
      answered: answered.has('duration') || hasDuration(text),
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
      answered:
        answered.has('blood_pressure') || hasAny(text, ['huyết áp', 'blood pressure', 'mmhg']),
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

const planGenericQuestions = (text, locale, answered = new Set()) => {
  const vi = locale !== 'en';
  return [
    {
      id: 'symptom_progression',
      category: 'danger',
      text: vi
        ? 'So với lúc mới bắt đầu, hiện bạn thấy đỡ hơn hay nặng lên?'
        : 'Compared with when it started, is it getting better or worse?',
      keywords: [['đỡ', 'nặng', 'thay đổi', 'better', 'worse', 'worsen']],
      answered:
        answered.has('progression') ||
        hasAny(text, [
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
      answered: answered.has('duration') || hasDuration(text),
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

const repeatedAnsweredQuestion = ({ context = {}, text = '' } = {}) => {
  const known = answeredTopics(context);
  return (String(text).match(/[^.!?\n]*\?/g) || []).some((question) => {
    const topics = questionTopics(question).filter(
      (topic) => topic !== 'duration' || !/mỗi lần|mỗi cơn|each episode|each time/iu.test(question)
    );
    return topics.length > 0 && topics.every((topic) => known.has(topic));
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
  const latestAnswer = contextualAnswers(context).findLast(
    (item) => item.answer === latestText(context) && item.ambiguous
  );
  if (latestAnswer?.ambiguous)
    return [
      {
        id: 'clarify_positive_answer',
        category: 'danger',
        text:
          locale === 'en'
            ? 'Which of the signs I just asked about are you experiencing?'
            : 'Bạn đang gặp dấu hiệu nào trong những điều tôi vừa hỏi?',
        keywords: [['dấu hiệu nào', 'triệu chứng nào', 'điều nào', 'which']],
      },
    ];
  const messages = activeConcernMessages(context);
  const text = normalize(messages.join('\n'));
  const answered = answeredTopics(context);
  // A short answer keeps the current concern; an explicit new complaint takes
  // precedence over symptoms mentioned in an older turn.
  const currentConcern =
    [...messages].reverse().find((message) => concernOf(message)) || latestText(context);
  const headache = hasAny(normalize(currentConcern), ['đau đầu', 'nặng đầu', 'headache']);
  const candidates = headache
    ? planHeadacheQuestions(text, locale, answered)
    : planGenericQuestions(text, locale, answered);
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

const addressedQuestionPlan = (input = {}) => {
  const style = resolveCommunicationStyle(input.context, { locale: input.locale });
  return buildQuestionPlan(input).map((item) => ({
    ...item,
    text: addressQuestionTemplate(
      item.text,
      style.caregiver && item.id !== 'opening'
        ? { ...style, patient_address: style.subject_address || 'người thân' }
        : style
    ),
  }));
};

const planClarifyingQuestions = (input) => addressedQuestionPlan(input).map((item) => item.text);

const isRequiredSafetyQuestion = (item) =>
  item.category === 'danger' &&
  (item.id.startsWith('headache_') || item.id === 'clarify_positive_answer');

const resolveClarifyingQuestions = ({ context = {}, locale = 'vi', generated = [] } = {}) => {
  const plan = addressedQuestionPlan({ context, locale });
  if (['no_message', 'acknowledgement', 'awaiting_patient'].includes(conversationIntent(context)))
    return [];
  const resolved = answeredTopics(context);
  const patientText = normalize(activeConcernMessages(context).join('\n'));
  for (const topic of questionTopics(patientText)) {
    if (!['duration', 'location', 'progression'].includes(topic)) resolved.add(topic);
  }
  if (hasDuration(patientText)) resolved.add('duration');
  if (context.blood_pressure?.length) resolved.add('blood_pressure');
  const documented = JSON.stringify({
    profile: context.profile,
    messages: patientMessages(context),
    blood_pressure: context.blood_pressure,
    glucose: context.glucose,
  });
  const knownNumbers = new Set(documented.match(/\d+(?:[.,]\d+)?/g) || []);
  const candidates = unique(
    generated
      .filter((value) => {
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          !/[?？]/u.test(value) ||
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
        if (repeatedDurationQuestion({ context, text: value })) return false;
        if (questionTopics(value).some((topic) => resolved.has(topic))) return false;
        return !filterAiOutput(value, 'low', locale).modified;
      })
      .map((value) => value.trim()),
    4
  );
  // Preserve mandatory, unanswered safety checks. Outside those checks the
  // model may ask a more useful case-specific question than our generic plan.
  // A safe question about abdominal pain must not become a stock history form.
  const used = new Set();
  const safetyQuestions = plan.filter(isRequiredSafetyQuestion).map((item) => {
    const question = candidates.find(
      (value) => !used.has(value) && item.keywords.every((terms) => hasAny(normalize(value), terms))
    );
    if (question) used.add(question);
    return question || item.text;
  });
  const result = [...safetyQuestions, ...candidates.filter((value) => !used.has(value))];
  return result.length ? unique(result, 2) : plan.map((item) => item.text);
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
  for (const item of contextualAnswers(context).slice(-6))
    facts.push(
      `Cặp hỏi–đáp trong ca (nguyên văn, không coi câu hỏi là bệnh sử): Chuyên gia: ${item.question} Bệnh nhân: ${item.answer}`
    );
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
  buildQuestionPlan: addressedQuestionPlan,
  resolveClarifyingQuestions,
  repeatedDurationQuestion,
  repeatedAnsweredQuestion,
  conversationIntent,
  contextualAnswers,
  buildAnsweredQuestionEvidence,
  isRequiredSafetyQuestion,
  __test__: { normalize, patientMessages },
};
