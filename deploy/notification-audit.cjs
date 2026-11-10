'use strict';

// Read-only production diagnostics. Never print recipients, device tokens,
// notification text or payloads. Counts are candidates, not delivery receipts.
const queries = {
  followup_completion_mismatch: `SELECT n.type,count(*)::int notices,
    count(*) FILTER(WHERE hc.triage_completed_at <= n.created_at)::int completed_before_notice,
    count(*) FILTER(WHERE hc.triage_completed_at <= n.created_at
      AND strpos(n.message,'chưa hoàn tất check-in')>0)::int incomplete_wording_after_completed,
    count(*) FILTER(WHERE hc.last_response_at > n.created_at)::int later_patient_response
    FROM notifications n JOIN health_checkins hc ON hc.id::text=n.data->>'checkinId'
      AND hc.user_id=n.user_id
    WHERE n.created_at>=NOW()-INTERVAL '7 days'
      AND n.type IN ('checkin_followup','checkin_followup_urgent') GROUP BY n.type`,
  volume_7d: `SELECT n.type, count(*)::int inbox_rows,
    count(*) FILTER(WHERE o.state='SENT')::int accepted_pushes,
    count(*) FILTER(WHERE o.attempts>1)::int retried_pushes,
    count(*) FILTER(WHERE o.notification_id IS NULL)::int without_standard_outbox
    FROM notifications n LEFT JOIN notification_push_outbox o ON o.notification_id=n.id
    WHERE n.created_at>=NOW()-INTERVAL '7 days' GROUP BY n.type ORDER BY count(*) DESC`,
  identical_within_5m: `WITH ordered AS (
    SELECT type,created_at,LAG(created_at) OVER(
      PARTITION BY user_id,type,md5(jsonb_build_array(title,message,data)::text)
      ORDER BY created_at,id) previous_at
    FROM notifications WHERE created_at>=NOW()-INTERVAL '7 days'
  ) SELECT type,count(*)::int repeated_pairs FROM ordered
    WHERE created_at-previous_at<=INTERVAL '5 minutes' GROUP BY type ORDER BY count(*) DESC`,
  repeated_stable_event: `WITH identified AS (
    SELECT user_id,type,CASE
      WHEN COALESCE(data->>'eventId',data->>'event_id') IS NOT NULL
        THEN 'event:'||COALESCE(data->>'eventId',data->>'event_id')
      WHEN COALESCE(data->>'messageId',data->>'message_id') IS NOT NULL
        THEN 'message:'||COALESCE(data->>'messageId',data->>'message_id')
      WHEN COALESCE(data->>'paymentId',data->>'payment_id') IS NOT NULL
        THEN 'payment:'||COALESCE(data->>'paymentId',data->>'payment_id')
      WHEN data->>'assessmentId' IS NOT NULL THEN 'assessment:'||(data->>'assessmentId')
      WHEN data->>'attemptId' IS NOT NULL THEN 'attempt:'||(data->>'attemptId')||':'||COALESCE(data->>'kind','')
    END identity,created_at
    FROM notifications WHERE created_at>=NOW()-INTERVAL '7 days'
  ), repeated AS (
    SELECT type,count(*) amount FROM identified WHERE identity IS NOT NULL
    GROUP BY user_id,type,identity HAVING count(*)>1
  ) SELECT type,count(*)::int repeated_event_groups,sum(amount-1)::int extra_inbox_rows
    FROM repeated GROUP BY type ORDER BY sum(amount-1) DESC`,
  cross_type_identical_within_5m: `WITH ordered AS (
    SELECT type,created_at,
      LAG(type) OVER w previous_type,LAG(created_at) OVER w previous_at
    FROM notifications WHERE created_at>=NOW()-INTERVAL '7 days'
    WINDOW w AS(PARTITION BY user_id,md5(jsonb_build_array(title,message)::text)
      ORDER BY created_at,id)
  ) SELECT previous_type,type,count(*)::int repeated_pairs FROM ordered
    WHERE type<>previous_type AND created_at-previous_at<=INTERVAL '5 minutes'
    GROUP BY previous_type,type ORDER BY count(*) DESC`,
  daily_singleton_candidates: `WITH repeated AS (
    SELECT user_id,type,(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS local_date,count(*) amount
    FROM notifications WHERE created_at>=NOW()-INTERVAL '7 days' AND type=ANY($1::text[])
    GROUP BY user_id,type,local_date HAVING count(*)>1
  ) SELECT type,count(*)::int affected_user_days,sum(amount-1)::int extra_rows
    FROM repeated GROUP BY type ORDER BY sum(amount-1) DESC`,
  pending_delivery: `SELECT state,count(*)::int jobs,
    count(*) FILTER(WHERE attempts>1)::int retried,
    count(*) FILTER(WHERE expires_at<NOW())::int expired,
    count(*) FILTER(WHERE state='INFLIGHT' AND lease_until<NOW())::int stale_leases
    FROM notification_push_outbox WHERE state<>'SENT' GROUP BY state ORDER BY state`,
  shared_tokens: `SELECT 'expo' channel,count(*)::int shared_token_groups FROM (
    SELECT push_token FROM users WHERE deleted_at IS NULL AND push_token IS NOT NULL
    GROUP BY push_token HAVING count(*)>1) grouped
    UNION ALL SELECT 'fcm',count(*)::int FROM (
      SELECT fcm_token FROM users WHERE deleted_at IS NULL AND fcm_token IS NOT NULL
      GROUP BY fcm_token HAVING count(*)>1) grouped
    UNION ALL SELECT 'voip',count(*)::int FROM (
      SELECT voip_push_token FROM users WHERE deleted_at IS NULL AND voip_push_token IS NOT NULL
      GROUP BY voip_push_token HAVING count(*)>1) grouped`,
  call_delivery_7d: `SELECT kind,state,count(*)::int jobs,
    count(*) FILTER(WHERE tries>1)::int retried
    FROM checkin_call_deliveries WHERE created_at>=NOW()-INTERVAL '7 days'
    GROUP BY kind,state ORDER BY kind,state`,
  repeated_incoming_attempts: `SELECT count(*)::int repeated_groups FROM (
    SELECT attempt_id,target_user_id FROM checkin_call_deliveries
    WHERE created_at>=NOW()-INTERVAL '7 days' AND kind='INCOMING_CALL' AND attempt_id IS NOT NULL
    GROUP BY attempt_id,target_user_id HAVING count(*)>1) grouped`,
  nearby_alert_families: `WITH recent AS (
    SELECT user_id,type,created_at,COALESCE(data->>'patientId',data->>'patient_id',
      data->>'patientUserId',data->>'sourceUserId',data->>'userId',user_id::text) subject
    FROM notifications WHERE created_at>=NOW()-INTERVAL '7 days'
      AND type IN ('early_signal','health_alert','caregiver_alert','emergency','checkin_call')
  ) SELECT a.type first_type,b.type second_type,count(*)::int candidate_pairs
    FROM recent a JOIN recent b ON a.user_id=b.user_id AND a.subject=b.subject
      AND a.type<b.type AND b.created_at BETWEEN a.created_at-INTERVAL '2 minutes'
        AND a.created_at+INTERVAL '2 minutes'
    GROUP BY a.type,b.type ORDER BY count(*) DESC`,
};

const dailyTypes = [
  'morning_checkin',
  'reminder_morning_summary',
  'reminder_afternoon',
  'reminder_evening_summary',
  'weekly_recap',
  'weekly_wellness_summary',
  'profile_incomplete',
];

async function audit(client) {
  const output = { window_days: 7, generated_at: new Date().toISOString() };
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='12s'");
    output.transaction_read_only = (
      await client.query('SHOW transaction_read_only')
    ).rows[0].transaction_read_only;
    for (const [name, sql] of Object.entries(queries)) {
      output[name] = (
        await client.query(sql, name === 'daily_singleton_candidates' ? [dailyTypes] : [])
      ).rows;
    }
    return output;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const { Client } = require('pg');
  const { databaseOptions } = require(
    require('node:path').join(process.cwd(), 'src/lib/database-options')
  );
  const client = new Client(databaseOptions(process.env.DATABASE_URL));
  await client.connect();
  try {
    const output = await audit(client);
    output.runtime_flags = Object.fromEntries(
      [
        'NOTIFICATION_DAILY_CAP',
        'HEALTH_METRIC_REMINDERS_ENABLED',
        'CHECKIN_CALL_ENABLED',
        'MED_CALL_ENABLED',
        'HEALTH_FEED_ENABLED',
      ].map((key) => [key, process.env[key] ?? null])
    );
    console.log('NOTIFICATION_AUDIT_BEGIN');
    console.log(JSON.stringify(output, null, 2));
    console.log('NOTIFICATION_AUDIT_END');
  } finally {
    await client.end();
  }
}

if (!module.parent)
  main().catch((error) => {
    console.error('Notification audit failed:', error.code || error.name);
    process.exitCode = 1;
  });
module.exports = { audit, queries };
