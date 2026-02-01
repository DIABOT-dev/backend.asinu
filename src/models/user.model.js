/**
 * User Model
 * Defines the User schema and validation rules
 */

const { z } = require('zod');

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
  .min(10, 'Số điện thoại phải có ít nhất 10 số')
  .max(15, 'Số điện thoại không hợp lệ')
  .regex(/^[0-9+\-\s()]+$/, 'Số điện thoại chỉ được chứa số và ký tự +, -, (), khoảng trắng')
  .transform(val => val.replace(/[\s\-()]/g, '')) // Remove spaces, dashes, parentheses
  .refine(val => /^(\+84|84|0)[0-9]{9,10}$/.test(val), {
    message: 'Số điện thoại phải bắt đầu bằng 0, 84 hoặc +84 và có 10-11 số'
  });

// Email validation
const emailSchema = z
  .string()
  .min(1, 'Email không được để trống')
  .email('Email không hợp lệ')
  .toLowerCase()
  .trim();

// Password validation
const passwordSchema = z
  .string()
  .min(8, 'Mật khẩu phải có ít nhất 8 ký tự')
  .regex(/[A-Z]/, 'Mật khẩu phải có ít nhất 1 chữ hoa')
  .regex(/[a-z]/, 'Mật khẩu phải có ít nhất 1 chữ thường')
  .regex(/[0-9]/, 'Mật khẩu phải có ít nhất 1 chữ số')
  .regex(/[^A-Za-z0-9]/, 'Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$%^&*...)');

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
  full_name: z.string().min(1, 'Tên không được để trống').max(255).optional(),
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
  message: 'Phải có ít nhất một trường để cập nhật'
});

/**
 * Login Schema - For authentication
 * Accepts either email or phone_number + password
 */
const UserLoginSchema = z.object({
  identifier: z.string().min(1, 'Email hoặc số điện thoại không được để trống'),
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
