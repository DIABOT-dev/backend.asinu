jest.mock('../../src/services/checkin/checkin.service', () => ({
  getHealthReport: jest.fn(),
  getHealthScore: jest.fn(),
}));

jest.mock('../../src/services/tree/tree.service', () => ({
  getTreeSummary: jest.fn(),
  getTreeHistory: jest.fn(),
}));

jest.mock('../../src/services/profile/mobile.service', () => ({
  getRecentLogs: jest.fn(),
}));

jest.mock('../../src/services/missions/missions.service', () => ({
  getMissions: jest.fn(),
}));

jest.mock('../../src/services/care-circle/careCircle.service', () => ({
  createInvitation: jest.fn(),
  getInvitations: jest.fn(),
  acceptInvitation: jest.fn(),
  rejectInvitation: jest.fn(),
  cancelInvitation: jest.fn(),
  getConnections: jest.fn(),
  deleteConnection: jest.fn(),
  updateConnection: jest.fn(),
  updateConnectionPermissions: jest.fn(),
  verifyCaregiverAccess: jest.fn(),
  getCaregiverLogs: jest.fn(),
  getCaregiverCheckins: jest.fn(),
  getPatientName: jest.fn(),
}));

const checkinService = require('../../src/services/checkin/checkin.service');
const treeService = require('../../src/services/tree/tree.service');
const mobileService = require('../../src/services/profile/mobile.service');
const { getMissions } = require('../../src/services/missions/missions.service');
const careCircleService = require('../../src/services/care-circle/careCircle.service');
const { getMemberHealthSummary } = require('../../src/controllers/careCircle.controller');

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('getMemberHealthSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks access when caregiver does not have care-circle permission', async () => {
    careCircleService.verifyCaregiverAccess.mockResolvedValue(false);
    const res = createRes();

    await getMemberHealthSummary({}, { user: { id: 10 }, params: { memberId: '20' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Không có quyền truy cập' });
    expect(checkinService.getHealthReport).not.toHaveBeenCalled();
  });

  test('returns symptom-first health report payload for connected caregiver', async () => {
    careCircleService.verifyCaregiverAccess.mockResolvedValue(true);
    careCircleService.getPatientName.mockResolvedValue('Nguyen Van A');
    careCircleService.getCaregiverCheckins.mockResolvedValue([
      {
        id: 99,
        created_at: '2026-06-10T08:00:00.000Z',
        triage_severity: 'medium',
        triage_summary: 'Người dùng báo mệt mỏi và khát nước.',
      },
    ]);
    checkinService.getHealthReport.mockResolvedValue({
      totalDays: 7,
      checkinDays: 6,
      severityDistribution: { low: 3, medium: 2, high: 1 },
      statusDistribution: { fine: 2, tired: 3, very_tired: 1, specific_concern: 0 },
      commonSymptoms: [
        { symptom: 'mệt mỏi', count: 4 },
        { symptom: 'khát nước nhiều', count: 3 },
      ],
      alerts: { familyAlerted: 2, emergencyTriggered: 0 },
      trend: 'worsening',
      sessions: [
        { date: '2026-06-10', status: 'tired', severity: 'medium', summary: 'Mệt mỏi.' },
        { date: '2026-06-09', status: 'very_tired', severity: 'high', summary: 'Chóng mặt.' },
      ],
      responseRate: 86,
      avgCheckinHour: 8,
    });
    checkinService.getHealthScore.mockResolvedValue({ level: 'monitor', factors: ['status_tired'], checkinDone: true });
    treeService.getTreeSummary.mockResolvedValue(null);
    treeService.getTreeHistory.mockResolvedValue({ history: [] });
    mobileService.getRecentLogs.mockResolvedValue({ ok: true, logs: [] });
    getMissions.mockResolvedValue([]);
    const res = createRes();

    await getMemberHealthSummary({}, { user: { id: 10 }, params: { memberId: '20' } }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      patientName: 'Nguyen Van A',
      report: expect.objectContaining({
        checkinDays: 6,
        trend: 'worsening',
        commonSymptoms: [
          { symptom: 'mệt mỏi', count: 4 },
          { symptom: 'khát nước nhiều', count: 3 },
        ],
        severityDistribution: { low: 3, medium: 2, high: 1 },
        statusDistribution: { fine: 2, tired: 3, very_tired: 1, specific_concern: 0 },
        recentSessions: [
          { date: '2026-06-10', status: 'tired', severity: 'medium', summary: 'Mệt mỏi.' },
          { date: '2026-06-09', status: 'very_tired', severity: 'high', summary: 'Chóng mặt.' },
        ],
      }),
    }));
  });
});
