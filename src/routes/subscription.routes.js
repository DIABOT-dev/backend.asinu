const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  createQR,
  getStatus,
  getPlans,
  getHistory,
} = require('../controllers/subscription.controller');

function subscriptionRoutes(pool) {
  const router = express.Router();

  router.post('/qr',     requireAuth, (req, res) => createQR(pool, req, res));
  router.get('/status',  requireAuth, (req, res) => getStatus(pool, req, res));
  router.get('/plans',                (req, res) => getPlans(pool, req, res));
  router.get('/history', requireAuth, (req, res) => getHistory(pool, req, res));

  return router;
}

module.exports = subscriptionRoutes;
