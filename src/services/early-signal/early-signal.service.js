'use strict';

const crypto = require('crypto');
const { t } = require('../../i18n');
const { sendAndSave } = require('../notification/basic.notification.service');
const entitlementService = require('../payment/entitlement.service');
const checkinCallService = require('../checkin-call/checkin-call.service');

const DISCLAIMER = 'Đây là gợi ý tham khảo, không phải chẩn đoán.';
const RED_FLAGS = [
  ['đau ngực', 'Đau ngực'],
  ['khó thở', 'Khó thở'],
  ['yếu liệt nửa người', 'Yếu liệt nửa người'],
  ['liệt nửa người', 'Yếu liệt nửa người'],
  ['lơ mơ', 'Lơ mơ hoặc thay đổi ý thức'],
  ['nôn ra máu', 'Nôn ra máu'],
  ['chest pain', 'Đau ngực'],
  ['shortness of breath', 'Khó thở'],
  ['vomiting blood', 'Nôn ra máu'],
];
const FORBIDDEN_OUTPUT = [
  /\b(chẩn đoán|mắc bệnh|bị viêm|bị ung thư)\b/i,
  /\b(paracetamol|aspirin|ibuprofen|warfarin|mg|ml)\b/i,
  /\b(uống|ngưng|đổi)\s+(thuốc|liều)\b/i,
  /không sao đâu/i,
];

function serviceError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function validateSafeOutput(output) {
  const text = [output.summary, output.suggested_specialty, ...(output.urgent_signs || [])]
    .filter(Boolean)
    .join(' ');
  const blocked = FORBIDDEN_OUTPUT.find((pattern) => pattern.test(text));
  if (blocked) throw serviceError('Unsafe early signal output', 500, 'UNSAFE_EARLY_SIGNAL_OUTPUT');
  return output;
}

async function assertCanView(pool, targetUserId, actorUserId) {
  if (Number(targetUserId) === Number(actorUserId)) return;
  const allowed = await pool.query(
    `SELECT 1
       FROM subscription_households h
       JOIN subscription_household_members m ON m.household_id = h.id
      WHERE h.owner_user_id = $1 AND m.user_id = $2 AND m.status = 'active'
      LIMIT 1`,
    [actorUserId, targetUserId]
  );
  if (!allowed.rowCount) throw serviceError('Không có quyền xem dữ liệu này.', 403, 'FORBIDDEN');
}

async function inputSnapshot(pool, userId) {
  const [checkins, symptoms, vitals, profile] = await Promise.all([
    pool.query(
      `SELECT session_date, initial_status, current_status, triage_severity,
              triage_summary, triage_messages
         FROM health_checkins
        WHERE user_id = $1 AND session_date >= CURRENT_DATE - 29
        ORDER BY session_date DESC`,
      [userId]
    ),
    pool.query(
      `SELECT symptom_name, severity, occurred_date
         FROM symptom_logs
        WHERE user_id = $1 AND occurred_date >= CURRENT_DATE - 29
        ORDER BY occurred_date DESC`,
      [userId]
    ),
    pool.query(
      `SELECT c.id, c.log_type, c.occurred_at,
              g.value AS glucose_value, g.unit AS glucose_unit,
              bp.systolic, bp.diastolic, bp.pulse
         FROM logs_common c
         LEFT JOIN glucose_logs g ON g.log_id = c.id
         LEFT JOIN blood_pressure_logs bp ON bp.log_id = c.id
        WHERE c.user_id = $1 AND c.occurred_at >= NOW() - INTERVAL '30 days'
        ORDER BY c.occurred_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT age, medical_conditions, chronic_symptoms
         FROM user_onboarding_profiles WHERE user_id = $1`,
      [userId]
    ),
  ]);
  return {
    user_id: Number(userId),
    generated_at: new Date().toISOString(),
    windows: { short_days: 7, long_days: 30 },
    checkins: checkins.rows,
    symptoms: symptoms.rows,
    vitals: vitals.rows,
    profile: profile.rows[0] || null,
  };
}

function countRecentSymptoms(snapshot, days) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const counts = new Map();
  for (const row of snapshot.symptoms) {
    if (new Date(row.occurred_date) < cutoff) continue;
    const name = String(row.symptom_name || '').trim().toLowerCase();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function analyse(snapshot) {
  const combinedText = JSON.stringify({
    checkins: snapshot.checkins,
    symptoms: snapshot.symptoms,
  }).toLowerCase();
  const urgentSigns = [...new Set(
    RED_FLAGS.filter(([needle]) => combinedText.includes(needle)).map(([, label]) => label)
  )];
  const criticalVitals = snapshot.vitals.filter((row) => {
    const glucose = Number(row.glucose_value);
    const systolic = Number(row.systolic);
    const diastolic = Number(row.diastolic);
    return (glucose && (glucose < 54 || glucose > 300)) || systolic >= 180 || diastolic >= 120;
  });
  const symptomCounts7d = countRecentSymptoms(snapshot, 7);
  const symptomCounts30d = countRecentSymptoms(snapshot, 30);
  const veryTired7d = snapshot.checkins.filter((row) => {
    const date = new Date(row.session_date);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 6);
    return date >= cutoff && ['very_tired', 'high'].includes(String(row.current_status || row.triage_severity));
  }).length;

  let output;
  if (urgentSigns.length || criticalVitals.length || veryTired7d >= 2) {
    const signals = [];
    if (urgentSigns.length) signals.push(...urgentSigns);
    if (criticalVitals.length) signals.push(`${criticalVitals.length} chỉ số ở mức cần xử lý sớm`);
    if (veryTired7d >= 2) signals.push(`${veryTired7d} lần ghi nhận rất mệt trong 7 ngày`);
    output = {
      severity: 'urgent',
      is_red_flag: urgentSigns.length > 0,
      signals,
      summary: urgentSigns.length
        ? 'Có dấu hiệu cần hỗ trợ khẩn cấp. Hãy gọi 115 và báo ngay cho gia đình.'
        : 'Các ghi nhận gần đây cần được nhân viên y tế đánh giá ngay.',
      suggested_specialty: null,
      urgent_signs: urgentSigns,
      disclaimer: DISCLAIMER,
    };
  } else if ((symptomCounts7d[0]?.[1] || 0) >= 4 || veryTired7d === 1) {
    const [symptom, count] = symptomCounts7d[0] || ['mệt', 1];
    output = {
      severity: 'see_doctor',
      is_red_flag: false,
      signals: [`${symptom} được ghi nhận ${count} lần trong 7 ngày`],
      summary: `Triệu chứng “${symptom}” lặp lại. Nên được bác sĩ đánh giá nếu tiếp tục kéo dài hoặc tăng lên.`,
      suggested_specialty: 'Nội tổng quát',
      urgent_signs: ['Đau ngực', 'Khó thở', 'Yếu liệt', 'Lơ mơ', 'Nôn ra máu'],
      disclaimer: DISCLAIMER,
    };
  } else {
    const leading = symptomCounts30d[0];
    output = {
      severity: 'monitor',
      is_red_flag: false,
      signals: leading ? [`${leading[0]} xuất hiện ${leading[1]} lần trong 30 ngày`] : [],
      summary: leading
        ? 'Chưa thấy xu hướng tăng rõ trong dữ liệu hiện có. Hãy tiếp tục check-in và ghi chỉ số.'
        : 'Chưa có đủ ghi nhận để phát hiện xu hướng. Hãy tiếp tục check-in mỗi ngày.',
      suggested_specialty: null,
      urgent_signs: ['Đau ngực', 'Khó thở', 'Yếu liệt', 'Lơ mơ', 'Nôn ra máu'],
      disclaimer: DISCLAIMER,
    };
  }
  return validateSafeOutput(output);
}

async function notifyFamily(pool, userId, assessment) {
  const recipients = await pool.query(
    `SELECT DISTINCT u.id, u.push_token, COALESCE(u.language_preference, 'vi') AS lang
       FROM users u
       JOIN (
         SELECT h.owner_user_id AS family_id
           FROM subscription_household_members m
           JOIN subscription_households h ON h.id = m.household_id
          WHERE m.user_id = $1 AND m.status = 'active' AND h.owner_user_id <> $1
         UNION
         SELECT CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END
           FROM user_connections c
          WHERE c.status = 'accepted' AND (c.requester_id = $1 OR c.addressee_id = $1)
            AND COALESCE((c.permissions->>'can_receive_alerts')::boolean, false) = true
       ) family ON family.family_id = u.id
      WHERE u.deleted_at IS NULL`,
    [userId]
  );
  await Promise.all(recipients.rows.map((recipient) => sendAndSave(
    pool,
    { id: recipient.id, push_token: recipient.push_token },
    'early_signal',
    t('push.early_signal_title', recipient.lang),
    t('push.early_signal_body', recipient.lang, {
      summary: assessment.summary,
      level: t(
        assessment.severity === 'urgent'
          ? 'push.early_signal_level_urgent'
          : 'push.early_signal_level_doctor',
        recipient.lang
      ),
    }),
    { assessmentId: String(assessment.id), userId: String(userId), severity: assessment.severity }
  ).catch(() => {})));
  if (recipients.rowCount) {
    await pool.query(
      'UPDATE early_signal_assessments SET family_notified_at = NOW() WHERE id = $1',
      [assessment.id]
    );
    assessment.family_notified_at = new Date().toISOString();
  }
  return recipients.rowCount;
}

async function evaluate(pool, userId, options = {}) {
  const requestedBy = Number(options.requestedBy || userId);
  await assertCanView(pool, userId, requestedBy);
  if ((options.triggerType || 'manual') === 'manual' && !options.triggerRef) {
    const recent = await pool.query(
      `SELECT * FROM early_signal_assessments
        WHERE user_id = $1 AND requested_by = $2 AND trigger_type = 'manual'
          AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [userId, requestedBy]
    );
    if (recent.rowCount) return recent.rows[0];
  }
  if (options.triggerRef) {
    const duplicate = await pool.query(
      `SELECT * FROM early_signal_assessments
        WHERE user_id = $1 AND trigger_type = $2 AND trigger_ref = $3 LIMIT 1`,
      [userId, options.triggerType || 'manual', String(options.triggerRef)]
    );
    if (duplicate.rowCount) return duplicate.rows[0];
  }

  const input = await inputSnapshot(pool, userId);
  const output = analyse(input);
  const auditHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ input, output }))
    .digest('hex');
  const inserted = await pool.query(
    `INSERT INTO early_signal_assessments (
       user_id, requested_by, trigger_type, trigger_ref, window_start, window_end,
       input_snapshot, severity, is_red_flag, signals, summary, suggested_specialty,
       urgent_signs, disclaimer, output_snapshot, audit_hash
     ) VALUES ($1,$2,$3,$4,CURRENT_DATE - 29,CURRENT_DATE,$5::jsonb,$6,$7,$8::jsonb,
               $9,$10,$11::jsonb,$12,$13::jsonb,$14)
     RETURNING *`,
    [
      userId,
      requestedBy,
      options.triggerType || 'manual',
      options.triggerRef ? String(options.triggerRef) : null,
      JSON.stringify(input),
      output.severity,
      output.is_red_flag,
      JSON.stringify(output.signals),
      output.summary,
      output.suggested_specialty,
      JSON.stringify(output.urgent_signs),
      output.disclaimer,
      JSON.stringify(output),
      auditHash,
    ]
  );
  const assessment = inserted.rows[0];
  const entitlement = await entitlementService.getEntitlement(pool, userId);
  if (output.is_red_flag || (entitlement.automaticEarlySignals && output.severity !== 'monitor')) {
    await notifyFamily(pool, userId, assessment);
  }
  if (entitlement.callCenterEnabled && output.severity === 'urgent') {
    const episode = await checkinCallService.startEarlySignalEpisode(pool, userId, assessment.id);
    if (episode) {
      await pool.query(
        'UPDATE early_signal_assessments SET call_episode_id = $2 WHERE id = $1',
        [assessment.id, episode.id]
      );
      assessment.call_episode_id = episode.id;
    }
  }
  return assessment;
}

async function latest(pool, userId, actorUserId) {
  await assertCanView(pool, userId, actorUserId);
  const result = await pool.query(
    'SELECT * FROM early_signal_assessments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

async function familyLatest(pool, ownerUserId) {
  const result = await pool.query(
    `SELECT DISTINCT ON (a.user_id) a.*, COALESCE(u.display_name, u.full_name, u.email, 'Người thân') AS user_name,
            u.avatar_url
       FROM subscription_households h
       JOIN subscription_household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN users u ON u.id = m.user_id
       LEFT JOIN early_signal_assessments a ON a.user_id = m.user_id
      WHERE h.owner_user_id = $1 AND a.id IS NOT NULL
      ORDER BY a.user_id, a.created_at DESC`,
    [ownerUserId]
  );
  return result.rows;
}

async function runWeekly(pool) {
  const result = await pool.query(
    `SELECT m.user_id
       FROM subscription_household_members m
       JOIN subscription_households h ON h.id = m.household_id
      WHERE m.status = 'active' AND h.plan_code <> 'free'
        AND h.status IN ('active','grace_period') AND h.current_period_end > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM early_signal_assessments a
           WHERE a.user_id = m.user_id AND a.trigger_type = 'weekly'
             AND a.created_at > NOW() - INTERVAL '6 days'
        )`
  );
  for (const row of result.rows) {
    await evaluate(pool, Number(row.user_id), {
      requestedBy: Number(row.user_id),
      triggerType: 'weekly',
      triggerRef: new Date().toISOString().slice(0, 10),
    });
  }
  return { evaluated: result.rowCount };
}

module.exports = {
  evaluate,
  latest,
  familyLatest,
  runWeekly,
  _test: { analyse, validateSafeOutput },
};
