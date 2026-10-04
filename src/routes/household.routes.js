'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { bindController } = require('../middleware/controller-handler.middleware');
const {
  listProtectedMembers,
  addProtectedMember,
  removeProtectedMember,
} = require('../controllers/household.controller');

function householdRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', bindController(listProtectedMembers, pool));
  router.post('/members', bindController(addProtectedMember, pool));
  router.delete('/members/:userId', bindController(removeProtectedMember, pool));

  return router;
}

module.exports = householdRoutes;
