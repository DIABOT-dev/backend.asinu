'use strict';

const FLOWS = {
  ALERT: 'FLOW_ALERT',
  FAMILY: 'FLOW_FAMILY',
  ONBOARDING: 'FLOW_ONBOARDING',
  NURTURE: 'FLOW_NURTURE',
  REACTIVATE: 'FLOW_REACTIVATE',
  WINBACK: 'FLOW_WINBACK',
};

const PUSHABLE_FLOWS = new Set([FLOWS.ALERT, FLOWS.FAMILY, FLOWS.ONBOARDING]);

function normalizeConditions(conditions) {
  if (Array.isArray(conditions)) return conditions.filter(Boolean).map(String);
  return [];
}

function computeJourneyDay(context, now = new Date()) {
  const start = context.onboarding_completed_at || context.created_at;
  if (!start) return 999;
  const diffMs = now.getTime() - new Date(start).getTime();
  return Math.max(1, Math.floor(diffMs / 86400000) + 1);
}

function hasAlert(context) {
  return Boolean(
    context.top_cluster &&
    context.top_cluster.trend === 'increasing' &&
    Number(context.top_cluster.count_7d || 0) >= 3
  );
}

function getSelfFlow(context, now = new Date()) {
  if (hasAlert(context)) return FLOWS.ALERT;
  if (context.segment === 'churned') return FLOWS.WINBACK;
  if (context.segment === 'inactive') return FLOWS.REACTIVATE;
  if (computeJourneyDay(context, now) <= 7) return FLOWS.ONBOARDING;
  return FLOWS.NURTURE;
}

function buildFlowPlan(context, now = new Date()) {
  const selfFlow = getSelfFlow(context, now);
  const caregivers = Array.isArray(context.related_patients) ? context.related_patients : [];
  const mixedEligible = caregivers.length > 0 && selfFlow !== FLOWS.ALERT;

  if (selfFlow === FLOWS.ALERT) {
    return [{ flow: FLOWS.ALERT, limit: 5, patientId: null, label: 'self-alert' }];
  }

  if (mixedEligible) {
    return [
      { flow: FLOWS.FAMILY, limit: 2, patientIds: caregivers.map((p) => p.patient_id), label: 'family' },
      { flow: selfFlow, limit: 3, patientId: null, label: 'self' },
    ];
  }

  if (caregivers.length > 0) {
    return [{ flow: FLOWS.FAMILY, limit: 5, patientIds: caregivers.map((p) => p.patient_id), label: 'family-only' }];
  }

  return [{ flow: selfFlow, limit: 5, patientId: null, label: 'self-only' }];
}

function topicPriority(context) {
  if (Number(context.medication_adherence_rate || 1) < 0.5) {
    return ['medication', 'diet', 'exercise', 'mental'];
  }
  return ['diet', 'exercise', 'medication', 'mental'];
}

function isSunday(timeParts) {
  return timeParts.weekday === 'Sun';
}

function createCandidateScore(content, context, slotIndex, preferredTopics) {
  let score = Number(content.engagement_score || 0);
  if (Number(content.flow_step || 0) === Number(context.current_step || 1)) score += 80;
  if (content.target_cluster_key && content.target_cluster_key === context.top_cluster?.cluster_key) score += 120;
  if (content.topic_category && preferredTopics.includes(content.topic_category)) {
    score += Math.max(0, 40 - preferredTopics.indexOf(content.topic_category) * 10);
  }
  if (slotIndex === 0 && content.content_type === 'warning') score += 100;
  return score;
}

function selectContentForPlan({ catalog, context, historyKeys, dismissedKeys, activeKeys, nowParts }) {
  const preferredTopics = topicPriority(context);
  const selected = [];
  const usedTopics = new Set();
  const usedContentIds = new Set();
  const poolForPlan = (plan) => {
    const patientIds = Array.isArray(plan.patientIds) && plan.patientIds.length > 0 ? plan.patientIds : [null];
    if (plan.flow === FLOWS.FAMILY) return patientIds;
    return Array.from({ length: plan.limit }, () => null);
  };

  for (const plan of buildFlowPlan(context)) {
    let perPlan = 0;
    for (const patientId of poolForPlan(plan)) {
      if (selected.length >= 5 || perPlan >= plan.limit) break;
      const candidates = catalog
        .filter((content) => content.target_flow === plan.flow)
        .filter((content) => content.status === 'active')
        .filter((content) => !usedContentIds.has(content.id))
        .filter((content) => !historyKeys.has(`${content.id}:${patientId || 'self'}`))
        .filter((content) => !dismissedKeys.has(`${content.id}:${patientId || 'self'}`))
        .filter((content) => !activeKeys.has(`${content.id}:${patientId || 'self'}`))
        .filter((content) => {
          if (!content.target_conditions?.length) return true;
          return content.target_conditions.some((condition) => normalizeConditions(context.medical_conditions).includes(condition));
        })
        .filter((content) => !content.target_cluster_key || content.target_cluster_key === context.top_cluster?.cluster_key)
        .filter((content) => {
          if (plan.flow === FLOWS.NURTURE && usedTopics.has(content.topic_category)) return false;
          if (plan.flow === FLOWS.REACTIVATE || plan.flow === FLOWS.WINBACK) return true;
          if (content.content_type === 'weekly_summary') {
            return isSunday(nowParts) && Number(context.checkin_days_7d || 0) >= 3;
          }
          return true;
        })
        .sort((a, b) => createCandidateScore(b, context, selected.length, preferredTopics) - createCandidateScore(a, context, selected.length, preferredTopics));

      const chosen = candidates[0];
      if (!chosen) continue;
      selected.push({
        content: chosen,
        patient_id: patientId,
        flow: plan.flow,
      });
      perPlan += 1;
      usedContentIds.add(chosen.id);
      if (chosen.topic_category) usedTopics.add(chosen.topic_category);
    }
  }

  return selected.slice(0, 5);
}

module.exports = {
  FLOWS,
  PUSHABLE_FLOWS,
  buildFlowPlan,
  computeJourneyDay,
  getSelfFlow,
  hasAlert,
  selectContentForPlan,
};
