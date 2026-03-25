const express = require('express');
const { requireBrainAuth } = require('../middleware/brainAuth');
const {
  getNextHandler,
  postAnswerHandler,
  getTimelineHandler,
  postEmergencyHandler,
  startEmergencyTriageHandler,
  submitEmergencyTriageAnswerHandler
} = require('../controllers/asinuBrain.controller');

function asinuBrainRoutes(pool) {
  const router = express.Router();

  router.get('/next', requireBrainAuth, (req, res) => getNextHandler(pool, req, res));
  router.post('/answer', requireBrainAuth, (req, res) => postAnswerHandler(pool, req, res));
  router.get('/timeline', requireBrainAuth, (req, res) => getTimelineHandler(pool, req, res));
  router.post('/emergency', requireBrainAuth, (req, res) => postEmergencyHandler(pool, req, res));
  router.post('/emergency/triage/start', requireBrainAuth, (req, res) => startEmergencyTriageHandler(pool, req, res));
  router.post('/emergency/triage/answer', requireBrainAuth, (req, res) => submitEmergencyTriageAnswerHandler(pool, req, res));

  return router;
}

module.exports = asinuBrainRoutes;
