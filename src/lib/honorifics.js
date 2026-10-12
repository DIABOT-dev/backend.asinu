/**
 * Xưng hô cá nhân hoá theo tuổi + giới tính (Vietnamese).
 * Dùng chung cho notifications, checkin, chat.
 *
 * @param {Object} user - { birth_year, gender, display_name, full_name, lang }
 * @returns {{ honorific: string, selfRef: string, callName: string, Honorific: string }}
 */
const { formatPersonName } = require('./text-format');

function getUserAge(user = {}, now = new Date()) {
  const today = new Date(now);
  const birth = user.date_of_birth && new Date(user.date_of_birth);
  let age = null;
  if (birth && Number.isFinite(birth.getTime()) && birth <= today) {
    age = today.getUTCFullYear() - birth.getUTCFullYear();
    if (
      today.getUTCMonth() < birth.getUTCMonth() ||
      (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())
    )
      age--;
  } else if (Number(user.birth_year) >= 1900) {
    age = today.getUTCFullYear() - Number(user.birth_year);
  } else if (/^\d{1,3}(?:\s*[-+]\s*\d{0,3})?$/.test(String(user.age ?? '').trim())) {
    age = parseInt(user.age, 10);
  }
  return Number.isFinite(age) && age >= 0 && age <= 120 ? age : null;
}

function getHonorifics(user) {
  // Ưu tiên full_name (canonical) hơn display_name
  const full = formatPersonName(user.full_name || user.display_name || '');
  const name = full ? full.trim().split(/\s+/).pop() : '';
  const lang = String(user.lang || 'vi')
    .toLowerCase()
    .startsWith('en')
    ? 'en'
    : 'vi';

  if (lang === 'en') {
    const callName = name || 'you';
    const Callname = callName.charAt(0).toUpperCase() + callName.slice(1);
    return {
      honorific: 'you',
      selfRef: 'I',
      callName,
      Honorific: 'You',
      SelfRef: 'I',
      CallName: Callname,
    };
  }

  const age = getUserAge(user);
  const gender = String(user.gender || '')
    .trim()
    .toLowerCase();
  const isMale = ['nam', 'male', 'm'].includes(gender);
  const isFemale = ['nữ', 'nu', 'female', 'f'].includes(gender);

  let honorific = 'bạn';
  let selfRef = 'mình';

  if (age) {
    if (age >= 75) {
      honorific = isMale ? 'ông' : isFemale ? 'bà' : 'bác';
      selfRef = 'cháu';
    } else if (age >= 60) {
      honorific = 'bác';
      selfRef = 'cháu';
    } else if (age >= 45) {
      honorific = isMale ? 'chú' : isFemale ? 'cô' : 'bác';
      selfRef = 'cháu';
    } else if (age >= 25) {
      honorific = isMale ? 'anh' : isFemale ? 'chị' : 'bạn';
      selfRef = 'mình';
    }
  }

  const callName = name ? `${honorific} ${name}` : honorific;
  const Honorific = honorific.charAt(0).toUpperCase() + honorific.slice(1);
  const CallName = name ? `${Honorific} ${name}` : Honorific;
  const SelfRef = selfRef.charAt(0).toUpperCase() + selfRef.slice(1);

  return { honorific, selfRef, callName, Honorific, CallName, SelfRef };
}

module.exports = { getHonorifics, getUserAge };
