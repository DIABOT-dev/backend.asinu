/**
 * Push Notification Service
 * Handles sending push notifications via Expo Push Notification Service
 * 
 * To use this service:
 * 1. Store user's Expo Push Token in the database when they login/register
 * 2. Call sendPushNotification when you need to notify users
 * 
 * Note: This requires users to have the Expo Push Token stored in the database
 */

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const { t } = require('../i18n');

/**
 * Send a push notification via Expo Push Notification Service
 * @param {string[]} expoPushTokens - Array of Expo push tokens
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data to send with notification
 * @returns {Promise<object>} Response from Expo Push Service
 */
async function sendPushNotification(expoPushTokens, title, body, data = {}) {
  if (!expoPushTokens || expoPushTokens.length === 0) {

    return { ok: false, error: t('error.no_push_tokens') };
  }

  // Filter valid Expo push tokens
  const validTokens = expoPushTokens.filter(token => 
    token && typeof token === 'string' && token.startsWith('ExponentPushToken[')
  );

  if (validTokens.length === 0) {

    return { ok: false, error: t('error.no_valid_push_tokens') };
  }

  // Map notification type → channel + sound
  const SOUND_MAP = {
    care_circle_invitation: { channelId: 'care-circle', sound: 'asinu_care.wav',      priority: 'high'   },
    care_circle_accepted:   { channelId: 'care-circle', sound: 'asinu_care.wav',      priority: 'high'   },
    alert:                  { channelId: 'alert',       sound: 'asinu_alert.wav',     priority: 'high'   },
    caregiver_alert:        { channelId: 'alert',       sound: 'asinu_alert.wav',     priority: 'high'   },
    streak_7:               { channelId: 'milestone',   sound: 'asinu_milestone.wav', priority: 'normal' },
    streak_14:              { channelId: 'milestone',   sound: 'asinu_milestone.wav', priority: 'normal' },
    streak_30:              { channelId: 'milestone',   sound: 'asinu_milestone.wav', priority: 'normal' },
    weekly_recap:           { channelId: 'milestone',   sound: 'asinu_milestone.wav', priority: 'normal' },
    morning_checkin:        { channelId: 'checkin',     sound: 'asinu_reminder.wav',  priority: 'high'   },
    checkin_followup:       { channelId: 'checkin',     sound: 'asinu_reminder.wav',  priority: 'high'   },
    checkin_followup_urgent:{ channelId: 'alert',       sound: 'asinu_alert.wav',     priority: 'high'   },
    emergency:              { channelId: 'alert',       sound: 'asinu_alert.wav',     priority: 'high'   },
  };
  const notifType = data?.type || '';
  const config = SOUND_MAP[notifType] || { channelId: 'reminder', sound: 'asinu_reminder.wav', priority: 'normal' };

  const messages = validTokens.map(token => ({
    to: token,
    sound: config.sound,
    title: title,
    body: body,
    data: data,
    priority: config.priority,
    channelId: config.channelId,
  }));

  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    
    if (!response.ok) {

      return { ok: false, error: result.message || 'Push service error' };
    }

    return { ok: true, data: result };
  } catch (error) {

    return { ok: false, error: error.message };
  }
}

/**
 * Send notification when a care circle invitation is received
 * @param {object} pool - Database connection pool
 * @param {number} addresseeId - User ID of the invitation recipient
 * @param {string} senderName - Name of the person who sent the invitation
 * @param {number} invitationId - ID of the invitation
 */
async function notifyCareCircleInvitation(pool, addresseeId, senderName, invitationId) {
  try {
    // Get addressee's push token from database
    // Note: You need to add a push_token column to the users table
    const result = await pool.query(
      'SELECT push_token, language_preference FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [addresseeId]
    );

    if (result.rows.length === 0 || !result.rows[0].push_token) {

      return { ok: false, error: t('error.no_push_token') };
    }

    const pushToken = result.rows[0].push_token;
    const lang = result.rows[0].language_preference || 'vi';

    return await sendPushNotification(
      [pushToken],
      t('push.invitation_title'),
      t('push.invitation_body', lang, { name: senderName }),
      {
        type: 'care_circle_invitation',
        invitationId: String(invitationId),
        senderId: String(addresseeId),
        senderName: senderName,
      }
    );
  } catch (error) {

    return { ok: false, error: error.message };
  }
}

/**
 * Send notification when a care circle invitation is accepted
 * @param {object} pool - Database connection pool
 * @param {number} requesterId - User ID who sent the original invitation
 * @param {string} accepterName - Name of person who accepted
 */
async function notifyCareCircleAccepted(pool, requesterId, accepterName) {
  try {
    const result = await pool.query(
      'SELECT push_token, language_preference FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [requesterId]
    );

    if (result.rows.length === 0 || !result.rows[0].push_token) {

      return { ok: false, error: t('error.no_push_token') };
    }

    const pushToken = result.rows[0].push_token;
    const lang = result.rows[0].language_preference || 'vi';

    return await sendPushNotification(
      [pushToken],
      t('push.accepted_title'),
      t('push.accepted_body', lang, { name: accepterName }),
      {
        type: 'care_circle_accepted',
        accepterId: String(requesterId),
        accepterName: accepterName,
      }
    );
  } catch (error) {

    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendPushNotification,
  notifyCareCircleInvitation,
  notifyCareCircleAccepted,
};
