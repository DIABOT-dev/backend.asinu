const { clinicalConversation } = require('./doctor-conversation-context');

const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();

const ADDRESS = 'bác|cô|chú|anh|chị|em|cháu|con|bạn|ông|bà';
const SELF = 'tôi|em|cháu|con|mình|anh|chị|cô|chú';
// Only direct address is evidence. A clinician title or a third-party person
// ("bác sĩ", "bạn tôi") must not become the patient's form of address.
const directAddresses = (text) =>
  [
    ...String(text)
      .trim()
      .normalize('NFKC')
      .matchAll(
        new RegExp(
          `(?:^|[.!?;:\\n,]\\s*|(?:chào|hỏi thêm|khi|nếu|làm|cho tôi biết|cho em biết)\\s+)(${ADDRESS})(?=\\s+(?:có|còn|đã|đang|thấy|cảm thấy|bị|đau|mất ngủ|khó ngủ|ngủ|ăn|uống|thử|cần|nên|hãy|giúp|cho|muốn|vừa|nhớ|đừng|theo dõi|liên hệ)(?:\\s|[,!?]|$)|\\s*[,!?])|(?:không|chưa)\\s+(${ADDRESS})(?:\\s+ạ)?\\s*[?？]`,
          'giu'
        )
      ),
  ].map((match) => normalize(match[1] || match[2]));

const clinicianSelf = (text) => {
  const match = String(text)
    .trim()
    .normalize('NFKC')
    .match(
      new RegExp(
        `(?:^|[.!?;\\n,]\\s*)(${SELF})\\s+(?:hỏi thêm|xin hỏi|xin phép|muốn hỏi|muốn hiểu|sẽ hỏi|sẽ xem|sẽ hỗ trợ|đang xem|đã hiểu|hiểu rồi)(?:\\s|[,.!?]|$)`,
        'iu'
      )
    );
  return match ? normalize(match[1]) : null;
};

const patientSelf = (text) => {
  const match = normalize(text).match(
    new RegExp(
      `(?:^|[.!?]\\s*)(?:(?:dạ|vâng)[, ]+)?(${ADDRESS})\\s+(?:bị|đau|thấy|cảm thấy|đang|đã|không|chưa|có|muốn|cần|hỏi)(?:\\s|[,.!?]|$)`,
      'u'
    )
  );
  return match ? match[1] : null;
};

const requestedAddress = (text) => {
  const match = normalize(text).match(
    new RegExp(
      `(?:gọi|xưng hô với)\\s+(?:tôi|em|cháu|con|mình)\\s+(?:là|bằng)\\s+(${ADDRESS})(?!\\p{L})`,
      'u'
    )
  );
  return match ? match[1] : null;
};

const isCaregiverMessage = (text) =>
  /(?:hỏi|tư vấn|trao đổi|nhắn)(?:\s+\p{L}+){0,3}\s+(?:giúp|thay|cho)\s+(?:bố|mẹ|ba|má|ông|bà|vợ|chồng|con|bé)|(?:bố|mẹ|ba|má|ông|bà|vợ|chồng|con)\s+(?:tôi|em|cháu|con|mình|của tôi|của em)\s+(?:đang|bị|đau|sốt|mệt)/iu.test(
    text
  );

const profileAddress = (profile, now) => {
  const year = Number(profile?.birth_year);
  const currentYear = now.getUTCFullYear();
  if (!Number.isInteger(year) || year < currentYear - 120 || year > currentYear) return null;
  const age = currentYear - year;
  if (age >= 60) return 'bác';
  if (age < 18) return 'em';
  const gender = normalize(profile?.gender);
  if (['male', 'nam', 'm'].includes(gender)) return 'anh';
  if (['female', 'nữ', 'nu', 'f'].includes(gender)) return 'chị';
  return null;
};

const resolveCommunicationStyle = (context = {}, { locale = 'vi', now = new Date() } = {}) => {
  if (locale === 'en')
    return {
      locale: 'en',
      patient_address: 'you',
      clinician_self: 'I',
      source: 'neutral',
      caregiver: false,
    };
  const turns = [...clinicalConversation(context)];
  const latest = context.latest_patient_message || context.initial_patient_statement;
  if (latest?.message && turns.at(-1)?.message !== latest.message)
    turns.push({ role: 'patient', message: latest.message });
  const patients = turns.filter((turn) => turn.role === 'patient');
  const specialists = turns.filter((turn) => turn.role === 'doctor');
  const caregiver = patients.some((turn) => isCaregiverMessage(turn.message));
  const self =
    [...specialists]
      .reverse()
      .map((turn) => clinicianSelf(turn.message))
      .find(Boolean) || 'tôi';
  const preference = [...patients]
    .reverse()
    .map((turn) => requestedAddress(turn.message))
    .find(Boolean);
  const established = [...specialists]
    .reverse()
    .flatMap((turn) => directAddresses(turn.message).filter((term) => term !== self))[0];
  const patientTerm = [...patients]
    .reverse()
    .map((turn) => patientSelf(turn.message))
    .find(Boolean);
  const fromProfile = caregiver ? null : profileAddress(context.profile, now);
  const patientAddress = preference || established || patientTerm || fromProfile || 'bạn';
  return {
    locale: 'vi',
    patient_address: patientAddress,
    clinician_self: self,
    source: preference
      ? 'patient_preference'
      : established
        ? 'conversation'
        : patientTerm
          ? 'patient_self'
          : fromProfile
            ? 'profile'
            : 'neutral',
    caregiver,
  };
};

// These replacements apply only to code-owned question templates. Never
// replace pronouns throughout model text or the patient's original messages.
const addressQuestionTemplate = (text, style) => {
  if (style.locale === 'en') return text;
  return text
    .replace(/(?<!\p{L})bạn(?!\p{L})/giu, (term) =>
      term[0] === 'B'
        ? style.patient_address[0].toLocaleUpperCase('vi') + style.patient_address.slice(1)
        : style.patient_address
    )
    .replace(/(?<!\p{L})(?:mình|tôi)(?!\p{L})/gu, style.clinician_self);
};

const communicationConflict = (text, style) => {
  if (!text || style.locale === 'en') return false;
  if (/thưa bác sĩ|bác sĩ cho (?:tôi|em|cháu) hỏi/iu.test(text)) return true;
  const self = clinicianSelf(text);
  if (
    directAddresses(text).some(
      (term) => term !== style.patient_address && !(term === style.clinician_self && self === term)
    )
  )
    return true;
  return Boolean(self && self !== style.clinician_self);
};

module.exports = { resolveCommunicationStyle, addressQuestionTemplate, communicationConflict };
