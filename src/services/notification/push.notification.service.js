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
const { t } = require('../../i18n');
const { capitalizeFirstLetter, formatPersonName } = require('../../lib/text-format');
const { notificationSoundConfig } = require('./notification-sound.config');

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
  const validTokens = [
    ...new Set(
      expoPushTokens.filter(
        (token) =>
          token &&
          typeof token === 'string' &&
          (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['))
      )
    ),
  ];

  if (validTokens.length === 0) {
    return { ok: false, error: t('error.no_valid_push_tokens') };
  }

  // Same versioned audio contract as the mobile app; Expo sound is iOS-only.
  const notifType = data?.type || '';
  const config = notificationSoundConfig(data || {});

  // Caregiver alert cần xác nhận → thêm categoryIdentifier để hiện nút trên notification
  const isCaregiverAlert =
    ['caregiver_alert', 'alert', 'emergency'].includes(notifType) ||
    data?.alertType === 'emergency' ||
    data?.requiresImmediate === true;

  const messages = validTokens.map((token) => ({
    to: token,
    sound: config.sound,
    title: capitalizeFirstLetter(title),
    body: capitalizeFirstLetter(body),
    data: data,
    priority: config.priority,
    channelId: config.channelId,
    // Expo Push Service expects categoryId. The app registers the matching
    // categoryIdentifier locally; using the server-side field here is what
    // makes interactive actions appear on a remote push.
    ...(isCaregiverAlert && { categoryId: 'health_alert' }),
    ...(notifType === 'doctor_message' && {
      categoryId: 'doctor_message',
      threadId: data?.task_id ? `doctor-${data.task_id}` : 'doctor-consultation',
    }),
  }));

  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json();

    if (!response.ok) {
      return { ok: false, error: result.message || t('error.push_service_error') };
    }

    const tickets = Array.isArray(result?.data) ? result.data : [];
    const errors = tickets
      .map((ticket, index) => ({ ticket, token: validTokens[index] }))
      .filter(({ ticket }) => ticket?.status === 'error');
    const invalidTokens = errors
      .filter(({ ticket }) => ticket?.details?.error === 'DeviceNotRegistered')
      .map(({ token }) => token)
      .filter(Boolean);

    if (
      tickets.length !== validTokens.length ||
      !tickets.some((ticket) => ticket?.status === 'ok')
    ) {
      return {
        ok: false,
        error: errors[0]?.ticket?.message || t('error.push_service_error'),
        data: result,
        invalidTokens,
      };
    }

    return { ok: true, data: result, invalidTokens };
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
async function notifyCareCircleInvitation(
  pool,
  addresseeId,
  senderName,
  invitationId,
  senderId = null
) {
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

    const lang = result.rows[0].language_preference || 'vi';
    // Lazy import: basic dispatch imports this module as its push transport.
    const { sendAndSave } = require('./basic.notification.service');
    const ok = await sendAndSave(
      pool,
      addresseeId,
      'care_circle_invitation',
      t('push.invitation_title', lang),
      t('push.invitation_body', lang, { name: formatPersonName(senderName) }),
      {
        type: 'care_circle_invitation',
        invitationId: String(invitationId),
        senderId: String(senderId || addresseeId),
        senderName: senderName,
      }
    );
    return { ok };
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
async function notifyCareCircleAccepted(pool, requesterId, accepterName, accepterId = null) {
  try {
    const result = await pool.query(
      'SELECT push_token, language_preference FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [requesterId]
    );

    if (result.rows.length === 0 || !result.rows[0].push_token) {
      return { ok: false, error: t('error.no_push_token') };
    }

    const lang = result.rows[0].language_preference || 'vi';
    const { sendAndSave } = require('./basic.notification.service');
    const ok = await sendAndSave(
      pool,
      requesterId,
      'care_circle_accepted',
      t('push.accepted_title', lang),
      t('push.accepted_body', lang, { name: formatPersonName(accepterName) }),
      {
        type: 'care_circle_accepted',
        accepterId: String(accepterId || requesterId),
        accepterName: accepterName,
      }
    );
    return { ok };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendPushNotification,
  notifyCareCircleInvitation,
  notifyCareCircleAccepted,
};
