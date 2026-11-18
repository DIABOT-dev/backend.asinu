'use strict';

const {
  caregiverAccessSql,
  verifyCaregiverAccess,
  getCaregiverLogs,
  getCaregiverCheckins,
  getPatientName,
} = require('./careCircle.service');
const checkinService = require('../checkin/checkin.service');
const { t } = require('../../i18n');

async function caregiverLogs(pool, caregiverId, patientId, lang) {
  if (!(await verifyCaregiverAccess(pool, caregiverId, patientId))) return null;
  const logs = await getCaregiverLogs(pool, patientId, 7);
  const patientName = (await getPatientName(pool, patientId)) || t('careCircle.user_label', lang);
  return { patientName, logs };
}

async function caregiverCheckins(pool, caregiverId, patientId) {
  if (!(await verifyCaregiverAccess(pool, caregiverId, patientId))) return null;
  const sessions = await getCaregiverCheckins(pool, patientId, 14);
  const patientName = await getPatientName(pool, patientId);
  return { patientName, sessions };
}

async function memberHealthSummary(pool, caregiverId, memberId) {
  if (!(await verifyCaregiverAccess(pool, caregiverId, memberId))) return null;
  const [report, healthScore] = await Promise.all([
    checkinService.getHealthReport(pool, memberId, 7),
    checkinService.getHealthScore(pool, memberId),
  ]);
  return {
    healthScore,
    report: {
      checkinDays: report.checkinDays,
      totalDays: report.totalDays,
      trend: report.trend,
      severityDistribution: report.severityDistribution,
      statusDistribution: report.statusDistribution,
      commonSymptoms: report.commonSymptoms,
      alerts: report.alerts,
      sessions: report.sessions || [],
      highlights: report.highlights || [],
      responseRate: report.responseRate || 0,
      avgCheckinHour: report.avgCheckinHour || 0,
    },
  };
}

async function memberHealthOverview(pool, caregiverId, memberId) {
  if (Number(caregiverId) === Number(memberId)) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(u.display_name, ''), u.full_name) AS "name",
            u.avatar_url AS "avatarUrl", p.height_cm AS "heightCm", p.weight_kg AS "weightKg",
            bp.systolic, bp.diastolic, bp.pulse, bp.unit AS "bloodPressureUnit", glucose.value AS glucose,
            glucose.unit AS "glucoseUnit"
     FROM users u
     LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT b.systolic, b.diastolic, b.pulse, b.unit
       FROM logs_common l JOIN blood_pressure_logs b ON b.log_id = l.id
       WHERE l.user_id = u.id AND l.log_type IN ('bp', 'blood_pressure') AND l.occurred_at <= NOW()
       ORDER BY l.occurred_at DESC, l.id DESC LIMIT 1
     ) bp ON TRUE
     LEFT JOIN LATERAL (
       SELECT g.value, g.unit
       FROM logs_common l JOIN glucose_logs g ON g.log_id = l.id
       WHERE l.user_id = u.id AND l.log_type = 'glucose' AND l.occurred_at <= NOW()
       ORDER BY l.occurred_at DESC, l.id DESC LIMIT 1
     ) glucose ON TRUE
     WHERE u.id = $1 AND u.deleted_at IS NULL
       AND EXISTS (${caregiverAccessSql})`,
    [memberId, caregiverId]
  );
  return rows[0] || null;
}

async function memberHealthCalendar(pool, caregiverId, memberId, month) {
  // Never fetch or cache another user's medical data before checking consent.
  if (!(await verifyCaregiverAccess(pool, caregiverId, memberId))) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
  const dateRange = {
    startDate: `${month}-01`,
    endDateExclusive: nextMonth.toISOString().slice(0, 10),
    totalDays: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(),
  };
  const [report, patientName] = await Promise.all([
    checkinService.getHealthReport(pool, memberId, dateRange.totalDays, dateRange),
    getPatientName(pool, memberId),
  ]);
  return { patientName, report: { ...report, period: 'month', month } };
}

module.exports = { caregiverLogs, caregiverCheckins, memberHealthSummary, memberHealthCalendar, memberHealthOverview };
