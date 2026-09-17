// Deterministic question planning keeps the copilot focused on information
// that can change triage or the next clinical action. The model may phrase
// questions, but it must not decide which safety-critical gaps are ignored.

const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (items, maximum = 4) => [...new Set(items.filter(Boolean))].slice(0, maximum);

const latestText = (context) => String(context?.latest_patient_message?.message || '').trim();

const questionAlreadyAnswered = (question, source) => {
  const text = normalize(source);
  const terms = normalize(question)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 4);
  if (!terms.length) return false;
  // A question is considered answered only when its key terms appear together
  // in the patient's own text. This avoids suppressing a safety question just
  // because an unrelated message mentions one common word.
  const matched = terms.filter((term) => text.includes(term));
  return matched.length >= Math.max(2, Math.ceil(terms.length * 0.6));
};

const hasAny = (text, terms) => terms.some((term) => text.includes(normalize(term)));

const planHeadacheQuestions = (text, locale) => {
  const vi = locale !== 'en';
  const unresolvedDangerSigns = vi
    ? [
        !hasAny(text, ['yếu', 'tê']) && 'yếu hoặc tê một bên',
        !hasAny(text, ['nói khó']) && 'nói khó',
        !hasAny(text, ['lú lẫn']) && 'lú lẫn',
        !hasAny(text, ['nhìn mờ', 'nhìn đôi']) && 'thay đổi thị lực',
        !hasAny(text, ['cứng gáy']) && 'cứng gáy',
        !hasAny(text, ['ngất']) && 'ngất',
        !hasAny(text, ['nôn']) && 'nôn liên tục',
      ].filter(Boolean)
    : [
        !hasAny(text, ['weakness', 'numbness']) && 'one-sided weakness or numbness',
        !hasAny(text, ['trouble speaking']) && 'trouble speaking',
        !hasAny(text, ['confusion']) && 'confusion',
        !hasAny(text, ['vision']) && 'vision changes',
        !hasAny(text, ['stiff neck']) && 'a stiff neck',
        !hasAny(text, ['fainting']) && 'fainting',
        !hasAny(text, ['vomiting']) && 'repeated vomiting',
      ].filter(Boolean);
  const dangerQuestion = vi
    ? `Bạn có ${unresolvedDangerSigns.join(', ')} không?`
    : `Do you have ${unresolvedDangerSigns.join(', ')}?`;
  const questions = [
    {
      category: 'danger',
      text: vi
        ? 'Cơn nặng/đau đầu có xuất hiện đột ngột và dữ dội nhất từ trước đến nay không?'
        : 'Did the headache start suddenly and become the most severe headache you have ever had?',
      answered: hasAny(text, ['đột ngột', 'dữ dội nhất', 'worst headache', 'sudden']),
    },
    {
      category: 'danger',
      text: dangerQuestion,
      answered: unresolvedDangerSigns.length === 0,
    },
    {
      category: 'cause',
      text: vi
        ? 'Cảm giác nặng đầu kéo dài bao lâu mỗi lần và bắt đầu từ thời điểm nào?'
        : 'How long does each episode last, and when did it first start?',
      answered: hasAny(text, ['kéo dài', 'mỗi lần', 'bắt đầu', 'since', 'duration']),
    },
    {
      category: 'cause',
      text: vi
        ? 'Triệu chứng có liên quan rõ với thời gian nhìn màn hình, thiếu ngủ, căng thẳng, tư thế cổ hoặc ánh sáng không?'
        : 'Is it clearly related to screen time, poor sleep, stress, neck posture, or bright light?',
      answered: hasAny(text, [
        'màn hình',
        'thiếu ngủ',
        'căng thẳng',
        'tư thế',
        'ánh sáng',
        'screen',
        'stress',
      ]),
    },
    {
      category: 'risk',
      text: vi
        ? 'Bạn có đo huyết áp gần đây không; nếu có, chỉ số và thời điểm đo là bao nhiêu?'
        : 'Have you checked your blood pressure recently? If so, what was the reading and when was it taken?',
      answered: hasAny(text, ['huyết áp', 'blood pressure', 'mmhg']),
    },
    {
      category: 'follow_up',
      text: vi
        ? 'Bạn đã thử nghỉ mắt, giảm màn hình hoặc biện pháp nào khác; triệu chứng thay đổi ra sao?'
        : 'What have you tried, such as screen breaks, and how did the symptom change?',
      answered: hasAny(text, ['đã thử', 'đỡ', 'không đỡ', 'cải thiện', 'tried', 'improved']),
    },
  ];
  return questions;
};

const planGenericQuestions = (text, locale) => {
  const vi = locale !== 'en';
  return [
    {
      category: 'danger',
      text: vi
        ? 'Hiện có dấu hiệu nào xuất hiện đột ngột hoặc nặng lên nhanh khiến bạn lo lắng không?'
        : 'Has anything started suddenly or worsened quickly and caused you concern?',
      answered: hasAny(text, ['đột ngột', 'nặng lên nhanh', 'sudden', 'worsening']),
    },
    {
      category: 'cause',
      text: vi
        ? 'Triệu chứng bắt đầu từ khi nào, xuất hiện liên tục hay từng đợt, và mức độ hiện tại bao nhiêu trên thang 0–10?'
        : 'When did it start, is it constant or episodic, and how severe is it from 0 to 10?',
      answered: hasAny(text, [
        'bắt đầu',
        'liên tục',
        'từng đợt',
        'mức độ',
        '0–10',
        '0-10',
        'severity',
      ]),
    },
    {
      category: 'risk',
      text: vi
        ? 'Bạn có bệnh nền, dị ứng, thuốc đang dùng hoặc yếu tố nguy cơ nào liên quan không?'
        : 'Do you have relevant conditions, allergies, medicines, or risk factors?',
      answered: hasAny(text, ['bệnh nền', 'dị ứng', 'thuốc đang dùng', 'allerg', 'medication']),
    },
    {
      category: 'follow_up',
      text: vi
        ? 'Bạn đã thử biện pháp nào và triệu chứng đáp ứng ra sao?'
        : 'What have you tried, and how did the symptom respond?',
      answered: hasAny(text, ['đã thử', 'đáp ứng', 'cải thiện', 'tried', 'response']),
    },
  ];
};

const planClarifyingQuestions = ({ context = {}, locale = 'vi' } = {}) => {
  const text = normalize(latestText(context));
  if (!text) return [];
  const headache = hasAny(text, ['đau đầu', 'nặng đầu', 'headache']);
  const candidates = headache
    ? planHeadacheQuestions(text, locale)
    : planGenericQuestions(text, locale);
  const missingData = Array.isArray(context.missing_data) ? context.missing_data : [];
  const profile = context.profile || {};
  const bloodPressureMissing = missingData.some((item) =>
    normalize(item).includes(locale === 'en' ? 'blood pressure' : 'huyết áp')
  );
  const riskQuestion = bloodPressureMissing
    ? locale === 'en'
      ? 'Have you checked your blood pressure recently? If so, what was the reading and when was it taken?'
      : 'Bạn có đo huyết áp gần đây không; nếu có, chỉ số và thời điểm đo là bao nhiêu?'
    : locale === 'en'
      ? 'Are you taking any regular medicines, and do you have any known allergies?'
      : 'Bạn đang dùng thuốc thường xuyên nào và có dị ứng thuốc/thức ăn đã biết không?';
  if (
    (!Array.isArray(profile.allergies) ||
      !profile.allergies.length ||
      !(context.medications || []).length) &&
    missingData.length
  )
    candidates.splice(Math.min(3, Math.max(0, candidates.length - 1)), 0, {
      category: 'risk',
      text: riskQuestion,
      answered: questionAlreadyAnswered(riskQuestion, text),
    });

  const selected = [];
  for (const candidate of candidates) {
    if (candidate.answered || questionAlreadyAnswered(candidate.text, text)) continue;
    selected.push(candidate.text);
    if (selected.length >= 4) break;
  }
  return unique(selected, 4);
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
  __test__: { normalize, questionAlreadyAnswered },
};
