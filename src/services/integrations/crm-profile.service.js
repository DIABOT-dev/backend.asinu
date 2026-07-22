const { emitCrmEventAsync } = require('./crm-event.service');

const stripAccents = (value) => String(value || '')
  .replace(/[đĐ]/g, 'd')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const toAgeInfo = ({ age, birth_year }) => {
  const parsedBirthYear = Number.parseInt(String(birth_year || ''), 10);
  const exactAge = Number.isFinite(parsedBirthYear) && parsedBirthYear > 1900
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
  if (legacyAge === '40-49' || legacyAge === '50-59') return { age_group: legacyAge, is_elderly: false };
  if (legacyAge === '60+') return { age_group: null, is_elderly: true };
  return { age_group: null, is_elderly: false };
};

const diseaseCodesFromConditions = (conditions) => {
  const values = Array.isArray(conditions) ? conditions : [];
  const codes = new Set();
  for (const item of values) {
    const text = stripAccents(typeof item === 'string' ? item : item?.label || item?.key || item?.other_text);
    if (!text || text === 'khong co' || text === 'none' || text === 'khoe manh') continue;
    if (!text.includes('tien tieu duong') && (text.includes('tieu duong') || text.includes('dai thao duong') || text.includes('diabetes'))) codes.add('benh:tieu-duong');
    if (text.includes('tang huyet ap') || text.includes('cao huyet ap') || text.includes('hypertension')) codes.add('benh:tang-huyet-ap');
    if (text.includes('gout')) codes.add('benh:gout');
    if (text.includes('mo mau') || text.includes('cholesterol') || text.includes('lipid')) codes.add('benh:mo-mau');
    if (text.includes('tim mach') || text.includes('benh tim') || text.includes('suy tim')) codes.add('benh:tim-mach');
    if (text.includes('suy than') || text.includes('benh than') || text.includes('than man')) codes.add('benh:than');
    if (text.includes('xuong khop') || text.includes('loang xuong') || text.includes('viem khop') || text.includes('arthritis')) codes.add('benh:xuong-khop');
    if (text.includes('tuyen giap') || text.includes('thyroid')) codes.add('benh:tuyen-giap');
    if (text.includes('beo phi') || text.includes('obesity')) codes.add('benh:beo-phi');
  }
  return [...codes];
};

const emitProfileUpdated = (pool, userId, profile = {}) => {
  const ageInfo = toAgeInfo(profile);
  emitCrmEventAsync(pool, 'profile.updated', {
    user_id: String(userId),
    age_group: ageInfo.age_group,
    is_elderly: ageInfo.is_elderly,
    self_reported_tag_codes: diseaseCodesFromConditions(profile.medical_conditions).join(','),
  });
};

module.exports = { emitProfileUpdated, diseaseCodesFromConditions, toAgeInfo };
