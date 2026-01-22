const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';

async function registerByEmail(pool, req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Missing email or password' });
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordHash = await bcrypt.hash(String(password), 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [normalizedEmail, passwordHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email already registered' });
    }

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(200).json({ ok: true, token, user });
  } catch (err) {
    console.error('Email register failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function loginByEmail(pool, req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Missing email or password' });
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const result = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(String(password), user.password_hash || '');
    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(200).json({ ok: true, token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Email login failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function getMe(pool, req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Missing token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, email, phone FROM users WHERE id = $1', [payload.id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'User not found' });
    }
    return res.status(200).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

module.exports = { registerByEmail, loginByEmail, getMe };
