const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cached = null;

function firebaseConfig() {
  if (cached) return cached;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');

  const credentials = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'));
  if (!credentials.project_id || !credentials.client_email || !credentials.private_key) {
    throw new Error('Invalid Firebase service account');
  }

  cached = {
    projectId: credentials.project_id,
    auth: new GoogleAuth({ credentials, scopes: [FCM_SCOPE] }),
  };
  return cached;
}

function stringData(data) {
  return Object.fromEntries(
    Object.entries(data || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
  );
}

async function sendFcmNotification(token, title, body, data = {}, options = {}) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'NO_FCM_TOKEN' };

  try {
    const { projectId, auth } = firebaseConfig();
    const accessToken = await auth.getAccessToken();
    if (!accessToken) throw new Error('Unable to obtain Firebase access token');

    // Check-in calls are data-only so FirebaseMessagingService receives them
    // while the app process is not running and can render a full-screen call.
    const message = {
      token,
      data: stringData({ ...data, title, body }),
      android: {
        priority: 'HIGH',
        ttl: options.incomingCall ? '120s' : '600s',
        direct_boot_ok: true,
      },
    };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10000),
      }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = result?.error?.message || `FCM HTTP ${response.status}`;
      return { ok: false, error, status: response.status };
    }
    return { ok: true, name: result.name };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = { sendFcmNotification };
