const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  createQR,
  handleWebhook,
  getBalance,
  getHistory,
} = require('../controllers/payment.controller');

function paymentRoutes(pool) {
  const router = express.Router();

  router.post('/qr',      requireAuth, (req, res) => createQR(pool, req, res));
  router.post('/webhook',              (req, res) => handleWebhook(pool, req, res));
  router.get('/balance',  requireAuth, (req, res) => getBalance(pool, req, res));
  router.get('/history',  requireAuth, (req, res) => getHistory(pool, req, res));

  return router;
}

module.exports = paymentRoutes;
