'use strict';

const {
  completedPhase,
  followUpCopyKeys,
  followUpSnapshot,
  isStaleCheckinReminder,
} = require('../../src/services/notification/checkin-reminder.policy');
const { t } = require('../../src/i18n');
const { getHonorifics } = require('../../src/lib/honorifics');

describe('check-in reminder content follows the current interview phase', () => {
  const completed = {
    id: '12',
    initial_status: 'tired',
    current_status: 'tired',
    flow_state: 'follow_up',
    triage_completed_at: new Date('2026-11-09T01:00:00Z'),
  };
  test.each([1, 2, 4])('a completed interview uses a check-again message at miss %i', (misses) => {
    const keys = followUpCopyKeys(completed, misses);
    const body = t(
      keys.body,
      'vi',
      getHonorifics({ full_name: 'Trần Văn Hùng', birth_year: 1970, gender: 'male' })
    );
    expect(body).toContain('đã ghi nhận');
    expect(body).toContain('Chú Hùng');
    expect(body).not.toMatch(/chưa hoàn tất|chưa xong|\{\{|\bbạn\b/u);
    expect(t(keys.body, 'en')).not.toMatch(/not completed|in progress/);
  });
  test('completed high alert retains monitoring guidance without claiming the interview is incomplete', () => {
    expect(followUpCopyKeys({ ...completed, flow_state: 'high_alert' }, 2).body).toBe(
      'checkin.followup_after_result_high'
    );
  });
  test('a newly opened follow-up is incomplete despite retaining the previous completion timestamp', () => {
    const session = { ...completed, triage_state: { phase: 'followup', phase_id: 'new-phase' } };
    expect(completedPhase(session)).toBe(false);
    expect(followUpCopyKeys(session, 1).body).toBe('checkin.followup_normal');
  });
  test('a committed current follow-up is complete even before post-processing finishes', () => {
    expect(
      completedPhase({
        ...completed,
        triage_state: { phase: 'followup', completed: { committed: true, finalized: false } },
      })
    ).toBe(true);
  });
  test('an uncommitted conclusion cannot reuse a previous completion timestamp', () => {
    expect(
      completedPhase({
        ...completed,
        triage_state: { phase: 'followup', completed: { finalized: false } },
      })
    ).toBe(false);
  });
  test('routine monitoring keeps its ordinary follow-up copy', () => {
    const session = {
      ...completed,
      current_status: 'fine',
      flow_state: 'monitoring',
      triage_severity: 'low',
    };
    expect(followUpCopyKeys(session, 3).body).toBe('checkin.followup_monitoring');
  });
  test('a queued reminder becomes stale when an answer advances its revision', async () => {
    const session = {
      ...completed,
      triage_state: { phase_id: 'phase', revision: 'before' },
      last_response_at: new Date(),
    };
    const db = {
      query: jest.fn(async () => ({
        rows: [{ ...session, triage_state: { phase_id: 'phase', revision: 'after' } }],
      })),
    };
    expect(
      await isStaleCheckinReminder(db, {
        user_id: 1,
        type: 'checkin_followup',
        data: followUpSnapshot(session),
      })
    ).toBe(true);
  });
  test('emergency and family safety alerts do not inherit patient reminder suppression', async () => {
    const db = { query: jest.fn() };
    for (const type of ['emergency', 'caregiver_alert', 'early_signal', 'health_alert'])
      expect(
        await isStaleCheckinReminder(db, { user_id: 1, type, data: { checkinId: '12' } })
      ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});
