'use strict';

// Explicitly audited text fields. Query/filter columns and measurements retain
// their SQL types; the encrypted volume also protects them when stored.
module.exports = [
  { table: 'med_dose_items', id: 'id', owner: 'patient_user_id', fields: ['display_name'] },
  { table: 'med_items', id: 'id', owner: 'patient_user_id', fields: ['display_name', 'printed_name'] },
  { table: 'med_schedules', id: 'id', owner: 'patient_user_id', fields: ['note'] },
  { table: 'med_media', id: 'id', owner: 'patient_user_id', fields: ['payload'] },
  { table: 'med_scan_jobs', id: 'id', owner: 'patient_user_id', fields: ['result_json'] },
  { table: 'med_setup_receipts', id: 'id', owner: 'patient_user_id', fields: ['result_json'] },
  { table: 'med_schedule_audit', id: 'id', owner: 'patient_user_id', fields: ['before_json', 'after_json'] },
  { table: 'chat_histories', id: 'id', owner: 'user_id', fields: ['message'] },
  { table: 'chat_feedback', id: 'id', owner: 'user_id', fields: ['message_text'] },
  { table: 'doctor_patient_medical_records', id: 'id', owner: 'user_id', fields: ['title', 'diagnosis', 'summary', 'treatment', 'notes'] },
  { table: 'doctor_task_messages', id: 'id', owner: 'user_id', fields: ['content'] },
  { table: 'patient_health_timeline_documents', id: 'user_id', owner: 'user_id', fields: ['content_markdown'] },
];
