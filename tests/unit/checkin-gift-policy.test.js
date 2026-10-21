'use strict';
const { selectExtra, selectLoc } = require('../../src/services/checkin-gifts/gift-policy');
const config = { loc_weight: 60, ticket_weight: 30, coupon_weight: 10 };

test('fortune selection gives each available kind equal weight despite a larger wish catalog', () => {
  const items = [
    ...Array.from({ length: 60 }, (_, id) => ({ id, type: 'wish' })),
    { id: 61, type: 'proverb' },
    { id: 62, type: 'health_tip' },
  ];
  for (const [index, expected] of ['wish', 'proverb', 'health_tip'].entries()) {
    const choose = jest.fn().mockReturnValueOnce(index).mockReturnValueOnce(0);
    expect(selectLoc(items, choose).type).toBe(expected);
    expect(choose.mock.calls[0]).toEqual([3]);
  }
  expect(selectLoc([], () => { throw new Error('No draw when empty'); })).toBe(null);
  expect(selectLoc([items[61]], () => 0)).toEqual(items[61]);
});

test('category boundaries are exact and unavailable rewards fold into fortunes', () => {
  for (const [value, expected] of [
    [0, 'none'],
    [599999, 'none'],
    [600000, 'ticket'],
    [899999, 'ticket'],
    [900000, 'coupon'],
    [999999, 'coupon'],
  ]) {
    expect(selectExtra(config, { ticket: true, coupon: true }, value)).toBe(expected);
    expect(selectExtra(config, { ticket: false, coupon: false }, value)).toBe('none');
  }
});
test('1000 simulations per answer have comparable distributions and no answer parameter', () => {
  const summaries = [];
  for (const answer of ['fine', 'tired', 'very_tired']) {
    const count = { none: 0, ticket: 0, coupon: 0 };
    for (let i = 0; i < 1000; i++) count[selectExtra(config, { ticket: true, coupon: true })]++;
    expect(count.none).toBeGreaterThan(500);
    expect(count.none).toBeLessThan(700);
    expect(count.ticket).toBeGreaterThan(210);
    expect(count.ticket).toBeLessThan(390);
    expect(count.coupon).toBeGreaterThan(40);
    expect(count.coupon).toBeLessThan(160);
    summaries.push({ answer, ...count });
  }
  console.log('Gift simulations', summaries);
});
test('identical random inputs never depend on answer, streak or plan', () => {
  for (const value of [1, 590000, 620000, 880000, 930000]) {
    const outputs = [];
    for (const answer of ['fine', 'tired', 'very_tired'])
      for (const plan of ['free', 'antam_2']) {
        outputs.push(
          selectExtra(
            { ...config, answer, plan, streak: 50 },
            { ticket: true, coupon: true },
            value
          )
        );
      }
    expect(new Set(outputs).size).toBe(1);
  }
});
test('invalid configuration and random ranges fail closed', () => {
  for (const value of [-1, 1000000, NaN, 0.2])
    expect(() => selectExtra(config, {}, value)).toThrow();
  expect(() => selectExtra({ ...config, loc_weight: 61 }, {}, 1)).toThrow();
});
