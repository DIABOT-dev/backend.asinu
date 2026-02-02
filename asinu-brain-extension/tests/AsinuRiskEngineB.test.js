const assert = require('assert');
const { computePsV1, DEFAULT_CONFIG } = require('../risk/AsinuRiskEngineB');

const baseInput = {
  risk_score: 0,
  trend_24h: 0,
  acute_flag: 0,
  missing_signal: 0,
  age_band: 'U60',
  comorbidity_tier: 0,
  frailty_tier: 0,
  profile_verified: true
};

const runCase = (name, input, expectedDecision) => {
  const result = computePsV1(input, DEFAULT_CONFIG);
  assert.strictEqual(
    result.decision,
    expectedDecision,
    `${name}: expected ${expectedDecision} got ${result.decision}`
  );
  return result;
};

runCase('low_baseline', { ...baseInput }, 0);

runCase(
  'check_in_threshold',
  { ...baseInput, risk_score: 100, age_band: '80P' },
  1
);

runCase(
  'notify_family_threshold',
  { ...baseInput, risk_score: 100, age_band: '80P', comorbidity_tier: 3 },
  2
);

runCase(
  'emergency_threshold',
  {
    ...baseInput,
    risk_score: 100,
    age_band: '80P',
    comorbidity_tier: 3,
    frailty_tier: 2,
    trend_24h: 1,
    acute_flag: 1,
    missing_signal: 1
  },
  3
);

runCase(
  'bypass_acute_flag',
  { ...baseInput, acute_flag: 2, age_band: 'U60' },
  3
);

runCase(
  'missing_signal_bypass',
  { ...baseInput, missing_signal: 1, age_band: '80P', comorbidity_tier: 3 },
  2
);

const clampCase = computePsV1(
  { ...baseInput, risk_score: 200, age_band: '80P' },
  DEFAULT_CONFIG
);
assert.ok(clampCase.P <= 100, 'clamp_risk_score: P should be <= 100');

const trendDownCase = computePsV1(
  { ...baseInput, risk_score: 10, trend_24h: -1 },
  DEFAULT_CONFIG
);
assert.strictEqual(trendDownCase.P, 0, 'trend_down: P should clamp to 0');

runCase(
  'check_in_boundary',
  { ...baseInput, risk_score: 67, age_band: '70_79' },
  1
);

runCase(
  'notify_boundary',
  { ...baseInput, risk_score: 100, age_band: '70_79', trend_24h: 1, acute_flag: 1 },
  2
);

console.log('AsinuRiskEngineB tests passed.');
