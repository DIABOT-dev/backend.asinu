const { checkinDateVN } = require('../src/services/checkin/checkin.service');

describe('Vietnam check-in session date', () => {
  test('uses the previous calendar day before the 05:00 boundary', () => {
    expect(checkinDateVN(0, new Date('2026-09-27T21:30:00.000Z'))).toBe('2026-09-27');
  });

  test('uses the current Vietnam calendar day from 05:00 onward', () => {
    expect(checkinDateVN(0, new Date('2026-09-27T22:30:00.000Z'))).toBe('2026-09-28');
  });

  test('applies relative offsets after the 05:00 boundary rule', () => {
    expect(checkinDateVN(-1, new Date('2026-09-27T21:30:00.000Z'))).toBe('2026-09-26');
  });
});
