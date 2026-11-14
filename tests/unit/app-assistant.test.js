jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { validatePlan, plan, numbersIn, requestSchema } = require('../../src/services/assistant/app-assistant.service');
const { logBaseSchema } = require('../../src/validation/validation.schemas');

const request = (text, current = { language: 'vi', fontSize: 'normal' }) => ({ text, current });
const ready = actions => ({ status: 'ready', question: '', actions });
beforeEach(() => jest.clearAllMocks());

test('a mixed request preserves all measurements and app settings without writing', () => {
  const text = 'Ghi đường huyết 120, huyết áp 130/80 nhịp tim 70, uống 500 ml nước, đổi tiếng Anh và chữ lớn hơn';
  const result = validatePlan(ready([
    { type: 'glucose', value: 120, unit: 'mg/dL', evidence: 'đường huyết 120' },
    { type: 'blood_pressure', systolic: 130, diastolic: 80, pulse: 70, evidence: 'huyết áp 130/80 nhịp tim 70' },
    { type: 'water', volume_ml: 500, evidence: 'uống 500 ml nước' },
    { type: 'language', value: 'en', evidence: 'đổi tiếng Anh' },
    { type: 'font_size', value: 'increase', evidence: 'chữ lớn hơn' },
  ]), request(text));
  expect(result.actions.map(action => action.type)).toEqual(['glucose', 'blood_pressure', 'water', 'language', 'font_size']);
  expect(result.actions[4].value).toBe('large');
});

test.each([
  ['small', 'decrease', 'small'], ['normal', 'decrease', 'small'],
  ['large', 'increase', 'xlarge'], ['xlarge', 'increase', 'xlarge'],
])('font stepping follows the four app sizes: %s %s', (fontSize, direction, expected) => {
  const result = validatePlan(ready([{ type: 'font_size', value: direction, evidence: 'đổi cỡ chữ' }]), request('đổi cỡ chữ', { language: 'vi', fontSize }));
  expect(result.actions[0].value).toBe(expected);
});

test.each([
  [{ type: 'water', volume_ml: 500, evidence: 'uống một cốc nước' }, 'uống một cốc nước'],
  [{ type: 'glucose', value: 130, unit: 'mg/dL', evidence: 'đường huyết 120' }, 'đường huyết 120'],
  [{ type: 'glucose', value: 5.6, unit: 'mmol/L', evidence: 'đường huyết 5,6 mmol/L' }, 'đường huyết 5,6 mmol/L'],
  [{ type: 'blood_pressure', systolic: 12, diastolic: 8, evidence: 'huyết áp 12/8' }, 'huyết áp 12/8'],
  [{ type: 'blood_pressure', systolic: 80, diastolic: 120, evidence: 'huyết áp 120/80' }, 'huyết áp 120/80'],
  [{ type: 'water', volume_ml: 10000, evidence: 'uống 10000 ml' }, 'uống 10000 ml'],
  [{ type: 'weight', value: 60, evidence: 'cân nặng 60' }, 'cân nặng 60'],
  [{ type: 'language', value: 'fr', evidence: 'tiếng Pháp' }, 'tiếng Pháp'],
  [{ type: 'language', value: 'en', userId: 999, evidence: 'tiếng Anh' }, 'tiếng Anh'],
])('invalid, invented or unsupported actions cannot become a preview (%j)', (action, text) => {
  expect(validatePlan(ready([action]), request(text))).toBeNull();
});

test('litres and Vietnamese spoken quantities retain the actual quantity', () => {
  expect(validatePlan(ready([{ type: 'water', volume_ml: 500, evidence: 'uống 0,5 lít nước' }]), request('uống 0,5 lít nước')).actions[0].volume_ml).toBe(500);
  expect(numbersIn('một trăm hai mươi')).toContain(120);
  expect(validatePlan(ready([{ type: 'glucose', value: 120, unit: 'mg/dL', evidence: 'đường huyết một trăm hai mươi' }]), request('đường huyết một trăm hai mươi')).actions[0].value).toBe(120);
});

test('clarification retains the original evidence, but not an assistant-invented reading', () => {
  const r = { ...request('là 80'), clarification: { original: 'huyết áp trên 120', question: 'Số dưới là bao nhiêu?' } };
  expect(validatePlan(ready([{ type: 'blood_pressure', systolic: 120, diastolic: 80, evidence: 'huyết áp trên 120\nlà 80' }]), r)).not.toBeNull();
  expect(validatePlan(ready([{ type: 'blood_pressure', systolic: 130, diastolic: 80, evidence: 'huyết áp 130/80' }]), r)).toBeNull();
});

test('duplicate actions and partial unsupported plans are rejected', () => {
  const a = { type: 'language', value: 'en', evidence: 'tiếng Anh' };
  expect(validatePlan(ready([a, a]), request('tiếng Anh'))).toBeNull();
  expect(validatePlan({ status: 'unsupported', question: 'Chưa hỗ trợ', actions: [a] }, request('tiếng Anh'))).toBeNull();
  expect(requestSchema.safeParse({ ...request('đổi tiếng Anh'), user_id: 2 }).success).toBe(false);
});

test('retired weight ingestion is rejected at the shared API schema', () => {
  expect(logBaseSchema.safeParse({ log_type: 'weight', occurred_at: new Date().toISOString(), data: { weight_kg: 60 } }).success).toBe(false);
});

test('semantic review blocks a valid-shaped action inferred from a question', async () => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(ready([{ type: 'glucose', value: 120, unit: 'mg/dL', evidence: 'đường huyết 120' }])) })
    .mockResolvedValueOnce({ content: '{"approved":false}' });
  const result = await plan(request('đường huyết 120 có cao không?'));
  expect(result.status).toBe('clarify');
  expect(result.actions).toEqual([]);
  expect(callTextAi).toHaveBeenCalledTimes(2);
});

test('an accepted plan is only a typed preview using the configured Dr7 provider', async () => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(ready([{ type: 'language', value: 'en', evidence: 'đổi tiếng Anh' }])) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await plan(request('đổi tiếng Anh'));
  expect(result.status).toBe('ready');
  expect(callTextAi.mock.calls[0][0]).toMatchObject({ provider: 'medgemma', strictProvider: true });
  expect(callTextAi.mock.calls[0][0].prompt).not.toMatch(/user_id|push_token|JWT_SECRET/);
});
test('private tool answers, including shared family health, never enter a subsequent model prompt', async () => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(ready([{ type: 'language', value: 'en', evidence: 'đổi tiếng Anh' }])) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  await plan({ ...request('đổi tiếng Anh'), conversation: [
    { role: 'user', text: 'Xem sức khỏe người thân' },
    { role: 'assistant', text: 'PRIVATE_RELATIVE_HEALTH_TOOL_RESULT' },
  ] });
  for (const [options] of callTextAi.mock.calls) expect(options.prompt).not.toContain('PRIVATE_RELATIVE_HEALTH_TOOL_RESULT');
  expect(callTextAi.mock.calls[0][0].prompt).toContain('Xem sức khỏe người thân');
});

const medication = require('../../src/services/assistant/medication-assistant.service');
const medicationContext = { available: true, items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Hapacol', kind: 'MEDICINE' }],
  schedules: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', item_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], time: '07:00', consent: 'ACTIVE', revision: 1 }] };
test('medication references resolve only within the authenticated server context', () => {
  const action = { type: 'medication_move', medicine_ref: 'm1', schedule_ref: 's1', time_local: '08:00', evidence: 'đổi Hapacol sáng sang 8 giờ sáng' };
  expect(validatePlan(ready([action]), request(action.evidence), medicationContext)).not.toBeNull();
  expect(validatePlan(ready([action]), request(action.evidence))).toBeNull();
  expect(validatePlan(ready([{ ...action, medicine_ref: 'm2' }]), request(action.evidence), medicationContext)).toBeNull();
  expect(validatePlan(ready([{ ...action, schedule_ref: 's2' }]), request(action.evidence), medicationContext)).toBeNull();
  expect(validatePlan(ready([{ ...action, user_id: 2 }]), request(action.evidence), medicationContext)).toBeNull();
});
test('optional empty envelope fields from Dr7 preserve valid actions and meaningful clarification', () => {
  const r = request('nhắc uống Hapacol mỗi ngày lúc 7 giờ sáng');
  expect(validatePlan({ status: 'ready', actions: [{ type: 'medication_create', name: 'Hapacol', times: ['07:00'], evidence: r.text }] }, r, medicationContext).status).toBe('ready');
  expect(validatePlan({ status: 'clarify', question: 'Bạn muốn nhắc lúc mấy giờ?' }, r, medicationContext)).toMatchObject({ status: 'clarify', actions: [] });
  expect(validatePlan({ status: 'ready' }, r, medicationContext)).toBeNull();
  expect(validatePlan({ status: 'clarify' }, r, medicationContext)).toBeNull();
});
test('new medicines need a real name from the user, valid clocks and no dose hidden in the name', () => {
  const r = request('nhắc uống Hapacol mỗi ngày lúc 7 giờ sáng');
  const action = { type: 'medication_create', name: 'Hapacol', times: ['07:00'], evidence: r.text };
  expect(validatePlan(ready([action]), r, medicationContext)).not.toBeNull();
  for (const change of [{ name: 'Metformin' }, { times: ['25:00'] }, { times: ['07:00', '07:00'] }, { name: 'Hapacol 2 viên' }])
    expect(validatePlan(ready([{ ...action, ...change }]), r, medicationContext)).toBeNull();
});
test('medication clarification uses a name from the prior user turn and the time from the latest answer', () => {
  const r = { ...request('7 giờ rưỡi sáng'), clarification: { original: 'Nhắc uống Hapacol mỗi ngày', question: 'Bạn muốn nhắc lúc mấy giờ?' } };
  const action = { type: 'medication_create', name: 'Hapacol', times: ['07:30'], evidence: r.text };
  expect(validatePlan(ready([action]), r, medicationContext)).not.toBeNull();
  expect(validatePlan(ready([{ ...action, name: 'Metformin' }]), r, medicationContext)).toBeNull();
});
test('daily repetition and add-versus-move are clarified instead of inferred from current schedules', () => {
  const create = { type: 'medication_create', name: 'Metformin', times: ['08:00'], evidence: 'Metformin' };
  expect(medication.policyQuestion([create], request('Nhắc uống Metformin lúc 8 giờ sáng'), medicationContext, 'vi')).toMatch(/hằng ngày/);
  expect(medication.policyQuestion([create], { ...request('Đúng rồi'), clarification: { original: 'Nhắc uống Metformin lúc 8 giờ sáng', question: 'Bạn muốn nhắc lịch này hằng ngày phải không?' } }, medicationContext, 'vi')).toBeUndefined();
  expect(medication.policyQuestion([{ ...create, name: 'Hapacol' }], request('Nhắc Hapacol mỗi ngày 8 giờ sáng'), medicationContext, 'vi')).toMatch(/thêm.*hay đổi/);
  expect(medication.policyQuestion([{ type: 'medication_move' }], { ...request('8 giờ sáng'), clarification: { original: 'Nhắc uống Hapacol mỗi ngày', question: 'Mấy giờ?' } }, medicationContext, 'vi')).toMatch(/thêm.*hay đổi/);
});
test('medication planning signs only reviewed previews and sends no real identifiers to the model', async () => {
  const spy = jest.spyOn(medication, 'contextForPlan').mockResolvedValue(medicationContext);
  const profileSpy = jest.spyOn(require('../../src/services/assistant/app-tools.service'), 'profileContext').mockResolvedValue(null);
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'assistant-unit-test-only-secret';
  try {
    const text = 'nhắc uống Metformin mỗi ngày lúc 7 giờ sáng';
    callTextAi.mockResolvedValueOnce({ content: JSON.stringify(ready([{ type: 'medication_create', name: 'Metformin', times: ['07:00'], evidence: text }])) })
      .mockResolvedValueOnce({ content: '{"approved":true}' });
    const result = await plan(request(text), 'vi', { pool: {}, userId: 123 });
    expect(result.actions[0]).toMatchObject({ type: 'medication', changes: [{ operation: 'create', name: 'Metformin', times: ['07:00'] }] });
    expect(typeof result.actions[0].planToken).toBe('string');
    expect(callTextAi.mock.calls[0][0].prompt).not.toContain(medicationContext.items[0].id);
    expect(callTextAi.mock.calls[0][0].prompt).not.toContain(medicationContext.schedules[0].id);
  } finally { spy.mockRestore(); profileSpy.mockRestore(); if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});

test('query tools accept only supported topics/ranges, and allow distinct queries in one request', () => {
  const text = 'xem huyết áp và đường huyết tuần này';
  const actions = ['blood_pressure', 'glucose'].map(topic => ({ type: 'query', topic, range: 'week', evidence: text }));
  expect(validatePlan(ready(actions), request(text))).not.toBeNull();
  expect(validatePlan(ready([{ ...actions[0], topic: 'sql', sql: 'SELECT * FROM users' }]), request(text))).toBeNull();
  expect(validatePlan(ready([{ ...actions[0], user_id: 999 }]), request(text))).toBeNull();
});

test('read-only questions return real tool results with no confirmation or writes', async () => {
  const tools = require('../../src/services/assistant/app-tools.service');
  const pool = {}, userId = 7, text = 'Hôm nay tôi uống bao nhiêu nước?';
  const profile = jest.spyOn(tools, 'profileContext').mockResolvedValue(null);
  const context = jest.spyOn(medication, 'contextForPlan').mockResolvedValue({ available: false, items: [], schedules: [] });
  const query = jest.spyOn(tools, 'query').mockResolvedValue('Hôm nay, bạn đã ghi 750 ml nước trong 3 lần.');
  try {
    callTextAi.mockResolvedValueOnce({ content: JSON.stringify(ready([{ type: 'query', topic: 'water', range: 'today', evidence: text }])) })
      .mockResolvedValueOnce({ content: '{"approved":true}' });
    const result = await plan(request(text), 'vi', { pool, userId });
    expect(result).toMatchObject({ status: 'answer', actions: [], answer: 'Hôm nay, bạn đã ghi 750 ml nước trong 3 lần.' });
    expect(query).toHaveBeenCalledWith(pool, userId, expect.objectContaining({ topic: 'water' }), 'vi');
  } finally { profile.mockRestore(); context.mockRestore(); query.mockRestore(); }
});

test('navigation and profile edits cannot target arbitrary screens, identities or inferred conditions', () => {
  expect(validatePlan(ready([{ type: 'navigate', destination: '/admin', evidence: 'mở quản trị' }]), request('mở quản trị'))).toBeNull();
  expect(validatePlan(ready([{ type: 'profile', changes: { phone: '0999999999' }, evidence: 'sửa số điện thoại' }]), request('sửa số điện thoại'))).toBeNull();
  expect(validatePlan(ready([{ type: 'profile', changes: { name: 'Lan' }, evidence: 'sửa tên thành An' }]), request('sửa tên thành An'))).toBeNull();
  expect(validatePlan(ready([{ type: 'profile', changes: { chronicDiseases: ['Tiểu đường'] }, evidence: 'tôi chóng mặt' }]), request('tôi chóng mặt'))).toBeNull();
  const text = 'thêm bệnh nền Gút';
  expect(validatePlan(ready([{ type: 'profile', changes: { chronicDiseases: ['Tiểu đường', 'Gút'] }, evidence: text }]), request(text), null, { chronicDiseases: ['Tiểu đường'] })).not.toBeNull();
});

test('a medicine in a group cannot acknowledge or pause its companions without clarification', () => {
  const grouped = { ...medicationContext, items: [...medicationContext.items, { id: 'other', name: 'Vitamin D3', kind: 'SUPPLEMENT' }],
    schedules: [{ ...medicationContext.schedules[0], item_ids: [medicationContext.items[0].id, 'other'] }] };
  const state = { type: 'medication_state', schedule_ref: 's1', state: 'pause', evidence: 'tạm dừng Hapacol' };
  const question = medication.policyQuestion([state], request('tạm dừng Hapacol'), grouped, 'vi');
  expect(question).toContain('Vitamin D3');
  expect(medication.policyQuestion([state], { ...request('Đúng rồi'), clarification: { original: 'tạm dừng Hapacol', question } }, grouped, 'vi')).toBeUndefined();
});

test('acknowledgements cannot select future or expired doses', () => {
  const action = { type: 'medication_answer', dose_ref: 'd1', answer: 'taken', evidence: 'đã uống' };
  for (const minutes of [5, -121]) {
    const context = { ...medicationContext, doses: [{ id: 'dose', state: 'SCHEDULED', scheduled_at: new Date(Date.now() + minutes * 60000) }] };
    expect(medication.validateAction(action, context)).toBe(false);
  }
});
