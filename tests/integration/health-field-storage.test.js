'use strict';
// Only synthetic fixtures in an explicitly selected local security test DB.
jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  ...jest.requireActual('../../src/services/integrations/doctor-task.service'),
  deliverDoctorRequest: jest.fn(async () => ({ data: { request_id: 'fixture' } })),
}));
jest.mock('../../src/services/integrations/doctor-profile.service', () => ({
  ...jest.requireActual('../../src/services/integrations/doctor-profile.service'),
  verifyDoctorSignature: jest.fn(),
}));
jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn() }));
jest.mock('../../src/services/integrations/doctor-chat-realtime', () => ({ broadcastChatEvent: jest.fn() }));

const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fields = require('../../src/security/health-field-encryption');
const chat = require('../../src/services/chat/chat.service');
const feedback = require('../../src/services/chat/chat-feedback.service');
const messaging = require('../../src/services/integrations/doctor-messaging.service');
const lifecycle = require('../../src/services/integrations/doctor-lifecycle.service');
const { loadDoctorClinicalContext } = require('../../src/services/integrations/doctor-context.service');
const { encryptExistingHealthFields } = require('../../scripts/encrypt-health-fields');

const url = process.env.SECURITY_TEST_DATABASE_URL;
(url ? describe : describe.skip)('encrypted storage through real PostgreSQL services', () => {
  let pool, directory, userId, taskId, previous;
  const tenant = 'clinic-demo';
  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_security_test')) throw Error('Local isolated security test DB required');
    pool = new Pool({ connectionString: url });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-storage-keys-'));
    fs.chmodSync(directory, 0o700);
    previous = [process.env.HEALTH_FIELD_ENCRYPTION_ENABLED, process.env.HEALTH_FIELD_KEY_DIRECTORY];
    process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.HEALTH_FIELD_KEY_DIRECTORY = directory;
    fields.assertHealthEncryptionReady();
    userId = (await pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [crypto.randomUUID() + '@security.invalid'])).rows[0].id;
    taskId = 'security-' + crypto.randomUUID();
    await pool.query(`INSERT INTO doctor_task_outbox(event_id,idempotency_key,tenant_id,payload,status) VALUES($1,$1,$2,$3,'sent')`, [taskId, tenant, { event_type: 'doctor.task.requested', payload: { task_id: taskId, app_user_id: String(userId), summary: 'synthetic fixture' } }]);
  });
  afterAll(async () => {
    if (pool) {
      try {
        if (taskId) await pool.query("DELETE FROM doctor_task_outbox WHERE payload->'payload'->>'task_id'=$1", [taskId]);
        if (userId) {
          await pool.query('DELETE FROM chat_histories WHERE user_id=$1', [userId]);
          await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        }
      } finally { await pool.end(); }
    }
    if (previous) {
      for (const [i, key] of ['HEALTH_FIELD_ENCRYPTION_ENABLED', 'HEALTH_FIELD_KEY_DIRECTORY'].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  test('chat and notes are encrypted in SQL and readable by their owner', async () => {
    await chat.saveUserMessage(pool, userId, 'Tin nhắn thử nghiệm', new Date());
    await chat.saveAssistantReply(pool, userId, 'Phản hồi thử nghiệm', new Date());
    await feedback.saveChatNote(pool, userId, 'fixture-message', 'Ghi chú thử nghiệm');
    const raw = await pool.query('SELECT message FROM chat_histories WHERE user_id=$1', [userId]);
    expect(raw.rows.every(row => row.message.startsWith(fields.PREFIX))).toBe(true);
    expect((await chat.getChatHistory(pool, userId)).map(row => row.message)).toEqual(['Tin nhắn thử nghiệm', 'Phản hồi thử nghiệm']);
    expect((await feedback.getChatNotes(pool, userId, 1, 10)).notes[0].message_text).toBe('Ghi chú thử nghiệm');
  });
  test('Doctor messaging preserves idempotency, Unicode limits, edits and previews', async () => {
    const text = 'ế'.repeat(5000);
    const input = { tenant_id: tenant, message_type: 'reply', content: text, client_message_id: crypto.randomUUID() };
    const first = await messaging.sendPatientMessage(pool, { userId, taskId, input });
    expect(first.content).toBe(text);
    expect((await messaging.sendPatientMessage(pool, { userId, taskId, input })).duplicate).toBe(true);
    expect((await messaging.listMessages(pool, tenant, taskId, userId)).messages[0].content).toBe(text);
    expect((await messaging.listPatientTasks(pool, userId, tenant)).tasks[0].latest_message).toBe(text);
    const edited = fields.PREFIX + 'user supplied text';
    await messaging.messageAction(pool, { tenantId: tenant, taskId, userId, actorType: 'patient', actorRef: String(userId), action: 'edit', messageId: first.id, content: edited });
    expect((await messaging.listMessages(pool, tenant, taskId, userId)).messages[0].content).toBe(edited);
    const raw = (await pool.query('SELECT content FROM doctor_task_messages WHERE id=$1', [first.id])).rows[0].content;
    expect(raw).not.toBe(edited);
    expect(fields.decryptHealthField(userId, 'doctor_task_messages.content', raw)).toBe(edited);
  });
  test('consultation records and Doctor AI context remain readable after encryption', async () => {
    const now = new Date().toISOString();
    await lifecycle.ingestDoctorLifecycle(pool, { body: {
      event_id: crypto.randomUUID(), event_type: 'service.completed', source: 'asinu-doctor', version: 1, occurred_at: now, correlation_id: taskId,
      payload: { tenant_id: tenant, app_order_id: taskId, app_user_id: String(userId), service_code: 'fixture', source_channel: 'app', specialty: 'general', service_flow: 'clinical', priority: 'normal', summary: 'fixture', status: 'completed', consultation_summary: { problem_summary: 'Mô tả thử nghiệm', assessment: 'Đánh giá thử nghiệm', next_steps: 'Hướng dẫn thử nghiệm', warning_signs: 'Dấu hiệu thử nghiệm', follow_up_recommendation: 'Theo dõi thử nghiệm' } },
    } });
    const row = (await pool.query('SELECT diagnosis,summary FROM doctor_patient_medical_records WHERE user_id=$1', [userId])).rows[0];
    expect(row.diagnosis.startsWith(fields.PREFIX)).toBe(true);
    const result = await loadDoctorClinicalContext(pool, { tenant_id: tenant, app_user_id: String(userId), task_id: taskId });
    expect(JSON.stringify(result)).toContain('Đánh giá thử nghiệm');
    expect(JSON.stringify(result)).not.toContain(row.diagnosis);
    const timeline = (await pool.query('SELECT content_markdown FROM patient_health_timeline_documents WHERE user_id=$1', [userId])).rows[0].content_markdown;
    expect(timeline.startsWith(fields.PREFIX)).toBe(true);
    expect(fields.decryptHealthField(userId, 'patient_health_timeline_documents.content_markdown', timeline)).toContain('Đánh giá thử nghiệm');
  });
  test('backfill is repeatable, preserves new ciphertext and account deletion retires its key', async () => {
    await pool.query("INSERT INTO chat_histories(user_id,message,sender) VALUES($1,'legacy fixture','user')", [userId]);
    expect(await encryptExistingHealthFields(pool)).toBeGreaterThan(0);
    expect(await encryptExistingHealthFields(pool)).toBe(0);
    const key = fs.readFileSync(path.join(directory, userId + '.key'));
    const value = (await pool.query('SELECT message FROM chat_histories WHERE user_id=$1 LIMIT 1', [userId])).rows[0].message;
    fs.unlinkSync(path.join(directory, userId + '.key'));
    await expect(chat.getChatHistory(pool, userId)).rejects.toThrow();
    fs.writeFileSync(path.join(directory, userId + '.key'), key, { mode: 0o600 });
    expect(await chat.getChatHistory(pool, userId)).toHaveLength(3);
    await pool.query('DELETE FROM chat_histories WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    expect(await fields.cleanupOrphanHealthKeys(pool)).toBe(1);
    expect(() => fields.decryptHealthField(userId, 'chat_histories.message', value)).toThrow();
  });
});
