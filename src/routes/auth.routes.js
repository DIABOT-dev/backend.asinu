const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const {
  registerByEmail,
  loginByEmail,
  getMe,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  zaloInitiate,
  zaloCallback,
  facebookInitiate,
  facebookCallback,
  loginByFacebookToken,
  googleInitiate,
  googleCallback,
  exchangeOAuthCodeHandler,
  searchUsers,
  verifyToken,
} = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { phoneSearchRateLimit } = require('../middleware/phone-search.middleware');

function authRoutes(pool) {
  const router = express.Router();

  // ===== REGISTER & LOGIN =====
  router.post('/email/register', bindController(registerByEmail, pool));
  router.post('/email/login', bindController(loginByEmail, pool));
  router.post('/google', bindController(loginByGoogle, pool));
  router.post('/apple', bindController(loginByApple, pool));
  router.post('/zalo', bindController(loginByZalo, pool));
  router.get('/zalo/initiate', bindController(zaloInitiate, pool));
  router.get('/zalo/callback', bindController(zaloCallback, pool));
  router.get('/facebook/initiate', bindController(facebookInitiate, pool));
  router.get('/facebook/callback', bindController(facebookCallback, pool));
  router.post('/facebook/token', bindController(loginByFacebookToken, pool));
  router.get('/google/initiate', bindController(googleInitiate, pool));
  router.get('/google/callback', bindController(googleCallback, pool));
  router.post('/oauth/exchange', bindController(exchangeOAuthCodeHandler, pool));
  // ===== AUTHENTICATED ENDPOINTS =====
  router.get('/me', requireAuth, bindController(getMe, pool));
  router.post('/verify', requireAuth, bindController(verifyToken, pool));
  // Phone search is rate-limited per user/day to prevent enumeration (MVP audit #5).
  router.get(
    '/users/search',
    requireAuth,
    phoneSearchRateLimit(pool),
    bindController(searchUsers, pool)
  );

  return router;
}

module.exports = authRoutes;
