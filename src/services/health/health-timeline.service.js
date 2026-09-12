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
  const result = await pool.query(
    `SELECT id, session_date, initial_status, current_status, triage_severity,
            triage_summary, triage_messages, triage_completed_at, updated_at
       FROM health_checkins
      WHERE user_id = $1
      ORDER BY session_date ASC, id ASC`,
    [userId]
  );
  const rows = result.rows;
  const lines = [
    '# Health timeline',
    '',
    '> Machine-readable summary of completed patient check-ins. Use as context only; verify with the patient.',
    '',
  ];

  for (const row of rows) {
    const date = row.session_date ? String(row.session_date).slice(0, 10) : 'unknown date';
    lines.push(`## Check-in ${date}`);
    lines.push(`- Status: ${escapeMarkdown(statusLabel[row.current_status] || statusLabel[row.initial_status] || row.current_status || 'chưa rõ')}`);
    if (row.triage_severity) lines.push(`- Severity: ${escapeMarkdown(severityLabel[row.triage_severity] || row.triage_severity)}`);
    if (row.triage_summary) lines.push(`- Summary: ${escapeMarkdown(row.triage_summary)}`);
    if (row.triage_completed_at) lines.push(`- Completed at: ${escapeMarkdown(row.triage_completed_at)}`);
    const messages = Array.isArray(row.triage_messages) ? row.triage_messages : [];
    if (messages.length) {
      lines.push('- Answers:');
      for (const message of messages) {
        const question = escapeMarkdown(message.question || message.question_text || message.question_id || 'Question');
        const answer = escapeMarkdown(answerText(message.answer));
        if (answer) lines.push(`  - ${question}: ${answer}`);
      }
    }
    lines.push('');
  }

  const markdown = lines.join('\n').slice(0, 120_000);
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

