const { bindController } = require('../middleware/controller-handler.middleware');
/**
 * Logs Routes
 * POST /api/logs/voice-parse — available to every signed-in user
 * Nhận audio + log_type, dùng Whisper → GPT-4o trả về parsed health data
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  audioUpload,
  handleUpload,
  verifyAudioMagicBytes,
} = require('../middleware/upload.middleware');
const { voiceParse } = require('../controllers/logs.controller');

function logsRoutes(pool) {
  const router = express.Router();

  router.post(
    '/voice-parse',
    requireAuth,
    handleUpload(audioUpload.single('audio')),
    verifyAudioMagicBytes,
    bindController(voiceParse, pool)
  );

  return router;
}

module.exports = logsRoutes;
