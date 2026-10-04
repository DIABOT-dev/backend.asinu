'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { bindController } = require('../middleware/controller-handler.middleware');
const { evaluate, latest, familyLatest } = require('../controllers/early-signal.controller');

function earlySignalRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.post('/evaluate', bindController(evaluate, pool));
  router.get('/latest', bindController(latest, pool));
  router.get('/family', bindController(familyLatest, pool));

  return router;
}

module.exports = earlySignalRoutes;
