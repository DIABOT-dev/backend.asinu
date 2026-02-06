const express = require('express');
const {
  registerByEmail,
  loginByEmail,
  getMe,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  loginByPhone,
  searchUsers,
  verifyToken
} = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

function authRoutes(pool) {
  const router = express.Router();

  // ===== REGISTER & LOGIN =====
  router.post('/email/register', (req, res) => registerByEmail(pool, req, res));
  router.post('/email/login', (req, res) => loginByEmail(pool, req, res));
  router.post('/google', (req, res) => loginByGoogle(pool, req, res));
  router.post('/apple', (req, res) => loginByApple(pool, req, res));
  router.post('/zalo', (req, res) => loginByZalo(pool, req, res));
  router.post('/phone-login', (req, res) => loginByPhone(pool, req, res));

  // ===== AUTHENTICATED ENDPOINTS =====
  router.get('/me', requireAuth, (req, res) => getMe(pool, req, res));
  router.post('/verify', requireAuth, (req, res) => verifyToken(pool, req, res));
  router.get('/users/search', requireAuth, (req, res) => searchUsers(pool, req, res));

  return router;
}

module.exports = authRoutes;
