const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { bindController } = require('../middleware/controller-handler.middleware');
const {
  imageUpload,
  audioUpload,
  handleUpload,
  verifyImageMagicBytes,
  verifyAudioMagicBytes,
} = require('../middleware/upload.middleware');
const {
  requestDoctorTask,
  submitDoctorRating,
  requestDoctorPrivacy,
  recommendDoctor,
  listDoctorDirectory,
  listDoctorDirectorySpecialties,
  listDoctorReviews,
  listDoctorSpecialties,
  listDoctorClinics,
  listDoctorTasks,
  listDoctorMessages,
  createDoctorMessage,
  createDoctorAttachment,
  createDoctorVoice,
  createDoctorMessageAction,
  getDoctorPrivacyReceipts,
} = require('../controllers/doctor-task.controller');

function doctorTaskRoutes(pool) {
  const router = express.Router();
  router.post('/tasks', requireAuth, bindController(requestDoctorTask, pool));
  router.get('/tasks', requireAuth, bindController(listDoctorTasks, pool));
  router.get('/tasks/:taskId/messages', requireAuth, bindController(listDoctorMessages, pool));
  router.post('/tasks/:taskId/messages', requireAuth, bindController(createDoctorMessage, pool));
  router.post(
    '/tasks/:taskId/messages/action',
    requireAuth,
    bindController(createDoctorMessageAction, pool)
  );
  router.post(
    '/tasks/:taskId/attachments',
    requireAuth,
    handleUpload(imageUpload.single('file')),
    verifyImageMagicBytes,
    bindController(createDoctorAttachment, pool)
  );
  router.post(
    '/tasks/:taskId/voice',
    requireAuth,
    handleUpload(audioUpload.single('file')),
    verifyAudioMagicBytes,
    bindController(createDoctorVoice, pool)
  );
  router.post('/tasks/:taskId/rating', requireAuth, bindController(submitDoctorRating, pool));
  router.post('/privacy', requireAuth, bindController(requestDoctorPrivacy, pool));
  router.get('/privacy', requireAuth, bindController(getDoctorPrivacyReceipts, pool));
  router.post('/recommendations', requireAuth, bindController(recommendDoctor, pool));
  router.post('/specialists', requireAuth, bindController(listDoctorDirectory, pool));
  router.get(
    '/specialty-options',
    requireAuth,
    bindController(listDoctorDirectorySpecialties, pool)
  );
  router.get(
    '/specialists/:doctorId/reviews',
    requireAuth,
    bindController(listDoctorReviews, pool)
  );
  router.post('/specialties', requireAuth, bindController(listDoctorSpecialties, pool));
  router.post('/clinics', requireAuth, bindController(listDoctorClinics, pool));
  return router;
}

module.exports = doctorTaskRoutes;
