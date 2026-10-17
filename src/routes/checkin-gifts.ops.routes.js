'use strict';
const express = require('express');
const { requireCronSecret } = require('../middleware/cron-auth');
const { createGiftController } = require('../controllers/checkin-gifts.controller');
module.exports = (pool) => {
  const router = express.Router(),
    controller = createGiftController(pool);
  router.use(requireCronSecret);
  router.get('/config', controller.config);
  router.put('/config', controller.saveConfig);
  router.get('/loc-items', controller.locs);
  router.put('/loc-items/:code', controller.saveLoc);
  router.put('/draws/:code', controller.saveDraw);
  router.get('/draws/:id/tickets.csv', controller.exportTickets);
  router.post('/draws/:id/results', controller.publish);
  return router;
};
