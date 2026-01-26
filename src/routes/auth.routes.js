const express = require('express');
const {
  registerByEmail,
  loginByEmail,
  getMe,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  loginByPhone,
} = require('../controllers/auth.controller');

function authRoutes(pool) {
  const router = express.Router();

  router.post('/email/register', (req, res) => registerByEmail(pool, req, res));
  router.post('/email/login', (req, res) => loginByEmail(pool, req, res));
  router.post('/google', (req, res) => loginByGoogle(pool, req, res));
  router.post('/apple', (req, res) => loginByApple(pool, req, res));
  router.post('/zalo', (req, res) => loginByZalo(pool, req, res));
  router.post('/phone-login', (req, res) => loginByPhone(pool, req, res));
  router.get('/me', (req, res) => getMe(pool, req, res));

  return router;
}

module.exports = authRoutes;
