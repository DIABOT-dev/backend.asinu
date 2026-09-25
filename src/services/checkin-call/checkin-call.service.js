const { sendPushNotification } = require('../notification/push.notification.service');
const { sendFcmNotification } = require('../notification/fcm.notification.service');
const { sendVoipNotification } = require('../notification/apns.voip.service');
const logger = require('../../lib/logger');
const { t } = require('../../i18n');

const DEFAULTS = Object.freeze({
  enabled: false,
  checkin_time: '08:00',
  timezone: 'Asia/Ho_Chi_Minh',
  grace_hours: 6,
  user_timeout_seconds: 60,
  family_ring_seconds: 60,
  family_confirm_minutes: 10,
  max_rounds: 1,
});
const TERMINAL = new Set([
  'RESOLVED',
  'EXHAUSTED',
  'EXHAUSTED_MILD',
  'EXHAUSTED_URGENT',
  'CANCELLED',
  'URGENT_ACKNOWLEDGED',
]);

function serviceError(message, statusCode, i18nKey, i18nParams) {
  return Object.assign(new Error(message), { statusCode, i18nKey, i18nParams });
}

function validateSettings(input) {
  const result = { ...DEFAULTS };
  if (typeof input.enabled === 'boolean') result.enabled = input.enabled;
  if (input.checkin_time !== undefined) {
    if (
      typeof input.checkin_time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.checkin_time)
    ) {
      throw serviceError('Invalid checkin_time', 400, 'checkinCall.error.invalid_checkin_time');
    }
    result.checkin_time = input.checkin_time;
  }
  if (input.timezone !== undefined) {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw serviceError('Invalid timezone', 400, 'checkinCall.error.invalid_timezone');
    }
    result.timezone = input.timezone;
  }
  const limits = {
    grace_hours: [2, 12],
    user_timeout_seconds: [30, 180],
    family_ring_seconds: [30, 120],
    family_confirm_minutes: [5, 30],
    max_rounds: [1, 3],
  };
  for (const [field, [min, max]] of Object.entries(limits)) {
    if (input[field] === undefined) continue;
    if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) {
      throw serviceError('Invalid ' + field, 400, 'checkinCall.error.invalid_setting', { field });
    }
    result[field] = input[field];
  }
  return result;
}

async function settings(pool, userId) {
  const found = await pool.query('SELECT * FROM checkin_call_settings WHERE user_id = $1', [
    userId,
  ]);
  return found.rows[0] || { user_id: userId, ...DEFAULTS };
}

async function saveSettings(pool, userId, input) {
  const current = await settings(pool, userId);
  const value = validateSettings({
    ...current,
    checkin_time: String(current.checkin_time).slice(0, 5),
    ...input,
  });
  if (value.enabled) {
    const ownToken = await pool.query(
      'SELECT push_token, fcm_token, voip_push_token FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );
    const hasExpo = /^(Exponent|Expo)PushToken\[/.test(ownToken.rows[0]?.push_token || '');
    if (!hasExpo && !ownToken.rows[0]?.fcm_token && !ownToken.rows[0]?.voip_push_token) {
      throw serviceError(
        'Notifications are required for check-in calls',
        409,
        'checkinCall.error.notifications_required'
      );
    }
    if (!(await familyFor(pool, userId)).length) {
      throw serviceError('Care Circle member required', 409, 'checkinCall.error.family_required');
    }
  }
  const saved = await pool.query(
    'INSERT INTO checkin_call_settings (user_id, enabled, checkin_time, timezone, grace_hours, user_timeout_seconds, family_ring_seconds, family_confirm_minutes, max_rounds) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, checkin_time = EXCLUDED.checkin_time, timezone = EXCLUDED.timezone, grace_hours = EXCLUDED.grace_hours, user_timeout_seconds = EXCLUDED.user_timeout_seconds, family_ring_seconds = EXCLUDED.family_ring_seconds, family_confirm_minutes = EXCLUDED.family_confirm_minutes, max_rounds = EXCLUDED.max_rounds, updated_at = now() RETURNING *',
    [
      userId,
      value.enabled,
      value.checkin_time,
      value.timezone,
      value.grace_hours,
      value.user_timeout_seconds,
      value.family_ring_seconds,
      value.family_confirm_minutes,
      value.max_rounds,
    ]
  );
  return saved.rows[0];
}

async function event(db, episodeId, name, actorId = null, attemptId = null, detail = {}) {
  await db.query(
    'INSERT INTO checkin_call_events (episode_id, attempt_id, actor_user_id, event, detail) VALUES ($1,$2,$3,$4,$5)',
    [episodeId, attemptId, actorId, name, JSON.stringify(detail)]
  );
}

async function createAttempt(db, episode, targetId, role, round = 1) {
  const result = await db.query(
    'INSERT INTO checkin_call_attempts (episode_id, target_user_id, target_role, round_number, room_name, ring_deadline) ' +
      "VALUES ($1,$2,$3,$4,'checkin-' || gen_random_uuid()::text, now() + ($5::integer * interval '1 second')) RETURNING *",
    [
      episode.id,
      targetId,
      role,
      round,
      role === 'USER' ? episode.config.user_timeout_seconds : episode.config.family_ring_seconds,
    ]
  );
  const attempt = result.rows[0];
  await db.query(
    "INSERT INTO checkin_call_deliveries (episode_id, attempt_id, target_user_id, kind) VALUES ($1,$2,$3,'INCOMING_CALL')",
    [episode.id, attempt.id, targetId]
  );
  await event(db, episode.id, 'CALL_STARTED', null, attempt.id, { role, targetId, round });
  return attempt;
}

async function familyFor(db, userId) {
  const result = await db.query(
    'SELECT CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END AS family_id ' +
      'FROM user_connections c JOIN users recipient ON recipient.id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END ' +
      'WHERE c.status = $2 AND (c.requester_id = $1 OR c.addressee_id = $1) ' +
      "AND COALESCE((c.permissions->>'can_receive_alerts')::boolean,false) = true " +
      "AND COALESCE((c.permissions->>'can_ack_escalation')::boolean,false) = true " +
      'AND recipient.deleted_at IS NULL ' +
      "AND (recipient.push_token LIKE 'ExponentPushToken[%]' OR recipient.push_token LIKE 'ExpoPushToken[%]' OR recipient.fcm_token IS NOT NULL OR recipient.voip_push_token IS NOT NULL) " +
      'ORDER BY (SELECT COUNT(*) FROM checkin_call_events ce JOIN checkin_call_episodes ep ON ep.id = ce.episode_id ' +
      "WHERE ep.user_id = $1 AND ce.actor_user_id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END AND ce.event = 'FAMILY_CONFIRMED' AND ce.created_at > now() - interval '90 days') DESC, " +
      'c.updated_at DESC NULLS LAST, c.accepted_at DESC NULLS LAST, c.id',
    [userId, 'accepted']
  );
  return result.rows.map((row) => Number(row.family_id));
}

async function startNextFamily(db, episode) {
  let ids = episode.family_ids || [];
  if (!ids.length) ids = await familyFor(db, episode.user_id);
  let index = Number(episode.family_index || 0);
  let round = Number(episode.round_number || 1);
  if (index >= ids.length) {
    index = 0;
    round += 1;
  }
  if (!ids.length || round > Number(episode.config.max_rounds)) {
    const exhaustedState = episode.severity === 'MILD' ? 'EXHAUSTED_MILD' : 'EXHAUSTED';
    await db.query(
      'UPDATE checkin_call_episodes SET state = $3, exhausted_at = now(), next_action_at = NULL, family_ids = $2, updated_at = now() WHERE id = $1',
      [episode.id, ids, exhaustedState]
    );
    await event(db, episode.id, exhaustedState, null, null, {
      reason: ids.length ? 'NO_CONFIRMATION' : 'NO_ELIGIBLE_FAMILY',
    });
    logger.error('checkin_call.exhausted', {
      episodeId: episode.id,
      severity: episode.severity,
      reason: ids.length ? 'NO_CONFIRMATION' : 'NO_ELIGIBLE_FAMILY',
    });
    return;
  }
  const targetId = ids[index];
  const attempt = await createAttempt(db, episode, targetId, 'FAMILY', round);
  await db.query(
    "UPDATE checkin_call_episodes SET state = 'MILD_FAMILY_ESCALATION', family_ids = $2, family_index = $3, round_number = $4, next_action_at = $5, updated_at = now() WHERE id = $1",
    [episode.id, ids, index + 1, round, attempt.ring_deadline]
  );
}

async function broadcastUrgent(db, episode) {
  const ids = await familyFor(db, episode.user_id);
  if (!ids.length) {
    await db.query(
      "UPDATE checkin_call_episodes SET state = 'EXHAUSTED_URGENT', severity = 'URGENT', exhausted_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
      [episode.id]
    );
    await event(db, episode.id, 'EXHAUSTED_URGENT', null, null, { reason: 'NO_ELIGIBLE_FAMILY' });
    logger.error('checkin_call.exhausted', {
      episodeId: episode.id,
      severity: 'URGENT',
      reason: 'NO_ELIGIBLE_FAMILY',
    });
    return;
  }
  for (const id of ids) await createAttempt(db, episode, id, 'FAMILY');
  await db.query(
    "UPDATE checkin_call_episodes SET state = 'URGENT_BROADCAST', severity = 'URGENT', family_ids = $2, urgent_until = now() + interval '30 minutes', next_action_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1",
    [episode.id, ids]
  );
  await event(db, episode.id, 'URGENT_BROADCAST', null, null, { familyCount: ids.length });
}

async function withEpisode(pool, episodeId, actorId, fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const found = await db.query('SELECT * FROM checkin_call_episodes WHERE id = $1 FOR UPDATE', [
      episodeId,
    ]);
    if (!found.rows.length)
      throw serviceError('Episode not found', 404, 'checkinCall.error.episode_not_found');
    const result = await fn(db, found.rows[0], actorId);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function answer(pool, episodeId, userId, choice) {
  if (![1, 2, 3].includes(choice))
    throw serviceError('Invalid choice', 400, 'checkinCall.error.invalid_choice');
  return withEpisode(pool, episodeId, userId, async (db, episode) => {
    if (episode.user_id !== userId)
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    if (episode.state === 'RESOLVED' && choice === 1) return episode;
    if (episode.state !== 'CONTACT_USER')
      throw serviceError(
        'Episode no longer accepting user answers',
        409,
        'checkinCall.error.episode_not_accepting'
      );
    await db.query(
      "UPDATE checkin_call_attempts SET state = 'COMPLETED', ended_at = now() WHERE episode_id = $1 AND target_role = 'USER' AND state IN ('RINGING','CONNECTED')",
      [episodeId]
    );
    if (choice === 1) {
      if (episode.config?.test_mode !== true) {
        await db.query(
          "INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state, resolved_at, last_response_at) VALUES ($1,$2,'fine','fine','resolved',now(),now()) ON CONFLICT (user_id, session_date) DO NOTHING",
          [userId, episode.local_date]
        );
      }
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'RESOLVED', severity = 'NONE', resolved_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
        [episodeId]
      );
      await event(db, episodeId, 'USER_OK', userId);
    } else if (choice === 2) {
      await db.query(
        "UPDATE checkin_call_episodes SET severity = 'MILD', family_index = 0, updated_at = now() WHERE id = $1",
        [episodeId]
      );
      episode.severity = 'MILD';
      await event(db, episodeId, 'USER_MILD', userId);
      await startNextFamily(db, episode);
    } else {
      await event(db, episodeId, 'USER_URGENT', userId);
      await broadcastUrgent(db, episode);
    }
    const updated = await db.query('SELECT * FROM checkin_call_episodes WHERE id = $1', [
      episodeId,
    ]);
    return updated.rows[0];
  });
}

async function getActive(pool, userId) {
  const result = await pool.query(
    'SELECT e.id, e.user_id, e.state, e.severity, e.acknowledged_by, a.id AS attempt_id, a.target_role, a.state AS attempt_state FROM checkin_call_attempts a ' +
      'JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.target_user_id = $1 ' +
      "AND a.state IN ('RINGING','CONNECTED','WAITING_CONFIRMATION','PUSH_WAIT') " +
      "AND e.state NOT IN ('RESOLVED','EXHAUSTED','EXHAUSTED_MILD','EXHAUSTED_URGENT','CANCELLED','URGENT_ACKNOWLEDGED') " +
      'ORDER BY a.created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

async function getEpisode(pool, episodeId, userId) {
  const result = await pool.query(
    'SELECT e.id, e.user_id, e.state, e.severity, e.acknowledged_by, e.created_at, e.resolved_at, e.exhausted_at ' +
      'FROM checkin_call_episodes e WHERE e.id = $1 AND (e.user_id = $2 OR $2 = ANY(e.family_ids))',
    [episodeId, userId]
  );
  return result.rows[0] || null;
}

async function getAttempt(pool, attemptId, userId) {
  const result = await pool.query(
    'SELECT a.id, a.episode_id, a.target_role, a.state, a.ring_deadline, a.confirm_deadline, e.state AS episode_state, e.severity ' +
      'FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id ' +
      'WHERE a.id = $1 AND a.target_user_id = $2',
    [attemptId, userId]
  );
  return result.rows[0] || null;
}

async function seen(pool, attemptId, userId) {
  const found = await pool.query(
    "SELECT a.episode_id FROM checkin_call_attempts a WHERE a.id = $1 AND a.target_user_id = $2 AND a.target_role = 'FAMILY'",
    [attemptId, userId]
  );
  if (!found.rows.length)
    throw serviceError('Attempt not found', 404, 'checkinCall.error.attempt_not_found');
  await event(pool, found.rows[0].episode_id, 'SEEN', userId, attemptId);
  return { ok: true };
}

async function endRemoteCalls(pool, episodeId, exceptAttemptId = null) {
  if (!pool?.query) return;
  try {
    const result = await pool.query(
      "SELECT a.id AS attempt_id, u.fcm_token, u.voip_push_token, u.voip_push_environment, COALESCE(u.language_preference, 'vi') AS lang " +
        'FROM checkin_call_attempts a JOIN users u ON u.id = a.target_user_id ' +
        'WHERE a.episode_id = $1 AND ($2::uuid IS NULL OR a.id != $2::uuid)',
      [episodeId, exceptAttemptId]
    );
    await Promise.allSettled(
      result.rows.flatMap((row) => {
        const title = t('checkinCall.push.accepted_title', row.lang);
        const payload = {
          type: 'checkin_call',
          checkinCall: true,
          action: 'END_CALL',
          kind: 'END_CALL',
          episodeId,
          attemptId: row.attempt_id,
          lang: row.lang,
        };
        const jobs = [];
        if (row.fcm_token) {
          jobs.push(
            sendFcmNotification(row.fcm_token, title, '', payload, {
              incomingCall: true,
            })
          );
        }
        if (row.voip_push_token) {
          jobs.push(
            sendVoipNotification(row.voip_push_token, payload, {
              action: 'END_CALL',
              environment: row.voip_push_environment,
              title,
              body: '',
            })
          );
        }
        return jobs;
      })
    );
  } catch (error) {
    logger.warn('checkin_call.remote_end_failed', {
      episodeId,
      error: error.message || String(error),
    });
  }
}

async function accept(pool, attemptId, userId) {
  const db = await pool.connect();
  let result;
  let urgentEpisodeId = null;
  try {
    await db.query('BEGIN');
    const found = await db.query(
      'SELECT e.*, a.target_role, a.state AS attempt_state FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.id = $1 AND a.target_user_id = $2 FOR UPDATE OF e',
      [attemptId, userId]
    );
    const episode = found.rows[0];
    if (!episode)
      throw serviceError('Attempt not found', 404, 'checkinCall.error.attempt_not_found');
    if (TERMINAL.has(episode.state))
      throw serviceError('Episode closed', 409, 'checkinCall.error.episode_closed');
    if (!['RINGING', 'PUSH_WAIT'].includes(episode.attempt_state)) {
      throw serviceError('Attempt closed', 409, 'checkinCall.error.attempt_closed');
    }
    if (episode.target_role === 'FAMILY' && episode.state === 'URGENT_BROADCAST') {
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'URGENT_ACKNOWLEDGED', acknowledged_by = $2, next_action_at = NULL, updated_at = now() WHERE id = $1",
        [episode.id, userId]
      );
      await db.query(
        "UPDATE checkin_call_attempts SET state = CASE WHEN id = $2 THEN 'CONNECTED' ELSE 'CANCELLED' END, connected_at = CASE WHEN id = $2 THEN now() ELSE connected_at END, ended_at = CASE WHEN id = $2 THEN ended_at ELSE now() END WHERE episode_id = $1 AND state IN ('RINGING','PUSH_WAIT','CONNECTED')",
        [episode.id, attemptId]
      );
      await db.query(
        "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE episode_id = $1 AND state = 'PENDING'",
        [episode.id]
      );
      await event(db, episode.id, 'URGENT_ACKNOWLEDGED', userId, attemptId);
      urgentEpisodeId = episode.id;
    } else {
      const seconds =
        episode.target_role === 'USER'
          ? Number(episode.config.user_timeout_seconds)
          : Number(episode.config.family_confirm_minutes) * 60;
      await db.query(
        "UPDATE checkin_call_attempts SET state = 'CONNECTED', connected_at = now(), confirm_deadline = now() + ($2::integer * interval '1 second') WHERE id = $1",
        [attemptId, seconds]
      );
      await db.query(
        "UPDATE checkin_call_episodes SET next_action_at = now() + ($2::integer * interval '1 second'), updated_at = now() WHERE id = $1",
        [episode.id, seconds]
      );
      await event(db, episode.id, 'CALL_ACCEPTED', userId, attemptId);
    }
    await db.query('COMMIT');
    result = {
      ok: true,
      state: episode.state === 'URGENT_BROADCAST' ? 'URGENT_ACKNOWLEDGED' : episode.state,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  if (urgentEpisodeId) await endRemoteCalls(pool, urgentEpisodeId, attemptId);
  return result;
}

async function confirmFamily(pool, episodeId, userId, action) {
  if (!['ACCEPT_AND_CHECK', 'ON_MY_WAY', 'CALLED_USER'].includes(action)) {
    throw serviceError('Invalid action', 400, 'checkinCall.error.invalid_action');
  }
  const result = await withEpisode(pool, episodeId, userId, async (db, episode) => {
    if (!episode.family_ids.includes(userId))
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    if (episode.state === 'RESOLVED' && episode.acknowledged_by === userId) return episode;
    if (
      !['MILD_FAMILY_ESCALATION', 'CONTACT_FAMILY', 'URGENT_ACKNOWLEDGED'].includes(episode.state)
    ) {
      throw serviceError('Episode closed', 409, 'checkinCall.error.episode_closed');
    }
    if (episode.state === 'URGENT_ACKNOWLEDGED' && episode.acknowledged_by !== userId) {
      throw serviceError(
        'Another family member accepted',
        409,
        'checkinCall.error.another_family_accepted'
      );
    }
    if (episode.state !== 'URGENT_ACKNOWLEDGED') {
      const contacted = await db.query(
        "SELECT 1 FROM checkin_call_attempts WHERE episode_id = $1 AND target_user_id = $2 AND target_role = 'FAMILY' AND state IN ('RINGING','CONNECTED','PUSH_WAIT','WAITING_CONFIRMATION') LIMIT 1",
        [episodeId, userId]
      );
      if (!contacted.rows.length)
        throw serviceError(
          'No active family alert',
          409,
          'checkinCall.error.no_active_family_alert'
        );
    }
    const permission = await db.query(
      "SELECT 1 FROM user_connections WHERE status = 'accepted' AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)) " +
        "AND COALESCE((permissions->>'can_ack_escalation')::boolean,false) = true",
      [episode.user_id, userId]
    );
    if (!permission.rows.length)
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    await db.query(
      "UPDATE checkin_call_episodes SET state = 'RESOLVED', acknowledged_by = $2, resolved_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
      [episodeId, userId]
    );
    await db.query(
      "UPDATE checkin_call_attempts SET state = 'COMPLETED', ended_at = now() WHERE episode_id = $1 AND state IN ('RINGING','CONNECTED','PUSH_WAIT','WAITING_CONFIRMATION')",
      [episodeId]
    );
    await db.query(
      "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE episode_id = $1 AND state = 'PENDING'",
      [episodeId]
    );
    await event(db, episodeId, 'FAMILY_CONFIRMED', userId, null, { action });
    return { ...episode, state: 'RESOLVED', acknowledged_by: userId };
  });
  await endRemoteCalls(pool, episodeId);
  return result;
}

async function createDailyEpisodes(pool) {
  const result = await pool.query(
    'INSERT INTO checkin_call_episodes (user_id, local_date, scheduled_at, grace_until, next_action_at, config) ' +
      'SELECT s.user_id, (now() AT TIME ZONE s.timezone)::date, ' +
      '(((now() AT TIME ZONE s.timezone)::date + s.checkin_time) AT TIME ZONE s.timezone), ' +
      "(((now() AT TIME ZONE s.timezone)::date + s.checkin_time) AT TIME ZONE s.timezone) + (s.grace_hours * interval '1 hour'), " +
      "(((now() AT TIME ZONE s.timezone)::date + s.checkin_time) AT TIME ZONE s.timezone) + (s.grace_hours * interval '1 hour'), " +
      'to_jsonb(s) FROM checkin_call_settings s JOIN users u ON u.id = s.user_id ' +
      'WHERE s.enabled = true AND u.deleted_at IS NULL AND (now() AT TIME ZONE s.timezone)::time >= s.checkin_time ' +
      'ON CONFLICT (user_id, local_date) DO NOTHING RETURNING id'
  );
  return result.rowCount;
}

async function advance(pool, id) {
  return withEpisode(pool, id, null, async (db, episode) => {
    if (
      !episode.next_action_at ||
      new Date(episode.next_action_at) > new Date() ||
      TERMINAL.has(episode.state)
    )
      return;
    if (episode.state === 'SCHEDULED') {
      const currentSettings = await db.query(
        'SELECT enabled FROM checkin_call_settings WHERE user_id = $1',
        [episode.user_id]
      );
      if (!currentSettings.rows[0]?.enabled) {
        await db.query(
          "UPDATE checkin_call_episodes SET state = 'CANCELLED', next_action_at = NULL, updated_at = now() WHERE id = $1",
          [id]
        );
        await event(db, id, 'CONFIG_DISABLED');
        return;
      }
      const existing = await db.query(
        'SELECT 1 FROM health_checkins WHERE user_id = $1 AND session_date = $2 LIMIT 1',
        [episode.user_id, episode.local_date]
      );
      if (existing.rows.length) {
        await db.query(
          "UPDATE checkin_call_episodes SET state = 'RESOLVED', resolved_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
          [id]
        );
        await event(db, id, 'CHECKIN_ALREADY_DONE');
        return;
      }
      await event(db, id, 'OVERDUE');
      const attempt = await createAttempt(db, episode, episode.user_id, 'USER');
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'CONTACT_USER', next_action_at = $2, updated_at = now() WHERE id = $1",
        [id, attempt.ring_deadline]
      );
    } else if (episode.state === 'CONTACT_USER') {
      await db.query(
        "UPDATE checkin_call_episodes SET severity = 'UNKNOWN', updated_at = now() WHERE id = $1",
        [id]
      );
      episode.severity = 'UNKNOWN';
      await db.query(
        "UPDATE checkin_call_attempts SET state = 'NO_ANSWER', ended_at = now() WHERE episode_id = $1 AND target_role = 'USER' AND state IN ('RINGING','CONNECTED')",
        [id]
      );
      await event(db, id, 'USER_TIMEOUT');
      await startNextFamily(db, episode);
    } else if (episode.state === 'MILD_FAMILY_ESCALATION' || episode.state === 'CONTACT_FAMILY') {
      const found = await db.query(
        "SELECT * FROM checkin_call_attempts WHERE episode_id = $1 AND target_role = 'FAMILY' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [id]
      );
      const attempt = found.rows[0];
      if (!attempt) return startNextFamily(db, episode);
      if (attempt.state === 'RINGING') {
        await db.query(
          "UPDATE checkin_call_attempts SET state = 'PUSH_WAIT', ended_at = now(), confirm_deadline = now() + ($2::integer * interval '1 minute') WHERE id = $1",
          [attempt.id, episode.config.family_confirm_minutes]
        );
        await db.query(
          "INSERT INTO checkin_call_deliveries (episode_id, attempt_id, target_user_id, kind) VALUES ($1,$2,$3,'FALLBACK')",
          [id, attempt.id, attempt.target_user_id]
        );
        await db.query(
          "UPDATE checkin_call_episodes SET next_action_at = now() + ($2::integer * interval '1 minute'), updated_at = now() WHERE id = $1",
          [id, episode.config.family_confirm_minutes]
        );
        await event(db, id, 'FAMILY_NO_ANSWER', null, attempt.id);
      } else {
        await db.query(
          "UPDATE checkin_call_attempts SET state = 'EXPIRED', ended_at = now() WHERE id = $1",
          [attempt.id]
        );
        await event(db, id, 'FAMILY_TIMEOUT', null, attempt.id);
        await startNextFamily(db, episode);
      }
    } else if (episode.state === 'URGENT_BROADCAST') {
      if (new Date(episode.urgent_until) <= new Date()) {
        await db.query(
          "UPDATE checkin_call_episodes SET state = 'EXHAUSTED_URGENT', exhausted_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
          [id]
        );
        await event(db, id, 'EXHAUSTED_URGENT');
        logger.error('checkin_call.exhausted', {
          episodeId: id,
          severity: 'URGENT',
          reason: 'MAX_DURATION',
        });
      } else {
        for (const familyId of episode.family_ids) {
          await db.query(
            'INSERT INTO checkin_call_deliveries (episode_id, attempt_id, target_user_id, kind) ' +
              "SELECT $1, a.id, $2, 'URGENT_REPEAT' FROM checkin_call_attempts a " +
              "WHERE a.episode_id = $1 AND a.target_user_id = $2 AND a.target_role = 'FAMILY' " +
              'ORDER BY a.created_at DESC LIMIT 1',
            [id, familyId]
          );
        }
        await db.query(
          "UPDATE checkin_call_episodes SET next_action_at = LEAST(now() + interval '60 seconds', urgent_until), updated_at = now() WHERE id = $1",
          [id]
        );
      }
    }
  });
}

async function tick(pool) {
  await createDailyEpisodes(pool);
  const due = await pool.query(
    'SELECT id FROM checkin_call_episodes WHERE next_action_at <= now() ORDER BY next_action_at LIMIT 100'
  );
  for (const row of due.rows) {
    try {
      await advance(pool, row.id);
    } catch (err) {
      logger.error('checkin_call.advance_failed', { episodeId: row.id, err });
    }
  }
  return due.rowCount;
}

async function dispatchDeliveries(pool) {
  await pool.query(
    "UPDATE checkin_call_deliveries SET state = 'PENDING', due_at = now(), updated_at = now() WHERE state = 'SENDING' AND updated_at < now() - interval '2 minutes'"
  );
  const pending = await pool.query(
    "SELECT d.id FROM checkin_call_deliveries d WHERE d.state = 'PENDING' AND d.due_at <= now() ORDER BY d.due_at LIMIT 50"
  );
  for (const row of pending.rows) {
    const db = await pool.connect();
    let delivery;
    try {
      await db.query('BEGIN');
      const found = await db.query(
        'SELECT d.*, e.state AS episode_state, e.severity, e.config, a.state AS attempt_state, ' +
          "u.push_token, u.fcm_token, u.voip_push_token, u.voip_push_environment, COALESCE(u.language_preference, 'vi') AS lang " +
          'FROM checkin_call_deliveries d JOIN checkin_call_episodes e ON e.id = d.episode_id ' +
          'LEFT JOIN checkin_call_attempts a ON a.id = d.attempt_id ' +
          'JOIN users u ON u.id = d.target_user_id WHERE d.id = $1 FOR UPDATE OF d',
        [row.id]
      );
      delivery = found.rows[0];
      if (!delivery || delivery.state !== 'PENDING') {
        await db.query('ROLLBACK');
        continue;
      }
      if (
        TERMINAL.has(delivery.episode_state) ||
        (delivery.kind === 'INCOMING_CALL' && delivery.attempt_state !== 'RINGING')
      ) {
        await db.query("UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE id = $1", [
          row.id,
        ]);
        await db.query('COMMIT');
        continue;
      }
      await db.query(
        "UPDATE checkin_call_deliveries SET state = 'SENDING', tries = tries + 1, updated_at = now() WHERE id = $1",
        [row.id]
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      logger.error('checkin_call.delivery_claim_failed', { deliveryId: row.id, err });
      continue;
    } finally {
      db.release();
    }
    const incoming = delivery.kind === 'INCOMING_CALL';
    const urgent = delivery.severity === 'URGENT';
    const lang = delivery.lang === 'en' ? 'en' : 'vi';
    const message = t(
      incoming ? 'checkinCall.push.incoming_body' : 'checkinCall.push.confirm_body',
      lang
    );
    const payload = {
      type: 'checkin_call',
      checkinCall: true,
      episodeId: delivery.episode_id,
      attemptId: delivery.attempt_id,
      kind: delivery.kind,
      severity: delivery.severity,
      ringSeconds:
        delivery.config?.family_ring_seconds || delivery.config?.user_timeout_seconds || 60,
      lang,
    };
    const title = t(urgent ? 'checkinCall.push.urgent_title' : 'checkinCall.push.call_title', lang);
    const nativeCall = incoming || delivery.kind === 'URGENT_REPEAT';
    const [directFcm, directApns] = await Promise.all([
      delivery.fcm_token
        ? sendFcmNotification(delivery.fcm_token, title, message, payload, {
            incomingCall: nativeCall,
          })
        : Promise.resolve({ ok: false, error: 'NO_FCM_TOKEN' }),
      nativeCall && delivery.voip_push_token
        ? sendVoipNotification(delivery.voip_push_token, payload, {
            action: 'INCOMING_CALL',
            environment: delivery.voip_push_environment,
            title,
            body: message,
          })
        : Promise.resolve({ ok: false, error: 'NO_VOIP_TOKEN' }),
    ]);
    const nativeOk = directFcm.ok || directApns.ok;
    const expoFallback =
      !nativeOk && delivery.push_token
        ? await sendPushNotification([delivery.push_token], title, message, payload)
        : null;
    if (delivery.tries === 0) {
      await pool.query(
        "INSERT INTO notifications (user_id, type, title, message, data) VALUES ($1,'checkin_call',$2,$3,$4)",
        [delivery.target_user_id, title, message, JSON.stringify(payload)]
      );
    }
    const ticket = expoFallback?.data?.data?.[0];
    const expoOk = Boolean(expoFallback?.ok && ticket?.status === 'ok');
    const pushOk = nativeOk || expoOk;
    const pushError = nativeOk
      ? null
      : ticket?.message ||
        ticket?.details?.error ||
        expoFallback?.error ||
        directApns.error ||
        directFcm.error ||
        'PUSH_FAILED';
    const noReachableChannel =
      !delivery.push_token && !delivery.fcm_token && !(nativeCall && delivery.voip_push_token);
    await pool.query(
      "UPDATE checkin_call_deliveries SET state = $2, last_error = $3, updated_at = now(), due_at = CASE WHEN $2 = 'PENDING' THEN now() + (LEAST(tries, 5) * interval '30 seconds') ELSE due_at END WHERE id = $1",
      [
        delivery.id,
        pushOk ? 'SENT' : noReachableChannel || delivery.tries >= 3 ? 'FAILED' : 'PENDING',
        pushOk ? null : String(pushError).slice(0, 200),
      ]
    );
    await event(
      pool,
      delivery.episode_id,
      pushOk ? 'PUSH_ACCEPTED_BY_PROVIDER' : 'PUSH_DELIVERY_FAILED',
      null,
      delivery.attempt_id,
      {
        kind: delivery.kind,
        targetId: delivery.target_user_id,
        error: pushOk ? undefined : String(pushError).slice(0, 200),
      }
    );
    if (!pushOk)
      logger.warn('checkin_call.push_failed', {
        episodeId: delivery.episode_id,
        targetId: delivery.target_user_id,
        error: String(pushError).slice(0, 200),
      });
  }
  return pending.rowCount;
}

function testCallsEnabled() {
  return process.env.NODE_ENV !== 'production' || process.env.CHECKIN_CALL_TEST_ENABLED === 'true';
}

async function startTestCall(pool, userId) {
  if (!testCallsEnabled()) {
    throw serviceError(
      'Check-in call testing is disabled',
      403,
      'checkinCall.error.test_disabled'
    );
  }

  const recipient = await pool.query(
    'SELECT id, push_token, fcm_token, voip_push_token FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  const user = recipient.rows[0];
  const hasExpo = /^(Exponent|Expo)PushToken\[/.test(user?.push_token || '');
  if (!user || (!hasExpo && !user.fcm_token && !user.voip_push_token)) {
    throw serviceError(
      'Notifications are required for check-in call testing',
      409,
      'checkinCall.error.notifications_required'
    );
  }

  const previous = await pool.query(
    "SELECT id FROM checkin_call_episodes WHERE user_id = $1 AND COALESCE((config->>'test_mode')::boolean, false) = true",
    [userId]
  );
  for (const row of previous.rows) await endRemoteCalls(pool, row.id);

  const db = await pool.connect();
  let episode;
  let attempt;
  try {
    await db.query('BEGIN');
    await db.query(
      "DELETE FROM checkin_call_episodes WHERE user_id = $1 AND COALESCE((config->>'test_mode')::boolean, false) = true",
      [userId]
    );
    const current = await settings(db, userId);
    const config = {
      ...DEFAULTS,
      ...current,
      checkin_time: String(current.checkin_time || DEFAULTS.checkin_time).slice(0, 5),
      enabled: true,
      test_mode: true,
      user_timeout_seconds: 180,
    };
    const inserted = await db.query(
      `INSERT INTO checkin_call_episodes (
         user_id, local_date, state, severity, scheduled_at, grace_until, next_action_at, config
       ) VALUES ($1, DATE '2099-12-31', 'CONTACT_USER', 'NONE', now(), now(), NULL, $2::jsonb)
       RETURNING *`,
      [userId, JSON.stringify(config)]
    );
    episode = inserted.rows[0];
    attempt = await createAttempt(db, episode, userId, 'USER');
    await db.query(
      'UPDATE checkin_call_episodes SET next_action_at = $2, updated_at = now() WHERE id = $1',
      [episode.id, attempt.ring_deadline]
    );
    await event(db, episode.id, 'TEST_CALL_STARTED', userId, attempt.id);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }

  await dispatchDeliveries(pool);
  const delivery = await pool.query(
    'SELECT state FROM checkin_call_deliveries WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1',
    [attempt.id]
  );
  if (delivery.rows[0]?.state === 'FAILED') {
    throw serviceError(
      'Unable to deliver the test call',
      503,
      'checkinCall.error.test_delivery_failed'
    );
  }

  return {
    episode: {
      id: episode.id,
      user_id: episode.user_id,
      state: episode.state,
      severity: episode.severity,
    },
    attempt: {
      id: attempt.id,
      episode_id: episode.id,
      target_role: attempt.target_role,
      state: attempt.state,
    },
    delivery_state: delivery.rows[0]?.state || 'PENDING',
  };
}

module.exports = {
  DEFAULTS,
  validateSettings,
  settings,
  saveSettings,
  answer,
  getActive,
  getEpisode,
  getAttempt,
  seen,
  accept,
  confirmFamily,
  createDailyEpisodes,
  tick,
  dispatchDeliveries,
  startTestCall,
};
