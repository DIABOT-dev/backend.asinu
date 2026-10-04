const express = require('express');
const controller = require('../controllers/doctor-profile.controller');
const { bindController } = require('../middleware/controller-handler.middleware');
const { requireDoctorSignature } = require('../middleware/doctor-signature.middleware');

function doctorProfileRoutes(pool) {
  const router = express.Router();
  router.post('/profile', bindController(controller.getDoctorPatientProfile, pool));
  router.post('/patient-files', bindController(controller.createDoctorPatientFile, pool));
  router.post('/lifecycle', bindController(controller.ingestDoctorPatientLifecycle, pool));
  router.post(
    '/messages/query',
    requireDoctorSignature,
    bindController(controller.queryDoctorMessages, pool)
  );
  router.post(
    '/messages/send',
    requireDoctorSignature,
    bindController(controller.sendDoctorMessage, pool)
  );
  router.post(
    '/messages/action',
    requireDoctorSignature,
    bindController(controller.doctorMessageAction, pool)
  );
  router.post(
    '/messages/voice',
    requireDoctorSignature,
    bindController(controller.sendDoctorVoice, pool)
  );
  router.post(
    '/ai-assist',
    requireDoctorSignature,
    bindController(controller.createDoctorAiAssist, pool)
  );
  router.post(
    '/ai-context-version',
    requireDoctorSignature,
    bindController(controller.getDoctorAiContextVersion, pool)
  );
  return router;
}

module.exports = doctorProfileRoutes;
