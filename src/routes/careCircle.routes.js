const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { careCircleEnabled, caregiverViewLogs } = require('../middleware/care-circle.gate.middleware');
const {
  createInvitation,
  createQrToken,
  previewQrToken,
  createInvitationFromQr,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  cancelInvitation,
  getConnections,
  deleteConnection,
  updateConnection,
  updateConnectionPermissions,
  updateHealthAccess,
  getMemberHealthCalendar,
} = require('../controllers/careCircle.controller');

function careCircleRoutes(pool) {
  const router = express.Router();
  const bind = (handler) => (req, res, next) =>
    Promise.resolve(handler(pool, req, res)).catch(next);

  // All Care Circle endpoints share the same on/off flag.
  router.use(careCircleEnabled);

  router.post('/invitations', requireAuth, bind(createInvitation));
  router.post('/qr-token', requireAuth, bind(createQrToken));
  router.post('/qr-token/preview', requireAuth, bind(previewQrToken));
  router.post('/qr-token/invitations', requireAuth, bind(createInvitationFromQr));
  router.get('/invitations', requireAuth, bind(getInvitations));
  router.post('/invitations/:id/accept', requireAuth, bind(acceptInvitation));
  router.post('/invitations/:id/reject', requireAuth, bind(rejectInvitation));
  router.delete('/invitations/:id', requireAuth, bind(cancelInvitation));
  router.get('/connections', requireAuth, bind(getConnections));
  router.put('/connections/:id', requireAuth, bind(updateConnection));
  router.put('/connections/:id/permissions', requireAuth, bind(updateConnectionPermissions));
  router.put('/connections/:id/health-access', requireAuth, bind(updateHealthAccess));
  router.get('/member/:memberId/health-calendar', requireAuth, caregiverViewLogs, bind(getMemberHealthCalendar));
  router.delete('/connections/:id', requireAuth, bind(deleteConnection));

  return router;
}

module.exports = careCircleRoutes;
