'use strict';

/**
 * Agent Service — Main orchestrator
 *
 * Connects: Context → Decision → Script Runner → Scoring → Memory
 *
 * This is the SINGLE ENTRY POINT for the check-in agent.
 * Controllers call this instead of calling individual services.
 */

const { getUserScript, getScript } = require('./script.service');
const { getNextQuestion } = require('../../core/checkin/script-runner');
const { detectCombo } = require('../../core/checkin/combo-detector');
const { evaluateScript } = require('../../core/checkin/scoring-engine');
const {
  getProfile,
  createSession,
  getSession,
  updateAnswers,
  completeSession,
  updateCheckinFromSession,
  alertFamilyIfNeeded,
} = require('./script-session.service');
const {
  decideGreeting,
  decideClusters,
  decideQuestionModifiers,
  decideFinalSeverity,
  decideFollowUp,
  explainDecisions,
} = require('../../core/agent/agent-decision');
const { getHonorifics } = require('../../lib/honorifics');

// ─── Context builder ──────────────────────────────────────────────────────

/**
 * Build the agent context object from database.
 * This gathers all info the decision engine needs.
 */
async function _buildContext(pool, userId) {
  // 1. Get profile
  const profile = await getProfile(pool, userId);

  // 2. Get honorifics
  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang: 'vi',
  });
  const honorifics = {
    ...h,
    CallName: h.callName ? h.callName.charAt(0).toUpperCase() + h.callName.slice(1) : '',
  };

  // 3. Get active clusters
  const { rows: clusters } = await pool.query(
    `SELECT * FROM problem_clusters
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY priority DESC, count_7d DESC`,
    [userId]
  );

  // 4. Get recent sessions (last 7 days)
  const { rows: recentSessions } = await pool.query(
    `SELECT id, user_id, cluster_key, session_type, severity, is_completed,
            follow_up_hours, created_at, completed_at
     FROM script_sessions
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 30`,
    [userId]
  );

  // 5. Check if today already has a session (follow-up indicator)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const todaySession = recentSessions.find(s => {
    const sessionDate = new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    return sessionDate === today && s.is_completed;
  });

  // 6. Current hour in VN timezone
  const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const hourOfDay = vnNow.getHours();

  return {
    userId,
    profile: {
      birth_year: profile.birth_year,
      gender: profile.gender,
      full_name: profile.full_name,
      medical_conditions: profile.medical_conditions || [],
    },
    honorifics,
    clusters,
    recentSessions,
    isFollowUp: !!todaySession,
    hourOfDay,
    today,
  };
}

// ─── Main API ─────────────────────────────────────────────────────────────

/**
 * Get agent-enhanced script for user.
 * Returns personalized greeting, prioritized clusters, context summary.
 *
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<{ greeting: string, clusters: Array, decisions: object, context: object } | null>}
 */
async function getAgentScript(pool, userId) {
  // 1. Build context
  const context = await _buildContext(pool, userId);

  // 2. Make decisions
  const greetingDecision = decideGreeting(context);
  const clusterDecision = decideClusters(context);

  // 3. Get scripts for clusters
  const baseScript = await getUserScript(pool, userId);

  // 4. For top cluster, decide question modifiers
  let questionModifiers = null;
  if (clusterDecision.length > 0 && baseScript) {
    const topCluster = clusterDecision[0].clusterKey;
    const script = baseScript.scripts[topCluster];
    if (script && script.script_data) {
      questionModifiers = decideQuestionModifiers(context, script.script_data, topCluster);
    }
  }

  // 5. Detect combos from all cluster display names
  const symptomTexts = context.clusters.map(c => c.display_name);
  const comboResult = detectCombo(symptomTexts, context.profile);

  // 6. Build decisions log
  const decisions = {
    greeting: greetingDecision,
    clusters: clusterDecision,
    questionModifiers,
    combos: comboResult,
  };

  const explanation = explainDecisions(decisions);

  return {
    greeting: greetingDecision.greeting,
    initial_options: baseScript?.initial_options || [
      { label: 'Toi on', value: 'fine', emoji: '😊' },
      { label: 'Hoi met', value: 'tired', emoji: '😐' },
      { label: 'Rat met', value: 'very_tired', emoji: '😫' },
    ],
    clusters: clusterDecision,
    comboWarnings: comboResult.isCombo ? comboResult.combos : [],
    scripts: baseScript?.scripts || {},
    profile: context.profile,
    decisions,
    explanation,
  };
}

/**
 * Start a check-in session with full agent intelligence.
 *
 * Flow:
 * 1. Build context (agent-context)
 * 2. Make decisions (agent-decision)
 * 3. Create session with personalized greeting + prioritized clusters
 * 4. Log decisions for explainability
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} status - 'fine' | 'tired' | 'very_tired'
 * @param {string|null} symptomInput - raw symptom text (if any)
 * @returns {Promise<{ greeting: string, clusters: Array, firstQuestion: object|null, comboWarnings: Array, decisions: object }>}
 */
async function startAgentCheckin(pool, userId, status, symptomInput) {
  // 1. Build context
  const context = await _buildContext(pool, userId);

  // 2. Make decisions
  const greetingDecision = decideGreeting(context);
  const clusterDecision = decideClusters(context);

  // If user said "fine", no need for script
  if (status === 'fine') {
    return {
      greeting: greetingDecision.greeting,
      status: 'fine',
      clusters: [],
      firstQuestion: null,
      comboWarnings: [],
      decisions: { greeting: greetingDecision, clusters: [], status: 'fine' },
      explanation: 'User reported feeling fine. No triage needed.',
    };
  }

  // 3. Determine which cluster to start with
  if (clusterDecision.length === 0) {
    return {
      greeting: greetingDecision.greeting,
      status,
      clusters: [],
      firstQuestion: null,
      comboWarnings: [],
      decisions: { greeting: greetingDecision, clusters: [], status },
      explanation: 'No active clusters found.',
    };
  }

  const topCluster = clusterDecision[0];

  // 4. Get script for top cluster
  const sessionType = context.isFollowUp ? 'followup' : 'initial';
  const script = await getScript(pool, userId, topCluster.clusterKey, sessionType);

  if (!script) {
    return {
      greeting: greetingDecision.greeting,
      status,
      clusters: clusterDecision,
      firstQuestion: null,
      comboWarnings: [],
      decisions: { greeting: greetingDecision, clusters: clusterDecision, status },
      explanation: `No script found for cluster: ${topCluster.clusterKey}`,
    };
  }

  // 5. Create session
  const session = await createSession(pool, userId, script.id, topCluster.clusterKey, sessionType, status);

  // 6. Decide question modifiers
  const scriptData = script.script_data;
  const questionModifiers = decideQuestionModifiers(context, scriptData, topCluster.clusterKey);

  // 7. Build modified questions list
  let modifiedScriptData = scriptData;
  if (questionModifiers.addBefore.length > 0 || questionModifiers.addAfter.length > 0) {
    const existingQuestions = sessionType === 'followup'
      ? (scriptData.followup_questions || [])
      : (scriptData.questions || []);

    const modifiedQuestions = [
      ...questionModifiers.addBefore,
      ...existingQuestions,
      ...questionModifiers.addAfter,
    ];

    modifiedScriptData = {
      ...scriptData,
      [sessionType === 'followup' ? 'followup_questions' : 'questions']: modifiedQuestions,
    };
  }

  // 8. Get first question
  const firstQ = getNextQuestion(modifiedScriptData, [], {
    sessionType,
    profile: context.profile,
  });

  // 9. Detect combos
  const symptomTexts = context.clusters.map(c => c.display_name);
  if (symptomInput) symptomTexts.push(symptomInput);
  const comboResult = detectCombo(symptomTexts, context.profile);

  // 10. Build decisions log
  const decisions = {
    greeting: greetingDecision,
    clusters: clusterDecision,
    questionModifiers,
    combos: comboResult,
    sessionId: session.id,
    sessionType,
    topCluster: topCluster.clusterKey,
  };

  const explanation = explainDecisions(decisions);

  return {
    greeting: greetingDecision.greeting,
    status,
    sessionId: session.id,
    clusters: clusterDecision,
    firstQuestion: firstQ.isDone ? null : firstQ.question,
    totalSteps: firstQ.totalSteps,
    comboWarnings: comboResult.isCombo ? comboResult.combos : [],
    decisions,
    explanation,
  };
}

/**
 * Process an answer with agent context.
 * After script completion: aggregate, decide follow-up, save memory.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {number} sessionId
 * @param {string} questionId
 * @param {*} answer
 * @returns {Promise<{ isDone: boolean, question?: object, conclusion?: object, decisions?: object }>}
 */
async function processAgentAnswer(pool, userId, sessionId, questionId, answer) {
  // 1. Get session
  const session = await getSession(pool, sessionId, userId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found for user ${userId}`);
  }

  // 2. Get script data
  const script = session.script_id
    ? await getScript(pool, userId, session.cluster_key, session.session_type)
    : null;
  const scriptData = script?.script_data || {};

  // 3. Build context
  const context = await _buildContext(pool, userId);

  // 4. Append answer
  const answers = [...(session.answers || [])];
  answers.push({
    question_id: questionId,
    answer,
    answered_at: new Date().toISOString(),
  });

  // 5. Get question modifiers (may have added extra questions)
  const questionModifiers = decideQuestionModifiers(context, scriptData, session.cluster_key);
  let modifiedScriptData = scriptData;
  if (questionModifiers.addBefore.length > 0 || questionModifiers.addAfter.length > 0) {
    const qKey = session.session_type === 'followup' ? 'followup_questions' : 'questions';
    const existingQuestions = scriptData[qKey] || [];
    modifiedScriptData = {
      ...scriptData,
      [qKey]: [
        ...questionModifiers.addBefore,
        ...existingQuestions,
        ...questionModifiers.addAfter,
      ],
    };
  }

  // 6. Get next question
  const result = getNextQuestion(modifiedScriptData, answers, {
    sessionType: session.session_type,
    profile: context.profile,
    previousSeverity: session.severity,
  });

  if (!result.isDone) {
    // Save progress
    await updateAnswers(pool, sessionId, answers, result.currentStep);
    return {
      isDone: false,
      question: result.question,
      currentStep: result.currentStep,
      totalSteps: result.totalSteps,
    };
  }

  // 7. Script complete — evaluate with agent intelligence
  const conclusion = result.conclusion || {};

  // 8. Agent decides final severity (with context)
  const severityDecision = decideFinalSeverity(context, conclusion.severity || 'low', answers);
  conclusion.severity = severityDecision.severity;

  // Update follow-up hours based on new severity
  const followUpDecision = decideFollowUp(context, severityDecision.severity, session.cluster_key);
  conclusion.followUpHours = followUpDecision.followUpHours;

  // 9. Save completed session
  await completeSession(pool, sessionId, answers, conclusion);

  // 10. Update health_checkins
  if (session.checkin_id) {
    await updateCheckinFromSession(
      pool,
      session.checkin_id,
      conclusion.severity,
      conclusion.summary,
      conclusion.followUpHours
    );

    // 11. Alert family if needed
    if (conclusion.needsFamilyAlert) {
      try {
        await alertFamilyIfNeeded(pool, userId, session.checkin_id, conclusion);
      } catch (err) {
        console.error(`[AgentService] Family alert failed:`, err.message);
      }
    }
  }

  // 12. Build decisions log
  const decisions = {
    severity: severityDecision,
    followUp: followUpDecision,
    questionModifiers,
  };

  const explanation = explainDecisions(decisions);

  return {
    isDone: true,
    conclusion: {
      ...conclusion,
      followUpMessage: followUpDecision.message,
      followUpType: followUpDecision.followUpType,
    },
    decisions,
    explanation,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  startAgentCheckin,
  processAgentAnswer,
  getAgentScript,
};
