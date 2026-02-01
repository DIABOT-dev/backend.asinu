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

  // Search users endpoint - for care circle invitations
  router.get('/users/search', requireAuth, async (req, res) => {
    try {
      const { q } = req.query;
      
      let result;
      if (!q || q.length < 2) {
        // Return all users (limited) when no query or query too short
        result = await pool.query(
          `SELECT id, email, phone, display_name, created_at 
           FROM users 
           WHERE deleted_at IS NULL 
             AND id != $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        );
      } else {
        // Search with query
        const searchTerm = `%${q.toLowerCase()}%`;
        result = await pool.query(
          `SELECT id, email, phone, display_name, created_at 
           FROM users 
           WHERE deleted_at IS NULL 
             AND id != $1
             AND (
               LOWER(email) LIKE $2 
               OR LOWER(display_name) LIKE $2 
               OR phone LIKE $2
             )
           ORDER BY created_at DESC
           LIMIT 20`,
          [req.user.id, searchTerm]
        );
      }

      const users = result.rows.map(user => ({
        id: String(user.id),
        name: user.display_name || (user.email ? user.email.split('@')[0] : `User ${user.id}`),
        email: user.email || null,
        phone: user.phone || null
      }));

      return res.status(200).json({ ok: true, users });
    } catch (err) {
      console.error('search users failed:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

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

  return router;
}

module.exports = authRoutes;
