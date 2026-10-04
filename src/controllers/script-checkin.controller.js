'use strict';

const {
  getUserScript,
  createClustersFromOnboarding,
} = require('../services/checkin/script.service');
const { getTodaySession } = require('../services/checkin/script-session.service');
const { startScriptFlow, answerScriptFlow } = require('../services/checkin/script-flow.service');
const { t, getLang } = require('../i18n');

// ─── GET /checkin/script ────────────────────────────────────────────────────

/**
 * Get cached script for user.
 * App calls this on check-in screen open → receives full JSON.
 * 0 AI calls.
 */
async function getScriptHandler(pool, req, res) {
  try {
    const result = await getUserScript(pool, req.user.id, getLang(req));

    if (!result) {
      return res.json({
        ok: true,
        has_script: false,
        message: t('checkin.script.no_clusters', getLang(req)),
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
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function startScriptHandler(pool, req, res) {
  try {
    const result = await startScriptFlow(pool, req.user.id, req.body || {}, getLang(req));
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[ScriptCheckin] startScript failed:', err.message);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function answerScriptHandler(pool, req, res) {
  try {
    const result = await answerScriptFlow(pool, req.user.id, req.body || {}, getLang(req));
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[ScriptCheckin] answer failed:', err.message);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
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
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
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
      return res.status(400).json({
        ok: false,
        error: t('checkin.script.symptoms_required', getLang(req)),
      });
    }

    const clusters = await createClustersFromOnboarding(pool, req.user.id, symptoms);
    return res.json({
      ok: true,
      clusters: clusters.map((c) => ({
        cluster_key: c.cluster_key,
        display_name: c.display_name,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
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
