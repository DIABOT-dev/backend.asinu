'use strict';
const { z } = require('zod');
const onboardingAiInputSchema = z.object({
  language: z.enum(['vi', 'en']).default('vi'),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(2000),
  }).strict()).max(24).default([]),
}).strict().refine(input => input.messages.reduce((total, message) => total + message.content.length, 0) <= 16000,
  'Conversation is too long.');
module.exports = { onboardingAiInputSchema };
