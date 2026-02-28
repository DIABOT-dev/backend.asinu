/**
 * User Model
 * Defines the User schema and validation rules
 */

const { z } = require('zod');
const { t } = require('../i18n');

// =====================================================
// ENUMS
// =====================================================

const AuthProvider = {
  EMAIL: 'EMAIL',
  GOOGLE: 'GOOGLE',
  APPLE: 'APPLE',
  PHONE: 'PHONE',
  ZALO: 'ZALO'
};

// =====================================================
// VALIDATION SCHEMAS
// =====================================================

// Phone number validation (Vietnamese format)
const phoneSchema = z
  .string()
  .min(10, t('validation.phone_min'))
  .max(15, t('validation.phone_invalid'))
  .regex(/^[0-9+\-\s()]+$/, t('validation.phone_chars'))
  .transform(val => val.replace(/[\s\-()]/g, '')) // Remove spaces, dashes, parentheses
  .refine(val => /^(\+84|84|0)[0-9]{9,10}$/.test(val), {
    message: t('validation.phone_format')
  });

// Email validation
const emailSchema = z
  .string()
  .min(1, t('validation.email_required'))
  .email(t('validation.email_invalid'))
  .toLowerCase()
  .trim();

// Password validation
const passwordSchema = z
  .string()
  .min(8, t('validation.password_min'))
  .regex(/[A-Z]/, t('validation.password_uppercase'))
  .regex(/[a-z]/, t('validation.password_lowercase'))
  .regex(/[0-9]/, t('validation.password_digit'))
  .regex(/[^A-Za-z0-9]/, t('validation.password_special'));

// =====================================================
// USER SCHEMA
// =====================================================

/**
 * User Schema - Matches database table structure
 */
const UserSchema = z.object({
  id: z.number().int().positive(),
  phone: z.string().nullable().optional(), // Legacy field
  phone_number: z.string().nullable().optional(), // Preferred field
  google_id: z.string().nullable().optional(),
  apple_id: z.string().nullable().optional(),
  zalo_id: z.string().nullable().optional(),
  auth_provider: z.enum(['EMAIL', 'GOOGLE', 'APPLE', 'PHONE', 'ZALO']).default('EMAIL'),
  email: z.string().nullable().optional(),
  password_hash: z.string().nullable().optional(),
  full_name: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
  created_at: z.date().optional(),
  deleted_at: z.date().nullable().optional(),
  token_version: z.number().int().default(0),
  push_token: z.string().nullable().optional()
});

/**
 * User Create Schema - For registration
 * Requires email, phone, and password
 */
const UserCreateSchema = z.object({
  email: emailSchema,
  phone_number: phoneSchema,
  password: passwordSchema,
  full_name: z.string().min(1, t('validation.name_required')).max(255).optional(),
  display_name: z.string().max(255).optional()
});

/**
 * User Update Schema - For profile updates
 */
const UserUpdateSchema = z.object({
  email: emailSchema.optional(),
  phone_number: phoneSchema.optional(),
  full_name: z.string().min(1).max(255).optional(),
  display_name: z.string().max(255).optional(),
  avatar_url: z.string().url().optional()
}).refine(data => Object.keys(data).length > 0, {
  message: t('validation.update_required')
});

/**
 * Login Schema - For authentication
 * Accepts either email or phone_number + password
 */
const UserLoginSchema = z.object({
  identifier: z.string().min(1, t('validation.identifier_required')),
  password: passwordSchema
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Determine if identifier is email or phone
 * @param {string} identifier - Email or phone number
 * @returns {'email'|'phone'} - Type of identifier
 */
function identifyLoginType(identifier) {
  // Check if it looks like an email
  if (identifier.includes('@')) {
    return 'email';
  }
  
  // Check if it's a phone number (starts with +, 0, or digits only)
  if (/^[\d+]/.test(identifier)) {
    return 'phone';
  }
  
  // Default to email for safety
  return 'email';
}

/**
 * Normalize phone number to consistent format
 * @param {string} phone - Phone number
 * @returns {string} - Normalized phone (+84xxxxxxxxx)
 */
function normalizePhone(phone) {
  // Remove all non-digit characters except +
  const cleaned = phone.replace(/[^\d+]/g, '');
  
  // If starts with 0, replace with +84
  if (cleaned.startsWith('0')) {
    return '+84' + cleaned.substring(1);
  }
  
  // If starts with 84, add +
  if (cleaned.startsWith('84')) {
    return '+' + cleaned;
  }
  
  // If already starts with +84, return as is
  if (cleaned.startsWith('+84')) {
    return cleaned;
  }
  
  // Otherwise, assume Vietnam and add +84
  return '+84' + cleaned;
}

/**
 * Sanitize user object for API response (remove sensitive fields)
 * @param {Object} user - User object from database
 * @returns {Object} - Sanitized user object
 */
function sanitizeUser(user) {
  const { password_hash, token_version, deleted_at, ...safeUser } = user;
  return safeUser;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  AuthProvider,
  
  // Schemas
  UserSchema,
  UserCreateSchema,
  UserUpdateSchema,
  UserLoginSchema,
  
  // Field Validators
  phoneSchema,
  emailSchema,
  passwordSchema,
  
  // Helper Functions
  identifyLoginType,
  normalizePhone,
  sanitizeUser
};
