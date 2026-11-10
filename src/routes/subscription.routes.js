const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getStatus } = require('../controllers/subscription.controller');

function subscriptionRoutes(pool) {
  const router = express.Router();

  router.get('/status', requireAuth, bindController(getStatus, pool));

  return router;
}

module.exports = subscriptionRoutes;
