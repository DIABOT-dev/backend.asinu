const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { registerSchema, loginSchema } = require('../validation/validation.schemas');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const GOOGLE_IOS_CLIENT_ID = process.env.GOOGLE_IOS_CLIENT_ID || '';
const ZALO_APP_ID = process.env.ZALO_APP_ID || '';
const ZALO_SECRET_KEY = process.env.ZALO_SECRET_KEY || '';

// Default missions for new users - CHỈ GIỮ NHỮNG MISSION CÓ THỂ HOÀN THÀNH
const DEFAULT_MISSIONS = [
  { mission_key: 'log_glucose', goal: 2 },      // Ghi đường huyết 2 lần/ngày
  { mission_key: 'log_bp', goal: 2 },           // Ghi huyết áp 2 lần/ngày
  { mission_key: 'log_weight', goal: 1 },       // Cân nặng 1 lần/ngày
  { mission_key: 'log_water', goal: 4 },        // Uống nước 4 lần/ngày
  { mission_key: 'log_meal', goal: 3 },         // Ghi bữa ăn 3 lần/ngày
  { mission_key: 'log_insulin', goal: 1 },      // Ghi insulin 1 lần/ngày
  { mission_key: 'log_medication', goal: 1 },   // Ghi thuốc 1 lần/ngày
  { mission_key: 'daily_checkin', goal: 1 }     // Check-in hàng ngày
];

async function initializeDefaultMissions(pool, userId) {
  try {
    const insertPromises = DEFAULT_MISSIONS.map(mission =>
      pool.query(
        `INSERT INTO user_missions (user_id, mission_key, status, progress, goal)
         VALUES ($1, $2, 'active', 0, $3)
         ON CONFLICT (user_id, mission_key) DO NOTHING`,
        [userId, mission.mission_key, mission.goal]
      )
    );
    await Promise.all(insertPromises);
    console.log(`[auth] Initialized ${DEFAULT_MISSIONS.length} default missions for user ${userId}`);
  } catch (err) {
    console.error('[auth] Failed to initialize default missions:', err);
    // Don't fail registration if missions fail
  }
}

function issueJwt(user) {
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  console.log(user)
  return { 
    ok: true, 
    token, 
    user: { 
      id: user.id, 
      email: user.email,
      phone: user.phone || user.phone_number || null,
      display_name: user.display_name || null,
      full_name: user.full_name || null
    } 
  };
}

function verifySocialToken(_provider, token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  // TODO: Add proper token verification for each provider
  // For now, accept any non-empty string token for development
  console.log(`[auth] Mock verification for ${_provider} with token: ${token.substring(0, 10)}...`);
  return true;
}

async function registerByEmail(pool, req, res) {
  // Validate request body with schema
  const parsed = registerSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
    return res.status(400).json({ ok: false, error: errorMessages });
  }

  const { email, phone_number, password, full_name, display_name } = parsed.data;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Normalize phone number (remove spaces, add +84 if needed)
    const normalizedPhone = phone_number.replace(/[\s\-()]/g, '');
    const finalPhone = normalizedPhone.startsWith('0') 
      ? '+84' + normalizedPhone.substring(1) 
      : normalizedPhone.startsWith('+') 
        ? normalizedPhone 
        : '+84' + normalizedPhone;

    const result = await pool.query(
      `INSERT INTO users (email, phone_number, password_hash, full_name, display_name, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 'EMAIL')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, phone_number, full_name, display_name`,
      [email, finalPhone, passwordHash, full_name || null, display_name || null]
    );

    if (result.rows.length === 0) {
      // Check if phone already exists
      const phoneCheck = await pool.query(
        'SELECT email FROM users WHERE phone_number = $1',
        [finalPhone]
      );
      if (phoneCheck.rows.length > 0) {
        return res.status(400).json({ ok: false, error: 'Số điện thoại đã được sử dụng' });
      }
      return res.status(400).json({ ok: false, error: 'Email đã được đăng ký' });
    }

    const user = result.rows[0];
    
    // Initialize default missions for new user
    await initializeDefaultMissions(pool, user.id);
    
    const response = issueJwt(user);
    return res.status(200).json(response);
  } catch (err) {
    console.error('Email register failed:', err);
    if (err.constraint === 'users_phone_number_key' || err.constraint === 'idx_users_phone_number') {
      return res.status(400).json({ ok: false, error: 'Số điện thoại đã được sử dụng' });
    }
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function loginByEmail(pool, req, res) {
  console.log('[auth.controller] loginByEmail called');
  console.log('[auth.controller] req.body:', req.body);
  console.log('[auth.controller] req.headers:', req.headers);
  
  // Validate request body with schema
  const parsed = loginSchema.safeParse(req.body || {});
  console.log('[auth.controller] Validation result:', parsed);
  
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map(issue => issue.message).join(', ');
    console.log('[auth.controller] Validation failed:', errorMessages);
    return res.status(400).json({ ok: false, error: errorMessages });
  }

  const { identifier, password } = parsed.data;
  console.log('[auth.controller] Parsed identifier:', identifier, 'password:', password ? '***' : 'MISSING');
  
  // Determine if identifier is email or phone
  const isEmail = identifier.includes('@');
  const isPhone = /^[\d+]/.test(identifier);

  try {
    let query;
    let queryParams;
    
    if (isEmail) {
      query = 'SELECT id, email, password_hash, phone, phone_number, display_name, full_name FROM users WHERE email = $1';
      queryParams = [identifier];
    } else if (isPhone) {
      // Normalize phone for search
      const normalizedPhone = identifier.replace(/[\s\-()]/g, '');
      const phoneVariants = [
        normalizedPhone,
        normalizedPhone.startsWith('0') ? '+84' + normalizedPhone.substring(1) : normalizedPhone,
        normalizedPhone.startsWith('84') ? '+' + normalizedPhone : normalizedPhone,
        normalizedPhone.startsWith('+84') ? normalizedPhone : '+84' + normalizedPhone
      ];
      query = 'SELECT id, email, password_hash, phone, phone_number, display_name, full_name FROM users WHERE phone_number = ANY($1::text[])';
      queryParams = [phoneVariants];
    } else {
      return res.status(401).json({ ok: false, error: 'Email hoặc số điện thoại không hợp lệ' });
    }

    const result = await pool.query(query, queryParams);

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Thông tin đăng nhập không đúng' });
    }

    const user = result.rows[0];
    console.log('[auth.controller] User from DB:', user);
    const isValid = await bcrypt.compare(password, user.password_hash || '');
    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Thông tin đăng nhập không đúng' });
    }

    const response = issueJwt(user);
    console.log('[auth.controller] Response to client:', response);
    return res.status(200).json(response);
  } catch (err) {
    console.error('Login failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getMe(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Thiếu token xác thực' });
  }

  try {
    const result = await pool.query('SELECT id, email, phone FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Không tìm thấy người dùng' });
    }
    return res.status(200).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token không hợp lệ' });
  }
}

async function loginByProvider(pool, req, res, provider, idColumn) {
  const { token, provider_id, email, phone_number } = req.body || {};
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Thiếu token xác thực' });
  }
  
  // Generate provider_id if not provided (for development)
  let actualProviderId = provider_id;
  if (!actualProviderId && email) {
    actualProviderId = `${provider}_${email}`;
    console.log(`[auth] Generated provider_id: ${actualProviderId}`);
  }
  
  if (!actualProviderId) {
    return res.status(400).json({ ok: false, error: 'Thiếu provider_id hoặc email' });
  }
  
  if (!verifySocialToken(provider, token)) {
    return res.status(401).json({ ok: false, error: 'Token không hợp lệ' });
  }

  try {
    const existing = await pool.query(
      `SELECT id, email, phone, phone_number, display_name FROM users WHERE ${idColumn} = $1`,
      [actualProviderId]
    );
    if (existing.rows.length > 0) {
      const response = issueJwt(existing.rows[0]);
      console.log(`[auth] Existing ${provider} user logged in:`, response.user.email);
      return res.status(200).json(response);
    }

    const insert = await pool.query(
      `INSERT INTO users (${idColumn}, email, phone_number, auth_provider)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, phone, phone_number, display_name`,
      [actualProviderId, email || null, phone_number || null, provider.toUpperCase()]
    );
    
    // Initialize default missions for new social login user
    await initializeDefaultMissions(pool, insert.rows[0].id);
    
    const response = issueJwt(insert.rows[0]);
    console.log(`[auth] New ${provider} user created:`, response.user.email);
    return res.status(200).json(response);
  } catch (err) {
    console.error(`Social login failed (${provider}):`, err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
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
    return res.status(400).json({ ok: false, error: 'Thiếu số điện thoại' });
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
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
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
