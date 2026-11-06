'use strict';
const { calculateConclusion } = require('../../src/core/checkin/triage-engine');

// Fixed synthetic cases only. No database, identifiers, names or freeform CLI input.
function cases(now = new Date()) {
  const at = (hours) => new Date(now.getTime() - hours * 3600000).toISOString();
  const groups = [
    ['head', ['đau đầu nhẹ', 'chóng mặt khi đứng dậy']],
    ['chest', ['hơi tức ngực từng lúc']],
    ['respiratory', ['ho', 'đau họng']],
    ['digestive', ['đầy bụng', 'buồn nôn nhẹ']],
    ['musculoskeletal', ['đau mỏi vai', 'đau lưng nhẹ']],
    ['fatigue', ['mệt mỏi', 'khó ngủ']],
    ['other', ['ngứa da nhẹ']],
  ];
  const output = [];
  for (const [group, symptoms] of groups) {
    for (let variant = 0; variant < 4; variant++) {
      const conditions =
        variant === 0
          ? []
          : variant === 1
            ? ['Mỡ máu cao']
            : variant === 2
              ? ['Cao huyết áp']
              : ['Tiểu đường'];
      const profile = {
        age: variant === 2 ? 68 : 52,
        gender: variant % 2 ? 'Nữ' : 'Nam',
        medical_conditions: conditions,
      };
      const state = {
        allSymptoms: symptoms,
        currentSymptoms: symptoms,
        redFlagsFound: [],
        completedSteps: new Set(['symptoms', 'onset', 'progression', 'red_flags']),
        actionsFound: [],
        onset: 'vài ngày nay',
        progression: variant === 0 ? 'better' : variant === 2 ? 'worse' : 'same',
        isElderly: profile.age >= 60,
        hasConditions: conditions.length > 0,
        assessmentIncomplete: false,
      };
      Object.assign(state, calculateConclusion(state, 'tired'));
      const context = {
        recentBP:
          variant === 2
            ? [
                { systolic: 128, diastolic: 82, occurred_at: at(3) },
                { systolic: 130, diastolic: 84, occurred_at: at(48) },
              ]
            : [{ systolic: 128, diastolic: 82, occurred_at: at(48) }],
        recentGlucose:
          variant === 3
            ? [
                { value: 6.4, unit: 'mmol/L', occurred_at: at(2) },
                { value: 6.7, unit: 'mmol/L', occurred_at: at(50) },
              ]
            : [],
        tookMedicationToday: variant === 3,
        medicationAdherenceContext: variant === 3 ? 'Thuốc 7 ngày: 6/7 ngày uống đúng' : null,
        previousCheckins: [
          {
            session_date: at(48).slice(0, 10),
            initial_status: 'tired',
            triage_summary: symptoms.join(', '),
          },
        ],
        symptomFrequencyContext: `${symptoms[0]}: 2 lần/7 ngày, 2 lần/30 ngày`,
      };
      output.push({ id: `${group}-${variant}`, lang: 'vi', profile, state, context });
    }
  }
  const incomplete = structuredClone(output[20]);
  incomplete.id = 'incomplete-assessment';
  incomplete.state.assessmentIncomplete = true;
  incomplete.state.completedSteps = new Set(['symptoms', 'onset']);
  Object.assign(incomplete.state, calculateConclusion(incomplete.state, 'tired'));
  output.push(incomplete);
  const english = structuredClone(output[21]);
  english.id = 'english-relative-checkin';
  english.lang = 'en';
  english.state.allSymptoms = ['fatigue', 'poor sleep'];
  english.state.currentSymptoms = english.state.allSymptoms;
  output.push(english);
  return output;
}
module.exports = { cases };
