'use strict';

const { DEFAULT_TIMEZONE, resolveTimezone } = require('../src/services/health_feed/config');
const { FLOWS, buildFlowPlan, getSelfFlow, hasAlert, selectContentForPlan } = require('../src/services/health_feed/logic');

describe('health feed logic', () => {
  test('defaults timezone to Vietnam when user timezone missing', () => {
    expect(resolveTimezone()).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  test('routes alert before mixed family feed', () => {
    const ctx = {
      segment: 'active',
      created_at: new Date().toISOString(),
      onboarding_completed_at: new Date().toISOString(),
      related_patients: [{ patient_id: 22 }],
      top_cluster: { trend: 'increasing', count_7d: 3, cluster_key: 'headache' },
    };
    expect(hasAlert(ctx)).toBe(true);
    expect(getSelfFlow(ctx)).toBe(FLOWS.ALERT);
    expect(buildFlowPlan(ctx)).toEqual([
      { flow: FLOWS.ALERT, limit: 5, patientId: null, label: 'self-alert' },
    ]);
  });

  test('builds mixed feed with max 2 family and 3 self items', () => {
    const ctx = {
      segment: 'active',
      created_at: new Date().toISOString(),
      onboarding_completed_at: new Date().toISOString(),
      related_patients: [{ patient_id: 11 }, { patient_id: 12 }],
      top_cluster: null,
    };
    expect(buildFlowPlan(ctx)).toEqual([
      { flow: FLOWS.FAMILY, limit: 2, patientIds: [11, 12], label: 'family' },
      { flow: FLOWS.ONBOARDING, limit: 3, patientId: null, label: 'self' },
    ]);
  });

  test('selects mixed feed respecting limits and unique content', () => {
    const catalog = [
      { id: 'f1', target_flow: FLOWS.FAMILY, status: 'active', content_type: 'family_note', target_conditions: [], topic_category: 'family', engagement_score: 50 },
      { id: 'f2', target_flow: FLOWS.FAMILY, status: 'active', content_type: 'family_note', target_conditions: [], topic_category: 'family', engagement_score: 49 },
      { id: 'f3', target_flow: FLOWS.FAMILY, status: 'active', content_type: 'family_note', target_conditions: [], topic_category: 'family', engagement_score: 48 },
      { id: 's1', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'diet', engagement_score: 50 },
      { id: 's2', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'exercise', engagement_score: 49 },
      { id: 's3', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'medication', engagement_score: 48 },
      { id: 's4', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'mental', engagement_score: 47 },
    ];
    const context = {
      segment: 'semi_active',
      created_at: '2026-05-01T00:00:00.000Z',
      onboarding_completed_at: '2026-05-02T00:00:00.000Z',
      related_patients: [{ patient_id: 11 }, { patient_id: 12 }],
      medical_conditions: [],
      medication_adherence_rate: 1,
      top_cluster: null,
      current_step: 1,
      checkin_days_7d: 0,
    };

    const selected = selectContentForPlan({
      catalog,
      context,
      historyKeys: new Set(),
      dismissedKeys: new Set(),
      activeKeys: new Set(),
      nowParts: { weekday: 'Mon' },
    });

    expect(selected).toHaveLength(5);
    expect(selected.filter((item) => item.flow === FLOWS.FAMILY)).toHaveLength(2);
    expect(selected.filter((item) => item.flow === FLOWS.NURTURE)).toHaveLength(3);
    expect(new Set(selected.map((item) => item.content.id)).size).toBe(5);
  });

  test('fills self-only feed up to limit instead of stopping after one item', () => {
    const catalog = [
      { id: 'a1', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'diet', engagement_score: 50 },
      { id: 'a2', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'exercise', engagement_score: 49 },
      { id: 'a3', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'medication', engagement_score: 48 },
      { id: 'a4', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'mental', engagement_score: 47 },
      { id: 'a5', target_flow: FLOWS.NURTURE, status: 'active', content_type: 'article', target_conditions: [], topic_category: 'general', engagement_score: 46 },
    ];
    const context = {
      segment: 'semi_active',
      created_at: '2026-05-01T00:00:00.000Z',
      onboarding_completed_at: '2026-04-01T00:00:00.000Z',
      related_patients: [],
      medical_conditions: [],
      medication_adherence_rate: 1,
      top_cluster: null,
      current_step: 1,
      checkin_days_7d: 0,
    };

    const selected = selectContentForPlan({
      catalog,
      context,
      historyKeys: new Set(),
      dismissedKeys: new Set(),
      activeKeys: new Set(),
      nowParts: { weekday: 'Mon' },
    });

    expect(selected).toHaveLength(5);
    expect(selected.every((item) => item.flow === FLOWS.NURTURE)).toBe(true);
  });
});
