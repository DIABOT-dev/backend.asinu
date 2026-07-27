const { emitCrmEventAsync } = require('./crm-event.service');

const toAgeInfo = ({ age, birth_year }) => {
  const parsedBirthYear = Number.parseInt(String(birth_year || ''), 10);
  const exactAge =
    Number.isFinite(parsedBirthYear) && parsedBirthYear > 1900
      ? new Date().getFullYear() - parsedBirthYear
      : null;
  if (exactAge != null && exactAge >= 0) {
    if (exactAge < 40) return { age_group: 'duoi-40', is_elderly: false };
    if (exactAge < 50) return { age_group: '40-49', is_elderly: false };
    if (exactAge < 60) return { age_group: '50-59', is_elderly: false };
    if (exactAge < 70) return { age_group: '60-69', is_elderly: true };
    return { age_group: '70-tro-len', is_elderly: true };
  }

  const legacyAge = String(age || '').trim();
  if (legacyAge === '30-39') return { age_group: 'duoi-40', is_elderly: false };
  if (legacyAge === '40-49' || legacyAge === '50-59')
    return { age_group: legacyAge, is_elderly: false };
  if (legacyAge === '60+') return { age_group: null, is_elderly: true };
  return { age_group: null, is_elderly: false };
};

const emitProfileUpdated = (pool, userId, profile = {}) => {
  const ageInfo = toAgeInfo(profile);
  emitCrmEventAsync(pool, 'profile.updated', {
    user_id: String(userId),
    age_group: ageInfo.age_group,
    is_elderly: ageInfo.is_elderly,
  });
};

module.exports = { emitProfileUpdated, toAgeInfo };
