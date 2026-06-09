'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const controller = require('../services/health_feed/controller');

function healthFeedRoutes(pool) {
  const router = express.Router();
  const wrap = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

  router.get('/feed', requireAuth, wrap((req, res) => controller.getFeed(pool, req, res)));
  router.post('/feed/:id/read', requireAuth, wrap((req, res) => controller.markFeedRead(pool, req, res)));
  router.post('/feed/:id/dismiss', requireAuth, wrap((req, res) => controller.dismissFeed(pool, req, res)));
  router.get('/content/:id', requireAuth, wrap((req, res) => controller.getContent(pool, req, res)));
  router.post('/content/:id/save', requireAuth, wrap((req, res) => controller.saveContent(pool, req, res)));
  router.post('/content/:id/unsave', requireAuth, wrap((req, res) => controller.unsaveContent(pool, req, res)));
  router.get('/saved', requireAuth, wrap((req, res) => controller.getSaved(pool, req, res)));
  router.post('/event', requireAuth, wrap((req, res) => controller.createEvent(pool, req, res)));

  return router;
}

module.exports = healthFeedRoutes;
