'use strict';

jest.mock('../../src/services/care-circle/careCircle.service', () => ({
  verifyCaregiverAccess: jest.fn(),
  getCaregiverLogs: jest.fn(),
  getCaregiverCheckins: jest.fn(),
  getPatientName: jest.fn(),
}));
jest.mock('../../src/services/checkin/checkin.service', () => ({
  getHealthReport: jest.fn(),
  getHealthScore: jest.fn(),
}));

const view = require('../../src/services/care-circle/caregiver-view.service');
const circle = require('../../src/services/care-circle/careCircle.service');
const checkin = require('../../src/services/checkin/checkin.service');

describe('caregiver view authorization', () => {
  const pool = {};
  beforeEach(() => jest.clearAllMocks());

  test('does not read protected logs when access is denied', async () => {
    circle.verifyCaregiverAccess.mockResolvedValueOnce(false);
    await expect(view.caregiverLogs(pool, 7, 8, 'vi')).resolves.toBeNull();
    expect(circle.getCaregiverLogs).not.toHaveBeenCalled();
  });

  test('does not read summary or score when access is denied', async () => {
    circle.verifyCaregiverAccess.mockResolvedValueOnce(false);
    await expect(view.memberHealthSummary(pool, 7, 8)).resolves.toBeNull();
    expect(checkin.getHealthReport).not.toHaveBeenCalled();
    expect(checkin.getHealthScore).not.toHaveBeenCalled();
  });

  test('builds an authorized summary with stable response fields', async () => {
    circle.verifyCaregiverAccess.mockResolvedValueOnce(true);
    checkin.getHealthReport.mockResolvedValueOnce({ checkinDays: 3, totalDays: 7 });
    checkin.getHealthScore.mockResolvedValueOnce({ score: 81 });
    await expect(view.memberHealthSummary(pool, 7, 8)).resolves.toMatchObject({
      healthScore: { score: 81 },
      report: { checkinDays: 3, totalDays: 7, sessions: [], highlights: [] },
    });
  });
});
