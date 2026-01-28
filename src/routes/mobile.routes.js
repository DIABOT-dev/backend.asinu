const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createMobileLog, getRecentLogs } = require('../controllers/mobile.controller');
const { postChat } = require('../controllers/chat.controller');
const { getMissionsHandler } = require('../controllers/missions.controller');
const { upsertOnboardingProfile } = require('../controllers/onboarding.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  router.post('/logs', requireAuth, (req, res) => createMobileLog(pool, req, res));
  router.get('/logs/recent', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.post('/chat', requireAuth, (req, res) => postChat(pool, req, res));
  router.get('/missions', requireAuth, (req, res) => getMissionsHandler(pool, req, res));
  router.post('/onboarding', requireAuth, (req, res) => upsertOnboardingProfile(pool, req, res));

  return router;
}

module.exports = mobileRoutes;
