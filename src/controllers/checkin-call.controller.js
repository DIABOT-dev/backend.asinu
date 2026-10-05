'use strict';

const service = require('../services/checkin-call/checkin-call.service');
const audio = require('../services/checkin-call/audio.service');
const { createAttemptToken } = require('../services/checkin-call/access.service');
const { getLang, t } = require('../i18n');

function respond(req, res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('[checkin-call]', error);
  const lang = getLang(req);
  const message =
    status >= 500
      ? t('error.server', lang)
      : error.i18nKey
        ? t(error.i18nKey, lang, error.i18nParams)
        : t('error.invalid_payload', lang);
  return res.status(status).json({
    ok: false,
    code: status === 500 ? 'INTERNAL_ERROR' : 'CHECKIN_CALL_ERROR',
    error: message,
  });
}

function publicEpisode(episode) {
  return {
    id: episode.id,
    user_id: episode.user_id,
    state: episode.state,
    severity: episode.severity,
    issue_category: episode.issue_category || null,
    triage_context: episode.triage_context?.body_location ? episode.triage_context : null,
    triage_display: episode.triage_display || null,
    acknowledged_by: episode.acknowledged_by || null,
  };
}

function createCheckinCallController(pool) {
  const handle = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      return respond(req, res, error);
    }
  };

  return {
    getSettings: handle(async (req, res) =>
      res.json({ ok: true, settings: await service.settings(pool, req.user.id) })
    ),
    saveSettings: handle(async (req, res) =>
      res.json({
        ok: true,
        settings: await service.saveSettings(pool, req.user.id, req.body || {}),
      })
    ),
    getActive: handle(async (req, res) =>
      res.json({ ok: true, active: await service.getActive(pool, req.user.id) })
    ),
    startTestCall: handle(async (req, res) =>
      res.status(201).json({
        ok: true,
        ...(await service.startTestCall(pool, req.user.id, {
          singleDeviceFamily: req.body?.single_device === true,
          localSimulation: req.body?.local_simulation === true,
        })),
      })
    ),
    getEpisode: handle(async (req, res) => {
      const episode = await service.getEpisode(pool, req.params.id, req.user.id, getLang(req));
      if (!episode) {
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.episode_not_found', getLang(req)) });
      }
      return res.json({ ok: true, episode: publicEpisode(episode) });
    }),
    getAudio: handle(async (req, res) => {
      const data = await audio.getAudio(pool, req.params.key, getLang(req));
      return res.json({
        ok: true,
        mimeType: data.mime_type,
        base64: data.audio_data.toString('base64'),
      });
    }),
    synthesizeConclusion: handle(async (req, res) => {
      const data = await audio.synthesizeText(req.body?.text, getLang(req));
      return res.json({
        ok: true,
        mimeType: data.mime_type,
        base64: data.audio_data.toString('base64'),
      });
    }),
    getAttempt: handle(async (req, res) => {
      const attempt = await service.getAttempt(pool, req.params.id, req.user.id, getLang(req));
      if (!attempt) {
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.attempt_not_found', getLang(req)) });
      }
      return res.json({ ok: true, attempt });
    }),
    getFamilyAudio: handle(async (req, res) => {
      const data = await service.getFamilyAudio(pool, req.params.id, req.user.id, getLang(req));
      return res.json({ ok: true, mimeType: data.mime_type, base64: data.audio_data.toString('base64') });
    }),
    answerEpisode: handle(async (req, res) => {
      const episode = await service.answer(
        pool,
        req.params.id,
        req.user.id,
        req.body?.choice,
        req.body?.issue_category
      );
      return res.json({ ok: true, episode: publicEpisode(episode) });
    }),
    startTriage: handle(async (req, res) => {
      const result = await service.startTriage(pool, req.params.id, req.user.id, getLang(req));
      return res.json({
        ok: true,
        episode: publicEpisode(result.episode),
        triage: result.triage,
      });
    }),
    completeTriage: handle(async (req, res) => {
      const episode = await service.completeTriage(
        pool,
        req.params.id,
        req.user.id,
        req.body || {}
      );
      return res.json({ ok: true, episode: publicEpisode(episode) });
    }),
    confirmFamily: handle(async (req, res) => {
      const episode = await service.confirmFamily(
        pool,
        req.params.id,
        req.user.id,
        req.body?.action
      );
      return res.json({ ok: true, episode: publicEpisode(episode) });
    }),
    markAttemptSeen: handle(async (req, res) =>
      res.json(await service.seen(pool, req.params.id, req.user.id))
    ),
    acceptAttempt: handle(async (req, res) =>
      res.json(await service.accept(pool, req.params.id, req.user.id))
    ),
    getAttemptToken: handle(async (req, res) => {
      const result = await createAttemptToken(pool, req.params.id, req.user.id);
      if (result.unavailable) {
        return res
          .status(503)
          .json({ ok: false, error: t('checkinCall.error.livekit_unavailable', getLang(req)) });
      }
      if (result.notFound) {
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.active_call_not_found', getLang(req)) });
      }
      return res.json({ ok: true, ...result });
    }),
  };
}

module.exports = { createCheckinCallController };
