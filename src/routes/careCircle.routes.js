const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  createInvitation,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  cancelInvitation,
  getConnections,
  deleteConnection,
  updateConnection,
  updateConnectionPermissions
} = require('../controllers/careCircle.controller');

function careCircleRoutes(pool) {
  const router = express.Router();

  router.post('/invitations', requireAuth, (req, res) => createInvitation(pool, req, res));
  router.get('/invitations', requireAuth, (req, res) => getInvitations(pool, req, res));
  router.post('/invitations/:id/accept', requireAuth, (req, res) => acceptInvitation(pool, req, res));
  router.post('/invitations/:id/reject', requireAuth, (req, res) => rejectInvitation(pool, req, res));
  router.delete('/invitations/:id', requireAuth, (req, res) => cancelInvitation(pool, req, res));
  router.get('/connections', requireAuth, (req, res) => getConnections(pool, req, res));
  router.put('/connections/:id', requireAuth, (req, res) => updateConnection(pool, req, res));
  router.put('/connections/:id/permissions', requireAuth, (req, res) => updateConnectionPermissions(pool, req, res));
  router.delete('/connections/:id', requireAuth, (req, res) => deleteConnection(pool, req, res));

  return router;
}

module.exports = careCircleRoutes;
