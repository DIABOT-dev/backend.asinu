const { OAuth2Client } = require('google-auth-library');

const googleOidcClient = new OAuth2Client();
const TRUSTED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Verify the OIDC bearer token attached by Google Pub/Sub push delivery.
 * The signed RTDN message is not sufficient by itself: anyone can POST the
 * same JSON envelope to a public endpoint unless the push identity is checked.
 */
async function requireGooglePubSubAuth(req, res, next) {
  const audience = String(process.env.GOOGLE_PUBSUB_AUDIENCE || '').trim();
  const serviceAccount = String(process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL || '').trim();
  if (!audience || !serviceAccount) {
    return res.status(503).json({ ok: false, error: 'Google Pub/Sub webhook is not configured' });
  }

  const authorization = String(req.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return res.status(401).json({ ok: false, error: 'Missing Pub/Sub identity token' });

  try {
    const ticket = await googleOidcClient.verifyIdToken({
      idToken: match[1],
      audience,
    });
    const payload = ticket.getPayload();
    if (
      !payload ||
      !TRUSTED_ISSUERS.has(String(payload.iss || '')) ||
      payload.aud !== audience ||
      payload.email !== serviceAccount ||
      payload.email_verified !== true
    ) {
      return res.status(401).json({ ok: false, error: 'Invalid Pub/Sub identity token' });
    }
    req.googlePubSubIdentity = { email: payload.email, subject: payload.sub };
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid Pub/Sub identity token' });
  }
}

module.exports = { requireGooglePubSubAuth };
