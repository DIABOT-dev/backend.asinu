const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  getMissionsHandler,
  getMissionHistoryHandler,
  getMissionStatsHandler,
} = require('../controllers/missions.controller');

function missionsRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/missions
   * Get user's current missions with progress
   */
  router.get('/', requireAuth, bindController(getMissionsHandler, pool));

  /**
   * GET /api/missions/history
   * Get mission completion history for past N days
   * Query: ?days=30 (default 30)
   */
  router.get('/history', requireAuth, bindController(getMissionHistoryHandler, pool));

  /**
   * GET /api/missions/stats
   * Get mission completion statistics
   */
  router.get('/stats', requireAuth, bindController(getMissionStatsHandler, pool));

  return router;
}

module.exports = missionsRoutes;
