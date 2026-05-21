const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { verifyReceipt, listProducts } = require('../controllers/iap.controller');

function iapRoutes(pool) {
  const router = express.Router();

  // Public — client needs pricing before sign-in to render a "from N₫" badge.
  router.get('/products', (req, res) => listProducts(pool, req, res));

  // Authenticated — every receipt must be tied to a user.
  router.post('/verify', requireAuth, (req, res) => verifyReceipt(pool, req, res));

  return router;
}

module.exports = iapRoutes;
