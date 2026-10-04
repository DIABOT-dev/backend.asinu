'use strict';

/** Bind the database dependency and forward controller failures to Express. */
function bindController(controller, pool) {
  return function controllerHandler(req, res, next) {
    try {
      return Promise.resolve(controller(pool, req, res, next)).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { bindController };
