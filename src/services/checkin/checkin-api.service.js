'use strict';

const checkinService = require('./checkin.service');
const caregiverStatusService = require('../care-circle/caregiver-status.service');
const { markActive } = require('../profile/lifecycle.service');
const earlySignalService = require('../early-signal/early-signal.service');

function eventTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || Date.now());
}

async function startCheckin(pool, userId, status, locations, other, options) {
  const session = await checkinService.startCheckin(
    pool,
    userId,
    status,
    locations,
    other,
    options
  );
  // Update lifecycle before responding so re-engagement cannot read stale state.
  await markActive(pool, userId).catch((err) =>
    console.warn('[Lifecycle] markActive failed:', err.message)
  );
  earlySignalService
    .evaluateAfterNewHealthData(
      pool,
      userId,
      `checkin-start:${session.id}:${status}:${eventTimestamp(
        session.occurrence_started_at || session.updated_at
      )}`
    )
    .catch((err) => console.warn('[EarlySignal] check-in start evaluation failed:', err.message));
  return session;
}

async function recordFollowUp(pool, userId, checkinId, status) {
  const session = await checkinService.recordFollowUp(pool, userId, checkinId, status);
  if (!session) return { session: null, alreadyResolved: false };
  if (session.flow_state === 'resolved' && session.current_status !== status) {
    return { session, alreadyResolved: true };
  }
  earlySignalService
    .evaluateAfterNewHealthData(
      pool,
      userId,
      `checkin-followup:${session.id}:${status}:${eventTimestamp(session.updated_at)}`
    )
    .catch((err) => console.warn('[EarlySignal] follow-up evaluation failed:', err.message));
  return { session, alreadyResolved: false };
}

async function triggerEmergency(pool, userId, location) {
  const result = await checkinService.triggerEmergency(pool, userId, location);
  const caregiverStatus = await caregiverStatusService.buildCaregiverStatus(pool, userId, {
    riskTier: 'emergency',
  });
  return { ...result, ...caregiverStatus };
}

module.exports = { startCheckin, recordFollowUp, triggerEmergency };
