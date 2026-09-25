const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const { requireAuth } = require('../middleware/auth.middleware');
const service = require('../services/checkin-call/checkin-call.service');
const audio = require('../services/checkin-call/audio.service');
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
        : error.message;
  return res
    .status(status)
    .json({
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
    acknowledged_by: episode.acknowledged_by || null,
  };
}

function checkinCallRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/settings', async (req, res) => {
    try {
      return res.json({ ok: true, settings: await service.settings(pool, req.user.id) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.put('/settings', async (req, res) => {
    try {
      return res.json({
        ok: true,
        settings: await service.saveSettings(pool, req.user.id, req.body || {}),
      });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.get('/active', async (req, res) => {
    try {
      return res.json({ ok: true, active: await service.getActive(pool, req.user.id) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.post('/test-call', async (req, res) => {
    try {
      return res.status(201).json({ ok: true, ...(await service.startTestCall(pool, req.user.id)) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.get('/episodes/:id', async (req, res) => {
    try {
      const episode = await service.getEpisode(pool, req.params.id, req.user.id);
      if (!episode)
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.episode_not_found', getLang(req)) });
      return res.json({ ok: true, episode: publicEpisode(episode) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.get('/audio/:key', async (req, res) => {
    // Audio is only available to authenticated app users; all phrases are fixed.
    try {
      const data = await audio.getAudio(pool, req.params.key, getLang(req));
      return res.json({
        ok: true,
        mimeType: data.mime_type,
        base64: data.audio_data.toString('base64'),
      });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.get('/attempts/:id', async (req, res) => {
    try {
      const attempt = await service.getAttempt(pool, req.params.id, req.user.id);
      if (!attempt)
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.attempt_not_found', getLang(req)) });
      return res.json({ ok: true, attempt });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.post('/episodes/:id/answer', async (req, res) => {
    try {
      const episode = await service.answer(pool, req.params.id, req.user.id, req.body?.choice);
      return res.json({ ok: true, episode: publicEpisode(episode) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.post('/episodes/:id/family-confirm', async (req, res) => {
    try {
      const episode = await service.confirmFamily(
        pool,
        req.params.id,
        req.user.id,
        req.body?.action
      );
      return res.json({ ok: true, episode: publicEpisode(episode) });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.post('/attempts/:id/seen', async (req, res) => {
    try {
      return res.json(await service.seen(pool, req.params.id, req.user.id));
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.post('/attempts/:id/accept', async (req, res) => {
    try {
      return res.json(await service.accept(pool, req.params.id, req.user.id));
    } catch (error) {
      return respond(req, res, error);
    }
  });
  router.get('/attempts/:id/token', async (req, res) => {
    try {
      const url = process.env.LIVEKIT_URL;
      const key = process.env.LIVEKIT_API_KEY;
      const secret = process.env.LIVEKIT_API_SECRET;
      if (!url || !key || !secret)
        return res
          .status(503)
          .json({ ok: false, error: t('checkinCall.error.livekit_unavailable', getLang(req)) });
      const found = await pool.query(
        'SELECT a.room_name, a.state, e.state AS episode_state FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.id = $1 AND a.target_user_id = $2',
        [req.params.id, req.user.id]
      );
      const attempt = found.rows[0];
      if (!attempt || !['RINGING', 'CONNECTED', 'PUSH_WAIT'].includes(attempt.state)) {
        return res
          .status(404)
          .json({ ok: false, error: t('checkinCall.error.active_call_not_found', getLang(req)) });
      }
      const token = new AccessToken(key, secret, { identity: 'user-' + req.user.id, ttl: '5m' });
      token.addGrant({
        roomJoin: true,
        room: attempt.room_name,
        canPublish: false,
        canSubscribe: true,
      });
      return res.json({ ok: true, url, token: await token.toJwt(), room: attempt.room_name });
    } catch (error) {
      return respond(req, res, error);
    }
  });
  return router;
}

module.exports = checkinCallRoutes;
