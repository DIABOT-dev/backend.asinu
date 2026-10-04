'use strict';

const { t } = require('../../i18n');

function localizedPlanName(planCode, lang = 'vi') {
  switch (planCode) {
    case 'antam_2': return t('subscription.plan.antam_2', lang);
    case 'antam_4': return t('subscription.plan.antam_4', lang);
    case 'antam_8': return t('subscription.plan.antam_8', lang);
    default: return t('subscription.plan.free', lang);
  }
}

const PLAN_DEFINITIONS = Object.freeze({
  free: Object.freeze({
    code: 'free',
    protectedMemberLimit: 1,
    connectionLimit: 1,
    monthlyPriceVnd: 0,
    yearlyPriceVnd: 0,
    annualConsultationCredits: 0,
  }),
  antam_2: Object.freeze({
    code: 'antam_2',
    protectedMemberLimit: 2,
    connectionLimit: Number(process.env.CARE_CIRCLE_AN_TAM_LIMIT || 20),
    monthlyPriceVnd: 149000,
    yearlyPriceVnd: 1199000,
    annualConsultationCredits: 2,
  }),
  antam_4: Object.freeze({
    code: 'antam_4',
    protectedMemberLimit: 4,
    connectionLimit: Number(process.env.CARE_CIRCLE_AN_TAM_LIMIT || 20),
    monthlyPriceVnd: 199000,
    yearlyPriceVnd: 1499000,
    annualConsultationCredits: 4,
  }),
  antam_8: Object.freeze({
    code: 'antam_8',
    protectedMemberLimit: 8,
    connectionLimit: Number(process.env.CARE_CIRCLE_AN_TAM_LIMIT || 20),
    monthlyPriceVnd: 249000,
    yearlyPriceVnd: 1799000,
    annualConsultationCredits: 8,
  }),
});

const PRODUCT_MATRIX = Object.freeze([
  ['antam_2', 'monthly', 'IAP_PRODUCT_ANTAM2_MONTHLY', 'asinu.antam2.monthly'],
  ['antam_2', 'yearly', 'IAP_PRODUCT_ANTAM2_YEARLY', 'asinu.antam2.yearly'],
  ['antam_4', 'monthly', 'IAP_PRODUCT_ANTAM4_MONTHLY', 'asinu.antam4.monthly'],
  ['antam_4', 'yearly', 'IAP_PRODUCT_ANTAM4_YEARLY', 'asinu.antam4.yearly'],
  ['antam_8', 'monthly', 'IAP_PRODUCT_ANTAM8_MONTHLY', 'asinu.antam8.monthly'],
  ['antam_8', 'yearly', 'IAP_PRODUCT_ANTAM8_YEARLY', 'asinu.antam8.yearly'],
]);

const APPLE_ANTAM2_IDS = Object.freeze({
  monthly: 'asinu.premium.monthly',
  yearly: 'asinu.premium.yearly',
});

function products(platform = 'google', lang = 'vi') {
  return PRODUCT_MATRIX.map(([planCode, billingPeriod, envName, defaultId]) => {
    const plan = PLAN_DEFINITIONS[planCode];
    const appleAntam2Id =
      platform === 'apple' && planCode === 'antam_2'
        ? APPLE_ANTAM2_IDS[billingPeriod]
        : null;
    return {
      id: appleAntam2Id || process.env[envName] || defaultId,
      plan_code: planCode,
      plan_name: localizedPlanName(planCode, lang),
      billing_period: billingPeriod,
      plan_months: billingPeriod === 'yearly' ? 12 : 1,
      protected_members: plan.protectedMemberLimit,
      consultation_credits: billingPeriod === 'yearly' ? plan.annualConsultationCredits : 0,
      display_price_vnd:
        billingPeriod === 'yearly' ? plan.yearlyPriceVnd : plan.monthlyPriceVnd,
    };
  });
}

function productForId(productId, platform) {
  const normalized = String(productId || '').trim().toLowerCase();
  const catalogs = platform
    ? [products(platform)]
    : [products('apple'), products('google')];
  return catalogs.flat().find((product) => product.id.toLowerCase() === normalized) || null;
}

function planDefinition(planCode) {
  return PLAN_DEFINITIONS[planCode] || PLAN_DEFINITIONS.free;
}

module.exports = {
  PLAN_DEFINITIONS,
  products,
  productForId,
  planDefinition,
  localizedPlanName,
};
