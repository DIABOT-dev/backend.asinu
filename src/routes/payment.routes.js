const { bindController } = require('../middleware/controller-handler.middleware');
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

  router.post('/qr', requireAuth, bindController(createQR, pool));
  router.post('/webhook', bindController(handleWebhook, pool));
  router.get('/balance', requireAuth, bindController(getBalance, pool));
  router.get('/history', requireAuth, bindController(getHistory, pool));

  return router;
}

module.exports = paymentRoutes;
