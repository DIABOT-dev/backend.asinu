/**
 * Chat Models
 * Defines schemas for chat messages and conversations
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const ChatRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system'
};

const ChatProvider = {
  DIABRAIN: 'diabrain',
  OPENAI: 'openai',
  GEMINI: 'gemini'
};

// =====================================================
// SCHEMAS
// =====================================================

const ChatHistorySchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  user_message: z.string(),
  assistant_message: z.string(),
  context: z.record(z.any()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  created_at: z.date().optional()
});

const ChatHistoryCreateSchema = z.object({
  user_id: z.number().int().positive(),
  user_message: z.string().min(1).max(2000),
  assistant_message: z.string(),
  context: z.record(z.any()).optional(),
  provider: z.string().optional(),
  model: z.string().optional()
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  context: z.record(z.any()).optional(),
  client_ts: z.number().optional()
});

// Legacy chat logs (for compatibility)
const ChatLogSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  user_message: z.string(),
  assistant_message: z.string(),
  created_at: z.date().optional()
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Format chat message for display
 */
function formatChatMessage(role, content, timestamp) {
  return {
    role,
    content,
    timestamp: timestamp || new Date()
  };
}

/**
 * Extract context from user profile
 */
function extractUserContext(profile) {
  return {
    age: profile.age,
    gender: profile.gender,
    medical_conditions: profile.medical_conditions,
    current_medications: profile.medications
  };
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  ChatRole,
  ChatProvider,
  
  // Schemas
  ChatHistorySchema,
  ChatHistoryCreateSchema,
  ChatRequestSchema,
  ChatLogSchema,
  
  // Helper Functions
  formatChatMessage,
  extractUserContext
};
