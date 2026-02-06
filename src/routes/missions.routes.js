const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  getMissionsHandler,
  getMissionHistoryHandler,
  getMissionStatsHandler
} = require('../controllers/missions.controller');

function missionsRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/missions
   * Get user's current missions with progress
   */
  router.get('/', requireAuth, (req, res) => getMissionsHandler(pool, req, res));

  /**
   * GET /api/missions/history
   * Get mission completion history for past N days
   * Query: ?days=30 (default 30)
   */
  router.get('/history', requireAuth, (req, res) => getMissionHistoryHandler(pool, req, res));

  /**
   * GET /api/missions/stats
   * Get mission completion statistics
   */
  router.get('/stats', requireAuth, (req, res) => getMissionStatsHandler(pool, req, res));

  return router;
}

module.exports = missionsRoutes;
