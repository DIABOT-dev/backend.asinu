/**
 * Pattern Detector
 *
 * Analyzes user health data and detects recurring patterns.
 * Intended to be run by the R&D cycle nightly.
 *
 * Detected pattern types:
 *   recurring_day       - symptom appears on specific day(s) of week
 *   time_correlation    - symptom correlates with time of day
 *   severity_trend      - severity increasing/decreasing over recent days
 *   symptom_cooccurrence - two symptoms frequently appear together
 *   followup_response   - user typically improves/worsens after N hours
 *   medication_correlation - skipped medication correlates with symptom next day
 */

'use strict';

const MIN_OCCURRENCES = 2;       // need at least 2 occurrences to form a pattern
const LOOKBACK_DAYS = 30;        // analyze last 30 days of data
const CONFIDENCE_THRESHOLD = 0.6; // only return patterns above this confidence

/**
 * Analyze user data and detect patterns.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<Array<Pattern>>}
 */
async function detectPatterns(pool, userId) {
  const patterns = [];

  // Run all data queries in parallel
  const [symptomLogsRes, checkinsRes, sessionsRes, medAdherenceRes] = await Promise.all([
    // Symptom logs with day-of-week info
    pool.query(
      `SELECT symptom_name, occurred_date,
              EXTRACT(DOW FROM occurred_date) AS day_of_week,
              EXTRACT(HOUR FROM created_at) AS hour
       FROM symptom_logs
       WHERE user_id = $1 AND occurred_date >= CURRENT_DATE - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY occurred_date DESC`,
      [userId]
    ),

    // Check-ins with timing
    pool.query(
      `SELECT session_date, triage_severity, flow_state, current_status,
              EXTRACT(HOUR FROM created_at) AS hour,
              EXTRACT(DOW FROM session_date) AS day_of_week
       FROM health_checkins
       WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY session_date DESC`,
      [userId]
    ),

    // Script sessions with cluster info
    pool.query(
      `SELECT cluster_key, severity, answers, created_at, completed_at
       FROM script_sessions
       WHERE user_id = $1 AND is_completed = TRUE
         AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY created_at DESC`,
      [userId]
    ),

    // Medication adherence
    pool.query(
      `SELECT medication_date, status
       FROM medication_adherence
       WHERE user_id = $1 AND medication_date >= CURRENT_DATE - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY medication_date DESC`,
      [userId]
    ).catch(() => ({ rows: [] })), // table may have no data
  ]);

  const symptomLogs = symptomLogsRes.rows;
  const checkins = checkinsRes.rows;
  const sessions = sessionsRes.rows;
  const medAdherence = medAdherenceRes.rows;

  // ── Pattern 1: Recurring symptom on specific days ──────────────────────────
  const symptomsByDay = {};
  for (const log of symptomLogs) {
    const key = log.symptom_name;
    if (!symptomsByDay[key]) symptomsByDay[key] = {};
    const dow = parseInt(log.day_of_week);
    symptomsByDay[key][dow] = (symptomsByDay[key][dow] || 0) + 1;
  }

  const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  const weeksInRange = Math.ceil(LOOKBACK_DAYS / 7);

  for (const [symptom, dayCounts] of Object.entries(symptomsByDay)) {
    const totalOccurrences = Object.values(dayCounts).reduce((a, b) => a + b, 0);
    for (const [dow, count] of Object.entries(dayCounts)) {
      if (count < MIN_OCCURRENCES) continue;
      // Confidence: how concentrated is this symptom on this day?
      const concentration = count / totalOccurrences;
      const frequency = count / weeksInRange;
      const confidence = Math.round(Math.min(concentration * 0.6 + frequency * 0.4, 1.0) * 100) / 100;

      if (confidence >= CONFIDENCE_THRESHOLD) {
        patterns.push({
          type: 'recurring_day',
          description: `${symptom} thường xuất hiện vào ${dayNames[dow]}`,
          confidence,
          data: { symptom, dayOfWeek: parseInt(dow), occurrences: count, totalWeeks: weeksInRange },
          actionable: true,
          suggestion: `Hỏi thêm về hoạt động ${dayNames[(parseInt(dow) + 6) % 7]} và giấc ngủ đêm trước`,
        });
      }
    }
  }

  // ── Pattern 2: Time-of-day correlation ─────────────────────────────────────
  const symptomsByHour = {};
  for (const log of symptomLogs) {
    const key = log.symptom_name;
    if (!symptomsByHour[key]) symptomsByHour[key] = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    const h = parseInt(log.hour || 0);
    if (h >= 5 && h < 12) symptomsByHour[key].morning++;
    else if (h >= 12 && h < 17) symptomsByHour[key].afternoon++;
    else if (h >= 17 && h < 21) symptomsByHour[key].evening++;
    else symptomsByHour[key].night++;
  }

  const periodLabels = { morning: 'buổi sáng', afternoon: 'buổi chiều', evening: 'buổi tối', night: 'ban đêm' };
  for (const [symptom, periods] of Object.entries(symptomsByHour)) {
    const total = Object.values(periods).reduce((a, b) => a + b, 0);
    if (total < MIN_OCCURRENCES) continue;

    for (const [period, count] of Object.entries(periods)) {
      const ratio = count / total;
      if (ratio >= 0.5 && count >= MIN_OCCURRENCES) {
        const confidence = Math.round(Math.min(ratio, 1.0) * 100) / 100;
        patterns.push({
          type: 'time_correlation',
          description: `${symptom} thường xảy ra vào ${periodLabels[period]}`,
          confidence,
          data: { symptom, period, count, total },
          actionable: true,
          suggestion: `Check-in ${periodLabels[period]} nên hỏi thêm về ${symptom}`,
        });
      }
    }
  }

  // ── Pattern 3: Severity trend ──────────────────────────────────────────────
  if (checkins.length >= 3) {
    const sevMap = { low: 1, medium: 2, high: 3, critical: 4 };
    const recentSev = checkins
      .slice(0, 7)
      .map(c => sevMap[c.triage_severity] || 0)
      .filter(v => v > 0)
      .reverse(); // oldest first

    if (recentSev.length >= 3) {
      let increasing = 0;
      let decreasing = 0;
      for (let i = 1; i < recentSev.length; i++) {
        if (recentSev[i] > recentSev[i - 1]) increasing++;
        else if (recentSev[i] < recentSev[i - 1]) decreasing++;
      }
      const steps = recentSev.length - 1;

      if (increasing >= steps * 0.6) {
        const confidence = Math.round((increasing / steps) * 100) / 100;
        patterns.push({
          type: 'severity_trend',
          description: `Mức độ nghiêm trọng tăng dần ${recentSev.length} ngày qua`,
          confidence,
          data: { trend: 'increasing', values: recentSev, days: recentSev.length },
          actionable: true,
          suggestion: 'Cần theo dõi sát hơn, cân nhắc tăng tần suất check-in',
        });
      } else if (decreasing >= steps * 0.6) {
        const confidence = Math.round((decreasing / steps) * 100) / 100;
        patterns.push({
          type: 'severity_trend',
          description: `Mức độ nghiêm trọng giảm dần ${recentSev.length} ngày qua`,
          confidence,
          data: { trend: 'decreasing', values: recentSev, days: recentSev.length },
          actionable: false,
          suggestion: 'Tình trạng cải thiện, có thể giảm tần suất check-in',
        });
      }
    }
  }

  // ── Pattern 4: Symptom cluster co-occurrence ───────────────────────────────
  // Find symptoms that appear on the same day
  const symptomsByDate = {};
  for (const log of symptomLogs) {
    const dateKey = log.occurred_date?.toISOString?.()?.slice(0, 10) || String(log.occurred_date);
    if (!symptomsByDate[dateKey]) symptomsByDate[dateKey] = new Set();
    symptomsByDate[dateKey].add(log.symptom_name);
  }

  const cooccurrences = {};
  for (const symptoms of Object.values(symptomsByDate)) {
    const arr = [...symptoms];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const pair = [arr[i], arr[j]].sort().join(' + ');
        cooccurrences[pair] = (cooccurrences[pair] || 0) + 1;
      }
    }
  }

  for (const [pair, count] of Object.entries(cooccurrences)) {
    if (count < MIN_OCCURRENCES) continue;
    const totalDays = Object.keys(symptomsByDate).length;
    const confidence = Math.round(Math.min(count / totalDays * 1.5, 1.0) * 100) / 100;
    if (confidence >= CONFIDENCE_THRESHOLD) {
      const [s1, s2] = pair.split(' + ');
      patterns.push({
        type: 'symptom_cooccurrence',
        description: `${s1} thường xuất hiện cùng ${s2}`,
        confidence,
        data: { symptoms: [s1, s2], cooccurrences: count, totalDays },
        actionable: true,
        suggestion: `Khi hỏi về ${s1}, nên hỏi thêm ${s2} và ngược lại`,
      });
    }
  }

  // ── Pattern 5: Medication adherence correlation ────────────────────────────
  if (medAdherence.length > 0 && symptomLogs.length > 0) {
    // Find days where medication was skipped, then check if symptoms appeared next day
    const skippedDates = medAdherence
      .filter(m => m.status === 'skipped')
      .map(m => m.medication_date);

    if (skippedDates.length >= 2) {
      let symptomsAfterSkip = 0;
      let totalSkips = skippedDates.length;

      for (const skipDate of skippedDates) {
        const nextDay = new Date(skipDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().slice(0, 10);
        const hadSymptom = symptomLogs.some(s => {
          const logDate = s.occurred_date?.toISOString?.()?.slice(0, 10) || String(s.occurred_date);
          return logDate === nextDayStr;
        });
        if (hadSymptom) symptomsAfterSkip++;
      }

      if (symptomsAfterSkip >= MIN_OCCURRENCES) {
        const confidence = Math.round((symptomsAfterSkip / totalSkips) * 100) / 100;
        if (confidence >= CONFIDENCE_THRESHOLD) {
          patterns.push({
            type: 'medication_correlation',
            description: `Quên thuốc thường kèm triệu chứng ngày hôm sau`,
            confidence,
            data: { skippedDays: totalSkips, symptomDaysAfter: symptomsAfterSkip },
            actionable: true,
            suggestion: 'Nhắc nhở uống thuốc và hỏi tình trạng khi phát hiện bỏ thuốc',
          });
        }
      }
    }
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  return patterns;
}

module.exports = { detectPatterns };
