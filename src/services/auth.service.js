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
};
