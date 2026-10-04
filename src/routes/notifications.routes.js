const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireCronSecret } = require('../middleware/cron-auth');
const {
  createNotification,
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

  router.get('/', requireAuth, bindController(getNotifications, pool));
  router.post('/', requireAuth, bindController(createNotification, pool));
  router.delete('/', requireAuth, bindController(deleteAll, pool));
  router.put('/mark-all-read', requireAuth, bindController(markAllAsRead, pool));
  router.put('/:id/read', requireAuth, bindController(markAsRead, pool));
  router.delete('/:id', requireAuth, bindController(deleteOne, pool));
  router.get('/preferences', requireAuth, bindController(getNotificationPreferences, pool));
  router.put('/preferences', requireAuth, bindController(updateNotificationPreferences, pool));
  router.get('/engagement/preview', requireAuth, bindController(previewEngagement, pool));
  router.post('/engagement/run', requireCronSecret, bindController(runEngagement, pool));
  router.post('/basic/run', requireCronSecret, bindController(runBasic, pool));

  return router;
}

module.exports = notificationRoutes;
