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
const { requireAuth } = require('../middleware/auth.middleware');

function authRoutes(pool) {
  const router = express.Router();

  router.post('/email/register', (req, res) => registerByEmail(pool, req, res));
  router.post('/email/login', (req, res) => loginByEmail(pool, req, res));
  router.post('/google', (req, res) => loginByGoogle(pool, req, res));
  router.post('/apple', (req, res) => loginByApple(pool, req, res));
  router.post('/zalo', (req, res) => loginByZalo(pool, req, res));
  router.post('/phone-login', (req, res) => loginByPhone(pool, req, res));
  router.get('/me', requireAuth, (req, res) => getMe(pool, req, res));

  // Verify token endpoint
  router.post('/verify', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, email, phone FROM users WHERE id = $1',
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ ok: false, error: 'User not found' });
      }
      const user = result.rows[0];
      return res.status(200).json({
        ok: true,
        token: req.headers.authorization?.replace('Bearer ', ''),
        profile: {
          id: String(user.id),
          name: user.email ? user.email.split('@')[0] : `User ${user.id}`,
          email: user.email || null,
          phone: user.phone || null
        }
      });
    } catch (err) {
      console.error('verify failed:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  // Delete account endpoint
  router.delete('/me', requireAuth, async (req, res) => {
    try {
      await pool.query(
        'UPDATE users SET deleted_at = NOW() WHERE id = $1',
        [req.user.id]
      );
      return res.status(200).json({ ok: true, message: 'Account deleted' });
    } catch (err) {
      console.error('delete account failed:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  return router;
}

module.exports = authRoutes;
