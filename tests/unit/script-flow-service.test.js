'use strict';

jest.mock('../../src/services/profile/lifecycle.service', () => ({ markActive: jest.fn() }));
jest.mock('../../src/services/checkin/script.service', () => ({ getScript: jest.fn() }));
jest.mock('../../src/services/checkin/script-session.service', () => ({
  getProfile: jest.fn(),
  createSession: jest.fn(),
  getSession: jest.fn(),
  updateAnswers: jest.fn(),
  completeSession: jest.fn(),
  markEmergency: jest.fn(),
  updateCheckinFromSession: jest.fn(),
  getScriptDataById: jest.fn(),
  alertFamilyIfNeeded: jest.fn(),
  setMultiSymptomMeta: jest.fn(),
  switchToNextCluster: jest.fn(),
}));
jest.mock('../../src/services/checkin/emergency-detector', () => ({
  detectEmergency: jest.fn(),
}));
jest.mock('../../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(null),
}));

const {
  startScriptFlow,
  answerScriptFlow,
} = require('../../src/services/checkin/script-flow.service');
const { markActive } = require('../../src/services/profile/lifecycle.service');
const { getSession, markEmergency } = require('../../src/services/checkin/script-session.service');
const { detectEmergency } = require('../../src/services/checkin/emergency-detector');

describe('script check-in service boundary', () => {
  const pool = {};

  beforeEach(() => jest.clearAllMocks());

  test('rejects invalid status before mutating lifecycle', async () => {
    const result = await startScriptFlow(pool, 7, { status: 'unknown' }, 'vi');
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(markActive).not.toHaveBeenCalled();
  });

  test('fine status marks activity without creating a script', async () => {
    const result = await startScriptFlow(pool, 7, { status: 'fine' }, 'vi');
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, needs_script: false, next_checkin: 'evening' },
    });
    expect(markActive).toHaveBeenCalledWith(pool, 7);
  });

  test('answer requires both identifiers', async () => {
    const result = await answerScriptFlow(pool, 7, { session_id: 9 }, 'en');
    expect(result.status).toBe(400);
    expect(getSession).not.toHaveBeenCalled();
  });

  test('answer refuses a completed session', async () => {
    getSession.mockResolvedValueOnce({ is_completed: true });
    const result = await answerScriptFlow(pool, 7, { session_id: 9, question_id: 'q1' }, 'vi');
    expect(result.status).toBe(400);
    expect(markActive).not.toHaveBeenCalled();
  });

  test('emergency answer closes the session before returning warning', async () => {
    getSession.mockResolvedValueOnce({ is_completed: false });
    detectEmergency.mockReturnValueOnce({ isEmergency: true, severity: 'critical' });
    const result = await answerScriptFlow(
      pool,
      7,
      {
        session_id: 9,
        question_id: 'q1',
        answer: 'đau ngực dữ dội',
      },
      'vi'
    );
    expect(markEmergency).toHaveBeenCalledWith(pool, 9);
    expect(result).toMatchObject({ status: 200, body: { ok: true, is_emergency: true } });
  });
});
