/**
 * Xưng hô cá nhân hoá theo tuổi + giới tính (Vietnamese).
 * Dùng chung cho notifications, checkin, chat.
 *
 * @param {Object} user - { birth_year, gender, display_name, full_name, lang }
 * @returns {{ honorific: string, selfRef: string, callName: string, Honorific: string }}
 */
function getHonorifics(user) {
  // Ưu tiên full_name (canonical) hơn display_name
  const full = user.full_name || user.display_name || '';
  const name = full ? full.trim().split(/\s+/).pop() : '';
  const lang = user.lang || 'vi';

  if (lang === 'en') {
    const callName = name || 'you';
    const Callname = callName.charAt(0).toUpperCase() + callName.slice(1);
    return {
      honorific: 'you', selfRef: 'I', callName,
      Honorific: 'You', SelfRef: 'I', CallName: Callname,
    };
  }

  const age = user.birth_year ? new Date().getFullYear() - user.birth_year : null;
  const gender = (user.gender || '').toLowerCase();
  const isMale = gender.includes('nam') || gender === 'male';

  let honorific = 'bạn';
  let selfRef = 'mình';

  if (age) {
    if (age >= 60) { honorific = isMale ? 'chú' : 'cô'; selfRef = 'cháu'; }
    else if (age >= 40) { honorific = isMale ? 'anh' : 'chị'; selfRef = 'em'; }
    else if (age >= 25) { honorific = isMale ? 'anh' : 'chị'; selfRef = 'mình'; }
  }

  const callName = name ? `${honorific} ${name}` : honorific;
  const Honorific = honorific.charAt(0).toUpperCase() + honorific.slice(1);
  const CallName = name ? `${Honorific} ${name}` : Honorific;
  const SelfRef = selfRef.charAt(0).toUpperCase() + selfRef.slice(1);

  return { honorific, selfRef, callName, Honorific, CallName, SelfRef };
}

module.exports = { getHonorifics };
