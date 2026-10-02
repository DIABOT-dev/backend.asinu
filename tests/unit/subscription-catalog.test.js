'use strict';

const fs = require('fs');
const path = require('path');

const {
  products,
  productForId,
  planDefinition,
  PLAN_DEFINITIONS,
} = require('../../src/services/payment/subscription-catalog');

describe('Asinu V2 subscription catalog', () => {
  test('contains monthly and yearly Store products for every An Tam plan', () => {
    const catalog = products();
    expect(catalog).toHaveLength(6);
    expect(new Set(catalog.map((item) => item.plan_code))).toEqual(
      new Set(['antam_2', 'antam_4', 'antam_8'])
    );
    expect(new Set(catalog.map((item) => item.billing_period))).toEqual(
      new Set(['monthly', 'yearly'])
    );
  });

  test('does not recognise legacy Premium products at runtime', () => {
    expect(productForId('asinu.premium.monthly')).toBeNull();
    expect(productForId('asinu.antam1.monthly')).toBeNull();
    expect(productForId('asinu.antam2.monthly')?.plan_code).toBe('antam_2');
    expect(planDefinition('antam_1').code).toBe('free');
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

  test('grants consultation credits only to annual products', () => {
    for (const product of products()) {
      expect(product.consultation_credits).toBe(
        product.billing_period === 'yearly' ? product.protected_members : 0
      );
    }
  });

  test('stays aligned with the database plan constraint', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../db/migrations/094_asinu_v2_entitlements_and_early_signals.sql'),
      'utf8'
    );
    const match = migration.match(/CHECK \(plan_code IN \(([^)]+)\)\)/);
    expect(match).not.toBeNull();
    const databasePlans = match[1]
      .split(',')
      .map((value) => value.trim().replaceAll("'", ''));
    expect(new Set(databasePlans)).toEqual(new Set(Object.keys(PLAN_DEFINITIONS)));
  });
});
