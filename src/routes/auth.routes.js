const express = require('express');
const { registerByEmail, loginByEmail, getMe } = require('../controllers/auth.controller');

function authRoutes(pool) {
  const router = express.Router();

  router.post('/email/register', (req, res) => registerByEmail(pool, req, res));
  router.post('/email/login', (req, res) => loginByEmail(pool, req, res));
  router.get('/me', (req, res) => getMe(pool, req, res));

  return router;
}

module.exports = authRoutes;
