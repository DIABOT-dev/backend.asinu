'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { createGiftController } = require('../controllers/checkin-gifts.controller');
module.exports = (pool) => {
  const router = express.Router(),
    controller = createGiftController(pool);
  router.use(requireAuth);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/today', controller.today);
  router.post('/open', controller.open);
  router.get('/history', controller.history);
  router.get('/draw/:id/rules', controller.rules);
  router.get('/draw/:id/results', controller.results);
  router.get('/:id', controller.receipt);
  return router;
};
