const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  postEvent,
  getStateHandler,
} = require('../controllers/carePulse.controller');

function carePulseRoutes(pool) {
  const router = express.Router();

  router.post('/events', requireAuth, bindController(postEvent, pool));
  router.get('/state', requireAuth, bindController(getStateHandler, pool));

  return router;
}

module.exports = carePulseRoutes;
