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

let basicRunning = false;
let engagementRunning = false;

function notificationRoutes(pool) {
  const router = express.Router();

  router.get('/',              requireAuth, (req, res) => getNotifications(pool, req, res));
  router.delete('/',          requireAuth, (req, res) => deleteAll(pool, req, res));
  router.put('/:id/read',     requireAuth, (req, res) => markAsRead(pool, req, res));
  router.delete('/:id',       requireAuth, (req, res) => deleteOne(pool, req, res));
  router.put('/mark-all-read', requireAuth, (req, res) => markAllAsRead(pool, req, res));
  router.get('/preferences',   requireAuth, (req, res) => getNotificationPreferences(pool, req, res));
  router.put('/preferences',   requireAuth, (req, res) => updateNotificationPreferences(pool, req, res));
  router.get('/engagement/preview', requireAuth, (req, res) => previewEngagement(pool, req, res));
  router.post('/engagement/run', async (req, res) => {
    if (engagementRunning) return res.status(429).json({ error: 'Engagement cron already running' });
    engagementRunning = true;
    try { await runEngagement(pool, req, res); } finally { engagementRunning = false; }
  });
  router.post('/basic/run', async (req, res) => {
    if (basicRunning) return res.status(429).json({ error: 'Basic cron already running' });
    basicRunning = true;
    try { await runBasic(pool, req, res); } finally { basicRunning = false; }
  });

  return router;
}

module.exports = notificationRoutes;
