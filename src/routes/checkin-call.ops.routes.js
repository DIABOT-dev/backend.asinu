const express = require('express');
const { requireCronSecret } = require('../middleware/cron-auth');
const { createCheckinCallOpsController } = require('../controllers/checkin-call-ops.controller');

function checkinCallOpsRoutes(pool) {
  const router = express.Router();
  const controller = createCheckinCallOpsController(pool);
  router.use(requireCronSecret);

  router.get('/metrics', controller.metrics);
  router.get('/exhausted', controller.exhausted);
  router.get('/episodes/:id/timeline', controller.timeline);

  return router;
}

module.exports = checkinCallOpsRoutes;
