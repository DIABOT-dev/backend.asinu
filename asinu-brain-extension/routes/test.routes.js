const express = require('express');
const {
  testMoodQuestion,
  testFollowupQuestion,
  testSymptomQuestion,
  testAllQuestions,
  testHealth
} = require('../controllers/test.controller');

/**
 * Public Test Routes - No Authentication Required
 * ONLY FOR TESTING OpenAI question generation
 */
function testRoutes(pool) {
  const router = express.Router();

  // Health check
  router.get('/health', (req, res) => testHealth(pool, req, res));

  // Test individual question types
  router.get('/question/mood', (req, res) => testMoodQuestion(pool, req, res));
  router.get('/question/followup', (req, res) => testFollowupQuestion(pool, req, res));
  router.get('/question/symptom', (req, res) => testSymptomQuestion(pool, req, res));

  // Test all questions at once
  router.get('/question/all', (req, res) => testAllQuestions(pool, req, res));

  return router;
}

module.exports = testRoutes;
