'use strict';

const {
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

module.exports = { caregiverLogs, caregiverCheckins, memberHealthSummary };
