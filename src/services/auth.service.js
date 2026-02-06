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

// =====================================================
// CONSTANTS
// =====================================================

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
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
 * Verify social auth token (mock for development)
 * TODO: Implement real verification for each provider
 * @param {string} provider - Auth provider (google, apple, zalo)
 * @param {string} token - Provider token
 * @returns {boolean} - Verification result
 */
function verifySocialToken(provider, token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  
  // TODO: Add proper token verification for each provider
  // For now, accept any non-empty string token for development
  console.log(`[auth.service] Mock verification for ${provider} with token: ${token.substring(0, 10)}...`);
  return true;
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
    console.log(`[auth.service] Generated provider_id: ${generated}`);
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
    'SELECT id, email, phone FROM users WHERE id = $1',
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
  const result = await pool.query(
    `INSERT INTO users (phone_number, auth_provider)
     VALUES ($1, 'PHONE')
     ON CONFLICT (phone_number) DO UPDATE SET deleted_at = NULL
     RETURNING id, email`,
    [phoneNumber]
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
    console.log(`[auth.service] Initialized ${DEFAULT_MISSIONS.length} default missions for user ${userId}`);
  } catch (err) {
    console.error('[auth.service] Failed to initialize default missions:', err);
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
    return '+84' + cleaned.substring(1);
  }
  if (cleaned.startsWith('+84')) {
    return cleaned;
  }
  if (cleaned.startsWith('84')) {
    return '+' + cleaned;
  }
  return '+84' + cleaned;
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
      return { ok: false, error: 'Email đã được đăng ký' };
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    // Normalize phone if provided
    let finalPhone = null;
    if (phoneNumber) {
      finalPhone = normalizePhoneNumber(phoneNumber);
      // Check if phone exists
      const phoneCheck = await pool.query(
        'SELECT id FROM users WHERE phone_number = $1',
        [finalPhone]
      );
      if (phoneCheck.rows.length > 0) {
        return { ok: false, error: 'Số điện thoại đã được sử dụng' };
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
    console.error('[auth.service] Register failed:', err);
    return { ok: false, error: 'Lỗi server' };
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
        'SELECT id, email, password_hash, phone, phone_number, display_name, full_name FROM users WHERE phone_number = ANY($1::text[])',
        [variants]
      );
      user = result.rows[0];
    }
    
    if (!user) {
      return { ok: false, error: 'Thông tin đăng nhập không đúng' };
    }
    
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return { ok: false, error: 'Thông tin đăng nhập không đúng' };
    }
    
    const token_response = issueJwt(user);
    return { 
      ok: true, 
      token: token_response.token, 
      user: token_response.user 
    };
  } catch (err) {
    console.error('[auth.service] Login failed:', err);
    return { ok: false, error: 'Lỗi server' };
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
    console.error(`[auth.service] Login by ${provider} failed:`, err);
    return { ok: false, error: 'Lỗi server' };
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
    console.error('[auth.service] Phone login failed:', err);
    return { ok: false, error: 'Lỗi server' };
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
    phone: user.phone || null
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
    let result;
    
    if (!query || query.length < 2) {
      // Return all users (limited) when no query or query too short
      result = await pool.query(
        `SELECT id, email, phone, display_name, created_at 
         FROM users 
         WHERE deleted_at IS NULL 
           AND id != $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [currentUserId]
      );
    } else {
      // Search with query
      const searchTerm = `%${query.toLowerCase()}%`;
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
        [currentUserId, searchTerm]
      );
    }
    
    return result.rows.map(user => ({
      id: String(user.id),
      name: user.display_name || (user.email ? user.email.split('@')[0] : `User ${user.id}`),
      email: user.email || null,
      phone: user.phone || null
    }));
  } catch (err) {
    console.error('[auth.service] Search users failed:', err);
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
