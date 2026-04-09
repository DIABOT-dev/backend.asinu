/**
 * Logs Routes
 * POST /api/logs/voice-parse — Premium only
 * Nhận audio + log_type, dùng Whisper → GPT-4o trả về parsed health data
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { audioUpload, handleUpload } = require('../middleware/upload.middleware');
const { voiceParse } = require('../controllers/logs.controller');

function logsRoutes(pool) {
  const router = express.Router();

  router.post(
    '/voice-parse',
    requireAuth,
    requirePremium(pool),
    handleUpload(audioUpload.single('audio')),
    (req, res) => voiceParse(pool, req, res)
  );

  return router;
}

module.exports = logsRoutes;
