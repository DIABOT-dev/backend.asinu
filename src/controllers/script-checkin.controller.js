'use strict';

/**
 * Script Check-in Controller
 *
 * API endpoints cho hệ thống script-driven check-in.
 * App lấy script từ cache → chạy logic thuần → KHÔNG gọi AI.
 *
 * Endpoints:
 *   GET  /checkin/script          — lấy script cached cho user
 *   POST /checkin/script/start    — bắt đầu script session
 *   POST /checkin/script/answer   — gửi câu trả lời, nhận câu tiếp hoặc kết quả
 *   GET  /checkin/script/session  — lấy session hiện tại
 *
 * Principle: controllers parse req.body → call service → res.json().
 * No pool.query here — all DB access is in the service layer.
 */

const { getUserScript, getScript, createClustersFromOnboarding } = require('../services/checkin/script.service');
const { getNextQuestion } = require('../core/checkin/script-runner');
const { getFallbackScriptData, logFallback, matchCluster } = require('../services/checkin/fallback.service');
const { detectEmergency } = require('../services/checkin/emergency-detector');
const { saveSymptomLogs } = require('../services/checkin/symptom-tracker.service');
const { parseSymptoms, analyzeMultiSymptom, aggregateSeverity } = require('../services/checkin/multi-symptom.service');
const { analyzeSymptom } = require('../core/agent/ai-symptom-analyzer');
const { parseAnswer } = require('../core/agent/ai-answer-parser');
const { generateFromAnalysis, saveGeneratedScript } = require('../services/checkin/ai-script-generator');
const {
  getProfile,
  createSession,
  getSession,
  getTodaySession,
  updateAnswers,
  completeSession,
  markEmergency,
  updateCheckinFromSession,
  getScriptDataById,
  alertFamilyIfNeeded,
  setMultiSymptomMeta,
  switchToNextCluster,
} = require('../services/checkin/script-session.service');

// ─── GET /checkin/script ────────────────────────────────────────────────────

/**
 * Get cached script for user.
 * App calls this on check-in screen open → receives full JSON.
 * 0 AI calls.
 */
async function getScriptHandler(pool, req, res) {
  try {
    const result = await getUserScript(pool, req.user.id);

    if (!result) {
      return res.json({
        ok: true,
        has_script: false,
        message: 'No clusters configured. Complete onboarding first.',
      });
    }

    return res.json({
      ok: true,
      has_script: true,
      greeting: result.greeting,
      initial_options: result.initial_options,
      clusters: result.clusters,
      profile: result.profile,
    });
  } catch (err) {
    console.error('[ScriptCheckin] getScript failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── POST /checkin/script/start ─────────────────────────────────────────────

/**
 * Start a script session.
 * Called when user chooses "Hơi mệt" or "Rất mệt".
 *
 * Body: { status: 'fine'|'tired'|'very_tired', cluster_key?: string, symptom_input?: string }
 *
 * If status = 'fine' → no script, just schedule evening check.
 * If cluster_key provided → load that cluster's script.
 * If symptom_input provided → try to match cluster or use fallback.
 */
async function startScriptHandler(pool, req, res) {
  try {
    const { status, cluster_key, symptom_input } = req.body;
    const userId = req.user.id;

    if (!['fine', 'tired', 'very_tired'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    // Status = fine → no script needed
    if (status === 'fine') {
      return res.json({
        ok: true,
        needs_script: false,
        message: 'Tốt quá! Hẹn tối nay nhé 💙',
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
          return res.json({
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
          return res.json({
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

    // No script found → try AI analysis before falling back to generic questions
    if (!script && symptom_input) {
      try {
        console.log(`[ScriptCheckin] No cached script for "${symptom_input}", trying AI analysis...`);
        const aiContext = {
          age: profile.birth_year ? new Date().getFullYear() - profile.birth_year : null,
          gender: profile.gender,
          medical_conditions: Array.isArray(profile.medical_conditions) ? profile.medical_conditions : [],
          medications: profile.daily_medication || null,
        };

        const analysis = await analyzeSymptom(symptom_input, aiContext);

        if (analysis && analysis.confidence > 0) {
          // AI understood the symptom — generate and save a real script
          const scriptData = generateFromAnalysis(analysis, profile);
          const saved = await saveGeneratedScript(
            pool, userId,
            analysis.clusterKey,
            analysis.displayName,
            scriptData
          );
          script = saved.script;
          clusterKey = analysis.clusterKey;
          console.log(`[ScriptCheckin] AI generated script: cluster=${clusterKey}, confidence=${analysis.confidence}`);
        }
      } catch (aiErr) {
        console.error('[ScriptCheckin] AI analysis failed, using fallback:', aiErr.message);
        // Fall through to generic fallback below
      }
    }

    // Still no script → use generic fallback
    if (!script) {
      isFallback = true;
      clusterKey = 'general_fallback';
      fallbackInput = symptom_input || null;
    }

    // Create script session (service handles checkin linkage)
    const session = await createSession(pool, userId, script?.id || null, clusterKey, 'initial', status);

    // Store multi-symptom context in session metadata if applicable
    if (multiSymptomResult && multiSymptomResult.matched.length > 1) {
      const pendingClusters = multiSymptomResult.matched.slice(1).map(m => ({
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
      response.all_clusters = multiSymptomResult.matched.map(m => ({
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

    return res.json(response);
  } catch (err) {
    console.error('[ScriptCheckin] startScript failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── POST /checkin/script/answer ────────────────────────────────────────────

/**
 * Submit an answer and get next question or conclusion.
 *
 * Body: { session_id, question_id, answer }
 *
 * Returns next question or conclusion with scoring.
 * 0 AI calls — pure script execution.
 */
async function answerScriptHandler(pool, req, res) {
  try {
    const { session_id, question_id, answer } = req.body;
    const userId = req.user.id;

    if (!session_id || !question_id) {
      return res.status(400).json({ ok: false, error: 'Missing session_id or question_id' });
    }

    // Get session
    const session = await getSession(pool, session_id, userId);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    if (session.is_completed) {
      return res.status(400).json({ ok: false, error: 'Session already completed' });
    }

    // Emergency check on free-text answers
    if (typeof answer === 'string' && answer.length > 2) {
      const emergency = detectEmergency([answer], {});
      if (emergency.isEmergency) {
        // Mark session as completed with emergency
        await markEmergency(pool, session_id);
        return res.json({
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
    const allQuestions = session.session_type === 'followup'
      ? (scriptData.followup_questions || [])
      : (scriptData.questions || []);
    const currentQuestion = allQuestions.find(q => q.id === question_id);

    let parsedAnswer = answer;
    if (currentQuestion && answer != null) {
      const parseResult = await parseAnswer(String(answer), currentQuestion, { profile });
      if (parseResult.confidence > 0.3) {
        parsedAnswer = parseResult.parsed;
        console.log(`[AnswerParser] "${answer}" → "${parsedAnswer}" (${parseResult.method}, conf=${parseResult.confidence})`);
      }
    }

    // Add answer to session
    const answers = [...(session.answers || []), {
      question_id,
      answer: parsedAnswer,
      original_answer: answer !== parsedAnswer ? answer : undefined,
      answered_at: new Date().toISOString(),
    }];

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

      const hasMoreClusters = multiMeta &&
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

        return res.json({
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
        if (['critical', 'high', 'medium', 'low'].indexOf(aggregated.severity) <
            ['critical', 'high', 'medium', 'low'].indexOf(conclusion.severity)) {
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
        const triageMessages = answers.map(a => ({
          question: a.question_id,
          answer: a.answer,
        }));
        saveSymptomLogs(pool, userId, session.checkin_id, triageMessages, null).catch(() => {});
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

    return res.json({
      ok: true,
      session_id,
      ...result,
    });
  } catch (err) {
    console.error('[ScriptCheckin] answer failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── GET /checkin/script/session ────────────────────────────────────────────

/**
 * Get current active script session for user.
 */
async function getSessionHandler(pool, req, res) {
  try {
    const session = await getTodaySession(pool, req.user.id);

    if (!session) {
      return res.json({ ok: true, has_session: false });
    }

    return res.json({
      ok: true,
      has_session: true,
      session: {
        id: session.id,
        cluster_key: session.cluster_key,
        session_type: session.session_type,
        current_step: session.current_step,
        is_completed: session.is_completed,
        severity: session.severity,
        conclusion_summary: session.conclusion_summary,
        conclusion_recommendation: session.conclusion_recommendation,
        conclusion_close_message: session.conclusion_close_message,
        needs_doctor: session.needs_doctor,
        follow_up_hours: session.follow_up_hours,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── POST /checkin/script/clusters ──────────────────────────────────────────

/**
 * Create clusters from symptoms (called during or after onboarding).
 *
 * Body: { symptoms: ['đau đầu', 'chóng mặt', ...] }
 */
async function createClustersHandler(pool, req, res) {
  try {
    const { symptoms } = req.body;
    if (!Array.isArray(symptoms) || symptoms.length === 0) {
      return res.status(400).json({ ok: false, error: 'symptoms array required' });
    }

    const clusters = await createClustersFromOnboarding(pool, req.user.id, symptoms);
    return res.json({
      ok: true,
      clusters: clusters.map(c => ({
        cluster_key: c.cluster_key,
        display_name: c.display_name,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getScriptHandler,
  startScriptHandler,
  answerScriptHandler,
  getSessionHandler,
  createClustersHandler,
};
