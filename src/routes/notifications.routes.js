const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteOne,
  deleteAll,
  getNotificationPreferences,
  updateNotificationPreferences,
  previewEngagement,
  runEngagement,
  runBasic,
} = require('../controllers/notification.controller');

function notificationRoutes(pool) {
  const router = express.Router();

  router.get('/',              requireAuth, (req, res) => getNotifications(pool, req, res));
  router.delete('/',          requireAuth, (req, res) => deleteAll(pool, req, res));
  router.put('/mark-all-read', requireAuth, (req, res) => markAllAsRead(pool, req, res));
  router.put('/:id/read',     requireAuth, (req, res) => markAsRead(pool, req, res));
  router.delete('/:id',       requireAuth, (req, res) => deleteOne(pool, req, res));
  router.get('/preferences',   requireAuth, (req, res) => getNotificationPreferences(pool, req, res));
  router.put('/preferences',   requireAuth, (req, res) => updateNotificationPreferences(pool, req, res));
  router.get('/engagement/preview', requireAuth, (req, res) => previewEngagement(pool, req, res));
  router.post('/engagement/run', (req, res) => runEngagement(pool, req, res));
  router.post('/basic/run', (req, res) => runBasic(pool, req, res));

  return router;
}

module.exports = notificationRoutes;
