'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const AI_CONSENT_VERSION = '2026-10-16.v3';
const AI_PROVIDERS = ['openai', 'google', 'dr7', 'diabrain', 'vieneu'];
// Deploy the receipt endpoints before enforcing a new contract on installed
// mobile builds. Accounts that already have a receipt always honor revocation.
const aiConsentEnforced = () => process.env.AI_CONSENT_ENFORCEMENT === 'true';

const consentError = () => Object.assign(new Error('AI data consent is required.'), {
  code: 'AI_CONSENT_REQUIRED', statusCode: 403,
});

async function hasAiConsent(pool, userId) {
  if (!pool?.query || !userId) return false;
  const result = await pool.query(
    `SELECT 1 FROM user_ai_consents c JOIN users u ON u.id = c.user_id
      WHERE c.user_id = $1 AND c.version = $2 AND c.revoked_at IS NULL
        AND c.providers @> $3::jsonb AND u.deleted_at IS NULL`,
    [userId, AI_CONSENT_VERSION, JSON.stringify(AI_PROVIDERS)]
  );
  return Boolean(result.rows.length);
}

async function mayProcessAi(pool, userId) {
  if (aiConsentEnforced()) return hasAiConsent(pool, userId);
  if (!pool?.query || !userId) return true; // Legacy background jobs during rollout only.
  const result = await pool.query(`SELECT c.version, c.providers, c.revoked_at
    FROM user_ai_consents c WHERE c.user_id = $1`, [userId]);
  if (!result.rows.length) return true; // Existing app builds cannot submit a server receipt.
  return hasAiConsent(pool, userId);
}

async function grantAiConsent(pool, userId) {
  await pool.query(`INSERT INTO user_ai_consents (user_id, version, providers, granted_at, revoked_at)
    VALUES ($1, $2, $3::jsonb, NOW(), NULL) ON CONFLICT (user_id) DO UPDATE
      SET version = EXCLUDED.version, providers = EXCLUDED.providers,
          granted_at = NOW(), revoked_at = NULL`,
  [userId, AI_CONSENT_VERSION, JSON.stringify(AI_PROVIDERS)]);
}
async function revokeAiConsent(pool, userId) {
  // A refusal must survive even when this account has no migrated receipt yet.
  await pool.query(`INSERT INTO user_ai_consents (user_id, version, providers, granted_at, revoked_at)
    VALUES ($1, $2, $3::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO UPDATE
      SET revoked_at = NOW()`, [userId, AI_CONSENT_VERSION, JSON.stringify(AI_PROVIDERS)]);
}

// No global "allowed" flag: concurrent users and delayed jobs keep separate
// identities. Re-read the receipt for every provider call to honor revocation.
function withAiUser(pool, userId, operation) {
  return context.run({ pool, userId }, operation);
}
async function assertAiConsent() {
  const current = context.getStore();
  if (current?.publicTemplate === true) return;
  if (!current) {
    if (aiConsentEnforced()) throw consentError();
    return;
  }
  if (!(await mayProcessAi(current.pool, current.userId))) throw consentError();
}
// Only fixed, non-personal phrases may use this path (never arbitrary input).
function withPublicAiTemplate(operation) {
  return context.run({ publicTemplate: true }, operation);
}

module.exports = { AI_CONSENT_VERSION, AI_PROVIDERS, consentError, hasAiConsent,
  grantAiConsent, revokeAiConsent, mayProcessAi, aiConsentEnforced,
  withAiUser, assertAiConsent, withPublicAiTemplate };
