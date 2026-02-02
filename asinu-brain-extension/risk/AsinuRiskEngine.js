const HIGH_RISK_KEYWORDS = [
  'diabetes',
  'hypertension',
  'high blood',
  'heart',
  'cardio',
  'stroke',
  'kidney',
  'cancer',
  'lung',
  'asthma',
  'tim mach',
  'tieu duong',
  'huyet ap'
];

const normalizeText = (value) => String(value || '').toLowerCase().trim();

const extractConditions = (profile) => {
  const list = [];
  if (!profile) return list;
  const medical = Array.isArray(profile.medical_conditions) ? profile.medical_conditions : [];
  const chronic = Array.isArray(profile.chronic_symptoms) ? profile.chronic_symptoms : [];
  for (const item of [...medical, ...chronic]) {
    if (typeof item === 'string') list.push(item);
    if (item && typeof item === 'object') {
      if (item.label) list.push(item.label);
      if (item.key) list.push(item.key);
      if (item.other_text) list.push(item.other_text);
    }
  }
  return list;
};

const countHighRiskConditions = (profile) => {
  const conditions = extractConditions(profile).map(normalizeText).filter(Boolean);
  const matched = new Set();
  for (const condition of conditions) {
    for (const keyword of HIGH_RISK_KEYWORDS) {
      if (condition.includes(keyword)) {
        matched.add(keyword);
      }
    }
  }
  return matched.size;
};

const parseAge = (ageValue) => {
  if (ageValue === null || ageValue === undefined) return null;
  if (typeof ageValue === 'number') return ageValue;
  const text = String(ageValue).trim();
  const match = text.match(/\d+/);
  if (!match) return null;
  return Number(match[0]);
};

const computeSusceptibleMultiplier = (profile) => {
  let multiplier = 1.0;
  const age = parseAge(profile?.age);
  if (age !== null) {
    if (age >= 70) multiplier = 1.5;
    else if (age >= 60) multiplier = 1.3;
  }

  const conditionCount = countHighRiskConditions(profile);
  multiplier = Math.min(2.0, multiplier + conditionCount * 0.2);
  return multiplier;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const computeTrend = (signal) => {
  if (signal?.trend) return signal.trend;
  const last3 = Number(signal?.counts?.last3 || 0);
  const prev4 = Number(signal?.counts?.prev4 || 0);
  if (last3 > prev4) return 'WORSENING';
  if (last3 < prev4) return 'IMPROVING';
  return 'STABLE';
};

const mapTier = (riskScore) => {
  if (riskScore <= 30) return 'LOW';
  if (riskScore <= 70) return 'MEDIUM';
  return 'HIGH';
};

const calculateRisk = ({ profile, persistence, signal }) => {
  const explain_codes = [];

  const susceptible_multiplier = computeSusceptibleMultiplier(profile);
  if (susceptible_multiplier > 1.0) explain_codes.push('SUSCEPTIBLE_MULTIPLIER');

  const frequency = clamp(Number(signal?.frequency || 0), 0, 1000);
  const duration = clamp(Number(signal?.duration || 1), 1, 30);
  const severityScore = clamp(Number(signal?.severity_score || 1), 1, 3);
  const trend = computeTrend(signal);

  const exposure = frequency * duration * severityScore;
  let exposure_delta = exposure;
  if (trend === 'STABLE') exposure_delta = exposure * 0.5;
  if (trend === 'IMPROVING') exposure_delta = exposure * 0.2;

  const prevRisk = clamp(Number(persistence?.risk_score || 0), 0, 100);
  let risk_today = clamp(prevRisk + exposure_delta * susceptible_multiplier, 0, 100);

  let streak_ok_days = Number(persistence?.streak_ok_days || 0);
  if (signal?.today_mood === 'OK') {
    streak_ok_days += 1;
    const decay = 5 + 2 * streak_ok_days;
    risk_today = clamp(risk_today - decay, 0, 100);
    explain_codes.push('DECAY_OK_STREAK');
  } else {
    streak_ok_days = 0;
  }

  let risk_tier = mapTier(risk_today);
  let notify_caregiver = false;

  if (signal?.has_chest_pain && signal?.has_shortness) {
    risk_tier = 'HIGH';
    notify_caregiver = true;
    risk_today = Math.max(risk_today, 71);
    explain_codes.push('ESCALATE_CHEST_SHORTNESS');
  }

  if (signal?.not_ok_48h >= 2) {
    risk_tier = risk_tier === 'LOW' ? 'MEDIUM' : risk_tier;
    notify_caregiver = true;
    risk_today = Math.max(risk_today, 31);
    explain_codes.push('ESCALATE_NOT_OK_48H');
  }

  return {
    pbt: susceptible_multiplier,
    exposure_score: exposure,
    risk_score: Math.round(clamp(risk_today, 0, 100)),
    risk_tier,
    trend,
    explain_codes,
    notify_caregiver,
    streak_ok_days
  };
};

module.exports = {
  calculateRisk
};
