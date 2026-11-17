'use strict';

const { createHash } = require('node:crypto');
const { z } = require('zod');
const { scales } = require('./app-actions.schema');

const requestSchema = z.object({
  text: z.string().trim().min(1).max(3000),
  current: z.object({ language: z.enum(['vi', 'en']), fontSize: z.enum(scales) }).strict(),
  clarification: z.object({ original: z.string().max(6000), question: z.string().max(2000) }).strict().optional(),
  hiddenArticles: z.array(z.string().max(100)).max(100).optional(),
  allowCuratedArticles: z.boolean().optional(),
  conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }).strict()).max(10).optional(),
}).strict();

function canonicalRequest(input) {
  const request = requestSchema.parse(input);
  return {
    text: request.text.trim(),
    current: { language: request.current.language, fontSize: request.current.fontSize },
    hiddenArticles: [...new Set(request.hiddenArticles || [])].sort(),
    allowCuratedArticles: request.allowCuratedArticles !== false,
  };
}

const fingerprint = input => createHash('sha256').update(JSON.stringify(canonicalRequest(input))).digest('hex');

module.exports = { requestSchema, canonicalRequest, fingerprint };
