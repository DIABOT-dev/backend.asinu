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
