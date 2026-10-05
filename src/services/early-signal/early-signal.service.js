'use strict';
const { attendance } = require('./attendance');

const crypto = require('crypto');
const { t } = require('../../i18n');
const { sendAndSave } = require('../notification/basic.notification.service');
const entitlementService = require('../payment/entitlement.service');
const checkinCallService = require('../checkin-call/checkin-call.service');

const DISCLAIMER_KEY = 'early_signal.disclaimer';
const SEVERITY_RANK = Object.freeze({ monitor: 0, see_doctor: 1, urgent: 2 });
const RED_FLAGS = [
  ['đau ngực', 'chest_pain'],
  ['khó thở', 'shortness_of_breath'],
  ['yếu liệt nửa người', 'half_body_weakness'],
  ['liệt nửa người', 'half_body_weakness'],
  ['lơ mơ', 'altered_consciousness'],
  ['nôn ra máu', 'vomiting_blood'],
  ['yếu liệt', 'weakness'],
  ['méo miệng', 'stroke'],
  ['nói khó', 'speech'],
  ['bất tỉnh', 'unconscious'],
  ['co giật', 'seizure'],
  ['chest pain', 'chest_pain'],
  ['shortness of breath', 'shortness_of_breath'],
  ['vomiting blood', 'vomiting_blood'],
];
const FORBIDDEN_OUTPUT = [
  /\b(chẩn đoán|mắc bệnh|bị viêm|bị ung thư)\b/i,
  /\b(you have|has|diagnosed with|suffers from)\s+(?:\S+\s+){0,3}(cancer|disease|syndrome|infection|inflammation)\b/i,
  /\b(paracetamol|aspirin|ibuprofen|warfarin|mg|ml)\b/i,
  /\b(kê|dùng|uống|ngưng|dừng|đổi|tăng|giảm)\s+(?:\S+\s+){0,3}(thuốc|liều)\b/i,
  /không sao đâu/i,
];

const SPECIALTY_RULES = [
  {
    needles: [
      'tiêu chảy',
      'đi ngoài',
      'đau bụng',
      'táo bón',
      'buồn nôn',
      'diarrhea',
      'abdominal pain',
      'nausea',
    ],
    specialty: 'gastroenterology',
  },
  {
    needles: ['đau đầu', 'chóng mặt', 'hoa mắt', 'run tay', 'headache', 'dizziness'],
    specialty: 'neurology',
  },
  {
    needles: ['tim đập nhanh', 'tức ngực', 'rapid heartbeat', 'chest tightness'],
    specialty: 'cardiology',
  },
  { needles: ['ho', 'khó thở', 'cough', 'shortness of breath'], specialty: 'respiratory' },
  { needles: ['đau khớp', 'đau lưng', 'joint pain', 'back pain'], specialty: 'musculoskeletal' },
  { needles: ['phát ban', 'ngứa', 'rash', 'itching'], specialty: 'dermatology' },
];

const normalizeLang = (lang) =>
  String(lang || '')
    .toLowerCase()
    .startsWith('en')
    ? 'en'
    : 'vi';
const descriptor = (key, params = {}) => ({ key, params });
function translate(copy, lang) {
  const params = { ...(copy.params || {}) };
  if (params.symptomKey) {
    params.symptom = t(params.symptomKey, normalizeLang(lang));
    delete params.symptomKey;
  }
  return t(copy.key, normalizeLang(lang), params);
}

function localizeOutput(output, lang = 'vi') {
  if (!output?._i18n) return output;
  const copy = output._i18n;
  const summaryCopy = copy.specialty
    ? {
        ...copy.summary,
        params: {
          ...(copy.summary.params || {}),
          specialty: t(`early_signal.specialty.${copy.specialty}`, normalizeLang(lang)),
        },
      }
    : copy.summary;
  return {
    ...output,
    signals: (copy.signals || []).map((item) => translate(item, lang)),
    summary: translate(summaryCopy, lang),
    suggested_specialty: copy.specialty
      ? t(`early_signal.specialty.${copy.specialty}`, normalizeLang(lang))
      : null,
    urgent_signs: (copy.urgentSigns || []).map((key) =>
      t(`early_signal.sign.${key}`, normalizeLang(lang))
    ),
    disclaimer: t(DISCLAIMER_KEY, normalizeLang(lang)),
  };
}

function localizeAssessment(assessment, lang = 'vi') {
  if (!assessment) return assessment;
  let snapshot = assessment.output_snapshot;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return assessment;
    }
  }
  if (!snapshot?._i18n) return assessment;
  const localized = localizeOutput(snapshot, lang);
  return {
    ...assessment,
    signals: localized.signals,
    summary: localized.summary,
    suggested_specialty: localized.suggested_specialty,
    urgent_signs: localized.urgent_signs,
    disclaimer: localized.disclaimer,
    output_snapshot: localized,
  };
}

function serviceError(message, statusCode, code, i18nKey = null, i18nParams = {}) {
  return Object.assign(new Error(message), { statusCode, code, i18nKey, i18nParams });
}

function validateSafeOutput(output, medicationNames = []) {
  const text = [
    output.summary,
    output.suggested_specialty,
    ...(output.signals || []),
    ...(output.urgent_signs || []),
  ]
    .filter(Boolean)
    .join(' ');
  const blocked = FORBIDDEN_OUTPUT.find((pattern) => pattern.test(text));
  const mentionsMedication = medicationNames
    .filter((name) => String(name || '').trim().length >= 3)
    .some((name) => text.toLowerCase().includes(String(name).trim().toLowerCase()));
  if (blocked || mentionsMedication) {
    throw serviceError('Unsafe early signal output', 500, 'UNSAFE_EARLY_SIGNAL_OUTPUT');
  }
  if (output.disclaimer !== t(DISCLAIMER_KEY, output._lang || 'vi')) {
    throw serviceError(
      'Missing required early signal disclaimer',
      500,
      'UNSAFE_EARLY_SIGNAL_OUTPUT'
    );
  }
  return output;
}

async function assertCanView(pool, targetUserId, actorUserId) {
  if (Number(targetUserId) === Number(actorUserId)) return;
  // Free assessments are private to the person who requested them. Sharing
  // with family is an active An Tam benefit for a protected household member.
  const entitlement = await entitlementService.getEntitlement(pool, targetUserId);
  if (!entitlement.automaticEarlySignals) {
    throw serviceError('Early signal access denied', 403, 'FORBIDDEN', 'early_signal.no_access');
  }
  const allowed = await pool.query(
    `SELECT 1
       FROM subscription_households h
       JOIN subscription_household_members m ON m.household_id = h.id
      WHERE h.owner_user_id = $1 AND m.user_id = $2 AND m.status = 'active'
      UNION ALL
     SELECT 1
       FROM user_connections c
      WHERE c.status = 'accepted'
        AND ((c.requester_id = $1 AND c.addressee_id = $2)
          OR (c.addressee_id = $1 AND c.requester_id = $2))
        AND (COALESCE((c.permissions->>'can_view_logs')::boolean, false)
          OR COALESCE((c.permissions->>'can_receive_alerts')::boolean, false))
      LIMIT 1`,
    [actorUserId, targetUserId]
  );
  if (!allowed.rowCount) {
    throw serviceError('Early signal access denied', 403, 'FORBIDDEN', 'early_signal.no_access');
  }
}

async function inputSnapshot(pool, userId) {
  const [checkins, scriptedCheckins, callEpisodes, symptoms, vitals, profile] = await Promise.all([
    pool.query(
      `SELECT id, session_date, initial_status, current_status, flow_state,
              triage_severity, triage_summary, triage_messages,
              emergency_triggered, triage_completed_at, created_at, updated_at
         FROM health_checkins
        WHERE user_id = $1 AND session_date >= CURRENT_DATE - 29
        ORDER BY session_date DESC`,
      [userId]
    ),
    pool.query(
      `SELECT id, checkin_id, session_type, answers, severity, needs_doctor,
              needs_family_alert, conclusion_summary, created_at, completed_at
         FROM script_sessions
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT e.local_date, e.state, e.severity, e.scheduled_at, e.grace_until,
              e.resolved_at, e.exhausted_at, e.trigger_source, e.triage_context,
              (SELECT min(created_at) FROM checkin_call_events v WHERE v.episode_id = e.id
                AND (v.event IN ('USER_OK','USER_OK_WITH_URGENT_SIGNAL','USER_MILD','USER_URGENT','USER_TRIAGE_STARTED','USER_TRIAGE_COMPLETED')
                  OR (v.event = 'CANCELLED' AND v.detail->>'reason' = 'MANUAL_CHECKIN'))) AS responded_at,
              (SELECT h.last_response_at FROM health_checkins h WHERE h.user_id = e.user_id AND h.session_date = e.local_date) AS checked_in_at
         FROM checkin_call_episodes e
        WHERE e.user_id = $1 AND e.local_date >= CURRENT_DATE - 29
          AND e.trigger_source = 'MISSED_CHECKIN'
        ORDER BY e.local_date DESC`,
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
      `SELECT c.id, c.log_type, c.occurred_at, c.source, c.note, c.metadata,
              g.value AS glucose_value, g.unit AS glucose_unit,
              bp.systolic, bp.diastolic, bp.pulse,
              w.weight_kg, w.body_fat_percent, w.muscle_percent,
              wa.volume_ml,
              ml.med_name, ml.dose_text, ml.dose_value, ml.dose_unit,
              meal.calories_kcal, meal.carbs_g, meal.protein_g, meal.fat_g, meal.meal_text,
              insulin.insulin_type, insulin.dose_units, insulin.unit AS insulin_unit
         FROM logs_common c
         LEFT JOIN glucose_logs g ON g.log_id = c.id
         LEFT JOIN blood_pressure_logs bp ON bp.log_id = c.id
         LEFT JOIN weight_logs w ON w.log_id = c.id
         LEFT JOIN water_logs wa ON wa.log_id = c.id
         LEFT JOIN medication_logs ml ON ml.log_id = c.id
         LEFT JOIN meal_logs meal ON meal.log_id = c.id
         LEFT JOIN insulin_logs insulin ON insulin.log_id = c.id
        WHERE c.user_id = $1 AND c.occurred_at >= NOW() - INTERVAL '30 days'
        ORDER BY c.occurred_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT p.age, p.birth_year, p.medical_conditions, p.chronic_symptoms,
              p.daily_medication, COALESCE(u.language_preference, 'vi') AS language_preference
         FROM users u
         LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    ),
  ]);
  return {
    user_id: Number(userId),
    generated_at: new Date().toISOString(),
    windows: { short_days: 7, long_days: 30 },
    checkins: checkins.rows,
    scripted_checkins: scriptedCheckins.rows,
    checkin_schedule: callEpisodes.rows.map((row) => ({
      ...row,
      attendance: attendance(row),
    })),
    symptoms: symptoms.rows,
    vitals: vitals.rows,
    profile: profile.rows[0] || null,
  };
}

function specialtyFor(symptom) {
  const normalized = String(symptom || '').toLowerCase();
  return (
    SPECIALTY_RULES.find((rule) => rule.needles.some((needle) => normalized.includes(needle)))
      ?.specialty || 'general'
  );
}

function countRecentSymptoms(snapshot, days) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const counts = new Map();
  for (const row of snapshot.symptoms) {
    if (new Date(row.occurred_date) < cutoff) continue;
    const name = String(row.symptom_name || '')
      .trim()
      .toLowerCase();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isRecent(value, days) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function analyse(snapshot, lang = 'vi') {
  const resolvedLang = normalizeLang(lang);
  const today = dateKey(new Date());
  const recentCheckins = snapshot.checkins.filter((row) => dateKey(row.session_date) === today);
  const recentScriptedCheckins = (snapshot.scripted_checkins || []).filter(
    (row) => dateKey(row.completed_at || row.created_at) === today
  );
  const recentSymptoms = snapshot.symptoms.filter((row) => dateKey(row.occurred_date) === today);
  const combinedText = JSON.stringify({
    checkins: recentCheckins,
    scripted_checkins: recentScriptedCheckins,
    symptoms: recentSymptoms,
  }).toLowerCase();
  const urgentSigns = [
    ...new Set(RED_FLAGS.filter(([needle]) => combinedText.includes(needle)).map(([, key]) => key)),
  ];
  if (recentCheckins.some((row) => row.emergency_triggered)) {
    urgentSigns.push('user_emergency');
  }
  if (recentScriptedCheckins.some((row) => row.severity === 'critical')) {
    urgentSigns.push('checkin_emergency');
  }
  const criticalVitals = snapshot.vitals.filter((row) => {
    if (!isRecent(row.occurred_at, 1)) return false;
    const glucose = Number(row.glucose_value);
    const systolic = Number(row.systolic);
    const diastolic = Number(row.diastolic);
    return (glucose && (glucose < 54 || glucose > 300)) || systolic >= 180 || diastolic >= 120;
  });
  const symptomCounts7d = countRecentSymptoms(snapshot, 7);
  const symptomCounts30d = countRecentSymptoms(snapshot, 30);
  const missedCheckins7d = (snapshot.checkin_schedule || []).filter(
    (row) => row.attendance === 'missed' && isRecent(row.local_date, 7)
  ).length;
  const veryTired7d = snapshot.checkins.filter((row) => {
    const date = new Date(row.session_date);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 6);
    return (
      date >= cutoff &&
      ['very_tired', 'high'].includes(String(row.current_status || row.triage_severity))
    );
  }).length;

  let output;
  if (urgentSigns.length || criticalVitals.length || veryTired7d >= 2) {
    const signalCopies = urgentSigns.map((key) => descriptor(`early_signal.sign.${key}`));
    if (criticalVitals.length)
      signalCopies.push(
        descriptor('early_signal.signal.critical_vitals', { count: criticalVitals.length })
      );
    if (veryTired7d >= 2)
      signalCopies.push(descriptor('early_signal.signal.very_tired', { count: veryTired7d }));
    output = {
      severity: 'urgent',
      is_red_flag: urgentSigns.length > 0,
      signals: [],
      summary: '',
      suggested_specialty: null,
      urgent_signs: [],
      disclaimer: '',
      _i18n: {
        signals: signalCopies,
        summary: descriptor(
          urgentSigns.length ? 'early_signal.summary.emergency' : 'early_signal.summary.urgent'
        ),
        specialty: null,
        urgentSigns,
      },
    };
  } else if ((symptomCounts7d[0]?.[1] || 0) >= 4 || veryTired7d === 1) {
    const [symptom, count] = symptomCounts7d[0] || [null, 1];
    const symptomParams = symptom ? { symptom } : { symptomKey: 'early_signal.symptom.very_tired' };
    const specialty = specialtyFor(symptom || 'fatigue');
    const urgentSignKeys = [
      'chest_pain',
      'shortness_of_breath',
      'weakness',
      'drowsiness',
      'vomiting_blood',
    ];
    output = {
      severity: 'see_doctor',
      is_red_flag: false,
      signals: [],
      summary: '',
      suggested_specialty: null,
      urgent_signs: [],
      disclaimer: '',
      _i18n: {
        signals: [
          descriptor('early_signal.signal.symptom_7d', { ...symptomParams, count }),
          ...(missedCheckins7d
            ? [descriptor('early_signal.signal.missed_7d', { count: missedCheckins7d })]
            : []),
        ],
        summary: descriptor('early_signal.summary.see_doctor', {
          ...symptomParams,
          count,
          specialty,
        }),
        specialty,
        urgentSigns: urgentSignKeys,
      },
    };
  } else {
    const leading = symptomCounts30d[0];
    const urgentSignKeys = [
      'chest_pain',
      'shortness_of_breath',
      'weakness',
      'drowsiness',
      'vomiting_blood',
    ];
    output = {
      severity: 'monitor',
      is_red_flag: false,
      signals: [],
      summary: '',
      suggested_specialty: null,
      urgent_signs: [],
      disclaimer: '',
      _i18n: {
        signals: [
          ...(leading
            ? [
                descriptor('early_signal.signal.symptom_30d', {
                  symptom: leading[0],
                  count: leading[1],
                }),
              ]
            : []),
          ...(missedCheckins7d
            ? [descriptor('early_signal.signal.missed_7d', { count: missedCheckins7d })]
            : []),
        ],
        summary: descriptor(
          leading ? 'early_signal.summary.monitor' : 'early_signal.summary.insufficient'
        ),
        specialty: null,
        urgentSigns: urgentSignKeys,
      },
    };
  }
  const localized = localizeOutput({ ...output, _lang: resolvedLang }, resolvedLang);
  return validateSafeOutput(localized, snapshot.vitals.map((row) => row.med_name).filter(Boolean));
}

async function notifyFamily(pool, userId, assessment) {
  const [recipients, subjectResult] = await Promise.all([
    pool.query(
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
    ),
    pool.query(
      `SELECT COALESCE(full_name, display_name) AS name
         FROM users WHERE id = $1`,
      [userId]
    ),
  ]);
  const deliveries = await Promise.all(
    recipients.rows.map((recipient) => {
      const subjectName =
        subjectResult.rows[0]?.name || t('early_signal.subject_fallback', recipient.lang);
      const localizedAssessment = localizeAssessment(assessment, recipient.lang);
      return sendAndSave(
        pool,
        { id: recipient.id, push_token: recipient.push_token },
        'early_signal',
        t(
          assessment.trigger_type === 'weekly'
            ? 'push.early_signal_weekly_title'
            : 'push.early_signal_title',
          recipient.lang,
          { name: subjectName }
        ),
        t('push.early_signal_body', recipient.lang, {
          summary: localizedAssessment.summary,
          level: t(
            assessment.severity === 'urgent'
              ? 'push.early_signal_level_urgent'
              : assessment.severity === 'see_doctor'
                ? 'push.early_signal_level_doctor'
                : 'push.early_signal_level_monitor',
            recipient.lang
          ),
        }),
        {
          assessmentId: String(assessment.id),
          userId: String(userId),
          userName: subjectName,
          severity: assessment.severity,
        },
        assessment.severity === 'urgent'
          ? 'critical'
          : assessment.severity === 'see_doctor'
            ? 'high'
            : 'medium'
      ).catch(() => {});
    })
  );
  const deliveredCount = deliveries.filter(Boolean).length;
  if (deliveredCount) {
    await pool.query(
      'UPDATE early_signal_assessments SET family_notified_at = NOW() WHERE id = $1',
      [assessment.id]
    );
    assessment.family_notified_at = new Date().toISOString();
  }
  return deliveredCount;
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
    if (recent.rowCount) return localizeAssessment(recent.rows[0], options.lang || 'vi');
  }
  if (options.triggerRef) {
    const duplicate = await pool.query(
      `SELECT * FROM early_signal_assessments
        WHERE user_id = $1 AND trigger_ref = $2
          AND (trigger_type = $3 OR ($3 = 'new_log' AND trigger_type = 'worsened'))
        ORDER BY created_at DESC LIMIT 1`,
      [userId, String(options.triggerRef), options.triggerType || 'manual']
    );
    if (duplicate.rowCount) return localizeAssessment(duplicate.rows[0], options.lang || 'vi');
  }

  const previousResult = await pool.query(
    `SELECT severity FROM early_signal_assessments
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const previousSeverity = previousResult.rows[0]?.severity || 'monitor';
  const input = await inputSnapshot(pool, userId);
  const output = analyse(input, options.lang || input.profile?.language_preference || 'vi');
  const requestedTriggerType = options.triggerType || 'manual';
  const isWorsened = SEVERITY_RANK[output.severity] > SEVERITY_RANK[previousSeverity];
  const triggerType =
    requestedTriggerType === 'new_log' && isWorsened ? 'worsened' : requestedTriggerType;
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
      triggerType,
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
  const shouldNotifyFamily =
    output.is_red_flag ||
    (entitlement.automaticEarlySignals && (triggerType === 'weekly' || triggerType === 'worsened'));
  if (shouldNotifyFamily) {
    await notifyFamily(pool, userId, assessment);
  }
  const shouldStartCall =
    entitlement.callCenterEnabled &&
    output.severity === 'urgent' &&
    (output.is_red_flag || triggerType !== 'new_log');
  if (shouldStartCall) {
    const episode = await checkinCallService.startEarlySignalEpisode(pool, userId, assessment.id);
    if (episode) {
      await pool.query('UPDATE early_signal_assessments SET call_episode_id = $2 WHERE id = $1', [
        assessment.id,
        episode.id,
      ]);
      assessment.call_episode_id = episode.id;
    }
  }
  return assessment;
}

async function latest(pool, userId, actorUserId, lang = 'vi') {
  await assertCanView(pool, userId, actorUserId);
  const result = await pool.query(
    `SELECT a.*, COALESCE(u.full_name, u.display_name, $2) AS user_name,
            u.phone_number AS user_phone
       FROM early_signal_assessments a
       JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
    [userId, t('early_signal.subject_fallback', normalizeLang(lang))]
  );
  return localizeAssessment(result.rows[0] || null, lang);
}

async function evaluateAfterNewHealthData(pool, userId, triggerRef) {
  const entitlement = await entitlementService.getEntitlement(pool, userId);
  if (!entitlement.automaticEarlySignals) return null;
  return evaluate(pool, userId, {
    requestedBy: userId,
    triggerType: 'new_log',
    triggerRef,
  });
}

async function familyLatest(pool, ownerUserId, lang = 'vi') {
  const result = await pool.query(
    `SELECT DISTINCT ON (a.user_id) a.*, COALESCE(u.display_name, u.full_name, u.email, $2) AS user_name,
            u.avatar_url
       FROM subscription_households h
       JOIN subscription_household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN users u ON u.id = m.user_id
       LEFT JOIN early_signal_assessments a ON a.user_id = m.user_id
      WHERE h.owner_user_id = $1 AND a.id IS NOT NULL
        AND h.plan_code <> 'free' AND h.status IN ('active', 'grace_period')
        AND h.current_period_end > NOW()
      ORDER BY a.user_id, a.created_at DESC`,
    [ownerUserId, t('early_signal.subject_fallback', normalizeLang(lang))]
  );
  return result.rows.map((assessment) => localizeAssessment(assessment, lang));
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
  evaluateAfterNewHealthData,
  _test: {
    analyse,
    inputSnapshot,
    validateSafeOutput,
    specialtyFor,
    localizeAssessment,
    localizeOutput,
  },
};
