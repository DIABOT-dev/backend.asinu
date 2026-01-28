const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { postEvent, getStateHandler, ackEscalation } = require('../controllers/carePulse.controller');

function carePulseRoutes(pool) {
  const router = express.Router();

  router.post('/events', requireAuth, (req, res) => postEvent(pool, req, res));
  router.get('/state', requireAuth, (req, res) => getStateHandler(pool, req, res));
  router.post('/escalations/ack', requireAuth, (req, res) => ackEscalation(pool, req, res));

  return router;
}

module.exports = carePulseRoutes;
