'use strict';

// Identical runtime is vendored in App, Doctor and CRM. Keep the files in sync.
// Wrapped keys stay on disk; unwrapped keys are received over verified mTLS.
// Application data remains in its database.
const fs = require('node:fs');
const https = require('node:https');

function unavailable() {
  return Object.assign(new Error('Encryption keys are temporarily unavailable.'), {
    code: 'SERVICE_UNAVAILABLE', statusCode: 503, status: 503,
  });
}

function keyringEnabled() {
  const provider = process.env.KEY_MANAGEMENT_PROVIDER || 'file';
  if (!['file', 'openbao'].includes(provider)) throw unavailable();
  return provider === 'openbao';
}

function readPrivateFile(filename, maximum = 65536, privateKey = false) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || (stat.mode & (privateKey ? 0o077 : 0o022))) throw unavailable();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function loadConfiguration() {
  try {
    const address = new URL(process.env.OPENBAO_ADDR || '');
    if (address.protocol !== 'https:' || address.username || address.password ||
        address.search || address.hash || address.pathname !== '/') throw unavailable();
    const role = process.env.OPENBAO_ROLE || '';
    const transitKey = process.env.OPENBAO_TRANSIT_KEY || '';
    if (![role, transitKey].every(value => /^[a-z][a-z0-9-]{1,63}$/u.test(value))) throw unavailable();
    const ttlMs = Number(process.env.OPENBAO_KEY_CACHE_TTL_SECONDS || 300) * 1000;
    const timeoutMs = Number(process.env.OPENBAO_TIMEOUT_MS || 3000);
    if (!Number.isInteger(ttlMs) || ttlMs < 30000 || ttlMs > 900000 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 10000) throw unavailable();
    const bundle = JSON.parse(readPrivateFile(process.env.OPENBAO_KEYRING_FILE).toString('utf8'));
    if (bundle.version !== 1 || bundle.role !== role || bundle.transit_key !== transitKey ||
        !Array.isArray(bundle.entries) || !bundle.entries.length || bundle.entries.length > 16) throw unavailable();
    const identifiers = new Set();
    for (const entry of bundle.entries) {
      if (!entry || !/^[a-z][a-z0-9-]{1,63}$/u.test(entry.id) || identifiers.has(entry.id) ||
          typeof entry.ciphertext !== 'string' || !/^(?:bao|vault):v[1-9][0-9]*:[A-Za-z0-9+/=]+$/u.test(entry.ciphertext)) throw unavailable();
      identifiers.add(entry.id);
    }
    const agent = new https.Agent({
      ca: readPrivateFile(process.env.OPENBAO_TLS_CA_FILE),
      cert: readPrivateFile(process.env.OPENBAO_TLS_CERT_FILE),
      key: readPrivateFile(process.env.OPENBAO_TLS_KEY_FILE, 65536, true),
      minVersion: 'TLSv1.3', rejectUnauthorized: true, keepAlive: true, maxSockets: 2,
    });
    return { address, role, transitKey, ttlMs, timeoutMs, bundle, agent };
  } catch { throw unavailable(); }
}

class Keyring {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.request = dependencies.request || this.httpRequest.bind(this);
    this.now = dependencies.now || Date.now;
    this.keys = new Map();
    this.validUntil = 0;
    this.pending = null;
    this.timer = null;
    this.token = null;
    this.tokenUntil = 0;
    this.stopped = false;
  }

  httpRequest(path, data, token) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const request = https.request(new URL('/v1/' + path, this.config.address), {
        method: 'POST', agent: this.config.agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          ...(token ? { 'X-Vault-Token': token } : {}) },
      });
      const deadline = setTimeout(() => request.destroy(unavailable()), this.config.timeoutMs);
      request.once('error', () => { clearTimeout(deadline); reject(unavailable()); });
      request.once('response', response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1048576) request.destroy(unavailable());
          else chunks.push(chunk);
        });
        response.once('error', () => { clearTimeout(deadline); reject(unavailable()); });
        response.once('end', () => {
          clearTimeout(deadline);
          if (response.statusCode !== 200) return reject(unavailable());
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(unavailable()); }
        });
      });
      request.end(body);
    });
  }

  async refresh() {
    if (this.stopped) throw unavailable();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const started = this.now();
      if (!this.token || started >= this.tokenUntil) {
        const result = await this.request('auth/cert/login', { name: this.config.role });
        if (this.stopped) throw unavailable();
        if (!result?.auth?.client_token || !Number.isFinite(result.auth.lease_duration) || result.auth.lease_duration < 1) throw unavailable();
        this.token = result.auth.client_token;
        this.tokenUntil = started + Math.min(result.auth.lease_duration * 800, 720000);
      }
      const result = await this.request('transit/decrypt/' + this.config.transitKey, {
        batch_input: this.config.bundle.entries.map(entry => ({
          ciphertext: entry.ciphertext,
          associated_data: Buffer.from('asinu:keyring:v1:' + this.config.role + ':' + entry.id).toString('base64'),
        })),
      }, this.token);
      const items = result?.data?.batch_results;
      const next = new Map();
      try {
        if (this.stopped) throw unavailable();
        if (!Array.isArray(items) || items.length !== this.config.bundle.entries.length) throw unavailable();
        items.forEach((item, index) => {
          if (item.error || typeof item.plaintext !== 'string') throw unavailable();
          const value = Buffer.from(item.plaintext, 'base64');
          if (value.toString('base64') !== item.plaintext || value.length < 16 || value.length > 4096) throw unavailable();
          next.set(this.config.bundle.entries[index].id, value);
        });
        // Commit a complete keyring atomically. A partial response never replaces it.
        for (const value of this.keys.values()) value.fill(0);
        this.keys = next;
        this.validUntil = this.now() + this.config.ttlMs;
      } catch {
        for (const value of next.values()) value.fill(0);
        throw unavailable();
      }
    })().catch(() => {
      this.token = null;
      this.tokenUntil = 0;
      throw unavailable();
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  get(id) {
    if (!this.ready() || !this.keys.has(id)) throw unavailable();
    return Buffer.from(this.keys.get(id));
  }

  ready() {
    if (this.now() >= this.validUntil) {
      for (const value of this.keys.values()) value.fill(0);
      this.keys.clear();
      return false;
    }
    return this.keys.size > 0;
  }

  start() {
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {
        // No provider response, secrets, request data, or credentials in logs.
        console.warn('openbao.key_refresh_failed');
      });
    }, Math.max(10000, Math.floor(this.config.ttlMs / 3)));
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.config.agent?.destroy();
    for (const value of this.keys.values()) value.fill(0);
    this.keys.clear();
    this.token = null;
    this.validUntil = 0;
  }
}

let active = null;
let initializing = null;
let generation = 0;
async function initializeKeyring() {
  if (!keyringEnabled()) return;
  if (active?.ready()) return;
  if (initializing) return initializing;
  const requestedGeneration = generation;
  initializing = (async () => {
    const candidate = new Keyring(loadConfiguration());
    try {
      await candidate.refresh();
      if (generation !== requestedGeneration) throw unavailable();
    }
    catch { candidate.stop(); throw unavailable(); }
    active?.stop();
    active = candidate;
    active.start();
  })().finally(() => { initializing = null; });
  return initializing;
}

function getKeyBytes(id) {
  if (!keyringEnabled() || !active) throw unavailable();
  return active.get(id);
}
function getSecret(id) {
  const bytes = getKeyBytes(id);
  try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
}
function keyringReady() { return !keyringEnabled() || Boolean(active?.ready()); }
async function refreshKeyring() {
  if (!keyringEnabled() || !active) throw unavailable();
  await active.refresh();
}
function stopKeyring() { generation += 1; active?.stop(); active = null; }

module.exports = { initializeKeyring, keyringEnabled, keyringReady, getKeyBytes,
  getSecret, refreshKeyring, stopKeyring, Keyring, unavailable };
