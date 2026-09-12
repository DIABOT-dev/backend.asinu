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
  const [profileResult, checkinResult, logsResult, recordsResult, messagesResult, filesResult] =
    await Promise.all([
      pool.query(
        `SELECT u.display_name, u.full_name, u.email, u.phone_number,
              p.gender, p.birth_year, p.date_of_birth,
              p.medical_conditions, p.chronic_symptoms, p.raw_profile
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
              bp.systolic, bp.diastolic, bp.pulse,
              glucose.value AS glucose_value, glucose.unit AS glucose_unit,
              medication.med_name, medication.dose_text, medication.frequency_text,
              symptoms.symptom_name, symptoms.severity AS symptom_severity
         FROM logs_common common
         LEFT JOIN blood_pressure_logs bp ON bp.log_id = common.id
         LEFT JOIN glucose_logs glucose ON glucose.log_id = common.id
         LEFT JOIN medication_logs medication ON medication.log_id = common.id
         LEFT JOIN symptom_logs symptoms ON symptoms.user_id = common.user_id
          AND symptoms.occurred_date::text = common.occurred_at::date::text
        WHERE common.user_id = $1
        ORDER BY common.occurred_at ASC, common.id ASC`,
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
  const rows = checkinResult.rows;
  const lines = [
    '# Health timeline',
    '',
    '> Complete patient health timeline assembled from onboarding, health logs, check-ins and consultations. Use as context only; verify with the patient.',
    '',
    '## Patient profile and declared health information',
    `- Name: ${escapeMarkdown(profile.full_name || profile.display_name || 'unknown')}`,
    `- Gender: ${escapeMarkdown(profile.gender || 'not declared')}`,
    `- Birth year: ${escapeMarkdown(profile.birth_year || profile.date_of_birth || 'not declared')}`,
    `- Medical conditions: ${escapeMarkdown(JSON.stringify(profile.medical_conditions || []))}`,
    `- Chronic symptoms: ${escapeMarkdown(JSON.stringify(profile.chronic_symptoms || []))}`,
    `- Allergies: ${escapeMarkdown(JSON.stringify(profile.raw_profile?.allergies || []))}`,
    `- Medications declared: ${escapeMarkdown(JSON.stringify(profile.raw_profile?.medications || []))}`,
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
    if (log.symptom_name)
      values.push(
        `symptom ${log.symptom_name}${log.symptom_severity ? ` (${log.symptom_severity})` : ''}`
      );
    if (values.length)
      lines.push(`- ${escapeMarkdown(log.occurred_at)}: ${escapeMarkdown(values.join('; '))}`);
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
