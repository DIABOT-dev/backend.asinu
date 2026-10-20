'use strict';

// Chat accepts a stored file reference. The client never chooses its URL or
// storage identity, and a file cannot cross patient, task or doctor boundaries.
const resolveDoctorAttachmentContent = async (pool, { content, appUserId, taskId, senderRef }) => {
  if (typeof content !== 'string' || !content.startsWith('[ASINU_ATTACHMENT]')) return content;
  const invalid = () =>
    Object.assign(new Error('The attachment is unavailable for this conversation.'), {
      statusCode: 400,
      code: 'INVALID_PATIENT_FILE',
    });
  let reference;
  try {
    reference = JSON.parse(content.slice('[ASINU_ATTACHMENT]'.length));
  } catch {
    throw invalid();
  }
  if (
    !reference ||
    !['string', 'number'].includes(typeof reference.id) ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(String(reference.id)) ||
    !senderRef
  )
    throw invalid();
  const {
    rows: [file],
  } = await pool.query(
    `SELECT id, name, mime_type, size_bytes, public_id, resource_type, delivery_type
       FROM doctor_patient_files
      WHERE id::text = $1 AND user_id = $2 AND source_task_id = $3 AND uploaded_by = $4`,
    [String(reference.id), appUserId, taskId, senderRef]
  );
  if (!file || !file.public_id || file.delivery_type !== 'authenticated') throw invalid();
  return `[ASINU_ATTACHMENT]${JSON.stringify({
    id: String(file.id),
    name: file.name,
    mime_type: file.mime_type,
    size_bytes: Number(file.size_bytes),
    public_id: file.public_id,
    resource_type: file.resource_type,
    delivery_type: file.delivery_type,
  })}`;
};

module.exports = { resolveDoctorAttachmentContent };
