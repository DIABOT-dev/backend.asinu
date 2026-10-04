'use strict';

/** Domain orchestration for script-driven check-in. HTTP mapping stays in controller. */
const { t } = require('../../i18n');
const { markActive } = require('../profile/lifecycle.service');
const { getNextQuestion } = require('../../core/checkin/script-runner');
const { getScript } = require('./script.service');
const { getFallbackScriptData, logFallback, matchCluster } = require('./fallback.service');
const { detectEmergency } = require('./emergency-detector');
const { saveSymptomLogs } = require('./symptom-tracker.service');
const earlySignalService = require('../early-signal/early-signal.service');
const {
  parseSymptoms,
  analyzeMultiSymptom,
  aggregateSeverity,
} = require('./multi-symptom.service');
const { analyzeSymptom } = require('../../core/agent/ai-symptom-analyzer');
const { parseAnswer } = require('../../core/agent/ai-answer-parser');
const { generateFromAnalysis, saveGeneratedScript } = require('./ai-script-generator');
const { getScriptRegenStatus, recordRegeneration } = require('./script-quota.service');
const { buildCaregiverStatus } = require('../care-circle/caregiver-status.service');
const {
  getProfile,
  createSession,
  getSession,
  updateAnswers,
  completeSession,
  markEmergency,
  updateCheckinFromSession,
  getScriptDataById,
  alertFamilyIfNeeded,
  setMultiSymptomMeta,
  switchToNextCluster,
} = require('./script-session.service');

const reply = (status, body) => ({ status, body });
const ok = (body) => reply(200, body);

async function startScriptFlow(pool, userId, { status, cluster_key, symptom_input }, lang) {
  if (!['fine', 'tired', 'very_tired'].includes(status)) {
    return reply(400, {
      ok: false,
      error: t('checkin.script.invalid_status', lang),
    });
  }

  // Starting any check-in is real activity, including the script-driven
  // flow. Keep lifecycle state in sync before the response returns.
  try {
    await markActive(pool, userId);
  } catch (err) {
    console.warn('[Lifecycle] markActive failed:', err.message);
  }

  // Status = fine → no script needed
  if (status === 'fine') {
    return ok({
      ok: true,
      needs_script: false,
      message: t('checkin.script.fine', lang),
      next_checkin: 'evening',
    });
  }

  // Determine which script to use
  let script = null;
  let clusterKey = cluster_key;
  let isFallback = false;
  let fallbackInput = null;
  let multiSymptomResult = null;

  const profile = await getProfile(pool, userId);

  if (cluster_key) {
    // User selected a specific cluster
    script = await getScript(pool, userId, cluster_key, 'initial');
  } else if (symptom_input) {
    // Parse multi-symptom input
    const symptomTexts = parseSymptoms(symptom_input);

    if (symptomTexts.length > 1) {
      // Multi-symptom path: combo detection + cluster matching
      multiSymptomResult = await analyzeMultiSymptom(pool, userId, symptomTexts, profile);

      if (multiSymptomResult.isEmergency) {
        return ok({
          ok: true,
          is_emergency: true,
          emergency: multiSymptomResult.emergency,
        });
      }

      // Use primary matched cluster's script
      if (multiSymptomResult.matched.length > 0) {
        const primary = multiSymptomResult.matched[0];
        clusterKey = primary.cluster.cluster_key;
        script = primary.script;
      }
    } else {
      // Single symptom — original flow
      const emergency = detectEmergency([symptom_input], profile);
      if (emergency.isEmergency) {
        return ok({
          ok: true,
          is_emergency: true,
          emergency,
        });
      }

      // Try matching to existing cluster
      const { matched, cluster } = await matchCluster(pool, userId, symptom_input);
      if (matched && cluster) {
        clusterKey = cluster.cluster_key;
        script = await getScript(pool, userId, cluster.cluster_key, 'initial');
      }
    }
  }

  // No script found → try AI analysis before falling back to generic questions.
  // Monthly quota (MVP audit #2) gates this: once a user has burned through
  // their regenerate allowance we use the generic fallback instead of
  // billing more AI tokens. Quota lookup failure-opens (returns allowed=true).
  if (!script && symptom_input) {
    const quota = await getScriptRegenStatus(pool, userId);
    if (!quota.allowed) {
      console.log(
        `[ScriptCheckin] Regen quota reached for user=${userId} (${quota.used}/${quota.limit}, tier=${quota.tier}) — using fallback`
      );
    } else {
      try {
        console.log(
          `[ScriptCheckin] No cached script for "${symptom_input}", trying AI analysis...`
        );
        const aiContext = {
          age: profile.birth_year ? new Date().getFullYear() - profile.birth_year : null,
          gender: profile.gender,
          medical_conditions: Array.isArray(profile.medical_conditions)
            ? profile.medical_conditions
            : [],
          medications: profile.daily_medication || null,
        };

        const analysis = await analyzeSymptom(symptom_input, aiContext);

        if (analysis && analysis.confidence > 0) {
          const scriptData = generateFromAnalysis(analysis, profile);
          const saved = await saveGeneratedScript(
            pool,
            userId,
            analysis.clusterKey,
            analysis.displayName,
            scriptData
          );
          script = saved.script;
          clusterKey = analysis.clusterKey;
          // Successful AI regeneration counts against monthly quota.
          recordRegeneration(pool, userId, analysis.clusterKey, 'new_symptom').catch(() => {});
          console.log(
            `[ScriptCheckin] AI generated script: cluster=${clusterKey}, confidence=${analysis.confidence}, quota=${quota.used + 1}/${quota.limit}`
          );
        }
      } catch (aiErr) {
        console.error('[ScriptCheckin] AI analysis failed, using fallback:', aiErr.message);
        // Fall through to generic fallback below
      }
    }
  }

  // Still no script → use generic fallback
  if (!script) {
    isFallback = true;
    clusterKey = 'general_fallback';
    fallbackInput = symptom_input || null;
  }

  // Create script session (service handles checkin linkage)
  const session = await createSession(
    pool,
    userId,
    script?.id || null,
    clusterKey,
    'initial',
    status
  );

  // Store multi-symptom context in session metadata if applicable
  if (multiSymptomResult && multiSymptomResult.matched.length > 1) {
    const pendingClusters = multiSymptomResult.matched.slice(1).map((m) => ({
      cluster_key: m.cluster.cluster_key,
      script_id: m.script?.id || null,
      symptom: m.symptom,
    }));
    await setMultiSymptomMeta(pool, session.id, {
      pending_clusters: pendingClusters,
      combos: multiSymptomResult.combos,
      unmatched: multiSymptomResult.unmatched,
      completed_clusters: [clusterKey],
    });
  }

  // Get first question
  const scriptData = script ? script.script_data : getFallbackScriptData();
  const firstStep = getNextQuestion(scriptData, [], {
    sessionType: 'initial',
    profile,
  });

  // Log fallback if needed
  if (isFallback && fallbackInput) {
    logFallback(pool, userId, fallbackInput).catch(() => {});
  }

  // Build response
  const response = {
    ok: true,
    session_id: session.id,
    cluster_key: clusterKey,
    is_fallback: isFallback,
    ...firstStep,
  };

  // Include combo info if detected
  if (multiSymptomResult && multiSymptomResult.combos.length > 0) {
    response.combos = multiSymptomResult.combos;
    response.extra_questions = multiSymptomResult.extraQuestions;
  }

  // Include all matched clusters so app can run them sequentially
  if (multiSymptomResult && multiSymptomResult.matched.length > 1) {
    response.all_clusters = multiSymptomResult.matched.map((m) => ({
      cluster_key: m.cluster.cluster_key,
      display_name: m.cluster.display_name,
      symptom: m.symptom,
      has_script: !!m.script,
    }));
    response.total_clusters = multiSymptomResult.matched.length;
    response.current_cluster_index = 0;
  }

  if (multiSymptomResult && multiSymptomResult.unmatched.length > 0) {
    response.unmatched_symptoms = multiSymptomResult.unmatched;
  }

  return ok(response);
}

async function answerScriptFlow(pool, userId, { session_id, question_id, answer }, lang) {
  if (!session_id || !question_id) {
    return reply(400, {
      ok: false,
      error: t('checkin.script.missing_session_question', lang),
    });
  }

  // Get session
  const session = await getSession(pool, session_id, userId);
  if (!session) {
    return reply(404, {
      ok: false,
      error: t('checkin.script.session_not_found', lang),
    });
  }

  if (session.is_completed) {
    return reply(400, {
      ok: false,
      error: t('checkin.script.session_completed', lang),
    });
  }

  // A response is also activity. This covers sessions created by older
  // clients that did not update lifecycle when they started.
  try {
    await markActive(pool, userId);
  } catch (err) {
    console.warn('[Lifecycle] markActive failed:', err.message);
  }

  // Emergency check on free-text answers
  if (typeof answer === 'string' && answer.length > 2) {
    const emergency = detectEmergency([answer], {});
    if (emergency.isEmergency) {
      // Mark session as completed with emergency
      await markEmergency(pool, session_id);
      earlySignalService
        .evaluateAfterNewHealthData(pool, userId, `script-checkin:${session_id}:emergency`)
        .catch((err) =>
          console.warn('[EarlySignal] script emergency evaluation failed:', err.message)
        );
      return ok({
        ok: true,
        is_emergency: true,
        emergency,
      });
    }
  }

  // ── Parse free-text answer if needed ──
  // Get script data early so we can find the current question
  let scriptData;
  if (session.script_id) {
    scriptData = await getScriptDataById(pool, session.script_id);
  }
  if (!scriptData) {
    scriptData = getFallbackScriptData();
  }

  const profile = await getProfile(pool, userId);

  // Find the current question to check if answer needs parsing
  const allQuestions =
    session.session_type === 'followup'
      ? scriptData.followup_questions || []
      : scriptData.questions || [];
  const currentQuestion = allQuestions.find((q) => q.id === question_id);

  let parsedAnswer = answer;
  if (currentQuestion && answer != null) {
    const parseResult = await parseAnswer(String(answer), currentQuestion, { profile });
    if (parseResult.confidence > 0.3) {
      parsedAnswer = parseResult.parsed;
      console.log(
        `[AnswerParser] "${answer}" → "${parsedAnswer}" (${parseResult.method}, conf=${parseResult.confidence})`
      );
    }
  }

  // Add answer to session
  const answers = [
    ...(session.answers || []),
    {
      question_id,
      answer: parsedAnswer,
      original_answer: answer !== parsedAnswer ? answer : undefined,
      answered_at: new Date().toISOString(),
    },
  ];

  // Get next question or conclusion (scriptData and profile already fetched above)
  const result = getNextQuestion(scriptData, answers, {
    sessionType: session.session_type,
    profile,
  });

  // Update session
  if (result.isDone) {
    const conclusion = result.conclusion;

    // Check if this is a multi-symptom session with more clusters to run
    let multiMeta = null;
    try {
      multiMeta = session.score_details?.multi_symptom || null;
    } catch (_) {}

    const hasMoreClusters =
      multiMeta &&
      Array.isArray(multiMeta.pending_clusters) &&
      multiMeta.pending_clusters.length > 0;

    if (hasMoreClusters) {
      // Save current cluster result, move to next cluster
      const nextCluster = multiMeta.pending_clusters[0];
      const remainingClusters = multiMeta.pending_clusters.slice(1);
      const completedClusters = [...(multiMeta.completed_clusters || []), nextCluster.cluster_key];

      // Store this cluster's result
      const clusterResults = multiMeta.cluster_results || [];
      clusterResults.push({
        cluster_key: session.cluster_key,
        severity: conclusion.severity,
        followUpHours: conclusion.followUpHours,
        needsDoctor: conclusion.needsDoctor,
        needsFamilyAlert: conclusion.needsFamilyAlert,
      });

      // Update session to next cluster
      const nextScriptData = nextCluster.script_id
        ? await getScriptDataById(pool, nextCluster.script_id)
        : getFallbackScriptData();

      await switchToNextCluster(pool, session_id, nextCluster.cluster_key, nextCluster.script_id, {
        pending_clusters: remainingClusters,
        combos: multiMeta.combos || [],
        unmatched: multiMeta.unmatched || [],
        completed_clusters: completedClusters,
        cluster_results: clusterResults,
      });

      // Get first question of next cluster's script
      const nextStep = getNextQuestion(nextScriptData, [], {
        sessionType: 'initial',
        profile,
      });

      return ok({
        ok: true,
        session_id,
        cluster_key: nextCluster.cluster_key,
        current_cluster_index: completedClusters.length - 1,
        total_clusters: completedClusters.length + remainingClusters.length,
        cluster_completed: session.cluster_key,
        ...nextStep,
      });
    }

    // Last cluster (or single cluster) — finalize

    // If multi-symptom, aggregate severity across all cluster results + combos
    if (multiMeta) {
      const clusterResults = multiMeta.cluster_results || [];
      clusterResults.push({
        cluster_key: session.cluster_key,
        severity: conclusion.severity,
        followUpHours: conclusion.followUpHours,
        needsDoctor: conclusion.needsDoctor,
        needsFamilyAlert: conclusion.needsFamilyAlert,
      });

      const aggregated = aggregateSeverity(clusterResults, multiMeta.combos || []);

      // Override conclusion with aggregated values if aggregated is worse
      if (
        ['critical', 'high', 'medium', 'low'].indexOf(aggregated.severity) <
        ['critical', 'high', 'medium', 'low'].indexOf(conclusion.severity)
      ) {
        conclusion.severity = aggregated.severity;
        conclusion.followUpHours = aggregated.followUpHours;
        conclusion.needsDoctor = aggregated.needsDoctor;
        conclusion.needsFamilyAlert = aggregated.needsFamilyAlert;
      }
    }

    // Complete the session
    await completeSession(pool, session_id, answers, conclusion);

    // Update health_checkins with result
    if (session.checkin_id) {
      await updateCheckinFromSession(
        pool,
        session.checkin_id,
        conclusion.severity,
        conclusion.summary,
        conclusion.followUpHours
      );

      // Save symptom logs for tracking
      const triageMessages = answers.map((a) => ({
        question: a.question_id,
        answer: a.answer,
      }));
      saveSymptomLogs(pool, userId, session.checkin_id, triageMessages, null)
        .then(() =>
          earlySignalService.evaluateAfterNewHealthData(
            pool,
            userId,
            `script-checkin:${session_id}:completed`
          )
        )
        .catch((err) => console.warn('[EarlySignal] script evaluation failed:', err.message));
    }

    // Log fallback answers if this was a fallback session
    if (session.cluster_key === 'general_fallback') {
      logFallback(pool, userId, 'fallback_session', session.checkin_id, answers).catch(() => {});
    }

    // Alert family if needed
    if (conclusion.needsFamilyAlert && session.checkin_id) {
      alertFamilyIfNeeded(pool, userId, session.checkin_id, conclusion).catch(() => {});
    }
  } else {
    // Just update answers and step
    await updateAnswers(pool, session_id, answers, answers.length);
  }

  // Surface caregiver connection state on completion so the frontend can
  // prompt the user to add a caregiver when the result is urgent and
  // nobody is wired up to receive alerts (MVP audit FIX #4).
  let caregiverStatus = {};
  if (result.isDone) {
    caregiverStatus = await buildCaregiverStatus(pool, userId, {
      riskTier: result.conclusion?.severity,
    });
  }

  return ok({
    ok: true,
    session_id,
    ...result,
    ...caregiverStatus,
  });
}

module.exports = { startScriptFlow, answerScriptFlow };
