const { provinces } = require('../../data/vietnam-administrative-units.json');
const fold = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
const shortName = value => fold(value).replace(/^(tinh|thanh pho|phuong|xa|dac khu)\s+/, '');

function normalizeAddress(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_address');
  const address = {};
  for (const [key, max] of [['province', 120], ['ward', 120], ['street', 300]]) {
    const field = value[key] ?? '';
    if (typeof field !== 'string' || field.length > max || field.includes('\u0000')) throw new Error('invalid_address');
    address[key] = field.replace(/\s+/g, ' ').trim();
  }
  for (const key of ['provinceCode','wardCode']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('invalid_address');
  const hasProvince = !!(address.province || value.provinceCode);
  const hasWard = !!(address.ward || value.wardCode);
  if (!hasProvince && !hasWard && !address.street) return null;
  if (hasWard && !hasProvince) throw new Error('invalid_address');
  const province = value.provinceCode ? provinces.find(province => province.code === value.provinceCode)
    : provinces.find(province => fold(province.name) === fold(address.province)) ?? provinces.find(province => shortName(province.name) === shortName(address.province));
  if (hasProvince && !province) throw new Error('invalid_address');
  const candidates = province?.wards.filter(ward => shortName(ward.name) === shortName(address.ward)) ?? [];
  const ward = value.wardCode ? province?.wards.find(ward => ward.code === value.wardCode)
    : province?.wards.find(ward => fold(ward.name) === fold(address.ward)) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (hasWard && !ward) throw new Error('invalid_address');
  return { provinceCode: province?.code ?? '', province: province?.name ?? '', wardCode: ward?.code ?? '', ward: ward?.name ?? '', street: address.street };
}

function validBirthDate(value, now = new Date()) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const earliest = `${Number(parts.year) - 150}-${parts.month}-${parts.day}`;
  return value <= today && value >= earliest;
}

module.exports = { normalizeAddress, validBirthDate };
