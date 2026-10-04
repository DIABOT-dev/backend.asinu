'use strict';

const { AccessToken } = require('livekit-server-sdk');

async function createAttemptToken(pool, attemptId, userId) {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) return { unavailable: true };

  const { rows } = await pool.query(
    'SELECT a.room_name, a.state, e.state AS episode_state FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.id = $1 AND a.target_user_id = $2',
    [attemptId, userId]
  );
  const attempt = rows[0];
  if (!attempt || !['RINGING', 'CONNECTED', 'PUSH_WAIT'].includes(attempt.state)) {
    return { notFound: true };
  }

  const token = new AccessToken(key, secret, { identity: 'user-' + userId, ttl: '5m' });
  token.addGrant({
    roomJoin: true,
    room: attempt.room_name,
    canPublish: false,
    canSubscribe: true,
  });
  return { url, token: await token.toJwt(), room: attempt.room_name };
}

module.exports = { createAttemptToken };
