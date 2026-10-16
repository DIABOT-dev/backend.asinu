'use strict';

// Explicitly audited text fields. Query/filter columns and measurements retain
// their SQL types; the encrypted volume also protects them when stored.
module.exports = [
  { table: 'chat_histories', id: 'id', owner: 'user_id', fields: ['message'] },
  { table: 'chat_feedback', id: 'id', owner: 'user_id', fields: ['message_text'] },
  { table: 'doctor_patient_medical_records', id: 'id', owner: 'user_id', fields: ['title', 'diagnosis', 'summary', 'treatment', 'notes'] },
  { table: 'doctor_task_messages', id: 'id', owner: 'user_id', fields: ['content'] },
  { table: 'patient_health_timeline_documents', id: 'user_id', owner: 'user_id', fields: ['content_markdown'] },
];
