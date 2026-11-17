'use strict';
const express = require('express');
const { bindController } = require('../middleware/controller-handler.middleware');
const { requireCrmCommand } = require('../middleware/crm-command-auth.middleware');
const { crmCommand } = require('../controllers/crm-commands.controller');
module.exports = (pool) => {
  const router = express.Router();
  router.post('/commands', requireCrmCommand, bindController(crmCommand, pool));
  return router;
};
