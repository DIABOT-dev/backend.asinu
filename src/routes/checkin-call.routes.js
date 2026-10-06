'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { conclusionAudioLimiter, nativeCallActionLimiter } = require('../middleware/checkin-call-rate-limit.middleware');
const { createCheckinCallController } = require('../controllers/checkin-call.controller');

function checkinCallRoutes(pool) {
  const router = express.Router();
  const controller = createCheckinCallController(pool);
  // Only an expiring, recipient/attempt/action-scoped capability works here.
  // All other endpoints retain normal session authentication.
  router.post('/native/attempts/:id/decline', nativeCallActionLimiter, controller.declineNativeCall);
  router.use(requireAuth);

  router.get('/settings', controller.getSettings);
  router.put('/settings', controller.saveSettings);
  router.get('/voice-preferences', controller.getVoicePreferences);
  router.put('/voice-preferences', controller.saveVoicePreferences);
  router.get('/attempts/:id/user-notice', conclusionAudioLimiter, controller.getUserNotice);
  router.get('/attempts/:id/user-audio/:key', conclusionAudioLimiter, controller.getUserAudio);
  router.get('/active', controller.getActive);
  router.post('/test-call', controller.startTestCall);
  router.get('/episodes/:id', controller.getEpisode);
  router.get('/audio-config', controller.getAudioConfig);
  router.get('/audio/:key', controller.getAudio);
  router.post('/audio/conclusion', conclusionAudioLimiter, controller.synthesizeConclusion);
  router.get('/attempts/:id', controller.getAttempt);
  router.get('/attempts/:id/family-audio', conclusionAudioLimiter, controller.getFamilyAudio);
  router.post('/episodes/:id/answer', controller.answerEpisode);
  router.post('/episodes/:id/triage/start', controller.startTriage);
  router.post('/episodes/:id/triage/complete', controller.completeTriage);
  router.post('/episodes/:id/family-confirm', controller.confirmFamily);
  router.post('/attempts/:id/seen', controller.markAttemptSeen);
  router.post('/attempts/:id/accept', controller.acceptAttempt);
  router.post('/attempts/:id/decline', controller.declineAttempt);
  router.get('/attempts/:id/token', controller.getAttemptToken);

  return router;
}

module.exports = checkinCallRoutes;
