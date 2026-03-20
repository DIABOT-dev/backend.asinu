/**
 * Auth Service
 * Business logic cho authentication
 * - JWT token issuing
 * - Password hashing/verification
 * - Social auth token verification
 * - User creation/lookup
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { t } = require('../../i18n');

// =====================================================
// CONSTANTS
// =====================================================

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[FATAL] JWT_SECRET environment variable is not set. Server cannot start.');
}
const JWT_EXPIRES_IN = '30d';

// =====================================================
// JWT OPERATIONS
// =====================================================

/**
 * Issue JWT token for authenticated user
 * @param {Object} user - User object with id and email
 * @returns {Object} - { ok: true, token, user }
 */
function issueJwt(user) {
  const token = jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email }
  };
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object|null} - Decoded payload or null if invalid
 */
function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// =====================================================
// PASSWORD OPERATIONS
// =====================================================

/**
 * Hash password with bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password
 */
async function hashPassword(password) {
  return bcrypt.hash(String(password), 12);
}

/**
 * Compare password with hash
 * @param {string} password - Plain text password
 * @param {string} hash - Stored hash
 * @returns {Promise<boolean>} - Match result
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(String(password), hash || '');
}

// =====================================================
// SOCIAL AUTH VERIFICATION
// =====================================================

/**
 * Verify social auth token with the provider's API
 * @param {string} provider - Auth provider (google, apple, zalo)
 * @param {string} token - Provider access token
 * @returns {Promise<{valid: boolean, profile?: {email?: string, name?: string, sub?: string}}>}
 */
async function verifySocialToken(provider, token) {
  if (!token || typeof token !== 'string') {
    return { valid: false };
  }

  try {
    if (provider === 'google') {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {

        return { valid: false };
      }
      const data = await res.json();
      if (!data.id && !data.email) {
        return { valid: false };
      }

      return { valid: true, profile: { email: data.email, name: data.name, sub: data.id } };
    }

    if (provider === 'apple') {
      // Apple sends identityToken (JWT signed by Apple)
      // Decode header to get kid, fetch Apple's public keys, verify signature
      try {
        const crypto = require('crypto');

        // 1. Decode JWT header to get kid
        const [headerB64] = token.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
        const kid = header.kid;
        if (!kid) return { valid: false };

        // 2. Fetch Apple's public keys
        const keysRes = await fetch('https://appleid.apple.com/auth/keys');
        if (!keysRes.ok) {
          console.error('[Apple Auth] Failed to fetch Apple keys');
          return { valid: false };
        }
        const { keys } = await keysRes.json();
        const appleKey = keys.find(k => k.kid === kid);
        if (!appleKey) {
          console.error('[Apple Auth] No matching key for kid:', kid);
          return { valid: false };
        }

        // 3. Convert JWK to PEM
        const keyObject = crypto.createPublicKey({ key: appleKey, format: 'jwk' });
        const pem = keyObject.export({ type: 'spki', format: 'pem' });

        // 4. Verify JWT
        const decoded = jwt.verify(token, pem, {
          algorithms: ['RS256'],
          issuer: 'https://appleid.apple.com',
          audience: process.env.APPLE_BUNDLE_ID || 'com.asinu.lite',
        });

        return {
          valid: true,
          profile: {
            email: decoded.email || undefined,
            sub: decoded.sub,
          }
        };
      } catch (appleErr) {
        console.error('[Apple Auth] Token verification failed:', appleErr.message);
        return { valid: false };
      }
    }

    if (provider === 'zalo') {
      const res = await fetch(`https://graph.zalo.me/v2.0/me?fields=id,name,picture`, {
        headers: { access_token: token }
      });
      if (!res.ok) {

        return { valid: false };
      }
      const data = await res.json();
      if (!data.id) {
        return { valid: false };
      }

      return { valid: true, profile: { sub: data.id, name: data.name } };
    }

    // Other providers: accept if non-empty

    return { valid: true };
  } catch (err) {

    return { valid: false };
  }
}

/**
 * Generate provider_id from email if not provided
 * @param {string} provider - Auth provider
 * @param {string|null} providerId - Existing provider ID
 * @param {string|null} email - User email
 * @returns {string|null} - Provider ID
 */
function generateProviderId(provider, providerId, email) {
  if (providerId) return providerId;
  if (email) {
    const generated = `${provider}_${email}`;

    return generated;
  }
  return null;
}

// =====================================================
// USER OPERATIONS
// =====================================================

/**
 * Find user by email
 * @param {Object} pool - Database pool
 * @param {string} email - User email
 * @returns {Promise<Object|null>} - User or null
 */
async function findUserByEmail(pool, email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const result = await pool.query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [normalizedEmail]
  );
  return result.rows[0] || null;
}

/**
 * Find user by ID
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - User or null
 */
async function findUserById(pool, userId) {
  const result = await pool.query(
    'SELECT id, email, phone_number FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Find user by social provider ID
 * @param {Object} pool - Database pool
 * @param {string} idColumn - Column name (google_id, apple_id, zalo_id)
 * @param {string} providerId - Provider ID value
 * @returns {Promise<Object|null>} - User or null
 */
async function findUserByProviderId(pool, idColumn, providerId) {
  const result = await pool.query(
    `SELECT id, email FROM users WHERE ${idColumn} = $1`,
    [providerId]
  );
  return result.rows[0] || null;
}

/**
 * Create user with email/password
 * @param {Object} pool - Database pool
 * @param {string} email - User email
 * @param {string} passwordHash - Hashed password
 * @returns {Promise<Object|null>} - Created user or null if exists
 */
async function createUserWithEmail(pool, email, passwordHash) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const result = await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    [normalizedEmail, passwordHash]
  );
  return result.rows[0] || null;
}

/**
 * Create user with social provider
 * @param {Object} pool - Database pool
 * @param {string} idColumn - Column name for provider ID
 * @param {string} providerId - Provider ID value
 * @param {string} provider - Provider name (GOOGLE, APPLE, ZALO)
 * @param {string|null} email - User email
 * @param {string|null} phoneNumber - User phone
 * @returns {Promise<Object>} - Created user
 */
async function createUserWithProvider(pool, idColumn, providerId, provider, email, phoneNumber) {
  const result = await pool.query(
    `INSERT INTO users (${idColumn}, email, phone_number, auth_provider)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email`,
    [providerId, email || null, phoneNumber || null, provider.toUpperCase()]
  );
  return result.rows[0];
}

/**
 * Create or update user with phone number
 * @param {Object} pool - Database pool
 * @param {string} phoneNumber - Phone number
 * @returns {Promise<Object>} - User
 */
async function createOrUpdateUserWithPhone(pool, phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);
  const variants = getPhoneVariants(normalized);

  // Find existing user across both phone columns
  const existing = await pool.query(
    `SELECT id, email FROM users
     WHERE phone_number = ANY($1::text[])
       AND deleted_at IS NULL
     LIMIT 1`,
    [variants]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO users (phone_number, auth_provider)
     VALUES ($1, 'PHONE')
     RETURNING id, email`,
    [normalized]
  );
  return result.rows[0];
}

// =====================================================
// MISSION INITIALIZATION
// =====================================================

const DEFAULT_MISSIONS = [
  { mission_key: 'log_glucose', goal: 2 },
  { mission_key: 'log_bp', goal: 2 },
  { mission_key: 'log_weight', goal: 1 },
  { mission_key: 'log_water', goal: 4 },
  { mission_key: 'log_meal', goal: 3 },
  { mission_key: 'log_insulin', goal: 1 },
  { mission_key: 'log_medication', goal: 1 },
  { mission_key: 'daily_checkin', goal: 1 }
];

/**
 * Initialize default missions for new user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<void>}
 */
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

  } catch (err) {

  }
}

// =====================================================
// PHONE NORMALIZATION
// =====================================================

/**
 * Normalize phone number to +84 format
 * @param {string} phoneNumber - Raw phone number
 * @returns {string} - Normalized phone number
 */
function normalizePhoneNumber(phoneNumber) {
  const cleaned = phoneNumber.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('0')) {
    return cleaned; // 0984532246 → 0984532246
  }
  if (cleaned.startsWith('+84')) {
    return '0' + cleaned.substring(3); // +84984532246 → 0984532246
  }
  if (cleaned.startsWith('84') && cleaned.length >= 11) {
    return '0' + cleaned.substring(2); // 84984532246 → 0984532246
  }
  return cleaned;
}

/**
 * Get phone variants for search (handles different formats)
 * @param {string} phoneNumber - Raw phone number
 * @returns {string[]} - Array of phone variants
 */
function getPhoneVariants(phoneNumber) {
  const normalized = phoneNumber.replace(/[\s\-()]/g, '');
  return [
    normalized,
    normalized.startsWith('0') ? '+84' + normalized.substring(1) : normalized,
    normalized.startsWith('84') ? '+' + normalized : normalized,
    normalized.startsWith('+84') ? normalized : '+84' + normalized
  ];
}

// =====================================================
// REGISTER/LOGIN OPERATIONS
// =====================================================

/**
 * Register user by email with validation
 * @param {Object} pool - Database pool
 * @param {string} email - User email
 * @param {string} password - Plain text password
 * @param {string|null} phoneNumber - Phone number
 * @param {string|null} fullName - Full name
 * @param {string|null} displayName - Display name
 * @returns {Promise<Object>} - { ok, token, user, error }
 */
async function registerByEmail(pool, email, password, phoneNumber, fullName, displayName) {
  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    
    // Check if email exists
    const existingEmail = await findUserByEmail(pool, normalizedEmail);
    if (existingEmail) {
      return { ok: false, error: t('auth.email_already_registered') };
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    // Normalize phone if provided
    let finalPhone = null;
    if (phoneNumber) {
      finalPhone = normalizePhoneNumber(phoneNumber);
      // Check both phone columns with all format variants
      const phoneCheck = await pool.query(
        `SELECT id FROM users
         WHERE phone_number = ANY($1::text[])
           AND deleted_at IS NULL`,
        [getPhoneVariants(finalPhone)]
      );
      if (phoneCheck.rows.length > 0) {
        return { ok: false, error: t('auth.phone_already_used') };
      }
    }
    
    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, phone_number, password_hash, full_name, display_name, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 'EMAIL')
       RETURNING id, email, phone_number, full_name, display_name`,
      [normalizedEmail, finalPhone, passwordHash, fullName || null, displayName || null]
    );
    
    const user = result.rows[0];
    
    // Initialize default missions
    await initializeDefaultMissions(pool, user.id);
    
    const token_response = issueJwt(user);
    return { 
      ok: true, 
      token: token_response.token, 
      user: token_response.user 
    };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Login user by email or phone
 * @param {Object} pool - Database pool
 * @param {string} identifier - Email or phone number
 * @param {string} password - Plain text password
 * @returns {Promise<Object>} - { ok, token, user, error }
 */
async function loginByEmail(pool, identifier, password) {
  try {
    const isEmail = identifier.includes('@');
    let user;
    
    if (isEmail) {
      const normalizedEmail = String(identifier).trim().toLowerCase();
      user = await findUserByEmail(pool, normalizedEmail);
    } else {
      // Search by phone variants
      const variants = getPhoneVariants(identifier);
      const result = await pool.query(
        'SELECT id, email, password_hash, phone_number, display_name, full_name FROM users WHERE phone_number = ANY($1::text[])',
        [variants]
      );
      user = result.rows[0];
    }
    
    if (!user) {
      return { ok: false, error: t('auth.invalid_credentials') };
    }
    
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return { ok: false, error: t('auth.invalid_credentials') };
    }
    
    const token_response = issueJwt(user);
    return { 
      ok: true, 
      token: token_response.token, 
      user: token_response.user 
    };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Login by social provider
 * @param {Object} pool - Database pool
 * @param {string} idColumn - Column name (google_id, apple_id, zalo_id)
 * @param {string} providerId - Provider ID
 * @param {string} provider - Provider name
 * @param {string|null} email - Email from provider
 * @param {string|null} phoneNumber - Phone from provider
 * @returns {Promise<Object>} - { ok, token, user, error }
 */
async function loginByProvider(pool, idColumn, providerId, provider, email, phoneNumber) {
  try {
    // Check if user exists with this provider
    const existing = await findUserByProviderId(pool, idColumn, providerId);
    if (existing) {
      const token_response = issueJwt(existing);
      return {
        ok: true,
        token: token_response.token,
        user: token_response.user
      };
    }

    // If email provided, check if already registered via email/password
    if (email) {
      const emailUser = await pool.query(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [String(email).trim().toLowerCase()]
      );
      if (emailUser.rows.length > 0 && emailUser.rows[0].password_hash) {
        return { ok: false, error: t('auth.email_registered_with_password'), statusCode: 409 };
      }
      // If exists without password (another social), link provider to that account
      if (emailUser.rows.length > 0) {
        const linkedUser = emailUser.rows[0];
        await pool.query(`UPDATE users SET ${idColumn} = $1 WHERE id = $2`, [providerId, linkedUser.id]);
        const token_response = issueJwt(linkedUser);
        return { ok: true, token: token_response.token, user: token_response.user };
      }
    }

    // Create new user
    const newUser = await createUserWithProvider(pool, idColumn, providerId, provider, email, phoneNumber);
    
    // Initialize default missions
    await initializeDefaultMissions(pool, newUser.id);
    
    const token_response = issueJwt(newUser);
    return { 
      ok: true, 
      token: token_response.token, 
      user: token_response.user 
    };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Login by phone only
 * @param {Object} pool - Database pool
 * @param {string} phoneNumber - Phone number
 * @returns {Promise<Object>} - { ok, token, user, error }
 */
async function loginByPhone(pool, phoneNumber) {
  try {
    const user = await createOrUpdateUserWithPhone(pool, phoneNumber);
    const token_response = issueJwt(user);
    return { 
      ok: true, 
      token: token_response.token, 
      user: token_response.user 
    };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Get current user profile
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - User or null
 */
async function getCurrentUser(pool, userId) {
  const user = await findUserById(pool, userId);
  if (!user) {
    return null;
  }
  return {
    id: String(user.id),
    email: user.email || null,
    phone: user.phone_number || null
  };
}

/**
 * Search users by query
 * @param {Object} pool - Database pool
 * @param {number} currentUserId - Current user ID
 * @param {string|null} query - Search query
 * @returns {Promise<Object[]>} - Array of users
 */
async function searchUsers(pool, currentUserId, query) {
  try {
    // Require at least 3 digits to search - phone number only for privacy
    const phone = (query || '').trim().replace(/[\s\-()]/g, '');
    if (phone.length < 3) {
      return [];
    }

    const result = await pool.query(
      `SELECT id, email, phone_number, display_name, full_name, created_at
       FROM users
       WHERE deleted_at IS NULL
         AND id != $1
         AND REPLACE(REPLACE(COALESCE(phone_number, ''), ' ', ''), '-', '') LIKE $2
       ORDER BY created_at DESC
       LIMIT 10`,
      [currentUserId, `%${phone}%`]
    );

    return result.rows.map(user => ({
      id: String(user.id),
      name: user.display_name || user.full_name || (user.email ? user.email.split('@')[0] : `User ${user.id}`),
      email: null, // Ẩn email vì lý do bảo mật - chỉ tìm bằng SĐT
      phone: user.phone_number || null
    }));
  } catch (err) {

    return [];
  }
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // JWT
  issueJwt,
  verifyJwt,
  
  // Password
  hashPassword,
  comparePassword,
  
  // Social auth
  verifySocialToken,
  generateProviderId,
  
  // User operations
  findUserByEmail,
  findUserById,
  findUserByProviderId,
  createUserWithEmail,
  createUserWithProvider,
  createOrUpdateUserWithPhone,
  
  // Phone utilities
  normalizePhoneNumber,
  getPhoneVariants,
  
  // Register/Login
  registerByEmail,
  loginByEmail,
  loginByProvider,
  loginByPhone,
  getCurrentUser,
  searchUsers,
  
  // Missions
  initializeDefaultMissions,
};
