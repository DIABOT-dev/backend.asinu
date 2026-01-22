const express = require('express');
const { authenticateJWT } = require('../middleware/auth');
const { createMobileLog, getRecentLogs } = require('../controllers/mobile.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  router.post('/logs', authenticateJWT, (req, res) => createMobileLog(pool, req, res));
  router.get('/logs/recent', authenticateJWT, (req, res) => getRecentLogs(pool, req, res));

  return router;
}

module.exports = mobileRoutes;
