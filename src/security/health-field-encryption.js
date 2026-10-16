'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'asinu:enc:v1:';

function config() {
  if (!process.env.HEALTH_FIELD_ENCRYPTION_ENABLED || process.env.HEALTH_FIELD_ENCRYPTION_ENABLED === 'false') return null;
  if (process.env.HEALTH_FIELD_ENCRYPTION_ENABLED !== 'true') throw new Error('Invalid health field encryption configuration');
  if (!process.env.HEALTH_FIELD_KEY_DIRECTORY) throw new Error('Health encryption key directory is required');
  return process.env.HEALTH_FIELD_KEY_DIRECTORY;
}

function keyFile(userId, directory) {
  const id = String(userId);
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error('A valid data owner is required');
  return path.join(directory, id + '.key');
}

function assertHealthEncryptionReady() {
  const directory = config();
  if (!directory) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error('Unsafe health key directory');
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function loadKey(userId, directory, create = false) {
  const file = keyFile(userId, directory);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077)) throw new Error('Unsafe health key directory');
  const deleted = file + '.deleted';
  if (fs.existsSync(deleted)) throw new Error('Health data owner has been deleted');
  if (create && !fs.existsSync(file)) {
    const temporary = file + '.' + crypto.randomUUID() + '.pending';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { fs.unlinkSync(temporary); }
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    if (fs.existsSync(deleted)) { fs.rmSync(file, { force: true }); throw new Error('Health data owner has been deleted'); }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size !== 32) throw new Error('Unsafe health encryption key file');
    const key = fs.readFileSync(fd);
    if (key.length !== 32) throw new Error('Invalid health encryption key');
    return key;
  } finally { fs.closeSync(fd); }
}

function aad(userId, field) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(field)) throw new Error('A valid protected field is required');
  return Buffer.from(`asinu-health-v1\0${userId}\0${field}`, 'utf8');
}

function encryptHealthField(userId, field, value) {
  const directory = config();
  if (value == null || !directory) return value;
  if (typeof value !== 'string') throw new Error('Protected health fields must be strings');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(userId, directory, true), iv);
  cipher.setAAD(aad(userId, field));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decryptHealthField(userId, field, value) {
  if (value == null) return value;
  const directory = config();
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  // Ciphertext is never returned as display text, even when configuration was
  // accidentally removed. Missing keys, tampering and wrong owners fail closed.
  if (!directory) throw new Error('Health encryption is required to read protected data');
  const encoded = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid health ciphertext');
  const payload = Buffer.from(encoded, 'base64url');
  if (payload.length < 28) throw new Error('Invalid health ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(userId, directory), payload.subarray(0, 12));
  decipher.setAAD(aad(userId, field));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

function decryptHealthRows(userId, table, fields, rows) {
  return rows.map(row => {
    const result = { ...row };
    for (const field of fields) if (Object.hasOwn(result, field)) result[field] = decryptHealthField(userId, `${table}.${field}`, result[field]);
    return result;
  });
}

function retireHealthKey(userId) {
  const directory = config();
  if (!directory) return;
  const file = keyFile(userId, directory);
  const deleted = file + '.deleted';
  try {
    const fd = fs.openSync(deleted, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, new Date().toISOString()); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function cleanupOrphanHealthKeys(pool) {
  const directory = config();
  if (!directory) return 0;
  const ids = fs.readdirSync(directory).filter(name => /^[1-9][0-9]*\.key$/.test(name)).map(name => name.slice(0, -4));
  let removed = 0;
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, start + 500);
    const { rows } = await pool.query('SELECT id FROM users WHERE id = ANY($1::integer[])', [batch]);
    const existing = new Set(rows.map(row => String(row.id)));
    for (const id of batch) if (!existing.has(id)) { retireHealthKey(id); removed++; }
  }
  return removed;
}

module.exports = { PREFIX, encryptHealthField, decryptHealthField, decryptHealthRows, retireHealthKey, cleanupOrphanHealthKeys, assertHealthEncryptionReady };
