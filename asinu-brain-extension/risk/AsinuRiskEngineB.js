const DEFAULT_CONFIG = {
  w1: 0.6,
  w2: 1,
  w3: 1,
  w4: 1,
  trend_points_map: { '-1': -10, '0': 0, '1': 10 },
  acute_points_map: { '0': 0, '1': 20, '2': 60 },
  missing_points_map: { '0': 0, '1': 15 },
  base_by_age: { U60: 30, '60_69': 40, '70_79': 50, '80P': 60 },
  add_by_comorbidity: { '0': 0, '1': 10, '2': 20, '3': 30 },
  add_by_frailty: { '0': 0, '1': 10, '2': 20 },
  missing_severity_threshold: 60,
  threshold_check_in: 20,
  threshold_notify: 45,
  threshold_emergency: 70
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const mergeMap = (base, patch) => ({ ...(base || {}), ...(patch || {}) });

const normalizeConfig = (params = {}) => ({
  w1: toNumber(params.w1, DEFAULT_CONFIG.w1),
  w2: toNumber(params.w2, DEFAULT_CONFIG.w2),
  w3: toNumber(params.w3, DEFAULT_CONFIG.w3),
  w4: toNumber(params.w4, DEFAULT_CONFIG.w4),
  trend_points_map: mergeMap(DEFAULT_CONFIG.trend_points_map, params.trend_points_map),
  acute_points_map: mergeMap(DEFAULT_CONFIG.acute_points_map, params.acute_points_map),
  missing_points_map: mergeMap(DEFAULT_CONFIG.missing_points_map, params.missing_points_map),
  base_by_age: mergeMap(DEFAULT_CONFIG.base_by_age, params.base_by_age),
  add_by_comorbidity: mergeMap(DEFAULT_CONFIG.add_by_comorbidity, params.add_by_comorbidity),
  add_by_frailty: mergeMap(DEFAULT_CONFIG.add_by_frailty, params.add_by_frailty),
  missing_severity_threshold: toNumber(
    params.missing_severity_threshold,
    DEFAULT_CONFIG.missing_severity_threshold
  ),
  threshold_check_in: toNumber(params.threshold_check_in, DEFAULT_CONFIG.threshold_check_in),
  threshold_notify: toNumber(params.threshold_notify, DEFAULT_CONFIG.threshold_notify),
  threshold_emergency: toNumber(params.threshold_emergency, DEFAULT_CONFIG.threshold_emergency),
  shadow_mode: params.shadow_mode
});

const mapDecisionLabel = (decision) => {
  if (decision === 3) return 'emergency';
  if (decision === 2) return 'notify_family';
  if (decision === 1) return 'check_in';
  return 'none';
};

const buildExplainability = (input, output) => {
  const trigger = [];
  if (output.flags.bypass_acute) {
    trigger.push('Co dau hieu uu tien');
  } else if (output.flags.bypass_missing) {
    trigger.push('Thieu tin hieu gan day');
  }

  if (input.trend_24h > 0) {
    trigger.push('Tin hieu tang trong 24 gio');
  }

  if (trigger.length === 0) {
    trigger.push('Tin hieu on dinh gan day');
  }

  const context = [];
  if (input.age_band === '80P') context.push('Tuoi 80+');
  if (input.age_band === '70_79') context.push('Tuoi 70-79');
  if (input.age_band === '60_69') context.push('Tuoi 60-69');
  if (input.comorbidity_tier > 0) context.push('Co yeu to nen');
  if (input.frailty_tier > 0) context.push('Nen tang can theo doi');
  if (!input.profile_verified) context.push('Ho so chua day du');

  const action = [];
  if (output.decision === 0) {
    action.push('Tiep tuc sinh hoat binh thuong');
    action.push('Minh se theo doi them');
  } else if (output.decision === 1) {
    action.push('Nhac bac tra loi check-in');
    action.push('Theo doi them trong hom nay');
  } else if (output.decision === 2) {
    action.push('Bao nguoi than de kiem tra');
    action.push('Theo doi thuong xuyen hon');
  } else {
    action.push('Lien he ngay voi nguoi than');
    action.push('Uu tien kiem tra som');
  }

  let confidenceLevel = 'medium';
  const confidenceReasons = [];
  if (output.flags.bypass_acute) {
    confidenceLevel = 'high';
    confidenceReasons.push('Co dau hieu uu tien');
  }

  if (input.missing_signal === 1 || !input.profile_verified) {
    if (!output.flags.bypass_acute) {
      confidenceLevel = 'low';
    }
    confidenceReasons.push('Thieu du lieu gan day');
  }

  if (confidenceReasons.length === 0) {
    confidenceReasons.push('Du lieu hien tai phu hop');
  }

  return {
    trigger: trigger.slice(0, 2),
    context,
    action: action.slice(0, 3),
    confidence: {
      level: confidenceLevel,
      reasons: confidenceReasons
    }
  };
};

const computePsV1 = (input, configOverrides = {}) => {
  const config = normalizeConfig(configOverrides);

  const trendPoints = toNumber(config.trend_points_map[String(input.trend_24h)] || 0, 0);
  const acutePoints = toNumber(config.acute_points_map[String(input.acute_flag)] || 0, 0);
  const missingPoints = toNumber(config.missing_points_map[String(input.missing_signal)] || 0, 0);

  const riskScore = clamp(toNumber(input.risk_score, 0), 0, 100);

  const pRaw =
    config.w1 * riskScore +
    config.w2 * trendPoints +
    config.w3 * acutePoints +
    config.w4 * missingPoints;
  const pScore = clamp(pRaw, 0, 100);

  const baseAge = toNumber(config.base_by_age[input.age_band] || 0, 0);
  const addComorbidity = toNumber(
    config.add_by_comorbidity[String(input.comorbidity_tier)] || 0,
    0
  );
  const addFrailty = toNumber(config.add_by_frailty[String(input.frailty_tier)] || 0, 0);
  const sRaw = baseAge + addComorbidity + addFrailty;
  const sScore = clamp(sRaw, 0, 100);

  const alertScore = clamp((pScore * sScore) / 100, 0, 100);

  let decision = 0;
  if (alertScore >= config.threshold_emergency) decision = 3;
  else if (alertScore >= config.threshold_notify) decision = 2;
  else if (alertScore >= config.threshold_check_in) decision = 1;

  const flags = {
    bypass_acute: false,
    bypass_missing: false,
    trend_24h: input.trend_24h,
    acute_flag: input.acute_flag,
    missing_signal: input.missing_signal,
    profile_verified: input.profile_verified
  };

  if (input.acute_flag === 2) {
    decision = 3;
    flags.bypass_acute = true;
  }

  if (input.missing_signal === 1 && sScore >= config.missing_severity_threshold) {
    decision = Math.max(decision, 2);
    flags.bypass_missing = true;
  }

  const output = {
    P: pScore,
    S: sScore,
    alert_score: alertScore,
    decision,
    decision_label: mapDecisionLabel(decision),
    flags,
    points: {
      trend_points: trendPoints,
      acute_points: acutePoints,
      missing_points: missingPoints
    },
    weights_used: {
      w1: config.w1,
      w2: config.w2,
      w3: config.w3,
      w4: config.w4
    },
    thresholds_used: {
      check_in: config.threshold_check_in,
      notify_family: config.threshold_notify,
      emergency: config.threshold_emergency,
      missing_severity_threshold: config.missing_severity_threshold
    }
  };

  return {
    ...output,
    explainability: buildExplainability(input, output)
  };
};

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  computePsV1
};
