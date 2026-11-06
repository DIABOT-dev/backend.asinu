// Keep this file identical to backend.asinu/src/lib/blood-pressure.js.
// Reading categories, not diagnoses or personalized treatment targets.
// https://professional.heart.org/en/science-news/2025-high-blood-pressure-guideline/top-things-to-know
// https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings
const BP_STANDARD = "AHA_ACC_2025";
// Existing application ingestion limits, not AHA diagnostic thresholds.
const BP_LIMITS = Object.freeze({
  systolicMin: 50,
  systolicMax: 250,
  diastolicMin: 30,
  diastolicMax: 150,
  pulseMin: 30,
  pulseMax: 220,
});

function bloodPressureNumber(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    value = Number(text);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateBloodPressure(systolic, diastolic, pulse) {
  const sys = bloodPressureNumber(systolic);
  const dia = bloodPressureNumber(diastolic);
  if (sys === null || dia === null) return { ok: false, error: "numbers" };
  if (sys <= dia) return { ok: false, error: "order" };
  if (
    sys < BP_LIMITS.systolicMin ||
    sys > BP_LIMITS.systolicMax ||
    dia < BP_LIMITS.diastolicMin ||
    dia > BP_LIMITS.diastolicMax
  )
    return { ok: false, error: "range" };
  const hasPulse =
    pulse !== undefined &&
    pulse !== null &&
    !(typeof pulse === "string" && pulse.trim() === "");
  const heartRate = hasPulse ? bloodPressureNumber(pulse) : undefined;
  if (
    hasPulse &&
    (heartRate === null ||
      heartRate < BP_LIMITS.pulseMin ||
      heartRate > BP_LIMITS.pulseMax)
  )
    return { ok: false, error: "pulse" };
  return { ok: true, systolic: sys, diastolic: dia, pulse: heartRate };
}

function bloodPressureAge(profile, now = new Date()) {
  if (!profile) return null;
  // Asinu uses UTC+07:00 for calendar dates, on both client and server.
  const today = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  if (profile.dateOfBirth) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(profile.dateOfBirth);
    if (!match) return null;
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return null;
    let age = today.getUTCFullYear() - year;
    if (
      today.getUTCMonth() < month - 1 ||
      (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)
    )
      age--;
    return age >= 0 && age <= 125 ? age : null;
  }
  if (
    typeof profile.age === "number" &&
    Number.isInteger(profile.age) &&
    profile.age >= 0 &&
    profile.age <= 125
  )
    return profile.age;
  const birthYear = bloodPressureNumber(profile.birthYear);
  if (birthYear === null || !Number.isInteger(birthYear)) return null;
  const age = today.getUTCFullYear() - birthYear;
  return age >= 0 && age <= 125 ? age : null;
}

function assessBloodPressure(systolic, diastolic, profile, now = new Date()) {
  const sys = bloodPressureNumber(systolic),
    dia = bloodPressureNumber(diastolic);
  const valid = validateBloodPressure(systolic, diastolic).ok;
  const age = bloodPressureAge(profile, now);
  const scope = age === null ? "unknown_age" : age < 18 ? "under18" : "adult";
  const ordered = sys !== null && dia !== null && dia > 0 && sys > dia;
  const veryHigh = ordered && (sys > 180 || dia > 120);
  // At the exact boundary, prompt a repeat reading without assigning a higher AHA category.
  const repeatHigh = ordered && (sys >= 180 || dia >= 120);
  const low = valid && scope === "adult" && (sys < 90 || dia < 60);
  let category = null;
  if (valid && scope === "adult") {
    if (veryHigh) category = "severe";
    else if (sys >= 140 || dia >= 90) category = "stage2";
    else if (sys >= 130 || dia >= 80) category = "stage1";
    else if (sys >= 120) category = "elevated";
    else category = "normal";
  }
  const displayCategory = category === "normal" && low ? "low" : category;
  return {
    standard: BP_STANDARD,
    valid,
    scope,
    category,
    displayCategory,
    low,
    veryHigh,
    repeatHigh,
  };
}

function bloodPressureMetricStatus(
  systolic,
  diastolic,
  profile,
  now = new Date()
) {
  const result = assessBloodPressure(systolic, diastolic, profile, now);
  // Preserve the safety warning for ordered, very high legacy readings even
  // when they exceed the application's current recording limits.
  if (result.repeatHigh) return "danger";
  if (!result.valid) return "unavailable";
  if (result.scope !== "adult") return "available";
  if (result.low || result.category !== "normal") return "monitor";
  return "stable";
}

module.exports = {
  BP_STANDARD,
  BP_LIMITS,
  bloodPressureNumber,
  validateBloodPressure,
  bloodPressureAge,
  assessBloodPressure,
  bloodPressureMetricStatus,
};
