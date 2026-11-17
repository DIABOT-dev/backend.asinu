jest.mock('../../src/lib/redis', () => ({ cacheGet: jest.fn(async () => null), cacheSet: jest.fn(), cacheDel: jest.fn() }));
jest.mock('../../src/services/auth/auth.service', () => ({ normalizePhoneNumber: value => value, getPhoneVariants: value => [value], getCrmUserPayload: jest.fn(async () => null) }));
jest.mock('../../src/services/integrations/crm-event.service', () => ({ emitCrmEventAsync: jest.fn() }));
jest.mock('../../src/services/integrations/crm-profile.service', () => ({ emitProfileUpdated: jest.fn() }));
jest.mock('../../src/services/media/cloudinary.service', () => ({ uploadAvatar: jest.fn() }));
const service = require('../../src/services/profile/profile.service');
const controller = require('../../src/controllers/profile.controller');
const { normalizeAddress, validBirthDate } = require('../../src/services/profile/profile-fields');
const cache = require('../../src/lib/redis');
const address = { provinceCode: '01', province: 'Thành phố Hà Nội', wardCode: '00004', ward: 'Phường Ba Đình', street: '12 Phố A' };
function fixture() {
  const state = { address: null, date: '1986-04-23' };
  const pool = { query: jest.fn(async (sql, values) => {
    if (/UPDATE users SET profile_address/.test(sql)) { expect(values.at(-1)).toBe(7); state.address = values[0] === null ? null : JSON.parse(values[0]); }
    if (/UPDATE user_onboarding_profiles SET date_of_birth/.test(sql)) { expect(values.at(-1)).toBe(7); state.date = values[0]; }
    if (/SELECT u.id,/.test(sql)) return { rows: [{ id: 7, full_name: 'Minh An', profile_address: state.address, date_of_birth: state.date }] };
    if (/SELECT id, email,/.test(sql)) return { rows: [{ id: 7, full_name: 'Minh An', profile_address: state.address }] };
    if (/SELECT user_id FROM user_onboarding_profiles/.test(sql)) return { rows: [{ user_id: 7 }] };
    if (/FROM user_onboarding_profiles/.test(sql)) return { rows: [{ date_of_birth: state.date, gender: 'Nam', medical_conditions: [], chronic_symptoms: [] }] };
    return { rows: [], rowCount: 1 };
  }) };
  return { pool, state };
}
beforeEach(() => { jest.clearAllMocks(); cache.cacheGet.mockResolvedValue(null); });

test('address writes, cache invalidation and both profile responses round trip for the authenticated user', async () => {
  const { pool } = fixture();
  const result = await service.updateProfile(pool, 7, { address });
  expect(result.ok).toBe(true);
  expect(result.profile.address).toEqual(address);
  expect(result.profile.dateOfBirth).toBe('1986-04-23');
  expect(cache.cacheDel).toHaveBeenCalledWith('profile:7', 'user:name:7');
  expect((await service.getBasicProfile(pool, 7)).profile.address).toEqual(address);
  const writes = pool.query.mock.calls.filter(([sql]) => /^UPDATE/.test(sql));
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toMatch(/^UPDATE users SET profile_address = \$1::jsonb WHERE id = \$2$/);
  expect(JSON.parse(writes[0][1][0])).toEqual(address);expect(writes[0][1][1]).toBe(7);
});
test('addresses normalize whitespace and can be removed explicitly', async () => {
  const { pool } = fixture();
  const result = await service.updateProfile(pool, 7, { address: { province: ' Hà Nội ', ward: ' Ba Đình ', street: '12\n Phố A' } });
  expect(result.profile.address).toEqual(address);
  expect((await service.updateProfile(pool, 7, { address: null })).profile.address).toBeNull();
  expect(normalizeAddress({ province: '', ward: '', street: '' })).toBeNull();
});
test.each([[], 'Hà Nội', {}, { province: 'Hà Nội' }, { ...address, street: 123 }, { ...address, street: 'x'.repeat(301) }, { ...address, ward: '\u0000' }, { ...address, provinceCode: '99' }, { ...address, provinceCode: 1 }, { ...address, wardCode: '99999' }, { ...address, provinceCode: '79' }, { province: 'Hà Nội', ward: 'Phường không tồn tại', street: '12 Phố A' }])('invalid address rejects the entire request before any write: %j', async value => {
  const { pool } = fixture();
  const result = await service.updateProfile(pool, 7, { name: 'Must not change', address: value });
  expect(result).toMatchObject({ ok: false, statusCode: 400 });
  expect(pool.query).not.toHaveBeenCalled();
});
test.each(['2025-02-29', '3000-01-01', '1800-01-01', '2000-13-01', '2000-01-32', '2000-1-1', {}, ''])('invalid date rejects before writes: %j', async dateOfBirth => {
  const { pool } = fixture();
  expect(await service.updateProfile(pool, 7, { dateOfBirth })).toMatchObject({ ok: false, statusCode: 400 });
  expect(pool.query).not.toHaveBeenCalled();
});
test('a chosen leap birthday is retained exactly and cannot modify the address', async () => {
  const { pool, state } = fixture(); state.address = address;
  const result = await service.updateProfile(pool, 7, { dateOfBirth: '2000-02-29' });
  expect(result.profile.dateOfBirth).toBe('2000-02-29'); expect(result.profile.address).toEqual(address);
  expect(pool.query.mock.calls.filter(([sql]) => /^UPDATE/.test(sql))).toHaveLength(1);
});
test('birthday bounds use the current Vietnamese calendar date', () => {
  const now = new Date('2026-11-16T18:00:00Z');
  expect(validBirthDate('2026-11-17', now)).toBe(true);
  expect(validBirthDate('2026-11-18', now)).toBe(false);
  expect(validBirthDate('1876-11-16', now)).toBe(false);
});
test('a profile cached before addresses existed is refreshed instead of hiding its address', async () => {
  const { pool, state } = fixture(); state.address = address;
  cache.cacheGet.mockResolvedValue({ ok: true, profile: { id: '7', checkinAddressing: {} } });
  expect((await service.getProfile(pool, 7)).profile.address).toEqual(address);
  cache.cacheGet.mockResolvedValue({ ok: true, profile: { id: '7', checkinAddressing: {}, address } });
  pool.query.mockClear(); expect((await service.getProfile(pool, 7)).profile.address).toEqual(address); expect(pool.query).not.toHaveBeenCalled();
});
test('the HTTP controller authorizes by the session and forwards only supported fields', async () => {
  const { pool } = fixture(); const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await controller.updateProfile(pool, { user: { id: 7 }, body: { address, userId: 8 } }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, profile: expect.objectContaining({ id: '7', address }) }));
  expect(pool.query.mock.calls.find(([sql]) => /^UPDATE users/.test(sql))[1].at(-1)).toBe(7);
  pool.query.mockClear(); await controller.updateProfile(pool, { body: { address } }, res);
  expect(res.status).toHaveBeenLastCalledWith(401); expect(pool.query).not.toHaveBeenCalled();
});
