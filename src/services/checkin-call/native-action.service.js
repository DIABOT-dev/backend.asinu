'use strict';

const { createHmac } = require('node:crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'asinu:checkin-native-decline';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingKey() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  // Domain separation: this capability can never be used as a login JWT.
  return createHmac('sha256', process.env.JWT_SECRET).update(AUDIENCE).digest();
}

function createDeclineCapability(attemptId, recipientId, ringDeadline) {
  if (!UUID.test(attemptId || '') || !Number.isSafeInteger(Number(recipientId)) || Number(recipientId) <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const deadline = Math.floor(new Date(ringDeadline).getTime() / 1000);
  if (!Number.isFinite(deadline) || deadline <= now) return null;
  const expires = Math.min(deadline + 30, now + 240);
  return jwt.sign({ attemptId, action: 'decline', exp: expires }, signingKey(), {
    algorithm: 'HS256', audience: AUDIENCE, issuer: 'asinu:checkin-call', subject: String(recipientId),
  });
}

function verifyDeclineCapability(attemptId, token) {
  try {
    if (!UUID.test(attemptId || '') || typeof token !== 'string' || token.length > 2048) throw new Error('Invalid capability');
    const claims = jwt.verify(token, signingKey(), {
      algorithms: ['HS256'], audience: AUDIENCE, issuer: 'asinu:checkin-call', maxAge: '4m',
    });
    const userId = Number(claims.sub);
    if (claims.action !== 'decline' || claims.attemptId !== attemptId || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || claims.exp - claims.iat > 240) throw new Error('Invalid scope');
    return userId;
  } catch {
    // Never include the credential or JWT parser diagnostics in logs/responses.
    const error = new Error('Invalid native call action');
    error.statusCode = 401;
    error.i18nKey = 'error.invalid_payload';
    throw error;
  }
}

async function declineNativeCall(pool, attemptId, token) {
  const userId = verifyDeclineCapability(attemptId, token);
  return require('./checkin-call.service').decline(pool, attemptId, userId, { ringingOnly: true });
}

module.exports = { createDeclineCapability, verifyDeclineCapability, declineNativeCall };
