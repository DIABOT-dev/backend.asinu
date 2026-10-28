'use strict';
const crypto = require('node:crypto');
const { getKeyBytes } = require('./openbao-keyring.cjs');

const KEY_PREFIX = 'asinu:key:v2:';
const aad = userId => Buffer.from('asinu:health-user-key:v2:' + userId, 'utf8');

function protectHealthKey(userId, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid health encryption key');
  const wrappingKey = getKeyBytes('health-key-wrap');
  const iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
    cipher.setAAD(aad(userId));
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.from(KEY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'));
  } finally { wrappingKey.fill(0); }
}

function unprotectHealthKey(userId, envelope) {
  const text = envelope.toString('utf8');
  if (!text.startsWith(KEY_PREFIX)) throw new Error('Protected health encryption key is required');
  const encoded = text.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{80}$/u.test(encoded)) throw new Error('Invalid health encryption key envelope');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 60 || bytes.toString('base64url') !== encoded) throw new Error('Invalid health encryption key envelope');
  const wrappingKey = getKeyBytes('health-key-wrap');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  } finally { wrappingKey.fill(0); }
}

module.exports = { KEY_PREFIX, protectHealthKey, unprotectHealthKey };
