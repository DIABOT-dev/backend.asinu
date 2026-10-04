'use strict';

jest.mock('../../src/services/checkin/checkin.service', () => ({
  startCheckin: jest.fn(),
  recordFollowUp: jest.fn(),
  triggerEmergency: jest.fn(),
}));
jest.mock('../../src/services/profile/lifecycle.service', () => ({
  markActive: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/care-circle/caregiver-status.service', () => ({
  buildCaregiverStatus: jest.fn(),
}));

const api = require('../../src/services/checkin/checkin-api.service');
const checkin = require('../../src/services/checkin/checkin.service');
const { markActive } = require('../../src/services/profile/lifecycle.service');
const earlySignal = require('../../src/services/early-signal/early-signal.service');
const caregiver = require('../../src/services/care-circle/caregiver-status.service');

describe('check-in orchestration', () => {
  const pool = {};
  beforeEach(() => jest.clearAllMocks());

  test('marks a new check-in active and schedules early-signal evaluation', async () => {
    checkin.startCheckin.mockResolvedValueOnce({ id: 12, updated_at: '2026-10-04' });
    const session = await api.startCheckin(pool, 7, 'fine', [], null, { source: 'scheduled' });
    expect(session.id).toBe(12);
    expect(markActive).toHaveBeenCalledWith(pool, 7);
    expect(earlySignal.evaluateAfterNewHealthData).toHaveBeenCalledWith(
      pool,
      7,
      'checkin-start:12:fine:2026-10-04'
    );
  });

  test('does not evaluate an already-resolved follow-up again', async () => {
    checkin.recordFollowUp.mockResolvedValueOnce({
      id: 12,
      flow_state: 'resolved',
      current_status: 'fine',
    });
    await expect(api.recordFollowUp(pool, 7, 12, 'tired')).resolves.toMatchObject({
      alreadyResolved: true,
      session: { id: 12 },
    });
    expect(earlySignal.evaluateAfterNewHealthData).not.toHaveBeenCalled();
  });

  test('includes caregiver connection state with an emergency result', async () => {
    checkin.triggerEmergency.mockResolvedValueOnce({ ok: true, emergency_id: 3 });
    caregiver.buildCaregiverStatus.mockResolvedValueOnce({ has_caregiver: false });
    await expect(api.triggerEmergency(pool, 7, null)).resolves.toEqual({
      ok: true,
      emergency_id: 3,
      has_caregiver: false,
    });
    expect(caregiver.buildCaregiverStatus).toHaveBeenCalledWith(pool, 7, {
      riskTier: 'emergency',
    });
  });
});
