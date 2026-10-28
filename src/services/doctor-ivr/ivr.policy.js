'use strict';
const { z } = require('zod');
const crypto = require('node:crypto');
const { assertTenantAllowed } = require('../integrations/doctor-task.service');
const policySchema = z
  .object({
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v }).format();
          return true;
        } catch {
          return false;
        }
      }),
    call_start_hour: z.number().int().min(7).max(20),
    call_end_hour: z.number().int().min(8).max(21),
    call_retries: z.number().int().min(0).max(2),
    retry_minutes: z.number().int().min(30).max(180),
    ring_seconds: z.number().int().min(20).max(60),
    response_timeout_seconds: z.number().int().min(10).max(60),
    safety_message: z.string().trim().min(1).max(600),
    red_flag_phrases: z.array(z.string().trim().min(2).max(120)).max(100),
  })
  .strict()
  .refine((v) => v.call_start_hour < v.call_end_hour, 'Giờ bắt đầu phải trước giờ kết thúc.');
const defaults = () => ({
  timezone: 'Asia/Ho_Chi_Minh',
  call_start_hour: 7,
  call_end_hour: 21,
  call_retries: 2,
  retry_minutes: 30,
  ring_seconds: 60,
  response_timeout_seconds: 10,
  safety_message:
    process.env.DOCTOR_IVR_SAFETY_MESSAGE ||
    'Nếu có dấu hiệu cấp cứu, anh/chị hãy gọi 115 hoặc đến cơ sở y tế gần nhất.',
  red_flag_phrases: (
    process.env.DOCTOR_IVR_RED_FLAG_PHRASES || 'khó thở|đau ngực dữ dội|bất tỉnh|yếu liệt'
  )
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean),
});
async function getPolicy(db, tenant) {
  const row = (
    await db.query('SELECT config FROM doctor_ivr_policies WHERE tenant_id=$1', [tenant])
  ).rows[0];
  return policySchema.parse({ ...defaults(), ...row?.config });
}
async function patientPolicy(db, tenant, user) {
  const policy = await getPolicy(db, tenant);
  const row = (
    await db.query(
      "SELECT COALESCE(to_jsonb(u)->>'timezone',to_jsonb(u)->>'time_zone') timezone FROM users u WHERE id=$1",
      [user]
    )
  ).rows[0];
  if (row?.timezone) {
    const result = policySchema.safeParse({ ...policy, timezone: row.timezone });
    if (result.success) return result.data;
  }
  return policy;
}
function nextEvening(value, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const start = Math.floor(new Date(value).getTime() / 60000) * 60000 + 60000;
  for (let minute = 0; minute <= 26 * 60; minute++) {
    const time = new Date(start + minute * 60000);
    if (formatter.format(time) === '19:00') return time;
  }
  throw new Error('IVR_INVALID_REMINDER_TIMEZONE');
}
// Step through UTC minutes, so DST gaps and repeated local hours are handled by
// the timezone database rather than adding a fixed offset to a local date.
function nextCallTime(value, policy) {
  const start = new Date(value).getTime();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: policy.timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  for (let minute = 0; minute <= 26 * 60; minute++) {
    const time = new Date(start + minute * 60000);
    const hour = Number(formatter.format(time));
    if (hour >= policy.call_start_hour && hour < policy.call_end_hour) return time;
  }
  throw new Error('IVR_INVALID_CALL_WINDOW');
}
async function metrics(db, tenant, days = 30) {
  const sessions = (
    await db.query(
      `SELECT count(*)::int total,
    count(*) FILTER(WHERE completed_at IS NOT NULL)::int completed,
    count(*) FILTER(WHERE status='unreachable')::int unreachable,
    round(avg(EXTRACT(EPOCH FROM completed_at-started_at)) FILTER(WHERE completed_at IS NOT NULL))::int mean_duration_s,
    round(avg(EXTRACT(EPOCH FROM updated_at-created_at)) FILTER(WHERE status='closed'))::int mean_task_turnaround_s
    FROM doctor_ivr_sessions WHERE tenant_id=$1 AND created_at>=NOW()-$2*INTERVAL '1 day'`,
      [tenant, days]
    )
  ).rows[0];
  const answers = (
    await db.query(
      `SELECT count(*)::int total,
    count(*) FILTER(WHERE a.answer_type='voice')::int voice,
    count(*) FILTER(WHERE a.answer_type='voice' AND (a.stt_confidence IS NULL OR a.stt_confidence<0.6))::int needs_review,
    count(*) FILTER(WHERE a.answer_type='voice' AND a.stt_confidence<0.6)::int low_confidence,
    count(*) FILTER(WHERE a.answer_type='voice' AND a.stt_confidence IS NULL)::int confidence_unavailable
    FROM doctor_ivr_answers a JOIN doctor_ivr_sessions s ON s.id=a.session_id
    WHERE s.tenant_id=$1 AND s.created_at>=NOW()-$2*INTERVAL '1 day' AND a.active`,
      [tenant, days]
    )
  ).rows[0];
  const questions = (
    await db.query(
      `SELECT COALESCE(a.question_fingerprint,md5(s.question_set_id::text||':'||a.question_id)) question_id,count(*)::int total,
    count(*) FILTER(WHERE a.answer_type='voice')::int voice
    FROM doctor_ivr_answers a JOIN doctor_ivr_sessions s ON s.id=a.session_id
    WHERE s.tenant_id=$1 AND s.created_at>=NOW()-$2*INTERVAL '1 day' AND a.active
    GROUP BY 1 ORDER BY total DESC LIMIT 100`,
      [tenant, days]
    )
  ).rows;
  return { days, sessions, answers, questions };
}
function questionFingerprint(tenant, question) {
  const normalize = (value) =>
    String(value).normalize('NFKC').toLocaleLowerCase('vi').replace(/\s+/gu, ' ').trim();
  const content = {
    text: normalize(question.text),
    options: question.options.map((o) => ({ label: normalize(o.label), type: o.type })),
  };
  return crypto
    .createHmac('sha256', require('./ivr.service').key())
    .update(`${tenant}:${JSON.stringify(content)}`)
    .digest('hex');
}
async function adminOperation(db, input) {
  require('./ivr.service').assertEnabled();
  assertTenantAllowed(input.tenant_id);
  if (input.operation === 'get')
    return {
      policy: await getPolicy(db, input.tenant_id),
      metrics: await metrics(db, input.tenant_id),
    };
  if (input.operation.startsWith('template')) {
    const ivr = require('./ivr.service');
    if (input.operation === 'templates')
      return {
        items: (
          await db.query(
            'SELECT * FROM doctor_ivr_templates WHERE tenant_id=$1 AND is_shared ORDER BY created_at DESC',
            [input.tenant_id]
          )
        ).rows.map((t) => ({
          id: t.id,
          name: t.name,
          specialty: t.specialty,
          content: ivr.reveal(t.owner_id, 'template', t.content_enc),
        })),
      };
    const id =
      input.data.id === undefined ? crypto.randomUUID() : z.string().uuid().parse(input.data.id);
    if (input.operation === 'template_delete') {
      return ivr.transaction(db, async (tx) => {
        const removed = await tx.query(
          'DELETE FROM doctor_ivr_templates WHERE id=$1 AND tenant_id=$2 AND is_shared',
          [id, input.tenant_id]
        );
        if (removed.rowCount)
          await tx.query(
            'INSERT INTO doctor_ivr_policy_events(id,tenant_id,actor,after_config) VALUES($1,$2,$3,$4)',
            [
              crypto.randomUUID(),
              input.tenant_id,
              input.admin_id,
              { action: 'template_deleted', template_id: id },
            ]
          );
        return { id };
      });
    }
    const { validateQuestionSet } = require('./question-set.schema');
    const content = validateQuestionSet(input.data.content);
    content.greeting = '';
    content.closing = '';
    const name = z.string().trim().min(1).max(120).parse(input.data.name);
    const specialty = z
      .string()
      .trim()
      .max(120)
      .parse(input.data.specialty || '');
    return ivr.transaction(db, async (tx) => {
      const saved = await tx.query(
        `INSERT INTO doctor_ivr_templates(id,tenant_id,owner_id,name,specialty,content_enc,is_shared)
      VALUES($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,specialty=EXCLUDED.specialty,
      owner_id=EXCLUDED.owner_id,content_enc=EXCLUDED.content_enc WHERE doctor_ivr_templates.tenant_id=$2 AND doctor_ivr_templates.is_shared RETURNING id`,
        [
          id,
          input.tenant_id,
          input.admin_id,
          name,
          specialty,
          ivr.seal(input.admin_id, 'template', content),
        ]
      );
      if (!saved.rowCount) throw ivr.error('IVR_TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu.', 404);
      await tx.query(
        'INSERT INTO doctor_ivr_policy_events(id,tenant_id,actor,after_config) VALUES($1,$2,$3,$4)',
        [
          crypto.randomUUID(),
          input.tenant_id,
          input.admin_id,
          { action: 'template_saved', template_id: id, question_count: content.questions.length },
        ]
      );
      return { id };
    });
  }
  const config = policySchema.parse(input.data);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `ivr-policy:${input.tenant_id}`,
    ]);
    const before = await getPolicy(client, input.tenant_id);
    await client.query(
      'INSERT INTO doctor_ivr_policies(tenant_id,config,updated_by) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET config=EXCLUDED.config,updated_by=EXCLUDED.updated_by,updated_at=NOW()',
      [input.tenant_id, config, input.admin_id]
    );
    await client.query(
      'INSERT INTO doctor_ivr_policy_events(id,tenant_id,actor,before_config,after_config) VALUES($1,$2,$3,$4,$5)',
      [crypto.randomUUID(), input.tenant_id, input.admin_id, before, config]
    );
    await client.query('COMMIT');
    return { policy: config };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
module.exports = {
  policySchema,
  defaults,
  getPolicy,
  patientPolicy,
  nextEvening,
  nextCallTime,
  metrics,
  adminOperation,
  questionFingerprint,
};
