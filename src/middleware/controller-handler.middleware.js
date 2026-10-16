'use strict';
const { withAiUser } = require('../services/ai/ai-consent.service');

/** Bind the database dependency and forward controller failures to Express. */
function bindController(controller, pool) {
  return function controllerHandler(req, res, next) {
    try {
      const invoke = () => controller(pool, req, res, next);
      return Promise.resolve(req.user?.id ? withAiUser(pool, req.user.id, invoke) : invoke()).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { bindController };
