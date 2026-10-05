const { sendPushNotification } = require('../notification/push.notification.service');
const { sendFcmNotification } = require('../notification/fcm.notification.service');
const { sendVoipNotification } = require('../notification/apns.voip.service');
const logger = require('../../lib/logger');
const { t } = require('../../i18n');
const { emitCrmEventAsync } = require('../integrations/crm-event.service');
const entitlementService = require('../payment/entitlement.service');
const { familyContact, familyNotice } = require('./family-contact.service');
const { synthesizeText } = require('./audio.service');
const { recordCallResponse, refreshEarlySignals } = require('./response-history.service');
const {
  BODY_LOCATIONS,
  getLocationOptions,
  getSymptomOptionsForLocation,
} = require('../checkin/body-location');

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
const MILD_ISSUE_CATEGORIES = new Set([
  'MILD_FATIGUE',
  'MILD_DIZZY',
  'MILD_PAIN',
  'MILD_UNSPECIFIED',
]);
const URGENT_ISSUE_CATEGORIES = new Set(['URGENT_RED_FLAG', 'URGENT_UNSPECIFIED']);
const TRIAGE_INTENSITIES = new Set(['MILD', 'MODERATE', 'URGENT']);
const URGENT_TRIAGE_SYMPTOMS = new Set(['shortness_of_breath', 'chest_pain', 'fall', 'fainting']);
const TRIAGE_TIMEOUT_SECONDS = 180;
const INVALID_APNS_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

function normalizeComparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function issueCategoryForTriage(symptom, intensity) {
  if (intensity === 'URGENT') return 'URGENT_RED_FLAG';
  if (symptom === 'dizziness' || symptom === 'light_headed') return 'MILD_DIZZY';
  if (symptom === 'fatigue' || symptom === 'mental_fatigue') return 'MILD_FATIGUE';
  return symptom ? 'MILD_PAIN' : 'MILD_UNSPECIFIED';
}

function localizeTriageContext(context, lang = 'vi') {
  if (!context?.body_location) return null;
  const language = String(lang || '').startsWith('en') ? 'en' : 'vi';
  const location = getLocationOptions(language).find(
    (option) => option.key === context.body_location
  );
  const symptom = getSymptomOptionsForLocation(context.body_location, language).find(
    (option) => option.key === context.symptom
  );
  const intensity = t(
    `checkinCall.triage.intensity_${String(context.intensity || 'MILD').toLowerCase()}`,
    language
  );
  const parts = [location?.label, symptom?.label, intensity].filter(Boolean);
  return {
    body_location: location?.label || context.body_location,
    symptom: symptom?.label || context.symptom,
    intensity,
    summary: parts.join(' · '),
  };
}

function serviceError(message, statusCode, i18nKey, i18nParams) {
  return Object.assign(new Error(message), { statusCode, i18nKey, i18nParams });
}

function isSingleDeviceFamilyTest(episode) {
  return episode.config?.test_mode === true && episode.config?.single_device_family_test === true;
}

function invalidPushTokenChannels(directFcm, directApns, expoTicket) {
  const fcmError = String(directFcm?.error || '').toLowerCase();
  const apnsError = String(directApns?.error || '');
  return {
    fcm:
      directFcm?.ok === false &&
      (Number(directFcm.status) === 404 ||
        fcmError.includes('unregistered') ||
        fcmError.includes('registration-token-not-registered')),
    apns:
      directApns?.ok === false &&
      (Number(directApns.status) === 410 || INVALID_APNS_REASONS.has(apnsError)),
    expo: expoTicket?.status === 'error' && expoTicket?.details?.error === 'DeviceNotRegistered',
  };
}

async function clearInvalidPushTokens(pool, delivery, channels) {
  const updates = [];
  if (channels.fcm && delivery.fcm_token) {
    updates.push(
      pool.query('UPDATE users SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2', [
        delivery.target_user_id,
        delivery.fcm_token,
      ])
    );
  }
  if (channels.apns && delivery.voip_push_token) {
    updates.push(
      pool.query(
        'UPDATE users SET voip_push_token = NULL, voip_push_environment = NULL WHERE id = $1 AND voip_push_token = $2',
        [delivery.target_user_id, delivery.voip_push_token]
      )
    );
  }
  if (channels.expo && delivery.push_token) {
    updates.push(
      pool.query('UPDATE users SET push_token = NULL WHERE id = $1 AND push_token = $2', [
        delivery.target_user_id,
        delivery.push_token,
      ])
    );
  }
  if (updates.length) await Promise.all(updates);
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

async function eligibleContacts(pool, userId) {
  const ids = await familyFor(pool, userId);
  if (!ids.length) return [];
  const result = await pool.query(
    "SELECT u.id, COALESCE(NULLIF(trim(u.full_name), ''), NULLIF(trim(u.display_name), '')) AS name FROM unnest($1::integer[]) WITH ORDINALITY f(id, position) JOIN users u ON u.id = f.id ORDER BY f.position",
    [ids]
  );
  return result.rows;
}

async function saveSettings(pool, userId, input) {
  const entitlement = await entitlementService.getEntitlement(pool, userId);
  if (!entitlement.callCenterEnabled) {
    throw serviceError('An Tam plan required', 403, 'error.an_tam_required');
  }
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

  const crmType =
    name === 'OVERDUE'
      ? 'checkin_call.started'
      : name === 'URGENT_ACKNOWLEDGED'
        ? 'checkin_call.acknowledged'
        : name === 'USER_OK' || name === 'FAMILY_CONFIRMED'
          ? 'checkin_call.resolved'
          : ['EXHAUSTED', 'EXHAUSTED_MILD', 'EXHAUSTED_URGENT'].includes(name)
            ? 'checkin_call.exhausted'
            : null;
  if (!crmType) return;

  const episodeResult = await db.query(
    'SELECT user_id, state, severity, config FROM checkin_call_episodes WHERE id = $1',
    [episodeId]
  );
  const episode = episodeResult.rows[0];
  if (!episode) return;
  const inferredState =
    name === 'OVERDUE'
      ? 'CONTACT_USER'
      : name === 'USER_OK' || name === 'FAMILY_CONFIRMED'
        ? 'RESOLVED'
        : name;
  await emitCrmEventAsync(
    db,
    crmType,
    {
      user_id: String(episode.user_id),
      episode_id: String(episodeId),
      state: inferredState,
      severity: episode.severity || 'NONE',
      reason: detail.reason || undefined,
      resolution: detail.action || (name === 'USER_OK' ? 'USER_OK' : undefined),
      actor_user_id: actorId == null ? undefined : String(actorId),
      attempt_id: attemptId || undefined,
      source_platform: 'mobile',
      is_test_fixture: episode.config?.test_mode === true,
    },
    {
      event_id: `${crmType}:${episodeId}`,
      correlation_id: String(episodeId),
    }
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
  const ids = isSingleDeviceFamilyTest(episode)
    ? [Number(episode.user_id)]
    : await familyFor(db, episode.user_id);
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

async function buildTriageContext(db, userId, lang = 'vi') {
  const language = String(lang || '').startsWith('en') ? 'en' : 'vi';
  const [recentLocationResult, symptomResult, profileResult] = await Promise.all([
    db.query(
      `SELECT location, COUNT(*)::integer AS recent_count, MAX(h.session_date) AS last_reported
       FROM health_checkins h
       CROSS JOIN LATERAL unnest(
         COALESCE(
           h.body_locations,
           CASE WHEN h.body_location IS NOT NULL THEN ARRAY[h.body_location]::text[] END,
           ARRAY[]::text[]
         )
       ) AS location
       WHERE h.user_id = $1
         AND h.session_date >= CURRENT_DATE - INTERVAL '90 days'
       GROUP BY location`,
      [userId]
    ),
    db.query(
      `SELECT symptom_name, count_30d, last_occurred
       FROM symptom_frequency
       WHERE user_id = $1
       ORDER BY count_30d DESC, last_occurred DESC NULLS LAST
       LIMIT 30`,
      [userId]
    ),
    db.query(
      `SELECT chronic_symptoms
       FROM user_onboarding_profiles
       WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const recentLocations = new Map(
    recentLocationResult.rows.map((row) => [
      row.location,
      {
        count: Number(row.recent_count || 0),
        lastReported: row.last_reported || null,
      },
    ])
  );
  const symptomHistory = symptomResult.rows.map((row) => ({
    normalized: normalizeComparable(row.symptom_name),
    count: Number(row.count_30d || 0),
    lastReported: row.last_occurred || null,
  }));
  const profileSymptoms = Array.isArray(profileResult.rows[0]?.chronic_symptoms)
    ? profileResult.rows[0].chronic_symptoms.map(normalizeComparable).filter(Boolean)
    : [];

  const locations = getLocationOptions(language)
    .map((location, defaultIndex) => {
      const recent = recentLocations.get(location.key);
      const symptoms = getSymptomOptionsForLocation(location.key, language)
        .map((symptom, symptomIndex) => {
          const normalizedLabel = normalizeComparable(symptom.label);
          const history = symptomHistory.find(
            (item) =>
              item.normalized === normalizedLabel ||
              item.normalized.includes(normalizedLabel) ||
              normalizedLabel.includes(item.normalized)
          );
          const inProfile = profileSymptoms.some(
            (item) =>
              item === normalizedLabel ||
              item.includes(normalizedLabel) ||
              normalizedLabel.includes(item)
          );
          return {
            ...symptom,
            urgent: URGENT_TRIAGE_SYMPTOMS.has(symptom.key),
            recent: Boolean(history || inProfile),
            recent_count: history?.count || 0,
            last_reported: history?.lastReported || null,
            default_index: symptomIndex,
          };
        })
        .sort(
          (a, b) =>
            Number(b.recent) - Number(a.recent) ||
            b.recent_count - a.recent_count ||
            a.default_index - b.default_index
        )
        .map(({ default_index: _defaultIndex, ...symptom }) => symptom);
      return {
        ...location,
        recent: Boolean(recent),
        recent_count: recent?.count || 0,
        last_reported: recent?.lastReported || null,
        symptoms,
        default_index: defaultIndex,
      };
    })
    .sort(
      (a, b) =>
        Number(b.recent) - Number(a.recent) ||
        b.recent_count - a.recent_count ||
        a.default_index - b.default_index
    )
    .map(({ default_index: _defaultIndex, ...location }) => location);

  return {
    timeout_seconds: TRIAGE_TIMEOUT_SECONDS,
    has_recent_context:
      recentLocationResult.rows.length > 0 ||
      symptomResult.rows.length > 0 ||
      profileSymptoms.length > 0,
    locations,
  };
}

async function startTriage(pool, episodeId, userId, lang = 'vi') {
  return withEpisode(pool, episodeId, userId, async (db, episode) => {
    if (Number(episode.user_id) !== Number(userId))
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    if (!['CONTACT_USER', 'TRIAGE_USER'].includes(episode.state))
      throw serviceError(
        'Episode no longer accepting triage',
        409,
        'checkinCall.error.episode_not_accepting'
      );
    if (episode.state === 'CONTACT_USER') {
      const updated = await db.query(
        `UPDATE checkin_call_episodes
         SET state = 'TRIAGE_USER', triage_started_at = now(),
             next_action_at = now() + ($2::integer * interval '1 second'), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [episodeId, TRIAGE_TIMEOUT_SECONDS]
      );
      episode = updated.rows[0];
      await event(db, episodeId, 'USER_TRIAGE_STARTED', userId);
    }
    return {
      episode,
      triage: await buildTriageContext(db, userId, lang),
    };
  });
}

async function completeTriage(pool, episodeId, userId, input = {}) {
  const bodyLocation = String(input.body_location || '').trim();
  const symptom = String(input.symptom || '').trim();
  const intensity = String(input.intensity || '')
    .trim()
    .toUpperCase();
  const validSymptom = getSymptomOptionsForLocation(bodyLocation, 'vi').some(
    (option) => option.key === symptom
  );
  if (
    !BODY_LOCATIONS.includes(bodyLocation) ||
    !validSymptom ||
    !TRIAGE_INTENSITIES.has(intensity)
  ) {
    throw serviceError('Invalid triage response', 400, 'checkinCall.error.invalid_triage');
  }

  const result = await withEpisode(pool, episodeId, userId, async (db, episode) => {
    if (Number(episode.user_id) !== Number(userId))
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    if (episode.state !== 'TRIAGE_USER')
      throw serviceError(
        'Episode no longer accepting triage',
        409,
        'checkinCall.error.episode_not_accepting'
      );

    const finalIntensity =
      episode.severity === 'URGENT' || URGENT_TRIAGE_SYMPTOMS.has(symptom) ? 'URGENT' : intensity;
    const triageContext = { body_location: bodyLocation, symptom, intensity: finalIntensity };
    const issueCategory = issueCategoryForTriage(symptom, finalIntensity);
    await db.query(
      `UPDATE checkin_call_attempts SET state = 'COMPLETED', ended_at = now()
       WHERE episode_id = $1 AND target_role = 'USER' AND state IN ('RINGING','CONNECTED')`,
      [episodeId]
    );
    await db.query(
      `UPDATE checkin_call_episodes
       SET severity = $2, issue_category = $3, triage_context = $4::jsonb,
           triage_completed_at = now(), family_index = 0, updated_at = now()
       WHERE id = $1`,
      [
        episodeId,
        finalIntensity === 'URGENT' ? 'URGENT' : 'MILD',
        issueCategory,
        JSON.stringify(triageContext),
      ]
    );
    episode.severity = finalIntensity === 'URGENT' ? 'URGENT' : 'MILD';
    episode.issue_category = issueCategory;
    episode.triage_context = triageContext;
    await event(db, episodeId, 'USER_TRIAGE_COMPLETED', userId, null, triageContext);
    await recordCallResponse(
      db,
      episode,
      finalIntensity === 'URGENT' ? 'URGENT' : 'MILD',
      triageContext
    );

    if (finalIntensity === 'URGENT') await broadcastUrgent(db, episode);
    else await startNextFamily(db, episode);

    const updated = await db.query('SELECT * FROM checkin_call_episodes WHERE id = $1', [
      episodeId,
    ]);
    return updated.rows[0];
  });
  void refreshEarlySignals(pool, result);
  return result;
}

async function answer(pool, episodeId, userId, choice, requestedIssueCategory) {
  if (![1, 2, 3].includes(choice))
    throw serviceError('Invalid choice', 400, 'checkinCall.error.invalid_choice');
  const issueCategory =
    choice === 1
      ? null
      : String(requestedIssueCategory || (choice === 2 ? 'MILD_UNSPECIFIED' : 'URGENT_UNSPECIFIED'))
          .trim()
          .toUpperCase();
  if (
    (choice === 2 && !MILD_ISSUE_CATEGORIES.has(issueCategory)) ||
    (choice === 3 && !URGENT_ISSUE_CATEGORIES.has(issueCategory))
  ) {
    throw serviceError('Invalid issue category', 400, 'checkinCall.error.invalid_issue_category');
  }
  const result = await withEpisode(pool, episodeId, userId, async (db, episode) => {
    if (episode.user_id !== userId)
      throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    if (episode.state === 'RESOLVED' && choice === 1) return episode;
    if (!['CONTACT_USER', 'TRIAGE_USER'].includes(episode.state))
      throw serviceError(
        'Episode no longer accepting user answers',
        409,
        'checkinCall.error.episode_not_accepting'
      );
    await db.query(
      "UPDATE checkin_call_attempts SET state = 'COMPLETED', ended_at = now() WHERE episode_id = $1 AND target_role = 'USER' AND state IN ('RINGING','CONNECTED')",
      [episodeId]
    );
    const preserveUrgent = episode.severity === 'URGENT';
    await recordCallResponse(
      db,
      episode,
      preserveUrgent || choice === 3 ? 'URGENT' : choice === 2 ? 'MILD' : 'NONE'
    );
    if (preserveUrgent) {
      // A self-report cannot erase an existing urgent assessment.
      await event(
        db,
        episodeId,
        choice === 1 ? 'USER_OK_WITH_URGENT_SIGNAL' : 'USER_URGENT',
        userId,
        null,
        { choice }
      );
      await broadcastUrgent(db, episode);
    } else if (choice === 1) {
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'RESOLVED', severity = 'NONE', resolved_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1",
        [episodeId]
      );
      await event(db, episodeId, 'USER_OK', userId);
    } else if (choice === 2) {
      await db.query(
        "UPDATE checkin_call_episodes SET severity = 'MILD', issue_category = $2, family_index = 0, updated_at = now() WHERE id = $1",
        [episodeId, issueCategory]
      );
      episode.severity = 'MILD';
      episode.issue_category = issueCategory;
      await event(db, episodeId, 'USER_MILD', userId, null, { issueCategory });
      await startNextFamily(db, episode);
    } else {
      await db.query(
        'UPDATE checkin_call_episodes SET issue_category = $2, updated_at = now() WHERE id = $1',
        [episodeId, issueCategory]
      );
      episode.issue_category = issueCategory;
      await event(db, episodeId, 'USER_URGENT', userId, null, { issueCategory });
      await broadcastUrgent(db, episode);
    }
    const updated = await db.query('SELECT * FROM checkin_call_episodes WHERE id = $1', [
      episodeId,
    ]);
    return updated.rows[0];
  });
  void refreshEarlySignals(pool, result);
  return result;
}

async function getActive(pool, userId) {
  const result = await pool.query(
    "SELECT e.id, e.user_id, e.state, e.severity, e.issue_category, e.triage_context, e.acknowledged_by, COALESCE((e.config->>'local_callkit_simulation')::boolean, false) AS local_callkit_simulation, a.id AS attempt_id, a.target_role, a.state AS attempt_state FROM checkin_call_attempts a " +
      'JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.target_user_id = $1 ' +
      "AND a.state IN ('RINGING','CONNECTED','WAITING_CONFIRMATION','PUSH_WAIT') " +
      "AND (e.state NOT IN ('RESOLVED','EXHAUSTED','EXHAUSTED_MILD','EXHAUSTED_URGENT','CANCELLED','URGENT_ACKNOWLEDGED') " +
      "OR (e.state = 'URGENT_ACKNOWLEDGED' AND e.acknowledged_by = $1 AND a.state = 'CONNECTED')) " +
      'ORDER BY a.created_at DESC LIMIT 1',
    [userId]
  );
  const active = result.rows[0] || null;
  if (active && !active.triage_context?.body_location) active.triage_context = null;
  return active;
}

async function getEpisode(pool, episodeId, userId, lang = 'vi') {
  const result = await pool.query(
    'SELECT e.id, e.user_id, e.state, e.severity, e.issue_category, e.triage_context, e.acknowledged_by, e.created_at, e.resolved_at, e.exhausted_at, e.updated_at, e.trigger_source, e.next_action_at, e.triage_started_at, e.triage_completed_at, ' +
      "COALESCE(NULLIF(trim(ack.full_name), ''), NULLIF(trim(ack.display_name), '')) AS acknowledged_name, " +
      "(SELECT v.detail->>'reason' FROM checkin_call_events v WHERE v.episode_id = e.id AND v.event = 'CANCELLED' ORDER BY v.id DESC LIMIT 1) AS cancellation_reason " +
      'FROM checkin_call_episodes e LEFT JOIN users ack ON ack.id = e.acknowledged_by WHERE e.id = $1 AND (e.user_id = $2 OR $2 = ANY(e.family_ids))',
    [episodeId, userId]
  );
  const episode = result.rows[0] || null;
  if (episode) {
    if (!episode.triage_context?.body_location) episode.triage_context = null;
    episode.triage_display = localizeTriageContext(episode.triage_context, lang);
  }
  return episode;
}

async function getAttempt(pool, attemptId, userId, lang = 'vi') {
  const result = await pool.query(
    'SELECT a.id, a.episode_id, a.target_role, a.state, a.ring_deadline, a.confirm_deadline, a.ended_at, a.target_user_id, e.acknowledged_by, e.resolved_at, e.exhausted_at, e.trigger_source, e.next_action_at, e.state AS episode_state, e.severity, e.issue_category, e.triage_context, ' +
      "(SELECT v.detail->>'reason' FROM checkin_call_events v WHERE v.episode_id = e.id AND v.event = 'CANCELLED' ORDER BY v.id DESC LIMIT 1) AS cancellation_reason, " +
      "COALESCE(NULLIF(trim(subject.full_name), ''), NULLIF(trim(subject.display_name), '')) AS subject_name, subject.phone_number AS subject_phone, profile.gender AS subject_gender, c.relationship_type, c.requester_id AS relationship_requester_id " +
      'FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id ' +
      'JOIN users subject ON subject.id = e.user_id ' +
      'LEFT JOIN user_onboarding_profiles profile ON profile.user_id = subject.id ' +
      'LEFT JOIN LATERAL (SELECT relationship_type, requester_id FROM user_connections ' +
      "WHERE status = 'accepted' AND ((requester_id = $2 AND addressee_id = e.user_id) OR (addressee_id = $2 AND requester_id = e.user_id)) ORDER BY updated_at DESC LIMIT 1) c ON true " +
      'WHERE a.id = $1 AND a.target_user_id = $2',
    [attemptId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  // Do not leak internal join columns or an unrelated person's profile.
  const {
    subject_name,
    subject_phone,
    subject_gender,
    relationship_type,
    relationship_requester_id,
    ...attempt
  } = row;
  if (attempt) {
    if (!attempt.triage_context?.body_location) attempt.triage_context = null;
    attempt.triage_display = localizeTriageContext(attempt.triage_context, lang);
    if (attempt.target_role === 'FAMILY') {
      attempt.subject = familyContact(
        {
          subject_name,
          subject_phone,
          subject_gender,
          relationship_type,
          relationship_requester_id,
        },
        userId,
        lang
      );
      attempt.family_notice = familyNotice(attempt, attempt.subject, lang);
    }
  }
  return attempt;
}

async function getFamilyAudio(pool, attemptId, userId, lang = 'vi') {
  // Authorize the exact attempt before exposing identity or requesting TTS.
  const attempt = await getAttempt(pool, attemptId, userId, lang);
  if (!attempt || attempt.target_role !== 'FAMILY') {
    throw serviceError('Family attempt not found', 404, 'checkinCall.error.attempt_not_found');
  }
  return synthesizeText(attempt.family_notice.audio_text, lang);
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

async function decline(pool, attemptId, userId) {
  const found = await pool.query(
    'SELECT episode_id FROM checkin_call_attempts WHERE id = $1 AND target_user_id = $2',
    [attemptId, userId]
  );
  if (!found.rows.length)
    throw serviceError('Attempt not found', 404, 'checkinCall.error.attempt_not_found');
  const episodeId = found.rows[0].episode_id;
  await withEpisode(pool, episodeId, userId, async (db, episode) => {
    const current = await db.query(
      'SELECT * FROM checkin_call_attempts WHERE id = $1 AND target_user_id = $2 FOR UPDATE',
      [attemptId, userId]
    );
    const attempt = current.rows[0];
    if (
      !attempt ||
      TERMINAL.has(episode.state) ||
      !['RINGING', 'CONNECTED', 'PUSH_WAIT', 'WAITING_CONFIRMATION'].includes(attempt.state)
    )
      return;
    await db.query(
      "UPDATE checkin_call_attempts SET state = 'NO_ANSWER', ended_at = now() WHERE id = $1",
      [attemptId]
    );
    await db.query(
      "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE attempt_id = $1 AND state IN ('PENDING','SENDING')",
      [attemptId]
    );
    await event(db, episodeId, 'CALL_DECLINED', userId, attemptId);
    if (episode.state !== 'URGENT_BROADCAST') {
      await db.query(
        'UPDATE checkin_call_episodes SET next_action_at = now(), updated_at = now() WHERE id = $1',
        [episodeId]
      );
    }
  });
  await endRemoteCalls(pool, episodeId, null, attemptId);
  return { ok: true };
}

async function endRemoteCalls(pool, episodeId, exceptAttemptId = null, onlyAttemptId = null) {
  if (!pool?.query) return;
  try {
    const result = await pool.query(
      "SELECT a.id AS attempt_id, u.fcm_token, COALESCE(u.language_preference, 'vi') AS lang " +
        'FROM checkin_call_attempts a JOIN users u ON u.id = a.target_user_id ' +
        'WHERE a.episode_id = $1 AND ($2::uuid IS NULL OR a.id != $2::uuid) ' +
        'AND ($3::uuid IS NULL OR a.id = $3::uuid)',
      [episodeId, exceptAttemptId, onlyAttemptId]
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
        // Never send END_CALL over PushKit. iOS requires a new CallKit report
        // for each VoIP push, including ones received after the call ended.
        // iOS ends via the authenticated call-state polling/answer rejection
        // in the app and the existing native ringing/response deadlines.
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

async function cancelActiveForManualCheckin(pool, userId) {
  const db = await pool.connect();
  let episodeIds = [];
  try {
    await db.query('BEGIN');
    const active = await db.query(
      "SELECT id FROM checkin_call_episodes WHERE user_id = $1 AND trigger_source = 'MISSED_CHECKIN' AND severity <> 'URGENT' AND state NOT IN ('RESOLVED','EXHAUSTED','EXHAUSTED_MILD','EXHAUSTED_URGENT','CANCELLED','URGENT_ACKNOWLEDGED') FOR UPDATE",
      [userId]
    );
    episodeIds = active.rows.map((row) => row.id);
    if (episodeIds.length) {
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'CANCELLED', next_action_at = NULL, updated_at = now() WHERE id = ANY($1::uuid[])",
        [episodeIds]
      );
      await db.query(
        "UPDATE checkin_call_attempts SET state = 'CANCELLED', ended_at = COALESCE(ended_at, now()) WHERE episode_id = ANY($1::uuid[]) AND state IN ('RINGING','CONNECTED','PUSH_WAIT','WAITING_CONFIRMATION')",
        [episodeIds]
      );
      await db.query(
        "UPDATE checkin_call_deliveries SET state = 'CANCELLED', updated_at = now() WHERE episode_id = ANY($1::uuid[]) AND state IN ('PENDING','SENDING')",
        [episodeIds]
      );
      for (const episodeId of episodeIds) {
        await event(db, episodeId, 'CANCELLED', userId, null, {
          reason: 'MANUAL_CHECKIN',
        });
      }
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  for (const episodeId of episodeIds) await endRemoteCalls(pool, episodeId);
  return episodeIds.length;
}

async function accept(pool, attemptId, userId) {
  const db = await pool.connect();
  let result;
  try {
    await db.query('BEGIN');
    const found = await db.query(
      'SELECT e.*, a.target_role, a.state AS attempt_state, a.confirm_deadline FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE a.id = $1 AND a.target_user_id = $2 FOR UPDATE OF e',
      [attemptId, userId]
    );
    const episode = found.rows[0];
    if (!episode)
      throw serviceError('Attempt not found', 404, 'checkinCall.error.attempt_not_found');

    const isOwnedUrgentCall =
      episode.state === 'URGENT_ACKNOWLEDGED' && Number(episode.acknowledged_by) === Number(userId);
    const isAlreadyAccepted =
      episode.attempt_state === 'CONNECTED' && (!TERMINAL.has(episode.state) || isOwnedUrgentCall);

    // Accept can be sent twice when CallKit/ConnectionService opens the app and
    // the React screen retries. Return the current state instead of a false 409.
    if (isAlreadyAccepted) {
      result = {
        ok: true,
        state: episode.state,
        confirm_deadline: episode.confirm_deadline,
        alreadyAccepted: true,
      };
    } else if (TERMINAL.has(episode.state)) {
      throw serviceError('Episode closed', 409, 'checkinCall.error.episode_closed');
    } else if (!['RINGING', 'PUSH_WAIT'].includes(episode.attempt_state)) {
      throw serviceError('Attempt closed', 409, 'checkinCall.error.attempt_closed');
    } else if (episode.target_role === 'FAMILY' && episode.state === 'URGENT_BROADCAST') {
      // Picking up is not a commitment to check. Keep other relatives reachable.
      const connected = await db.query(
        "UPDATE checkin_call_attempts SET state = 'CONNECTED', connected_at = now(), confirm_deadline = LEAST(now() + interval '120 seconds', $2::timestamptz) WHERE id = $1 RETURNING confirm_deadline",
        [attemptId, episode.urgent_until]
      );
      await db.query(
        "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE attempt_id = $1 AND state = 'PENDING'",
        [attemptId]
      );
      await event(db, episode.id, 'CALL_ACCEPTED', userId, attemptId);
      result = {
        ok: true,
        state: episode.state,
        confirm_deadline: connected.rows[0]?.confirm_deadline || null,
      };
    } else {
      const seconds =
        episode.target_role === 'USER'
          ? Number(episode.config.user_timeout_seconds)
          : Number(episode.config.family_confirm_minutes) * 60;
      const connected = await db.query(
        "UPDATE checkin_call_attempts SET state = 'CONNECTED', connected_at = now(), confirm_deadline = now() + ($2::integer * interval '1 second') WHERE id = $1 RETURNING confirm_deadline",
        [attemptId, seconds]
      );
      await db.query(
        "UPDATE checkin_call_episodes SET next_action_at = now() + ($2::integer * interval '1 second'), updated_at = now() WHERE id = $1",
        [episode.id, seconds]
      );
      await event(db, episode.id, 'CALL_ACCEPTED', userId, attemptId);
      result = {
        ok: true,
        state: episode.state,
        confirm_deadline: connected.rows[0]?.confirm_deadline || null,
      };
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
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
      ![
        'MILD_FAMILY_ESCALATION',
        'CONTACT_FAMILY',
        'URGENT_BROADCAST',
        'URGENT_ACKNOWLEDGED',
      ].includes(episode.state)
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
        "SELECT 1 FROM checkin_call_attempts WHERE episode_id = $1 AND target_user_id = $2 AND target_role = 'FAMILY' AND state IN ('RINGING','CONNECTED','PUSH_WAIT','WAITING_CONFIRMATION') AND (confirm_deadline IS NULL OR confirm_deadline > now()) LIMIT 1",
        [episodeId, userId]
      );
      if (!contacted.rows.length)
        throw serviceError(
          'No active family alert',
          409,
          'checkinCall.error.no_active_family_alert'
        );
    }
    const isTestFamilyActor =
      isSingleDeviceFamilyTest(episode) && Number(episode.user_id) === Number(userId);
    if (!isTestFamilyActor) {
      const permission = await db.query(
        "SELECT 1 FROM user_connections WHERE status = 'accepted' AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)) " +
          "AND COALESCE((permissions->>'can_ack_escalation')::boolean,false) = true",
        [episode.user_id, userId]
      );
      if (!permission.rows.length)
        throw serviceError('Forbidden', 403, 'checkinCall.error.forbidden');
    }
    const resolved = await db.query(
      "UPDATE checkin_call_episodes SET state = 'RESOLVED', acknowledged_by = $2, resolved_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [episodeId, userId]
    );
    await db.query(
      "UPDATE checkin_call_attempts SET state = CASE WHEN target_user_id = $2 THEN 'COMPLETED' ELSE 'CANCELLED' END, ended_at = now() WHERE episode_id = $1 AND state IN ('RINGING','CONNECTED','PUSH_WAIT','WAITING_CONFIRMATION')",
      [episodeId, userId]
    );
    await db.query(
      "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE episode_id = $1 AND state IN ('PENDING','SENDING')",
      [episodeId]
    );
    await event(db, episodeId, 'FAMILY_CONFIRMED', userId, null, { action });
    return resolved.rows[0] || { ...episode, state: 'RESOLVED', acknowledged_by: userId };
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
      "JOIN subscription_household_members hm ON hm.user_id = s.user_id AND hm.status = 'active' " +
      "JOIN subscription_households h ON h.id = hm.household_id AND h.plan_code <> 'free' " +
      "AND h.status IN ('active','grace_period') AND h.current_period_end > now() " +
      'WHERE s.enabled = true AND u.deleted_at IS NULL AND (now() AT TIME ZONE s.timezone)::time >= s.checkin_time ' +
      'ON CONFLICT DO NOTHING RETURNING id'
  );
  return result.rowCount;
}

async function startEarlySignalEpisode(pool, userId, assessmentId) {
  const entitlement = await entitlementService.getEntitlement(pool, userId);
  if (!entitlement.callCenterEnabled) return null;

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const activeUrgent = await db.query(
      "SELECT * FROM checkin_call_episodes WHERE user_id = $1 AND severity = 'URGENT' AND state IN ('CONTACT_USER','TRIAGE_USER','URGENT_BROADCAST','URGENT_ACKNOWLEDGED') ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    if (activeUrgent.rows.length) {
      await event(db, activeUrgent.rows[0].id, 'EARLY_SIGNAL_ATTACHED', null, null, {
        assessmentId,
      });
      await db.query('COMMIT');
      return activeUrgent.rows[0];
    }
    const current = await settings(db, userId);
    const config = {
      ...DEFAULTS,
      ...current,
      checkin_time: String(current.checkin_time || DEFAULTS.checkin_time).slice(0, 5),
      enabled: true,
      early_signal: true,
    };
    const inserted = await db.query(
      `INSERT INTO checkin_call_episodes (
         user_id, local_date, state, severity, scheduled_at, grace_until,
         next_action_at, config, trigger_source, early_signal_assessment_id
       ) VALUES ($1, (now() AT TIME ZONE $2)::date, 'CONTACT_USER', 'URGENT',
                 now(), now(), NULL, $3::jsonb, 'EARLY_SIGNAL', $4)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [userId, config.timezone, JSON.stringify(config), assessmentId]
    );
    if (!inserted.rowCount) {
      const existing = await db.query(
        'SELECT * FROM checkin_call_episodes WHERE early_signal_assessment_id = $1',
        [assessmentId]
      );
      await db.query('COMMIT');
      return existing.rows[0] || null;
    }
    const episode = inserted.rows[0];
    const attempt = await createAttempt(db, episode, userId, 'USER');
    await db.query(
      'UPDATE checkin_call_episodes SET next_action_at = $2, updated_at = now() WHERE id = $1',
      [episode.id, attempt.ring_deadline]
    );
    await event(db, episode.id, 'EARLY_SIGNAL_CONTACT_USER', null, attempt.id, {
      assessmentId,
    });
    await db.query('COMMIT');
    return episode;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function advance(pool, id) {
  const remoteEnd = await withEpisode(pool, id, null, async (db, episode) => {
    if (episode.state === 'URGENT_ACKNOWLEDGED') {
      // Recover calls accepted by the older backend which stopped the entire
      // escalation on pickup and had no confirmation deadline.
      const connected = await db.query(
        "SELECT connected_at FROM checkin_call_attempts WHERE episode_id = $1 AND target_role = 'FAMILY' AND state = 'CONNECTED' ORDER BY connected_at DESC LIMIT 1",
        [id]
      );
      const waitingUntil = connected.rows[0]?.connected_at
        ? new Date(connected.rows[0].connected_at).getTime() + 120_000
        : 0;
      if (waitingUntil > Date.now() && new Date(episode.urgent_until) > new Date()) return;
      await db.query(
        "UPDATE checkin_call_episodes SET state = 'URGENT_BROADCAST', acknowledged_by = NULL, next_action_at = now(), updated_at = now() WHERE id = $1",
        [id]
      );
      await event(db, id, 'URGENT_CONFIRMATION_TIMEOUT');
      episode.state = 'URGENT_BROADCAST';
      episode.next_action_at = new Date();
    }
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
      // A schedule can outlive its subscription or household membership.
      // Recheck access before starting a new call, without interrupting an
      // escalation that has already started.
      const entitlement = await entitlementService.getEntitlement(db, episode.user_id);
      if (!entitlement.callCenterEnabled) {
        await db.query(
          "UPDATE checkin_call_episodes SET state = 'CANCELLED', next_action_at = NULL, updated_at = now() WHERE id = $1",
          [id]
        );
        await event(db, id, 'CANCELLED', null, null, { reason: 'ENTITLEMENT_REVOKED' });
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
    } else if (episode.state === 'CONTACT_USER' || episode.state === 'TRIAGE_USER') {
      // A pre-existing urgent assessment must not become a routine missed check-in
      // just because the protected person could not answer the call.
      const urgentTimeout = episode.severity === 'URGENT';
      const severity = urgentTimeout ? 'URGENT' : 'UNKNOWN';
      const issueCategory = urgentTimeout
        ? URGENT_ISSUE_CATEGORIES.has(episode.issue_category)
          ? episode.issue_category
          : episode.config?.early_signal === true
            ? 'URGENT_RED_FLAG'
            : 'URGENT_UNSPECIFIED'
        : 'UNKNOWN';
      await db.query(
        'UPDATE checkin_call_episodes SET severity = $2, issue_category = $3, updated_at = now() WHERE id = $1',
        [id, severity, issueCategory]
      );
      episode.severity = severity;
      episode.issue_category = issueCategory;
      const ended = await db.query(
        "UPDATE checkin_call_attempts SET state = 'NO_ANSWER', ended_at = now() WHERE episode_id = $1 AND target_role = 'USER' AND state IN ('RINGING','CONNECTED') RETURNING id",
        [id]
      );
      await event(db, id, episode.state === 'TRIAGE_USER' ? 'USER_TRIAGE_TIMEOUT' : 'USER_TIMEOUT');
      if (urgentTimeout) await broadcastUrgent(db, episode);
      else await startNextFamily(db, episode);
      return { attemptIds: ended.rows.map((row) => row.id) };
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
        return { attemptIds: [attempt.id] };
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
        return { all: true };
      } else {
        const expired = [];
        for (const familyId of episode.family_ids) {
          const found = await db.query(
            "SELECT * FROM checkin_call_attempts WHERE episode_id = $1 AND target_user_id = $2 AND target_role = 'FAMILY' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
            [id, familyId]
          );
          const attempt = found.rows[0];
          // Do not ring over somebody who is reading the alert. A pickup has a
          // bounded confirmation window; if it lapses, a fresh call can resume.
          if (attempt?.state === 'CONNECTED' && new Date(attempt.confirm_deadline) > new Date())
            continue;
          if (
            !attempt ||
            ['CONNECTED', 'EXPIRED', 'CANCELLED', 'NO_ANSWER'].includes(attempt.state) ||
            (attempt.state === 'RINGING' && new Date(attempt.ring_deadline) <= new Date())
          ) {
            if (attempt) {
              await db.query(
                "UPDATE checkin_call_attempts SET state = 'EXPIRED', ended_at = now() WHERE id = $1",
                [attempt.id]
              );
              await db.query(
                "UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE attempt_id = $1 AND state IN ('PENDING','SENDING')",
                [attempt.id]
              );
              await event(db, id, 'FAMILY_TIMEOUT', null, attempt.id);
              expired.push(attempt.id);
            }
            await createAttempt(db, episode, familyId, 'FAMILY');
            continue;
          }
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
        return { attemptIds: expired };
      }
    }
  });
  if (remoteEnd?.all) await endRemoteCalls(pool, id);
  else {
    for (const attemptId of remoteEnd?.attemptIds || []) {
      await endRemoteCalls(pool, id, null, attemptId);
    }
  }
  return remoteEnd;
}

async function tick(pool) {
  await createDailyEpisodes(pool);
  const due = await pool.query(
    "SELECT id FROM checkin_call_episodes WHERE next_action_at <= now() OR state = 'URGENT_ACKNOWLEDGED' ORDER BY COALESCE(next_action_at, created_at) LIMIT 100"
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
        'SELECT d.*, e.state AS episode_state, e.severity, e.issue_category, e.config, a.state AS attempt_state, a.target_role, ' +
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
        (delivery.kind === 'URGENT_REPEAT' && delivery.attempt_state !== 'RINGING') ||
        (delivery.kind === 'INCOMING_CALL' && delivery.attempt_state !== 'RINGING')
      ) {
        await db.query("UPDATE checkin_call_deliveries SET state = 'CANCELLED' WHERE id = $1", [
          row.id,
        ]);
        await db.query('COMMIT');
        continue;
      }
      if (delivery.config?.local_callkit_simulation === true) {
        await db.query(
          "UPDATE checkin_call_deliveries SET state = 'SENT', tries = tries + 1, last_error = NULL, updated_at = now() WHERE id = $1",
          [row.id]
        );
        await event(
          db,
          delivery.episode_id,
          'LOCAL_CALLKIT_SIMULATION_READY',
          delivery.target_user_id,
          delivery.attempt_id,
          { kind: delivery.kind }
        );
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
      issueCategory: delivery.issue_category || undefined,
      ringSeconds:
        delivery.target_role === 'USER'
          ? delivery.config?.user_timeout_seconds || 60
          : delivery.config?.family_ring_seconds || 60,
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
      incoming && delivery.voip_push_token
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
    const invalidChannels = invalidPushTokenChannels(directFcm, directApns, ticket);
    await clearInvalidPushTokens(pool, delivery, invalidChannels);
    const expoOk = Boolean(expoFallback?.ok && ticket?.status === 'ok');
    const pushOk = nativeOk || expoOk;
    const pushError = nativeOk
      ? null
      : ticket?.message ||
        ticket?.details?.error ||
        expoFallback?.error ||
        (incoming && delivery.voip_push_token && directApns.error) ||
        (delivery.fcm_token && directFcm.error) ||
        'NO_REACHABLE_PUSH_TOKEN';
    const noReachableChannel =
      !delivery.push_token && !delivery.fcm_token && !(incoming && delivery.voip_push_token);
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

async function startTestCall(pool, userId, options = {}) {
  if (!testCallsEnabled()) {
    throw serviceError('Check-in call testing is disabled', 403, 'checkinCall.error.test_disabled');
  }
  if (process.env.NODE_ENV === 'production') {
    const entitlement = await entitlementService.getEntitlement(pool, userId);
    if (!entitlement.callCenterEnabled) {
      throw serviceError('An Tam plan required', 403, 'error.an_tam_required');
    }
  }

  const recipient = await pool.query(
    'SELECT id, push_token, fcm_token, voip_push_token FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  const user = recipient.rows[0];
  const hasExpo = /^(Exponent|Expo)PushToken\[/.test(user?.push_token || '');
  const localSimulation = process.env.NODE_ENV !== 'production' && options.localSimulation === true;
  if (!user || (!localSimulation && !hasExpo && !user.fcm_token && !user.voip_push_token)) {
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
    const singleDeviceFamily = options.singleDeviceFamily === true;
    const config = {
      ...DEFAULTS,
      ...current,
      checkin_time: String(current.checkin_time || DEFAULTS.checkin_time).slice(0, 5),
      enabled: true,
      test_mode: true,
      single_device_family_test: singleDeviceFamily,
      local_callkit_simulation: localSimulation,
      user_timeout_seconds: 180,
    };
    const inserted = await db.query(
      `INSERT INTO checkin_call_episodes (
         user_id, local_date, state, severity, scheduled_at, grace_until, next_action_at, config,
         family_ids
       ) VALUES ($1, DATE '2099-12-31', 'CONTACT_USER', 'NONE', now(), now(), NULL, $2::jsonb,
         $3::integer[])
       RETURNING *`,
      [userId, JSON.stringify(config), singleDeviceFamily ? [userId] : []]
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
    local_simulation: localSimulation,
  };
}

module.exports = {
  DEFAULTS,
  validateSettings,
  settings,
  eligibleContacts,
  saveSettings,
  answer,
  startTriage,
  completeTriage,
  getActive,
  getEpisode,
  getAttempt,
  getFamilyAudio,
  seen,
  decline,
  accept,
  confirmFamily,
  createDailyEpisodes,
  advance,
  tick,
  dispatchDeliveries,
  startTestCall,
  startEarlySignalEpisode,
  cancelActiveForManualCheckin,
  _test: { invalidPushTokenChannels },
};
