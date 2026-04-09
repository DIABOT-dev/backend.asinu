'use strict';

/**
 * Agent Decision Engine
 *
 * Given a context object, decides:
 *   1. What greeting to use (personalized)
 *   2. Which cluster to prioritize
 *   3. Whether to add/skip questions based on history
 *   4. How to interpret answers (with context)
 *   5. What conclusion to draw (with history awareness)
 *   6. What follow-up plan to create
 *
 * Design: Every decision is logged with reasoning (explainability).
 * Later: MedGemma replaces rule-based decisions with AI.
 */

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function sevRank(s) {
  return SEVERITY_RANK[s] || 0;
}

// ─── Greeting decision ─────────────────────────────────────────────────────

/**
 * Decide what greeting to show.
 * Uses context to personalize: mention yesterday's symptom, ask about medication, etc.
 *
 * @param {object} context
 * @param {object} context.profile - { full_name, birth_year, gender, medical_conditions }
 * @param {object} context.honorifics - { honorific, selfRef, callName, Honorific, CallName }
 * @param {Array}  context.recentSessions - recent script_sessions (last 7 days)
 * @param {Array}  context.clusters - problem_clusters rows
 * @param {boolean} context.isFollowUp - whether this is a follow-up session
 * @param {number} context.hourOfDay - current hour (0-23) in user timezone
 * @returns {{ greeting: string, reason: string }}
 */
function decideGreeting(context) {
  const { honorifics: h, recentSessions = [], clusters = [], isFollowUp = false, hourOfDay = 12 } = context;
  if (!h) {
    return { greeting: 'Chao ban! Hom nay ban the nao?', reason: 'no_honorifics_fallback' };
  }

  const CallName = h.CallName || (h.callName ? h.callName.charAt(0).toUpperCase() + h.callName.slice(1) : 'Ban');

  // Rule 5: follow-up
  if (isFollowUp) {
    return {
      greeting: `${CallName} oi, so voi luc truoc, ${h.honorific} thay the nao?`,
      reason: 'follow_up_session',
    };
  }

  // Find yesterday's high-severity session
  const yesterday = _getYesterdaySessions(recentSessions);
  const highYesterday = yesterday.find(s => s.severity === 'high' || s.severity === 'critical');

  // Rule 1: high severity yesterday
  if (highYesterday) {
    const clusterName = _clusterDisplayName(highYesterday.cluster_key, clusters);
    return {
      greeting: `${CallName} oi, hom qua ${h.honorific} noi bi ${clusterName}, hom nay the nao roi?`,
      reason: `yesterday_high_severity: ${highYesterday.cluster_key}=${highYesterday.severity}`,
    };
  }

  // Rule 2: worsening trend in any cluster
  const worseningCluster = clusters.find(c => c.trend === 'increasing' && c.count_7d >= 3);
  if (worseningCluster) {
    return {
      greeting: `${CallName} oi, may hom nay ${h.honorific} ${worseningCluster.display_name} nhieu hon, hom nay the nao?`,
      reason: `worsening_trend: ${worseningCluster.cluster_key} count_7d=${worseningCluster.count_7d}`,
    };
  }

  // Rule 3: missed medication (check if user has medical conditions suggesting medication)
  const hasChronicConditions = (context.profile?.medical_conditions || []).length > 0;
  const noRecentCheckin = recentSessions.length === 0 || _daysSinceLastSession(recentSessions) >= 2;
  if (hasChronicConditions && noRecentCheckin) {
    return {
      greeting: `${CallName} oi, ${h.honorific} uong thuoc chua? Hom nay the nao?`,
      reason: 'chronic_conditions_no_recent_checkin',
    };
  }

  // Rule 4: standard greeting (time-aware)
  const timeGreeting = hourOfDay < 12 ? 'Chao buoi sang' : hourOfDay < 18 ? 'Chao buoi chieu' : 'Chao buoi toi';
  return {
    greeting: `${timeGreeting} ${CallName}! Hom nay ${h.honorific} the nao?`,
    reason: 'standard_greeting',
  };
}

// ─── Cluster prioritization ────────────────────────────────────────────────

/**
 * Decide which clusters to ask about (priority order).
 * Based on: frequency, trend, yesterday's result, time of day.
 *
 * @param {object} context
 * @returns {Array<{ clusterKey: string, displayName: string, reason: string, priority: number }>}
 */
function decideClusters(context) {
  const { clusters = [], recentSessions = [] } = context;

  if (clusters.length === 0) return [];

  // Score each cluster
  const scored = clusters.map(c => {
    let score = c.priority || 0;
    let reasons = [];

    // Rule 1: yesterday HIGH and not resolved
    const yesterdaySessions = _getYesterdaySessions(recentSessions);
    const yesterdayForCluster = yesterdaySessions.find(
      s => s.cluster_key === c.cluster_key && (s.severity === 'high' || s.severity === 'critical')
    );
    if (yesterdayForCluster) {
      // Check if it was resolved (any later session with low/medium)
      const resolved = recentSessions.some(
        s => s.cluster_key === c.cluster_key
          && s.severity === 'low'
          && new Date(s.created_at) > new Date(yesterdayForCluster.created_at)
      );
      if (!resolved) {
        score += 50;
        reasons.push(`yesterday_high_unresolved`);
      }
    }

    // Rule 2: worsening clusters before stable
    if (c.trend === 'increasing') {
      score += 30;
      reasons.push('trend_increasing');
    } else if (c.trend === 'decreasing') {
      score -= 10;
      reasons.push('trend_decreasing');
    }

    // Rule 3: higher frequency = higher priority
    if (c.count_7d >= 5) {
      score += 20;
      reasons.push(`high_frequency_7d=${c.count_7d}`);
    } else if (c.count_7d >= 3) {
      score += 10;
      reasons.push(`moderate_frequency_7d=${c.count_7d}`);
    }

    // Rule 4: recently triggered clusters
    if (c.last_triggered_at) {
      const hoursSince = (Date.now() - new Date(c.last_triggered_at).getTime()) / 3600000;
      if (hoursSince < 24) {
        score += 15;
        reasons.push(`recently_triggered_${Math.round(hoursSince)}h_ago`);
      }
    }

    return {
      clusterKey: c.cluster_key,
      displayName: c.display_name,
      reason: reasons.length > 0 ? reasons.join(', ') : 'base_priority',
      priority: score,
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b.priority - a.priority);

  return scored;
}

// ─── Question modifiers ────────────────────────────────────────────────────

/**
 * Decide whether to modify a script's questions based on context.
 *
 * @param {object} context
 * @param {object} scriptData - script_data JSON
 * @param {string} clusterKey
 * @returns {{ addBefore: Array, addAfter: Array, skip: Array, reason: string }}
 */
function decideQuestionModifiers(context, scriptData, clusterKey) {
  const { profile = {}, recentSessions = [], clusters = [] } = context;
  const conditions = (profile.medical_conditions || []).join(' ').toLowerCase();
  const addBefore = [];
  const addAfter = [];
  const skip = [];
  const reasons = [];

  // Rule 1: diabetes + dizziness cluster → add blood sugar question
  const hasDiabetes = conditions.includes('tieu duong') || conditions.includes('tieu duong')
    || conditions.includes('diabetes') || conditions.includes('dai thao duong');
  if (hasDiabetes && (clusterKey === 'dizziness' || clusterKey === 'fatigue')) {
    addAfter.push({
      id: 'agent_blood_sugar',
      text: '{Honorific} co do duong huyet hom nay chua? Bao nhieu?',
      type: 'single_choice',
      options: ['Chua do', 'Binh thuong (< 180)', 'Hoi cao (180-300)', 'Rat cao (> 300)'],
      cluster: clusterKey,
      source: 'agent_modifier',
    });
    reasons.push('diabetes+dizziness/fatigue: added blood sugar question');
  }

  // Rule 2: hypertension + headache → add blood pressure question
  const hasHypertension = conditions.includes('huyet ap') || conditions.includes('hypertension')
    || conditions.includes('cao huyet ap');
  if (hasHypertension && (clusterKey === 'headache' || clusterKey === 'dizziness')) {
    addAfter.push({
      id: 'agent_blood_pressure',
      text: '{Honorific} co do huyet ap chua? Bao nhieu?',
      type: 'single_choice',
      options: ['Chua do', 'Binh thuong (< 140/90)', 'Hoi cao (140-160)', 'Rat cao (> 160)'],
      cluster: clusterKey,
      source: 'agent_modifier',
    });
    reasons.push('hypertension+headache/dizziness: added blood pressure question');
  }

  // Rule 3: recurring symptom (count_7d >= 3) → add comparison question
  const cluster = clusters.find(c => c.cluster_key === clusterKey);
  if (cluster && cluster.count_7d >= 3) {
    addBefore.push({
      id: 'agent_compare_usual',
      text: 'So voi thuong ngay, {honorific} thay hom nay nang hon hay nhe hon?',
      type: 'single_choice',
      options: ['Nhe hon moi ngay', 'Nhu moi ngay', 'Nang hon moi ngay'],
      cluster: clusterKey,
      source: 'agent_modifier',
    });
    reasons.push(`recurring_symptom: count_7d=${cluster.count_7d}, added comparison question`);
  }

  // Rule 4: user answered "van vay" 3 times in a row → add doctor suggestion
  const recentSameCluster = recentSessions
    .filter(s => s.cluster_key === clusterKey && s.is_completed)
    .slice(0, 3);
  if (recentSameCluster.length >= 3) {
    const allSame = recentSameCluster.every(s => s.severity === 'medium');
    if (allSame) {
      addAfter.push({
        id: 'agent_suggest_doctor',
        text: '{Honorific} bi ${clusterKey} nhieu ngay roi. {Honorific} co muon di kham bac si khong?',
        type: 'single_choice',
        options: ['Da hen bac si', 'Chua, de xem them', 'Khong can'],
        cluster: clusterKey,
        source: 'agent_modifier',
      });
      reasons.push('repeated_medium_severity: 3+ consecutive, suggested doctor visit');
    }
  }

  // Rule 5: weekend + stress pattern
  const dayOfWeek = new Date().getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend && (clusterKey === 'fatigue' || clusterKey === 'insomnia' || clusterKey === 'stress')) {
    addAfter.push({
      id: 'agent_rest_activity',
      text: 'Cuoi tuan {honorific} co nghi ngoi duoc khong? Co di bo hay tap the duc gi khong?',
      type: 'single_choice',
      options: ['Co nghi ngoi tot', 'Khong nghi duoc nhieu', 'Van phai lam viec'],
      cluster: clusterKey,
      source: 'agent_modifier',
    });
    reasons.push('weekend+stress_cluster: added rest/activity question');
  }

  return {
    addBefore,
    addAfter,
    skip,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no_modifications',
  };
}

// ─── Final severity decision ───────────────────────────────────────────────

/**
 * Decide final severity, considering context beyond just script answers.
 *
 * @param {object} context
 * @param {string} scriptSeverity - severity from scoring engine
 * @param {Array} answers - user's answers
 * @returns {{ severity: string, adjustments: Array<{ from: string, to: string, reason: string }> }}
 */
function decideFinalSeverity(context, scriptSeverity, answers) {
  const { recentSessions = [], clusters = [], profile = {} } = context;
  let severity = scriptSeverity;
  const adjustments = [];

  // Get the cluster for this session (from most recent answer's cluster or first cluster)
  const clusterKey = answers[0]?.cluster || (clusters[0] && clusters[0].cluster_key);

  // Rule 1: same cluster was HIGH yesterday → bump medium to high
  if (clusterKey) {
    const yesterdaySessions = _getYesterdaySessions(recentSessions);
    const yesterdayHigh = yesterdaySessions.find(
      s => s.cluster_key === clusterKey && (s.severity === 'high' || s.severity === 'critical')
    );
    if (yesterdayHigh && severity === 'medium') {
      adjustments.push({ from: 'medium', to: 'high', reason: `yesterday was ${yesterdayHigh.severity} for same cluster` });
      severity = 'high';
    }
  }

  // Rule 2: 3+ check-ins this week with same cluster → bump
  if (clusterKey) {
    const thisWeekSame = recentSessions.filter(s =>
      s.cluster_key === clusterKey && _isWithinDays(s.created_at, 7)
    );
    if (thisWeekSame.length >= 3 && severity === 'low') {
      adjustments.push({ from: 'low', to: 'medium', reason: `${thisWeekSame.length} check-ins this week for same cluster` });
      severity = 'medium';
    }
  }

  // Rule 3: worsening trend → bump low to medium
  if (clusterKey) {
    const cluster = clusters.find(c => c.cluster_key === clusterKey);
    if (cluster && cluster.trend === 'increasing' && severity === 'low') {
      adjustments.push({ from: 'low', to: 'medium', reason: `worsening trend for ${clusterKey}` });
      severity = 'medium';
    }
  }

  // Rule 4: elderly + conditions — scoring engine already handles this, don't double-bump
  const isElderly = profile.birth_year && (new Date().getFullYear() - profile.birth_year >= 60);
  const hasConditions = (profile.medical_conditions || []).length > 0;
  if (isElderly && hasConditions && severity === 'high') {
    // Don't bump to critical — scoring engine already bumped for elderly
    // Just note it
    if (adjustments.length === 0) {
      // No adjustments needed — scoring engine handled it
    }
  }

  // Rule 5: user usually recovers quickly — don't over-escalate
  if (clusterKey && severity === 'high') {
    const pastMonth = recentSessions.filter(s =>
      s.cluster_key === clusterKey && s.is_completed && _isWithinDays(s.created_at, 30)
    );
    if (pastMonth.length >= 5) {
      const quickRecoveries = pastMonth.filter(s => s.severity === 'low' || s.severity === 'medium');
      const recoveryRate = quickRecoveries.length / pastMonth.length;
      if (recoveryRate >= 0.8 && adjustments.some(a => a.to === 'high')) {
        // User typically recovers — revert bump
        adjustments.push({ from: 'high', to: 'medium', reason: `high recovery rate (${Math.round(recoveryRate * 100)}%) — not escalating` });
        severity = 'medium';
      }
    }
  }

  return { severity, adjustments };
}

// ─── Follow-up plan ────────────────────────────────────────────────────────

/**
 * Decide follow-up plan based on context.
 *
 * @param {object} context
 * @param {string} severity
 * @param {string} clusterKey
 * @returns {{ followUpHours: number, followUpType: string, message: string, reason: string }}
 */
function decideFollowUp(context, severity, clusterKey) {
  const { hourOfDay = 12, recentSessions = [], honorifics: h } = context;
  const CallName = h?.CallName || (h?.callName ? h.callName.charAt(0).toUpperCase() + h.callName.slice(1) : 'Ban');

  // Base follow-up hours
  let followUpHours;
  let followUpType;
  switch (severity) {
    case 'critical': followUpHours = 0.5; followUpType = 'urgent'; break;
    case 'high':     followUpHours = 1;   followUpType = 'check_back'; break;
    case 'medium':   followUpHours = 3;   followUpType = 'scheduled'; break;
    default:         followUpHours = 6;   followUpType = 'evening'; break;
  }

  const reasons = [`base: ${severity}=${followUpHours}h`];

  // Rule 2: user typically doesn't respond quickly — push schedule
  const recentCompleted = recentSessions.filter(s => s.is_completed && s.completed_at);
  if (recentCompleted.length >= 3) {
    // Check average response time
    const responseTimes = recentCompleted.slice(0, 5).map(s => {
      const created = new Date(s.created_at).getTime();
      const completed = new Date(s.completed_at).getTime();
      return (completed - created) / 3600000; // hours
    });
    const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    if (avgResponseTime > 2 && followUpHours < 2) {
      followUpHours = 2;
      reasons.push(`user avg response time ${avgResponseTime.toFixed(1)}h — pushed to 2h`);
    }
  }

  // Rule 3: night time (22h-6h) → delay until morning unless critical
  if ((hourOfDay >= 22 || hourOfDay < 6) && severity !== 'critical') {
    const hoursUntilMorning = hourOfDay >= 22 ? (24 - hourOfDay + 7) : (7 - hourOfDay);
    if (followUpHours < hoursUntilMorning) {
      followUpHours = hoursUntilMorning;
      followUpType = 'morning';
      reasons.push(`night time — delayed until 7am (~${hoursUntilMorning}h)`);
    }
  }

  // Rule 4: user had no-response 2+ times → simpler message
  const noResponseCount = recentSessions.filter(s => !s.is_completed && _isWithinDays(s.created_at, 7)).length;
  let message;
  if (noResponseCount >= 2) {
    message = `${CallName}: ${severity === 'high' ? 'Kham bac si chua?' : 'Hom nay the nao?'}`;
    followUpType = 'simplified';
    reasons.push(`${noResponseCount} no-responses — simplified message`);
  } else {
    switch (severity) {
      case 'critical':
        message = `${CallName} oi, ${h?.selfRef || 'con'} rat lo. ${h?.Honorific || 'Ban'} the nao roi? Da goi cap cuu chua?`;
        break;
      case 'high':
        message = `${CallName} oi, ${h?.selfRef || 'con'} hoi lai ${h?.honorific || 'ban'} nhe. ${h?.Honorific || 'Ban'} do hon chua?`;
        break;
      case 'medium':
        message = `${CallName} oi, ${h?.honorific || 'ban'} thay the nao roi?`;
        break;
      default:
        message = `Chao ${CallName}! ${h?.Honorific || 'Ban'} khoe khong?`;
        break;
    }
  }

  return {
    followUpHours,
    followUpType,
    message,
    reason: reasons.join('; '),
  };
}

// ─── Explainability ────────────────────────────────────────────────────────

/**
 * Generate explainability log for all decisions made.
 *
 * @param {object} decisions - { greeting, clusters, questionModifiers, severity, followUp }
 * @returns {string} Vietnamese explanation
 */
function explainDecisions(decisions) {
  const parts = [];

  if (decisions.greeting) {
    parts.push(`Loi chao: ${decisions.greeting.reason}`);
  }

  if (decisions.clusters && decisions.clusters.length > 0) {
    const top = decisions.clusters[0];
    parts.push(`Hoi ve ${top.displayName} truoc vi ${top.reason} (priority=${top.priority})`);
    if (decisions.clusters.length > 1) {
      parts.push(`Cac cluster khac: ${decisions.clusters.slice(1).map(c => c.displayName).join(', ')}`);
    }
  }

  if (decisions.questionModifiers) {
    const m = decisions.questionModifiers;
    if (m.addBefore.length > 0 || m.addAfter.length > 0) {
      parts.push(`Them cau hoi: ${m.reason}`);
    }
    if (m.skip.length > 0) {
      parts.push(`Bo qua cau hoi: ${m.skip.join(', ')}`);
    }
  }

  if (decisions.severity) {
    const s = decisions.severity;
    if (s.adjustments && s.adjustments.length > 0) {
      for (const adj of s.adjustments) {
        parts.push(`Severity ${adj.from} -> ${adj.to}: ${adj.reason}`);
      }
    }
  }

  if (decisions.followUp) {
    parts.push(`Follow-up: ${decisions.followUp.followUpHours}h (${decisions.followUp.reason})`);
  }

  return parts.join('. ') || 'Khong co dieu chinh dac biet.';
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _getYesterdaySessions(sessions) {
  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setHours(23, 59, 59, 999);

  return sessions.filter(s => {
    const d = new Date(s.created_at);
    return d >= yesterdayStart && d <= yesterdayEnd;
  });
}

function _daysSinceLastSession(sessions) {
  if (sessions.length === 0) return Infinity;
  const latest = sessions.reduce((max, s) =>
    new Date(s.created_at) > new Date(max.created_at) ? s : max
  );
  return (Date.now() - new Date(latest.created_at).getTime()) / 86400000;
}

function _isWithinDays(dateStr, days) {
  if (!dateStr) return false;
  const diff = Date.now() - new Date(dateStr).getTime();
  return diff >= 0 && diff <= days * 86400000;
}

function _clusterDisplayName(clusterKey, clusters) {
  const c = clusters.find(cl => cl.cluster_key === clusterKey);
  return c ? c.display_name : clusterKey;
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  decideGreeting,
  decideClusters,
  decideQuestionModifiers,
  decideFinalSeverity,
  decideFollowUp,
  explainDecisions,
};
