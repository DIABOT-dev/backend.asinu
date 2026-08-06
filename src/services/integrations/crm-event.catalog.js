/**
 * ASINU → CRM event catalog.
 *
 * Keep this list aligned with crm-contracts/src/index.ts. The App backend
 * deliberately knows the complete contract, while only Phase 1 events are
 * emitted today. Health labels and Doctor/service events are deferred until
 * their source modules are implemented.
 */

const CRM_PHASE_ONE_EVENT_TYPES = Object.freeze([
  'user.created',
  'user.updated',
  'user.deleted',
  'profile.updated',
  'consent.updated',
  'app.opened',
  'screen.viewed',
  'session.started',
  'session.ended',
  'content.viewed',
  'content.saved',
  'checkin.started',
  'checkin.completed',
  'health_log.created',
  'mission.completed',
  'care_circle.updated',
  'chat.used',
  'payment.completed',
  'payment.refunded',
  'subscription.started',
  'subscription.activated',
  'subscription.renewed',
  'subscription.expiring',
  'subscription.cancelled',
  'subscription.expired',
]);

const CRM_DEFERRED_EVENT_TYPES = Object.freeze([
  'health.label.updated',
  'health.label.revoked',
  'service.requested',
  'service.dispatched',
  'service.accepted',
  'service.started',
  'service.updated',
  'service.completed',
  'service.cancelled',
  'service.expired',
]);

const CRM_EVENT_TYPES = Object.freeze([...CRM_PHASE_ONE_EVENT_TYPES, ...CRM_DEFERRED_EVENT_TYPES]);

const CRM_EVENT_TYPE_SET = new Set(CRM_EVENT_TYPES);

function isCrmEventType(eventType) {
  return typeof eventType === 'string' && CRM_EVENT_TYPE_SET.has(eventType);
}

function assertCrmEventType(eventType) {
  if (isCrmEventType(eventType)) return eventType;
  const error = new Error(`Unsupported CRM event type: ${String(eventType)}`);
  error.code = 'UNSUPPORTED_CRM_EVENT_TYPE';
  throw error;
}

module.exports = {
  CRM_EVENT_TYPES,
  CRM_PHASE_ONE_EVENT_TYPES,
  CRM_DEFERRED_EVENT_TYPES,
  isCrmEventType,
  assertCrmEventType,
};
