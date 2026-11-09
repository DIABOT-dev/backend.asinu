jest.mock('../../src/lib/redis', () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}));
jest.mock('../../src/services/auth/auth.service', () => ({
  normalizePhoneNumber: jest.fn(),
  getPhoneVariants: jest.fn(),
  getCrmUserPayload: jest.fn(),
}));
const { getBasicProfile } = require('../../src/services/profile/profile.service');

test.each([
  [23, 'Nam', 'bạn', 'Bạn Đức'],
  [30, 'Nam', 'anh', 'Anh Đức'],
  [30, 'Nữ', 'chị', 'Chị Đức'],
  [50, 'Nam', 'chú', 'Chú Đức'],
  [50, 'Nữ', 'cô', 'Cô Đức'],
  [65, 'Nữ', 'bác', 'Bác Đức'],
  [80, 'Nam', 'ông', 'Ông Đức'],
  [80, 'Nữ', 'bà', 'Bà Đức'],
])(
  'bootstrap profile exposes the same age-based addressing used by check-in questions (%s, %s)',
  async (age, gender, honorific, CallName) => {
    const pool = {
      query: jest.fn(async () => ({
        rows: [
          {
            id: 7,
            full_name: 'Dương Anh Đức',
            birth_year: new Date().getUTCFullYear() - age,
            gender,
            age_range: null,
          },
        ],
      })),
    };
    const result = await getBasicProfile(pool, 7);
    expect(result.ok).toBe(true);
    expect(result.profile.checkinAddressing).toMatchObject({ honorific, CallName });
    expect(pool.query).toHaveBeenCalledTimes(1);
  }
);

test('missing age and gender use the neutral fallback without inventing patient details', async () => {
  const pool = { query: jest.fn(async () => ({ rows: [{ id: 7 }] })) };
  const result = await getBasicProfile(pool, 7);
  expect(result.profile.checkinAddressing).toMatchObject({ honorific: 'bạn', CallName: 'Bạn' });
});
