const { assertCrmEventType } = require('./crm-event.catalog');

const setOf = (...fields) => new Set(fields);

const USER_PROFILE_FIELDS = setOf(
  'user_id',
  'full_name',
  'phone',
  'email',
  'lead_source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'consent_ads',
  'timezone',
  'account_tier',
  'subscription_expires_at',
  'avatar_url',
  'birth_year',
  'gender',
  'zalo_user_id'
);

const ENGAGEMENT_FIELDS = setOf(
  'user_id',
  'session_id',
  'screen_name',
  'feature_code',
  'content_id',
  'feed_item_id',
  'content_type',
  'source_platform',
  'duration_sec',
  'action',
  'status',
  'state',
  'count',
  'mission_key',
  'chat_count',
  'chat_id',
  'provider',
  'tokens_used',
  'log_id',
  'log_type',
  'checkin_id',
  'flow_state',
  'occurred_at',
  'source',
  'content_action'
);

const CONSENT_FIELDS = setOf('user_id', 'consent_type', 'status', 'version');
const PROFILE_FIELDS = setOf('user_id', 'age_group', 'is_elderly');

const PAYMENT_FIELDS = setOf(
  'user_id',
  'external_ref',
  'transaction_id',
  'provider',
  'status',
  'amount_minor',
  'refund_amount_minor',
  'currency',
  'product_code',
  'paid_at',
  'refunded_at',
  'state',
  'payer_user_id',
  'beneficiary_user_id',
  'is_gift',
  'txn_type',
  'item_ref',
  'parent_external_ref',
  'original_external_ref',
  'occurred_at',
  'is_test_fixture'
);

const SUBSCRIPTION_FIELDS = setOf(
  'user_id',
  'subscription_id',
  'plan_code',
  'product_code',
  'state',
  'status',
  'expires_at',
  'started_at',
  'cancelled_at',
  'external_ref',
  'provider',
  'amount_minor',
  'currency',
  'paid_at',
  'payer_user_id',
  'beneficiary_user_id',
  'is_gift',
  'txn_type',
  'item_ref',
  'is_test_fixture'
);

const SERVICE_FIELDS = setOf(
  'user_id',
  'app_user_id',
  'app_order_id',
  'order_id',
  'service_code',
  'source_channel',
  'specialty',
  'service_flow',
  'priority',
  'summary',
  'consent_status',
  'consent_version',
  'patient_display_name',
  'patient_age_group',
  'patient_gender',
  'profile_version',
  'status',
  'state',
  'doctor_ref',
  'medical_record_ref',
  'expires_at'
);

const CARE_CIRCLE_FIELDS = setOf(
  'user_id',
  'patient_user_id',
  'caregiver_user_id',
  'guardian_user_id',
  'actor_user_id',
  'data_entry_user_id',
  'circle_owner_user_id',
  'connection_id',
  'relationship',
  'relationship_type',
  'role',
  'can_receive_alerts',
  'status'
);

const HEALTH_LABEL_FIELDS = setOf(
  'user_id',
  'subject_user_id',
  'label_code',
  'label_value',
  'tag_code',
  'action',
  'confidence',
  'consent_required',
  'consent_granted',
  'source',
  'medical_record_ref',
  'source_ref',
  'effective_at',
  'expires_at'
);

const EVENT_ALLOWLISTS = {
  'user.created': USER_PROFILE_FIELDS,
  'user.updated': USER_PROFILE_FIELDS,
  'user.deleted': setOf('user_id'),
  'profile.updated': PROFILE_FIELDS,
  'consent.updated': CONSENT_FIELDS,
  'app.opened': ENGAGEMENT_FIELDS,
  'screen.viewed': ENGAGEMENT_FIELDS,
  'session.started': ENGAGEMENT_FIELDS,
  'session.ended': ENGAGEMENT_FIELDS,
  'content.viewed': ENGAGEMENT_FIELDS,
  'content.saved': ENGAGEMENT_FIELDS,
  'checkin.started': ENGAGEMENT_FIELDS,
  'checkin.completed': ENGAGEMENT_FIELDS,
  'health_log.created': ENGAGEMENT_FIELDS,
  'mission.completed': ENGAGEMENT_FIELDS,
  'chat.used': ENGAGEMENT_FIELDS,
  'payment.completed': PAYMENT_FIELDS,
  'payment.refunded': PAYMENT_FIELDS,
  'subscription.started': SUBSCRIPTION_FIELDS,
  'subscription.activated': SUBSCRIPTION_FIELDS,
  'subscription.renewed': SUBSCRIPTION_FIELDS,
  'subscription.expiring': SUBSCRIPTION_FIELDS,
  'subscription.cancelled': SUBSCRIPTION_FIELDS,
  'subscription.expired': SUBSCRIPTION_FIELDS,
  'care_circle.updated': CARE_CIRCLE_FIELDS,
  'health.label.updated': HEALTH_LABEL_FIELDS,
  'health.label.revoked': HEALTH_LABEL_FIELDS,
  'service.requested': SERVICE_FIELDS,
  'service.dispatched': SERVICE_FIELDS,
  'service.accepted': SERVICE_FIELDS,
  'service.started': SERVICE_FIELDS,
  'service.updated': SERVICE_FIELDS,
  'service.completed': SERVICE_FIELDS,
  'service.cancelled': SERVICE_FIELDS,
  'service.expired': SERVICE_FIELDS,
};

const normalizeKey = (key) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

const isSafePrimitive = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const projectCrmPayload = (eventType, payload) => {
  assertCrmEventType(eventType);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};

  const allowlist = EVENT_ALLOWLISTS[eventType] || ENGAGEMENT_FIELDS;
  return Object.fromEntries(
    Object.entries(payload)
      .map(([key, value]) => [normalizeKey(key), value])
      .filter(([key, value]) => allowlist.has(key) && isSafePrimitive(value))
  );
};

const stripContactPii = (payload) => {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !['phone', 'phone_number', 'mobile', 'email', 'email_address'].includes(
              normalizeKey(key)
            )
        )
        .map(([key, childValue]) => [key, strip(childValue)])
    );
  };
  return strip(payload);
};

module.exports = { projectCrmPayload, stripContactPii };
