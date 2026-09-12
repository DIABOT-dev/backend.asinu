'use strict';

const escapeMarkdown = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();

const statusLabel = {
  fine: 'ổn',
  tired: 'hơi mệt',
  very_tired: 'rất mệt',
  specific_concern: 'có triệu chứng cụ thể',
};

const severityLabel = {
  low: 'nhẹ',
  medium: 'trung bình',
  high: 'cao',
  critical: 'nguy cấp',
  emergency: 'khẩn cấp',
};

const answerText = (answer) => {
  if (Array.isArray(answer)) return answer.map((item) => answerText(item)).join(', ');
  if (answer && typeof answer === 'object') return JSON.stringify(answer);
  return String(answer ?? '');
};

/** Rebuild the durable Markdown health timeline used by Doctor AI. */
const rebuildPatientHealthTimeline = async (pool, userId) => {
  const [
    profileResult,
    checkinResult,
    logsResult,
    symptomsResult,
    recordsResult,
    messagesResult,
    filesResult,
  ] = await Promise.all([
    pool.query(
      `SELECT u.display_name, u.full_name, u.email, u.phone_number,
              p.*
         FROM users u LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT id, session_date, initial_status, current_status, triage_severity,
            triage_summary, triage_messages, triage_completed_at, updated_at
       FROM health_checkins
      WHERE user_id = $1
      ORDER BY session_date ASC, id ASC`,
      [userId]
    ),
    pool.query(
      `SELECT common.occurred_at, common.log_type, common.source,
              common.note, common.metadata,
              bp.systolic, bp.diastolic, bp.pulse,
              glucose.value AS glucose_value, glucose.unit AS glucose_unit,
              medication.med_name, medication.dose_text, medication.frequency_text,
              weight.weight_kg, weight.body_fat_percent, weight.muscle_percent,
              water.volume_ml,
              meal.calories_kcal, meal.carbs_g, meal.protein_g, meal.fat_g, meal.meal_text,
              insulin.insulin_type, insulin.dose_units, insulin.unit AS insulin_unit,
              insulin.timing, insulin.injection_site
         FROM logs_common common
         LEFT JOIN blood_pressure_logs bp ON bp.log_id = common.id
         LEFT JOIN glucose_logs glucose ON glucose.log_id = common.id
         LEFT JOIN medication_logs medication ON medication.log_id = common.id
         LEFT JOIN weight_logs weight ON weight.log_id = common.id
         LEFT JOIN water_logs water ON water.log_id = common.id
         LEFT JOIN meal_logs meal ON meal.log_id = common.id
         LEFT JOIN insulin_logs insulin ON insulin.log_id = common.id
        WHERE common.user_id = $1
        ORDER BY common.occurred_at ASC, common.id ASC`,
      [userId]
    ),
    pool.query(
      `SELECT symptom_name, severity, occurred_date, created_at
           FROM symptom_logs
          WHERE user_id = $1
          ORDER BY occurred_date ASC, id ASC`,
      [userId]
    ),
    pool.query(
      `SELECT record_type, title, diagnosis, summary, treatment, notes,
              doctor_ref, source_task_id, recorded_at
         FROM doctor_patient_medical_records
        WHERE user_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [userId]
    ),
    pool.query(
      `SELECT task_id, sender_type, message_type, content, created_at
         FROM doctor_task_messages
        WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
      [userId]
    ),
    pool.query(
      `SELECT name, mime_type, size_bytes, source_task_id, created_at
         FROM doctor_patient_files
        WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
      [userId]
    ),
  ]);
  const profile = profileResult.rows[0] || {};
  const rawProfile =
    profile.raw_profile && typeof profile.raw_profile === 'object' ? profile.raw_profile : {};
  const profileValue = (value, fallback = 'not declared') => {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0))
      return fallback;
    return Array.isArray(value) || typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  };
  const rows = checkinResult.rows;
  const lines = [
    '# Health timeline',
    '',
    '> Complete patient health timeline assembled from onboarding, health logs, check-ins and consultations. Use as context only; verify with the patient.',
    '',
    '## Patient profile and declared health information',
    `- Name: ${escapeMarkdown(profile.full_name || profile.display_name || 'unknown')}`,
    `- Gender: ${escapeMarkdown(profileValue(profile.gender))}`,
    `- Birth year/date of birth: ${escapeMarkdown(profileValue(profile.birth_year || profile.date_of_birth))}`,
    `- Height: ${escapeMarkdown(profileValue(profile.height_cm))} cm`,
    `- Weight: ${escapeMarkdown(profileValue(profile.weight_kg))} kg`,
    `- Blood type: ${escapeMarkdown(profileValue(profile.blood_type))}`,
    `- Medical conditions: ${escapeMarkdown(profileValue(profile.medical_conditions, 'none declared'))}`,
    `- Chronic symptoms: ${escapeMarkdown(profileValue(profile.chronic_symptoms, 'none declared'))}`,
    `- Joint issues: ${escapeMarkdown(profileValue(profile.joint_issues, 'none declared'))}`,
    `- Daily medication: ${escapeMarkdown(profileValue(profile.daily_medication))}`,
    `- Allergies: ${escapeMarkdown(profileValue(rawProfile.allergies, 'none declared'))}`,
    `- Medications declared: ${escapeMarkdown(profileValue(rawProfile.medications, 'none declared'))}`,
    `- Lifestyle and goals: ${escapeMarkdown(
      profileValue({
        goal: profile.goal || profile.user_goal,
        exercise_freq: profile.exercise_freq,
        walking_habit: profile.walking_habit,
        sleep_hours: profile.sleep_hours || profile.sleep_duration,
        water_intake: profile.water_intake,
        checkup_freq: profile.checkup_freq,
      })
    )}`,
    `- Profile updated at: ${escapeMarkdown(profile.updated_at || 'unknown')}`,
    '',
  ];

  for (const row of rows) {
    const date = row.session_date ? String(row.session_date).slice(0, 10) : 'unknown date';
    lines.push(`## Check-in ${date}`);
    lines.push(
      `- Status: ${escapeMarkdown(statusLabel[row.current_status] || statusLabel[row.initial_status] || row.current_status || 'chưa rõ')}`
    );
    if (row.triage_severity)
      lines.push(
        `- Severity: ${escapeMarkdown(severityLabel[row.triage_severity] || row.triage_severity)}`
      );
    if (row.triage_summary) lines.push(`- Summary: ${escapeMarkdown(row.triage_summary)}`);
    if (row.triage_completed_at)
      lines.push(`- Completed at: ${escapeMarkdown(row.triage_completed_at)}`);
    const messages = Array.isArray(row.triage_messages) ? row.triage_messages : [];
    if (messages.length) {
      lines.push('- Answers:');
      for (const message of messages) {
        const question = escapeMarkdown(
          message.question || message.question_text || message.question_id || 'Question'
        );
        const answer = escapeMarkdown(answerText(message.answer));
        if (answer) lines.push(`  - ${question}: ${answer}`);
      }
    }
    lines.push('');
  }

  lines.push('## Health measurements and symptom logs');
  if (!logsResult.rows.length) lines.push('- No health logs recorded.');
  for (const log of logsResult.rows) {
    const values = [];
    if (log.systolic != null)
      values.push(
        `blood pressure ${log.systolic}/${log.diastolic}${log.pulse ? `, pulse ${log.pulse}` : ''}`
      );
    if (log.glucose_value != null)
      values.push(`glucose ${log.glucose_value} ${log.glucose_unit || ''}`);
    if (log.med_name)
      values.push(`medication ${log.med_name} ${log.dose_text || ''} ${log.frequency_text || ''}`);
    if (log.weight_kg != null)
      values.push(
        `weight ${log.weight_kg} kg${log.body_fat_percent != null ? `, body fat ${log.body_fat_percent}%` : ''}`
      );
    if (log.volume_ml != null) values.push(`water ${log.volume_ml} ml`);
    if (log.meal_text || log.calories_kcal != null)
      values.push(
        `meal ${log.meal_text || ''}${log.calories_kcal != null ? `, ${log.calories_kcal} kcal` : ''}`
      );
    if (log.dose_units != null)
      values.push(
        `insulin ${log.insulin_type || ''} ${log.dose_units}${log.insulin_unit || ' U'}${log.timing ? `, ${log.timing}` : ''}`
      );
    if (log.note) values.push(`note ${log.note}`);
    if (log.metadata && Object.keys(log.metadata).length)
      values.push(`metadata ${JSON.stringify(log.metadata)}`);
    if (values.length)
      lines.push(`- ${escapeMarkdown(log.occurred_at)}: ${escapeMarkdown(values.join('; '))}`);
  }
  for (const symptom of symptomsResult.rows) {
    lines.push(
      `- ${escapeMarkdown(symptom.occurred_date)}: symptom ${escapeMarkdown(symptom.symptom_name)}${symptom.severity ? ` (${escapeMarkdown(symptom.severity)})` : ''}`
    );
  }
  lines.push('');

  lines.push('## Medical records');
  if (!recordsResult.rows.length) lines.push('- No medical records recorded.');
  for (const record of recordsResult.rows) {
    lines.push(
      `- ${escapeMarkdown(record.recorded_at)} | ${escapeMarkdown(record.record_type || record.title || 'record')}: ${escapeMarkdown([record.diagnosis, record.summary, record.treatment, record.notes].filter(Boolean).join(' | '))}`
    );
  }
  lines.push('');

  lines.push('## Consultation conversation timeline');
  if (!messagesResult.rows.length) lines.push('- No consultation messages recorded.');
  for (const message of messagesResult.rows) {
    lines.push(
      `- ${escapeMarkdown(message.created_at)} | task ${escapeMarkdown(message.task_id)} | ${message.sender_type === 'patient' ? 'Patient' : 'Doctor'}: ${escapeMarkdown(message.content)}`
    );
  }
  lines.push('');

  lines.push('## Patient attachments');
  if (!filesResult.rows.length) lines.push('- No attachments recorded.');
  for (const file of filesResult.rows) {
    lines.push(
      `- ${escapeMarkdown(file.created_at)} | ${escapeMarkdown(file.name)} | ${escapeMarkdown(file.mime_type)} | task ${escapeMarkdown(file.source_task_id)}`
    );
  }
  lines.push('');

  const markdown = lines.join('\n');
  await pool.query(
    `INSERT INTO patient_health_timeline_documents(user_id, content_markdown, checkin_count, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET content_markdown = EXCLUDED.content_markdown,
       checkin_count = EXCLUDED.checkin_count, updated_at = NOW()`,
    [userId, markdown, rows.length]
  );
  return markdown;
};

module.exports = { rebuildPatientHealthTimeline };
