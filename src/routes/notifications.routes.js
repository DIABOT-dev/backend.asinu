const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireCronSecret } = require('../middleware/cron-auth');
const rateLimit = require('express-rate-limit');
const reminderAssistant = require('../controllers/reminder-assistant.controller');
const { audioUpload, handleUpload, verifyAudioMagicBytes } = require('../middleware/upload.middleware');
const { transcribeAudio } = require('../controllers/chat.controller');
const {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteOne,
  deleteAll,
  getNotificationPreferences,
  updateNotificationPreferences,
  runEngagement,
  runBasic,
} = require('../controllers/notification.controller');

function notificationRoutes(pool) {
  const router = express.Router();
  const assistantLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 15,
    keyGenerator: req => `reminder-assistant:${req.user.id}`,
    standardHeaders: true, legacyHeaders: false,
    message: { ok: false, code: 'REMINDER_ASSISTANT_RATE_LIMITED' } });
  const assistantConsent = (req, res, next) => reminderAssistant.requireReminderAssistant(pool, req, res, next);

  router.post('/reminder-assistant/plan', requireAuth, assistantConsent, assistantLimit,
    bindController(reminderAssistant.plan, pool));
  router.post('/reminder-assistant/apply', requireAuth, assistantConsent,
    bindController(reminderAssistant.apply, pool));
  router.post('/reminder-assistant/transcribe', requireAuth, assistantConsent, assistantLimit,
    handleUpload(audioUpload.single('audio')), verifyAudioMagicBytes, bindController(transcribeAudio, pool));

  router.get('/', requireAuth, bindController(getNotifications, pool));
  router.post('/', requireAuth, bindController(createNotification, pool));
  router.delete('/', requireAuth, bindController(deleteAll, pool));
  router.put('/mark-all-read', requireAuth, bindController(markAllAsRead, pool));
  router.put('/:id/read', requireAuth, bindController(markAsRead, pool));
  router.delete('/:id', requireAuth, bindController(deleteOne, pool));
  router.get('/preferences', requireAuth, bindController(getNotificationPreferences, pool));
  router.put('/preferences', requireAuth, bindController(updateNotificationPreferences, pool));
  router.post('/engagement/run', requireCronSecret, bindController(runEngagement, pool));
  router.post('/basic/run', requireCronSecret, bindController(runBasic, pool));

  return router;
}

module.exports = notificationRoutes;
