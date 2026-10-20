const {
  resolveDoctorAttachmentContent,
} = require('../../src/services/integrations/doctor-attachment.service');
const input = { appUserId: '42', taskId: 'task-1', senderRef: 'doctor-1' };
const file = {
  id: '17',
  name: 'guide.pdf',
  mime_type: 'application/pdf',
  size_bytes: '512',
  public_id: 'private/guide',
  resource_type: 'raw',
  delivery_type: 'authenticated',
};
const content = (data) => `[ASINU_ATTACHMENT]${JSON.stringify(data)}`;

test('uses the owned, private stored attachment and discards client URLs and storage IDs', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [file] }) };
  const result = await resolveDoctorAttachmentContent(pool, {
    ...input,
    content: content({
      id: 17,
      url: 'https://untrusted.example/file',
      public_id: 'another/patient',
      name: 'forged.pdf',
    }),
  });
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('uploaded_by = $4'), [
    '17',
    '42',
    'task-1',
    'doctor-1',
  ]);
  expect(result).toBe(content({ ...file, size_bytes: 512 }));
  expect(result).not.toContain('https://');
});

test('rejects files outside the patient, conversation or uploader scope before creating any message', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await expect(
    resolveDoctorAttachmentContent(pool, { ...input, content: content({ id: 'other-file' }) })
  ).rejects.toMatchObject({ code: 'INVALID_PATIENT_FILE', statusCode: 400 });
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test.each([null, {}, { id: '../secret' }, { id: { bad: true } }])(
  'rejects malformed file references: %j',
  async (reference) => {
    const pool = { query: jest.fn() };
    await expect(
      resolveDoctorAttachmentContent(pool, { ...input, content: content(reference) })
    ).rejects.toMatchObject({ code: 'INVALID_PATIENT_FILE' });
    expect(pool.query).not.toHaveBeenCalled();
  }
);

test.each([
  { ...file, public_id: null },
  { ...file, delivery_type: 'upload' },
])('rejects missing or public storage identities', async (row) => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
  await expect(
    resolveDoctorAttachmentContent(pool, { ...input, content: content({ id: 17 }) })
  ).rejects.toMatchObject({ code: 'INVALID_PATIENT_FILE' });
});

test('leaves ordinary conversation text unchanged', async () => {
  const pool = { query: jest.fn() };
  expect(await resolveDoctorAttachmentContent(pool, { ...input, content: 'Hello' })).toBe('Hello');
  expect(pool.query).not.toHaveBeenCalled();
});
