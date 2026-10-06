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

  test('does not fetch a monthly report or name without consent', async () => {
    circle.verifyCaregiverAccess.mockResolvedValueOnce(false);
    await expect(view.memberHealthCalendar(pool, 7, 8, '2026-10')).resolves.toBeNull();
    expect(checkin.getHealthReport).not.toHaveBeenCalled();
    expect(circle.getPatientName).not.toHaveBeenCalled();
  });

  test.each([
    ['2024-02', '2024-03-01', 29],
    ['2025-02', '2025-03-01', 28],
    ['2026-12', '2027-01-01', 31],
  ])('loads the exact month %s, with an exclusive end date', async (month, end, days) => {
    circle.verifyCaregiverAccess.mockResolvedValueOnce(true);
    circle.getPatientName.mockResolvedValueOnce('Parent');
    checkin.getHealthReport.mockResolvedValueOnce({ sessions: [], totalDays: days });
    const result = await view.memberHealthCalendar(pool, 7, 8, month);
    expect(checkin.getHealthReport).toHaveBeenCalledWith(pool, 8, days, {
      startDate: `${month}-01`, endDateExclusive: end, totalDays: days,
    });
    expect(result).toEqual({ patientName: 'Parent', report: { sessions: [], totalDays: days, period: 'month', month } });
  });
});
