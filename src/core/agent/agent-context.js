/**
 * Agent Context Builder
 *
 * Gathers everything the agent knows about a user into one object.
 * This is the "brain input" — all data the agent needs to make decisions.
 *
 * Later: MedGemma reads this context to generate personalized scripts.
 * Now: Used by adaptive script modifier to adjust questions.
 */

'use strict';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function vnNow() {
  // Vietnam is UTC+7
  const d = new Date();
  d.setHours(d.getHours() + 7 + d.getTimezoneOffset() / 60);
  return d;
}

function timePeriod(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function calcAge(birthYear) {
  if (!birthYear) return null;
  return new Date().getFullYear() - birthYear;
}

function avgSeverityLabel(checkins) {
  if (!checkins.length) return 'low';
  const map = { low: 1, medium: 2, high: 3, critical: 4 };
  const sum = checkins.reduce((s, c) => s + (map[c.triage_severity] || 1), 0);
  const avg = sum / checkins.length;
  if (avg >= 2.5) return 'high';
  if (avg >= 1.5) return 'medium';
  return 'low';
}

// ─── Main builder ──────────────────────────────────────────────────────────────

async function buildContext(pool, userId) {
  // Run all queries in parallel
  const [
    profileRes,
    symptomsRes,
    checkinsRes,
    clustersRes,
    sessionsRes,
    memoriesRes,
    agentMemRes,
    engagementRes,
  ] = await Promise.all([
    // 1. Profile
    pool.query(
      `SELECT u.id, u.display_name, u.full_name,
              COALESCE(u.language_preference, 'vi') AS lang,
              p.birth_year, p.gender, p.medical_conditions, p.chronic_symptoms,
              p.daily_medication, p.risk_score, p.user_group
       FROM users u
       LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    ),

    // 2. Recent symptoms (7 days)
    pool.query(
      `SELECT symptom_name, count_7d, count_30d, trend, last_occurred
       FROM symptom_frequency
       WHERE user_id = $1 AND count_7d > 0
       ORDER BY count_7d DESC
       LIMIT 20`,
      [userId]
    ),

    // 3. Recent check-ins (7 days)
    pool.query(
      `SELECT session_date, initial_status, current_status, flow_state,
              triage_severity, triage_summary, resolved_at, created_at
       FROM health_checkins
       WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY session_date DESC`,
      [userId]
    ),

    // 4. Active clusters
    pool.query(
      `SELECT cluster_key, display_name, priority, trend, count_7d, count_30d
       FROM problem_clusters
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY priority DESC`,
      [userId]
    ),

    // 5. Recent script sessions
    pool.query(
      `SELECT cluster_key, severity, answers, conclusion_summary,
              needs_doctor, follow_up_hours, created_at, completed_at
       FROM script_sessions
       WHERE user_id = $1 AND is_completed = TRUE
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    ),

    // 6. User memories (chat AI memories)
    pool.query(
      `SELECT content, category, updated_at
       FROM user_memories
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 10`,
      [userId]
    ),

    // 6b. Agent check-in memories
    pool.query(
      `SELECT memory_type, memory_key, content, confidence, source, updated_at
       FROM agent_checkin_memory
       WHERE user_id = $1 AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC
       LIMIT 20`,
      [userId]
    ).catch(() => ({ rows: [] })), // table may not exist yet

    // 7. Engagement events (last 30 days)
    pool.query(
      `SELECT event_type, occurred_at, metadata
       FROM user_engagement
       WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '30 days'
       ORDER BY occurred_at DESC
       LIMIT 100`,
      [userId]
    ).catch(() => ({ rows: [] })), // table may not exist yet
  ]);

  // ── Parse profile ──────────────────────────────────────────────────────────
  const prof = profileRes.rows[0] || {};
  const age = calcAge(prof.birth_year);
  const conditions = Array.isArray(prof.medical_conditions) ? prof.medical_conditions : [];
  const medications = prof.daily_medication || null;
  const name = prof.full_name || prof.display_name || null;

  // ── Parse symptoms ─────────────────────────────────────────────────────────
  const symptomRows = symptomsRes.rows;
  const recurring = symptomRows.filter(s => s.count_7d >= 3);
  const improving = symptomRows.filter(s => s.trend === 'decreasing');
  const worsening = symptomRows.filter(s => s.trend === 'increasing');

  // ── Parse check-ins ────────────────────────────────────────────────────────
  const checkinRows = checkinsRes.rows;
  const lastCheckin = checkinRows[0] || null;
  const daysCheckedIn = new Set(checkinRows.map(c => c.session_date?.toISOString?.() || c.session_date)).size;

  // ── Parse clusters ─────────────────────────────────────────────────────────
  const clusterRows = clustersRes.rows;
  const topCluster = clusterRows[0]?.cluster_key || null;

  // ── Parse sessions ─────────────────────────────────────────────────────────
  const sessionRows = sessionsRes.rows;
  const prevSession = sessionRows[0] || null;

  // ── Parse memories ─────────────────────────────────────────────────────────
  const memoryRows = memoriesRes.rows;
  const agentMemRows = agentMemRes.rows;

  // ── Parse engagement ───────────────────────────────────────────────────────
  const engRows = engagementRes.rows;
  const checkinResponses = engRows.filter(e => e.event_type === 'checkin_response');
  const responseRate = engRows.length > 0
    ? Math.round((checkinResponses.length / Math.max(engRows.length, 1)) * 100) / 100
    : null;

  // Avg response time (from metadata.response_minutes if available)
  let avgResponseMinutes = null;
  const responseTimes = checkinResponses
    .map(e => e.metadata?.response_minutes)
    .filter(m => typeof m === 'number');
  if (responseTimes.length > 0) {
    avgResponseMinutes = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
  }

  // ── Time context ───────────────────────────────────────────────────────────
  const now = vnNow();
  const currentHour = now.getHours();
  const dayOfWeek = DAYS[now.getDay()];
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const period = timePeriod(currentHour);

  // ── Computed insights ──────────────────────────────────────────────────────
  const avgSev = avgSeverityLabel(checkinRows);
  const hasWorseningTrend = worsening.length > 0;
  const isFrequentUser = daysCheckedIn >= 5;
  const needsAttention = avgSev === 'high' || hasWorseningTrend
    || (lastCheckin && lastCheckin.triage_severity === 'high');

  let riskLevel = 'low';
  if (needsAttention || (prof.risk_score && prof.risk_score >= 70)) {
    riskLevel = 'high';
  } else if (hasWorseningTrend || avgSev === 'medium' || (prof.risk_score && prof.risk_score >= 40)) {
    riskLevel = 'moderate';
  }

  // Build suggested greeting
  let suggestedGreeting;
  const greetName = name || 'bạn';
  if (lastCheckin && lastCheckin.triage_summary) {
    suggestedGreeting = `Chào ${greetName}! Hôm qua ${lastCheckin.triage_summary.slice(0, 40)}, hôm nay thế nào?`;
  } else {
    suggestedGreeting = `Chào ${greetName}! Hôm nay bạn thấy thế nào?`;
  }

  // ── Build final context object ─────────────────────────────────────────────
  return {
    userId,
    profile: {
      name,
      age,
      gender: prof.gender || null,
      conditions,
      medications,
      riskScore: prof.risk_score || 0,
      userGroup: prof.user_group || 'wellness',
      lang: prof.lang || 'vi',
    },
    symptoms: {
      recent7d: symptomRows.map(s => ({
        name: s.symptom_name,
        count: s.count_7d,
        count30d: s.count_30d,
        trend: s.trend,
      })),
      recurring: recurring.map(s => s.symptom_name),
      improving: improving.map(s => s.symptom_name),
      worsening: worsening.map(s => s.symptom_name),
    },
    history: {
      checkins7d: checkinRows.map(c => ({
        date: c.session_date,
        status: c.current_status,
        severity: c.triage_severity,
        flowState: c.flow_state,
      })),
      avgSeverity: avgSev,
      daysCheckedIn,
      lastCheckin: lastCheckin ? {
        date: lastCheckin.session_date,
        severity: lastCheckin.triage_severity,
        summary: lastCheckin.triage_summary,
      } : null,
      previousSession: prevSession ? {
        cluster: prevSession.cluster_key,
        severity: prevSession.severity,
        answers: prevSession.answers,
        summary: prevSession.conclusion_summary,
        needsDoctor: prevSession.needs_doctor,
        at: prevSession.completed_at || prevSession.created_at,
      } : null,
    },
    clusters: {
      active: clusterRows.map(c => ({
        key: c.cluster_key,
        displayName: c.display_name,
        priority: c.priority,
        trend: c.trend,
      })),
      topCluster,
    },
    memories: memoryRows.map(m => ({
      content: m.content,
      category: m.category,
    })),
    agentMemories: agentMemRows.map(m => ({
      type: m.memory_type,
      key: m.memory_key,
      content: m.content,
      confidence: parseFloat(m.confidence),
      source: m.source,
    })),
    timing: {
      currentHour,
      dayOfWeek,
      period,
      isWeekend,
    },
    engagement: {
      responseRate,
      avgResponseMinutes,
      totalEvents30d: engRows.length,
    },
    insights: {
      isFrequentUser,
      hasWorseningTrend,
      needsAttention,
      riskLevel,
      suggestedGreeting,
    },
  };
}

module.exports = { buildContext };
