const fs = require('fs');
const http2 = require('http2');

const APNS_HOSTS = Object.freeze({
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
});

let signingKeyPromise = null;
let cachedProviderToken = null;
let cachedProviderTokenAt = 0;

function normalizeEnvironment(value) {
  return value === 'production' ? 'production' : 'sandbox';
}

function privateKeyPem() {
  const inline = process.env.APNS_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');
  const path = process.env.APNS_PRIVATE_KEY_PATH;
  if (path) return fs.readFileSync(path, 'utf8');
  return '';
}

function configuration(environment) {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID || process.env.APPLE_BUNDLE_ID || 'com.asinu.lite';
  const privateKey = privateKeyPem();
  if (!keyId || !teamId || !privateKey || !bundleId) {
    throw new Error('APNs VoIP is not configured');
  }
  return {
    keyId,
    teamId,
    privateKey,
    topic: bundleId + '.voip',
    environment: normalizeEnvironment(environment),
  };
}

async function providerToken(config) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedProviderToken && now - cachedProviderTokenAt < 50 * 60) {
    return cachedProviderToken;
  }

  const { importPKCS8, SignJWT } = await import('jose');
  if (!signingKeyPromise) signingKeyPromise = importPKCS8(config.privateKey, 'ES256');
  const key = await signingKeyPromise;
  cachedProviderToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(now)
    .sign(key);
  cachedProviderTokenAt = now;
  return cachedProviderToken;
}

function buildPayload(data = {}, action = 'INCOMING_CALL') {
  const english = data.lang === 'en';
  return {
    aps: { 'content-available': 1 },
    type: 'checkin_call',
    checkinCall: true,
    action,
    episodeId: data.episodeId || '',
    attemptId: data.attemptId || '',
    kind: data.kind || action,
    severity: data.severity || 'UNKNOWN',
    ringSeconds: Number(data.ringSeconds) || 60,
    lang: english ? 'en' : 'vi',
    title: data.title || (english ? 'Asinu call' : 'Cuộc gọi Asinu'),
    body:
      data.body ||
      (english ? 'Asinu is calling. Please respond.' : 'Asinu đang gọi, vui lòng phản hồi.'),
  };
}

async function sendVoipNotification(token, data = {}, options = {}) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'NO_VOIP_TOKEN' };

  let config;
  try {
    config = configuration(options.environment);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }

  try {
    const jwt = await providerToken(config);
    const payload = buildPayload(
      { ...data, title: options.title, body: options.body },
      options.action || 'INCOMING_CALL'
    );

    return await new Promise((resolve) => {
      const client = http2.connect(APNS_HOSTS[config.environment]);
      let settled = false;
      let status = 0;
      let responseBody = '';

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.close();
        resolve(result);
      };

      const timer = setTimeout(() => {
        client.destroy();
        finish({ ok: false, error: 'APNS_TIMEOUT' });
      }, 10000);

      client.once('error', (error) => finish({ ok: false, error: error.message || String(error) }));

      const request = client.request({
        ':method': 'POST',
        ':path': '/3/device/' + encodeURIComponent(token),
        authorization: 'bearer ' + jwt,
        'apns-topic': config.topic,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': '0',
        ...(data.episodeId ? { 'apns-collapse-id': String(data.episodeId).slice(0, 64) } : {}),
      });

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        status = Number(headers[':status'] || 0);
      });
      request.on('data', (chunk) => {
        responseBody += chunk;
      });
      request.on('error', (error) => finish({ ok: false, error: error.message || String(error) }));
      request.on('end', () => {
        let response = {};
        try {
          response = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          response = {};
        }
        if (status === 200) return finish({ ok: true, apnsId: response.apnsId || null });
        if (status === 403 && response.reason === 'ExpiredProviderToken') {
          cachedProviderToken = null;
          cachedProviderTokenAt = 0;
        }
        return finish({
          ok: false,
          status,
          error: response.reason || (status ? 'APNS_HTTP_' + status : 'APNS_NO_RESPONSE'),
        });
      });
      request.end(JSON.stringify(payload));
    });
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = {
  sendVoipNotification,
  _test: { normalizeEnvironment, buildPayload },
};
