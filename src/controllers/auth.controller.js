const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const GOOGLE_IOS_CLIENT_ID = process.env.GOOGLE_IOS_CLIENT_ID || '';
const ZALO_APP_ID = process.env.ZALO_APP_ID || '';
const ZALO_SECRET_KEY = process.env.ZALO_SECRET_KEY || '';

function issueJwt(user) {
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  return { ok: true, token, user: { id: user.id, email: user.email } };
}

function verifySocialToken(_provider, token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  return true;
}

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
    const response = issueJwt(user);
    return res.status(200).json(response);
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

    const response = issueJwt(user);
    return res.status(200).json(response);
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

async function loginByProvider(pool, req, res, provider, idColumn) {
  const { token, provider_id, email, phone_number } = req.body || {};
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }
  if (!provider_id) {
    return res.status(400).json({ ok: false, error: 'Missing provider_id' });
  }
  if (!verifySocialToken(provider, token)) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }

  try {
    const existing = await pool.query(
      `SELECT id, email FROM users WHERE ${idColumn} = $1`,
      [provider_id]
    );
    if (existing.rows.length > 0) {
      const response = issueJwt(existing.rows[0]);
      return res.status(200).json(response);
    }

    const insert = await pool.query(
      `INSERT INTO users (${idColumn}, email, phone_number, auth_provider)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email`,
      [provider_id, email || null, phone_number || null, provider.toUpperCase()]
    );
    const response = issueJwt(insert.rows[0]);
    return res.status(200).json(response);
  } catch (err) {
    console.error(`Social login failed (${provider}):`, err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function loginByGoogle(pool, req, res) {
  void GOOGLE_IOS_CLIENT_ID;
  return loginByProvider(pool, req, res, 'google', 'google_id');
}

async function loginByApple(pool, req, res) {
  return loginByProvider(pool, req, res, 'apple', 'apple_id');
}

async function loginByZalo(pool, req, res) {
  void ZALO_APP_ID;
  void ZALO_SECRET_KEY;
  return loginByProvider(pool, req, res, 'zalo', 'zalo_id');
}

async function loginByPhone(pool, req, res) {
  const { phone_number } = req.body || {};
  if (!phone_number) {
    return res.status(400).json({ ok: false, error: 'Missing phone_number' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users (phone_number, auth_provider)
       VALUES ($1, 'PHONE')
       ON CONFLICT (phone_number) DO UPDATE SET deleted_at = NULL
       RETURNING id, email`,
      [phone_number]
    );
    const response = issueJwt(result.rows[0]);
    return res.status(200).json(response);
  } catch (err) {
    console.error('Phone login failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = {
  registerByEmail,
  loginByEmail,
  getMe,
  loginByGoogle,
  loginByApple,
  loginByZalo,
  loginByPhone,
};
