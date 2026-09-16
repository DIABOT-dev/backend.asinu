const compare = (value, operator, threshold) =>
  operator === 'gte' ? value >= threshold : value <= threshold;

const glucoseValueInUnit = (value, sourceUnit, targetUnit) => {
  if (sourceUnit === targetUnit) return value;
  if (sourceUnit === 'mg/dL' && targetUnit === 'mmol/L') return value / 18;
  if (sourceUnit === 'mmol/L' && targetUnit === 'mg/dL') return value * 18;
  return null;
};

const parseDate = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const withinAge = (value, maxAgeHours, now) => {
  const date = parseDate(value);
  if (!date || !Number.isFinite(maxAgeHours)) return false;
  const ageMs = now.getTime() - date.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
};

const findingFromRule = (rule, value, unit, observedAt) => ({
  rule_id: rule.rule_id,
  rule_version: rule.version,
  source_document_id: rule.source_document_id,
  severity: rule.severity,
  metric: rule.config.metric || rule.config.symptom,
  value,
  unit,
  observed_at: observedAt ? new Date(observedAt).toISOString() : null,
  patient_message: rule.patient_message,
  expert_message: rule.expert_message,
});

const evaluateObservationRule = (rule, context, now) => {
  const { metric, operator, threshold, unit, maxAgeHours } = rule.config || {};
  if (!['systolic', 'diastolic', 'pulse', 'glucose'].includes(metric)) return [];
  if (!['gte', 'lte'].includes(operator) || !Number.isFinite(threshold)) return [];
  const findings = [];
  if (metric === 'glucose') {
    for (const observation of context.glucose || []) {
      if (!withinAge(observation.occurred_at, maxAgeHours, now)) continue;
      const converted = glucoseValueInUnit(Number(observation.value), observation.unit, unit);
      if (Number.isFinite(converted) && compare(converted, operator, threshold)) {
        findings.push(
          findingFromRule(rule, Number(converted.toFixed(2)), unit, observation.occurred_at)
        );
      }
    }
    return findings.slice(0, 5);
  }
  for (const observation of context.blood_pressure || []) {
    if (!withinAge(observation.occurred_at, maxAgeHours, now)) continue;
    const value = Number(observation[metric]);
    if (Number.isFinite(value) && compare(value, operator, threshold)) {
      findings.push(
        findingFromRule(rule, value, metric === 'pulse' ? '/min' : 'mmHg', observation.occurred_at)
      );
    }
  }
  return findings.slice(0, 5);
};

const normalizeSymptom = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('vi')
    .trim();

const evaluateSymptomRule = (rule, context, now) => {
  const { symptom, minimumDays, maxAgeHours } = rule.config || {};
  if (!symptom || !Number.isInteger(minimumDays) || minimumDays < 1) return [];
  const wanted = normalizeSymptom(symptom);
  const dates = (context.symptoms || [])
    .filter((item) => normalizeSymptom(item.symptom_name).includes(wanted))
    .map((item) => parseDate(item.occurred_date))
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  if (!dates.length || !withinAge(dates[dates.length - 1], maxAgeHours, now)) return [];
  const durationDays = Math.floor((dates[dates.length - 1] - dates[0]) / 86400000) + 1;
  return durationDays >= minimumDays
    ? [findingFromRule(rule, durationDays, 'days', dates[dates.length - 1])]
    : [];
};

const evaluateClinicalRules = (rules, context, now = new Date()) =>
  (rules || []).flatMap((rule) =>
    rule.rule_type === 'observation_threshold'
      ? evaluateObservationRule(rule, context, now)
      : rule.rule_type === 'symptom_duration'
        ? evaluateSymptomRule(rule, context, now)
        : []
  );

module.exports = { evaluateClinicalRules, glucoseValueInUnit };
