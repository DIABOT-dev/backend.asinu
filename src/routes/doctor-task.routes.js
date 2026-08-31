const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  requestDoctorTask,
  submitDoctorRating,
  requestDoctorPrivacy,
  recommendDoctor,
  listDoctorTasks,
  listDoctorMessages,
  createDoctorMessage,
  getDoctorPrivacyReceipts,
} = require('../controllers/doctor-task.controller');

function doctorTaskRoutes(pool) {
  const router = express.Router();
  router.post('/tasks', requireAuth, (req, res, next) =>
    Promise.resolve(requestDoctorTask(pool, req, res)).catch(next)
  );
  router.get('/tasks', requireAuth, (req, res, next) =>
    Promise.resolve(listDoctorTasks(pool, req, res)).catch(next)
  );
  router.get('/tasks/:taskId/messages', requireAuth, (req, res, next) =>
    Promise.resolve(listDoctorMessages(pool, req, res)).catch(next)
  );
  router.post('/tasks/:taskId/messages', requireAuth, (req, res, next) =>
    Promise.resolve(createDoctorMessage(pool, req, res)).catch(next)
  );
  router.post('/tasks/:taskId/rating', requireAuth, (req, res, next) =>
    Promise.resolve(submitDoctorRating(pool, req, res)).catch(next)
  );
  router.post('/privacy', requireAuth, (req, res, next) =>
    Promise.resolve(requestDoctorPrivacy(pool, req, res)).catch(next)
  );
  router.get('/privacy', requireAuth, (req, res, next) =>
    Promise.resolve(getDoctorPrivacyReceipts(pool, req, res)).catch(next)
  );
  router.post('/recommendations', requireAuth, (req, res, next) =>
    Promise.resolve(recommendDoctor(pool, req, res)).catch(next)
  );
  return router;
}

module.exports = doctorTaskRoutes;
