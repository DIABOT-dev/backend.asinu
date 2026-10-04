const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  postEvent,
  getStateHandler,
  ackEscalation,
} = require('../controllers/carePulse.controller');

function carePulseRoutes(pool) {
  const router = express.Router();

  router.post('/events', requireAuth, bindController(postEvent, pool));
  router.get('/state', requireAuth, bindController(getStateHandler, pool));
  router.post('/escalations/ack', requireAuth, bindController(ackEscalation, pool));

  return router;
}

module.exports = carePulseRoutes;
