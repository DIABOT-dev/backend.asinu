'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireDoctorSignature } = require('../middleware/doctor-signature.middleware');
const {
  handleUpload,
  audioUpload,
  verifyAudioMagicBytes,
} = require('../middleware/upload.middleware');
const { nativeCallActionLimiter } = require('../middleware/checkin-call-rate-limit.middleware');
const {
  createDoctorIvrGenerationLimiter,
} = require('../middleware/doctor-ivr-rate-limit.middleware');
const { createDoctorIvrController } = require('../controllers/doctor-ivr.controller');
module.exports = function doctorIvrRoutes(pool) {
  const router = express.Router(),
    controller = createDoctorIvrController(pool);
  router.post(
    '/ivr/doctor',
    requireDoctorSignature,
    createDoctorIvrGenerationLimiter(),
    controller.doctorOperation
  );
  router.post('/ivr/admin', requireDoctorSignature, controller.adminOperation);
  router.get('/ivr/config', requireAuth, controller.config);
  router.post('/ivr/calls/device', requireAuth, controller.registerCallDevice);
  router.post('/ivr/calls/:id/action', requireAuth, controller.callAction);
  router.post(
    '/ivr/native/calls/:id/decline',
    nativeCallActionLimiter,
    controller.declineNativeCall
  );
  router.get('/ivr/sessions', requireAuth, controller.listSessions);
  router.get('/ivr/sessions/:id', requireAuth, controller.getSession);
  router.post('/ivr/sessions/:id/action', requireAuth, controller.patientAction);
  router.post(
    '/ivr/sessions/:id/voice',
    requireAuth,
    handleUpload(audioUpload.single('file')),
    verifyAudioMagicBytes,
    controller.uploadVoice
  );
  router.get('/ivr/sessions/:id/audio/:questionId', requireAuth, controller.questionAudio);
  router.get('/ivr/media/:id', controller.media);
  return router;
};
