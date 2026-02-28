/**
 * Asinu Risk Engine C - Clinical-Based Risk Assessment
 * Đánh giá rủi ro dựa trên CHỈ SỐ LÂM SÀNG THỰC TẾ
 * 
 * Logic:
 * 1. GLUCOSE: < 70 hoặc > 180 = HIGH, 70-100/140-180 = MEDIUM, 100-140 = LOW
 * 2. BP SYSTOLIC: < 90 hoặc > 160 = HIGH, 90-100/140-160 = MEDIUM, 100-140 = LOW  
 * 3. BP DIASTOLIC: < 60 hoặc > 100 = HIGH, 60-70/90-100 = MEDIUM, 70-90 = LOW
 * 4. KẾT HỢP với mood và symptoms để ra quyết định cuối cùng
 */

const { t } = require('../../src/i18n');

const GLUCOSE_RANGES = {
  CRITICAL_LOW: 70,
  NORMAL_LOW: 100,
  NORMAL_HIGH: 140,
  CRITICAL_HIGH: 180
};

const BP_SYS_RANGES = {
  CRITICAL_LOW: 90,
  NORMAL_LOW: 100,
  NORMAL_HIGH: 140,
  CRITICAL_HIGH: 160
};

const BP_DIA_RANGES = {
  CRITICAL_LOW: 60,
  NORMAL_LOW: 70,
  NORMAL_HIGH: 90,
  CRITICAL_HIGH: 100
};

/**
 * Đánh giá risk từ chỉ số glucose
 */
const assessGlucoseRisk = (value) => {
  if (!value) {
    // Không có dữ liệu - không đánh giá (dùng mood/symptoms thay thế)
    return { tier: 'UNKNOWN', score: 0, reason: null };
  }
  
  const val = Number(value);
  
  // Critical cases
  if (val < GLUCOSE_RANGES.CRITICAL_LOW) {
    return {
      tier: 'HIGH',
      score: 80,
      reason: t('risk.glucose_very_low', 'vi', { value: val })
    };
  }
  
  if (val > GLUCOSE_RANGES.CRITICAL_HIGH) {
    return {
      tier: 'HIGH',
      score: 75,
      reason: t('risk.glucose_very_high', 'vi', { value: val })
    };
  }
  
  // Medium risk
  if (val < GLUCOSE_RANGES.NORMAL_LOW) {
    return {
      tier: 'MEDIUM',
      score: 50,
      reason: t('risk.glucose_slightly_low', 'vi', { value: val })
    };
  }
  
  if (val > GLUCOSE_RANGES.NORMAL_HIGH) {
    return {
      tier: 'MEDIUM',
      score: 45,
      reason: t('risk.glucose_slightly_high', 'vi', { value: val })
    };
  }
  
  // Normal
  return {
    tier: 'LOW',
    score: 10,
    reason: t('risk.glucose_normal', 'vi', { value: val })
  };
};

/**
 * Đánh giá risk từ chỉ số huyết áp
 */
const assessBPRisk = (systolic, diastolic) => {
  if (!systolic || !diastolic) {
    // Không có dữ liệu - không đánh giá (dùng mood/symptoms thay thế)
    return { tier: 'UNKNOWN', score: 0, reason: null };
  }
  
  const sys = Number(systolic);
  const dia = Number(diastolic);
  
  // Critical cases
  if (sys < BP_SYS_RANGES.CRITICAL_LOW || dia < BP_DIA_RANGES.CRITICAL_LOW) {
    return {
      tier: 'HIGH',
      score: 85,
      reason: t('risk.bp_very_low', 'vi', { sys, dia })
    };
  }
  
  if (sys > BP_SYS_RANGES.CRITICAL_HIGH || dia > BP_DIA_RANGES.CRITICAL_HIGH) {
    return {
      tier: 'HIGH',
      score: 80,
      reason: t('risk.bp_very_high', 'vi', { sys, dia })
    };
  }
  
  // Medium risk
  if (sys < BP_SYS_RANGES.NORMAL_LOW || dia < BP_DIA_RANGES.NORMAL_LOW) {
    return {
      tier: 'MEDIUM',
      score: 45,
      reason: t('risk.bp_slightly_low', 'vi', { sys, dia })
    };
  }
  
  if (sys > BP_SYS_RANGES.NORMAL_HIGH || dia > BP_DIA_RANGES.NORMAL_HIGH) {
    return {
      tier: 'MEDIUM',
      score: 50,
      reason: t('risk.bp_slightly_high', 'vi', { sys, dia })
    };
  }
  
  // Normal
  return {
    tier: 'LOW',
    score: 10,
    reason: t('risk.bp_normal', 'vi', { sys, dia })
  };
};

/**
 * Điều chỉnh risk dựa trên mood và symptoms
 */
const adjustRiskByMoodSymptoms = (baseRisk, mood, symptoms = []) => {
  let adjustedScore = baseRisk.score;
  const reasons = [baseRisk.reason];
  
  // Mood impact
  if (mood === 'NOT_OK') {
    adjustedScore += 15;
    reasons.push(t('risk.mood_not_ok'));
  } else if (mood === 'TIRED') {
    adjustedScore += 5;
    reasons.push(t('risk.mood_tired'));
  }
  
  // Symptoms impact
  if (symptoms.includes('chest_pain') && symptoms.includes('shortness_of_breath')) {
    adjustedScore += 30;
    reasons.push(t('risk.symptom_chest_breath'));
  } else if (symptoms.includes('chest_pain')) {
    adjustedScore += 20;
    reasons.push(t('risk.symptom_chest_pain'));
  } else if (symptoms.includes('shortness_of_breath')) {
    adjustedScore += 15;
    reasons.push(t('risk.symptom_shortness_of_breath'));
  } else if (symptoms.includes('dizziness')) {
    adjustedScore += 10;
    reasons.push(t('risk.symptom_dizziness'));
  }
  
  // Clamp to 0-100
  adjustedScore = Math.min(100, Math.max(0, adjustedScore));
  
  // Determine tier
  let tier = 'LOW';
  if (adjustedScore >= 70) tier = 'HIGH';
  else if (adjustedScore >= 40) tier = 'MEDIUM';
  
  return {
    tier,
    score: adjustedScore,
    reasons,
    notify_caregiver: tier === 'HIGH'
  };
};

/**
 * Main assessment function - Đánh giá tổng hợp
 */
const assessClinicalRisk = ({ glucose, bloodPressure, mood, symptoms }) => {
  const glucoseRisk = assessGlucoseRisk(glucose?.value);
  const bpRisk = assessBPRisk(bloodPressure?.systolic, bloodPressure?.diastolic);
  
  // Lấy risk cao nhất từ 2 chỉ số (nếu có)
  let baseRisk;
  if (glucoseRisk.tier !== 'UNKNOWN' && bpRisk.tier !== 'UNKNOWN') {
    // Có cả 2 chỉ số - lấy risk cao hơn
    baseRisk = glucoseRisk.score > bpRisk.score ? glucoseRisk : bpRisk;
  } else if (glucoseRisk.tier !== 'UNKNOWN') {
    // Chỉ có glucose
    baseRisk = glucoseRisk;
  } else if (bpRisk.tier !== 'UNKNOWN') {
    // Chỉ có BP
    baseRisk = bpRisk;
  } else {
    // Không có chỉ số nào - dựa hoàn toàn vào mood/symptoms
    baseRisk = { tier: 'LOW', score: 0, reason: null };
  }
  
  // Điều chỉnh dựa trên mood và symptoms
  const finalRisk = adjustRiskByMoodSymptoms(baseRisk, mood, symptoms);
  
  return {
    risk_tier: finalRisk.tier,
    risk_score: finalRisk.score,
    notify_caregiver: finalRisk.notify_caregiver,
    clinical_assessment: {
      glucose: glucoseRisk,
      blood_pressure: bpRisk
    },
    combined_reasons: finalRisk.reasons.filter(r => r !== null), // Bỏ null reasons
    metadata: {
      engine: 'AsinuRiskEngineC',
      version: 'clinical-v1',
      assessed_at: new Date().toISOString(),
      has_glucose: glucoseRisk.tier !== 'UNKNOWN',
      has_bp: bpRisk.tier !== 'UNKNOWN'
    }
  };
};

module.exports = {
  assessClinicalRisk,
  assessGlucoseRisk,
  assessBPRisk,
  GLUCOSE_RANGES,
  BP_SYS_RANGES,
  BP_DIA_RANGES
};
