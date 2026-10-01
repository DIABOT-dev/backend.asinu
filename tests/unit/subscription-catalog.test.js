'use strict';

const {
  products,
  productForId,
  planDefinition,
} = require('../../src/services/payment/subscription-catalog');

describe('Asinu V2 subscription catalog', () => {
  test('contains exactly the six An Tam Store products', () => {
    const catalog = products();
    expect(catalog).toHaveLength(6);
    expect(new Set(catalog.map((item) => item.plan_code)))
      .toEqual(new Set(['antam_2', 'antam_4', 'antam_8']));
    expect(new Set(catalog.map((item) => item.billing_period)))
      .toEqual(new Set(['monthly', 'yearly']));
  });

  test('does not recognise legacy Premium products at runtime', () => {
    expect(productForId('asinu.premium.monthly')).toBeNull();
    expect(productForId('asinu.antam2.monthly')?.plan_code).toBe('antam_2');
  });

  test('matches approved prices and protected-member limits', () => {
    expect(planDefinition('antam_2')).toMatchObject({
      protectedMemberLimit: 2,
      monthlyPriceVnd: 149000,
      yearlyPriceVnd: 1199000,
    });
    expect(planDefinition('antam_4')).toMatchObject({
      protectedMemberLimit: 4,
      monthlyPriceVnd: 199000,
      yearlyPriceVnd: 1499000,
    });
    expect(planDefinition('antam_8')).toMatchObject({
      protectedMemberLimit: 8,
      monthlyPriceVnd: 249000,
      yearlyPriceVnd: 1799000,
    });
  });
});
