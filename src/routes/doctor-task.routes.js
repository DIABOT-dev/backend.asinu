const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requestDoctorTask } = require('../controllers/doctor-task.controller');

function doctorTaskRoutes(pool) {
  const router = express.Router();
  router.post('/tasks', requireAuth, (req, res, next) =>
    Promise.resolve(requestDoctorTask(pool, req, res)).catch(next)
  );
  return router;
}

module.exports = doctorTaskRoutes;
