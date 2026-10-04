'use strict';

const crypto = require('crypto');

function decodeJwtJsonPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchZaloProfile(code, options = {}) {
  const body = new URLSearchParams({
    app_id: process.env.ZALO_APP_ID,
    grant_type: 'authorization_code',
    code,
  });
  if (options.codeVerifier) body.set('code_verifier', options.codeVerifier);
  if (options.redirectUri) body.set('redirect_uri', options.redirectUri);

  const tokenRes = await fetch('https://oauth.zaloapp.com/v4/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      secret_key: process.env.ZALO_SECRET_KEY,
    },
    body: body.toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return { error: 'token_exchange_failed' };

  const profileRes = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name,picture,phone', {
    headers: { access_token: tokenData.access_token },
  });
  const profile = await profileRes.json();
  if (!profile.id) return { error: 'profile_failed' };
  return { profile };
}

async function fetchFacebookProfile(code, redirectUri) {
  const tokenRes = await fetch(
    `https://graph.facebook.com/v18.0/oauth/access_token?${new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    })}`
  );
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return { error: 'token_exchange_failed' };

  const profileRes = await fetch(
    `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${tokenData.access_token}`
  );
  const profile = await profileRes.json();
  if (!profile.id) return { error: 'profile_failed' };
  return { profile };
}

async function fetchGoogleProfile(code, redirectUri) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_WEB_CLIENT_ID,
      client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return { error: 'token_exchange_failed' };

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json();
  if (!profile.id) return { error: 'profile_failed' };
  return { profile };
}

async function verifyFacebookNativeToken({ accessToken, idToken }) {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) return { error: 'NOT_CONFIGURED' };
  if (idToken) {
    const tokenParts = String(idToken).split('.');
    if (tokenParts.length !== 3) return { error: 'INVALID_TOKEN' };

    const [headerB64, payloadB64, sigB64] = tokenParts;
    const header = decodeJwtJsonPart(headerB64);
    const payload = decodeJwtJsonPart(payloadB64);
    const validIssuers = ['https://www.facebook.com', 'https://limited.facebook.com'];
    if (
      !header ||
      !payload ||
      header.alg !== 'RS256' ||
      payload.aud !== appId ||
      !validIssuers.includes(payload.iss)
    )
      return { error: 'INVALID_TOKEN' };

    const jwksUrl =
      payload.iss === 'https://limited.facebook.com'
        ? 'https://limited.facebook.com/.well-known/oauth/openid/jwks/'
        : 'https://www.facebook.com/.well-known/oauth/openid/jwks/';
    const jwksRes = await fetch(jwksUrl);
    const jwks = await jwksRes.json();
    const jwk = jwks.keys?.find((key) => key.kid === header.kid);
    if (!jwk || jwk.kty !== 'RSA') return { error: 'INVALID_TOKEN' };

    const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const valid = crypto.verify(
      'SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      pubKey,
      Buffer.from(sigB64, 'base64url')
    );
    if (!valid) return { error: 'INVALID_TOKEN' };

    const now = Math.floor(Date.now() / 1000);
    const clockSkewSeconds = 60;
    if (
      payload.aud !== appId ||
      !validIssuers.includes(payload.iss) ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now - clockSkewSeconds ||
      typeof payload.iat !== 'number' ||
      payload.iat > now + clockSkewSeconds ||
      payload.iat < now - 24 * 60 * 60 ||
      (payload.nbf !== undefined &&
        (typeof payload.nbf !== 'number' || payload.nbf > now + clockSkewSeconds)) ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0
    )
      return { error: 'INVALID_TOKEN' };

    return { userId: payload.sub, email: payload.email || null, limited: true };
  }

  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appSecret) return { error: 'NOT_CONFIGURED' };
  if (!accessToken) return { error: 'INVALID_TOKEN' };
  const debugRes = await fetch(
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${appId}|${appSecret}`
  );
  const debugJson = await debugRes.json();
  if (!debugJson?.data?.is_valid || debugJson?.data?.app_id !== appId) {
    return { error: 'INVALID_TOKEN' };
  }

  const userId = debugJson.data.user_id;
  const profileRes = await fetch(
    `https://graph.facebook.com/${userId}?fields=id,name,email&access_token=${appId}|${appSecret}`
  );
  const profile = await profileRes.json();
  return { userId, email: profile.email || null, limited: false };
}

module.exports = {
  fetchZaloProfile,
  fetchFacebookProfile,
  fetchGoogleProfile,
  verifyFacebookNativeToken,
};
