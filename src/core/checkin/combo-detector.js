'use strict';

/**
 * Combo Detector — Detect dangerous symptom combinations
 *
 * Detects DANGEROUS COMBINATIONS of symptoms that individually might not
 * be emergencies but TOGETHER are serious.
 *
 * Pure logic, zero AI calls.
 */

// ─── Dangerous combos — tổ hợp triệu chứng nguy hiểm ──────────────────────

const DANGER_COMBOS = [
  {
    id: 'stroke_risk',
    name: 'Nghi đột quỵ',
    symptoms: [['đau đầu', 'nhức đầu'], ['mờ mắt', 'mắt mờ', 'nhìn đôi', 'mất thị lực']],
    match: 'all',
    severity: 'critical',
    action: 'Gọi cấp cứu 115 ngay. Yếu nửa người + đau đầu + mờ mắt là dấu hiệu đột quỵ.',
    needsDoctor: true,
    needsFamilyAlert: true,
    followUpHours: 0.5,
  },
  {
    id: 'appendicitis_risk',
    name: 'Nghi viêm ruột thừa',
    symptoms: [['đau bụng', 'đau bụng dưới'], ['sốt', 'sốt cao']],
    match: 'all',
    severity: 'high',
    action: 'Đi khám bác sĩ NGAY hôm nay. Đau bụng dưới bên phải kèm sốt có thể là viêm ruột thừa.',
    needsDoctor: true,
    needsFamilyAlert: true,
    followUpHours: 1,
  },
  {
    id: 'dehydration_risk',
    name: 'Nguy cơ mất nước nặng',
    symptoms: [['tiêu chảy', 'đi ngoài'], ['nôn', 'buồn nôn'], ['sốt']],
    match: 'all',
    severity: 'high',
    action: 'Uống oresol ngay, đi khám nếu không giảm. Tiêu chảy + nôn + sốt gây mất nước nhanh.',
    needsDoctor: true,
    needsFamilyAlert: false,
    followUpHours: 1,
  },
  {
    id: 'hypertension_crisis',
    name: 'Cơn tăng huyết áp',
    symptoms: [['đau đầu', 'nhức đầu'], ['chóng mặt'], ['buồn nôn', 'nôn']],
    match: 'all',
    severity: 'high',
    action: 'Đo huyết áp ngay nếu có máy. Nếu > 180/120 → gọi cấp cứu. Nằm nghỉ, uống thuốc huyết áp nếu có.',
    needsDoctor: true,
    needsFamilyAlert: true,
    followUpHours: 1,
  },
  {
    id: 'respiratory_infection',
    name: 'Nhiễm trùng hô hấp',
    symptoms: [['ho'], ['sốt', 'sốt cao'], ['đau họng', 'đau cổ họng']],
    match: 'all',
    severity: 'medium',
    action: 'Nghỉ ngơi, uống nhiều nước ấm, uống hạ sốt. Nếu sốt > 39°C hoặc ho ra đờm vàng → đi khám.',
    needsDoctor: false,
    needsFamilyAlert: false,
    followUpHours: 3,
  },
  {
    id: 'diabetic_warning',
    name: 'Biến chứng tiểu đường',
    symptoms: [['mệt mỏi', 'mệt'], ['chóng mặt'], ['khát nước', 'khô miệng']],
    match: 'all',
    severity: 'high',
    action: 'Đo đường huyết NGAY. Nếu > 300 mg/dL → đi cấp cứu. Uống nhiều nước, không ăn đồ ngọt.',
    needsDoctor: true,
    needsFamilyAlert: true,
    followUpHours: 1,
  },
  {
    id: 'headache_dizziness',
    name: 'Đau đầu kèm chóng mặt — kiểm tra huyết áp',
    symptoms: [['đau đầu', 'nhức đầu'], ['chóng mặt']],
    match: 'all',
    severity: 'medium',
    action: 'Đo huyết áp nếu có máy. Nằm nghỉ, uống nước. Nếu huyết áp > 160/100 → đi khám ngay.',
    needsDoctor: false,
    needsFamilyAlert: false,
    followUpHours: 2,
    extraQuestions: [
      {
        id: 'combo_bp',
        text: '{Honorific} có máy đo huyết áp không? Nếu có, đo giúp {selfRef} nhé.',
        type: 'single_choice',
        options: ['Có, huyết áp bình thường', 'Có, huyết áp cao', 'Không có máy đo'],
      },
    ],
  },
  {
    id: 'fatigue_weight_loss',
    name: 'Mệt mỏi + sụt cân — cần xét nghiệm',
    symptoms: [['mệt mỏi', 'mệt'], ['sụt cân', 'giảm cân', 'ăn không ngon']],
    match: 'all',
    severity: 'medium',
    action: 'Nên đi xét nghiệm máu tổng quát. Mệt mỏi kéo dài kèm sụt cân cần kiểm tra tuyến giáp, đường huyết, thiếu máu.',
    needsDoctor: true,
    needsFamilyAlert: false,
    followUpHours: 3,
  },
];

// ─── Severity ordering ──────────────────────────────────────────────────────

const SEVERITY_ORDER = { critical: 3, high: 2, medium: 1, low: 0 };

function severityRank(s) {
  return SEVERITY_ORDER[s] || 0;
}

// ─── Main detection function ────────────────────────────────────────────────

/**
 * Check an array of symptom strings against DANGER_COMBOS.
 *
 * @param {string[]} symptomTexts — individual symptom strings
 * @param {object} profile — { medical_conditions?: string[] }
 * @returns {{
 *   isCombo: boolean,
 *   combos: Array<{ id, name, severity, action, needsDoctor, needsFamilyAlert, followUpHours, extraQuestions? }>,
 *   highestSeverity: string
 * }}
 */
function detectCombo(symptomTexts, profile = {}) {
  profile = profile || {};
  if (!symptomTexts || symptomTexts.length === 0) {
    return { isCombo: false, combos: [], highestSeverity: 'low' };
  }

  // Join all symptoms into one text for matching
  const combinedText = symptomTexts.join(' ').toLowerCase();
  const conditions = (profile.medical_conditions || []).join(' ').toLowerCase();
  const hasDiabetes =
    conditions.includes('tiểu đường') ||
    conditions.includes('tieu duong') ||
    conditions.includes('diabetes') ||
    conditions.includes('đái tháo đường');

  const matched = [];

  for (const combo of DANGER_COMBOS) {
    let isMatch = false;

    if (combo.match === 'all') {
      // Special case: diabetic_warning with diabetes → match 2 of 3 groups
      if (combo.id === 'diabetic_warning' && hasDiabetes) {
        const groupMatches = combo.symptoms.filter(group =>
          group.some(kw => combinedText.includes(kw.toLowerCase()))
        );
        isMatch = groupMatches.length >= 2;
      } else {
        // Standard: ALL groups must have at least 1 match
        isMatch = combo.symptoms.every(group =>
          group.some(kw => combinedText.includes(kw.toLowerCase()))
        );
      }
    }

    if (isMatch) {
      const entry = {
        id: combo.id,
        name: combo.name,
        severity: combo.severity,
        action: combo.action,
        needsDoctor: combo.needsDoctor,
        needsFamilyAlert: combo.needsFamilyAlert,
        followUpHours: combo.followUpHours,
      };
      if (combo.extraQuestions) {
        entry.extraQuestions = combo.extraQuestions;
      }
      matched.push(entry);
    }
  }

  // Sort by severity descending (critical > high > medium)
  matched.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const highestSeverity = matched.length > 0 ? matched[0].severity : 'low';

  return {
    isCombo: matched.length > 0,
    combos: matched,
    highestSeverity,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  detectCombo,
  DANGER_COMBOS,
};
