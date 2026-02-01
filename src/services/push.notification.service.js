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
    console.warn('[push] No push tokens provided');
    return { ok: false, error: 'No push tokens' };
  }

  // Filter valid Expo push tokens
  const validTokens = expoPushTokens.filter(token => 
    token && typeof token === 'string' && token.startsWith('ExponentPushToken[')
  );

  if (validTokens.length === 0) {
    console.warn('[push] No valid Expo push tokens');
    return { ok: false, error: 'No valid push tokens' };
  }

  const messages = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: title,
    body: body,
    data: data,
    priority: 'high',
    channelId: 'care-circle',
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
      console.error('[push] Expo push service error:', result);
      return { ok: false, error: result.message || 'Push service error' };
    }

    console.log('[push] Notifications sent successfully:', result);
    return { ok: true, data: result };
  } catch (error) {
    console.error('[push] Error sending push notification:', error);
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
      'SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [addresseeId]
    );

    if (result.rows.length === 0 || !result.rows[0].push_token) {
      console.log('[push] No push token found for user', addresseeId);
      return { ok: false, error: 'No push token' };
    }

    const pushToken = result.rows[0].push_token;
    
    return await sendPushNotification(
      [pushToken],
      'Lời mời kết nối Care Circle',
      `${senderName} muốn kết nối với bạn trong Care Circle`,
      {
        type: 'care_circle_invitation',
        invitationId: String(invitationId),
        senderId: String(addresseeId),
        senderName: senderName,
      }
    );
  } catch (error) {
    console.error('[push] Error notifying care circle invitation:', error);
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
      'SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [requesterId]
    );

    if (result.rows.length === 0 || !result.rows[0].push_token) {
      console.log('[push] No push token found for user', requesterId);
      return { ok: false, error: 'No push token' };
    }

    const pushToken = result.rows[0].push_token;
    
    return await sendPushNotification(
      [pushToken],
      'Lời mời được chấp nhận',
      `${accepterName} đã chấp nhận lời mời kết nối Care Circle của bạn`,
      {
        type: 'care_circle_accepted',
        accepterId: String(requesterId),
        accepterName: accepterName,
      }
    );
  } catch (error) {
    console.error('[push] Error notifying care circle accepted:', error);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendPushNotification,
  notifyCareCircleInvitation,
  notifyCareCircleAccepted,
};
