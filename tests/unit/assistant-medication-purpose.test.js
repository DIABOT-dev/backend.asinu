'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const purpose = require('../../src/services/v21/medication-purpose.service');
const medication = require('../../src/services/assistant/medication-assistant.service');
const assistant = require('../../src/services/assistant/app-assistant.service');
const { callTextAi } = require('../../src/services/ai/ai.service');
const source = { name: 'DHG Pharma', url: 'https://dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650-0' };
const context = { available: true, items: [], schedules: [], doses: [] };
const action = (name = 'Hapacol 650') => ({ type: 'medication_create', name, times: ['07:00'], evidence: `Nhắc uống ${name} mỗi ngày lúc 7 giờ sáng` });
function result(name = 'Hapacol 650', override = {}) {
  const match = { status: 'matched', tags: ['fever_reduction', 'pain_relief'], productName: name, source, checkedAt: new Date().toISOString() };
  return { ...match, token: jwt.sign({ purpose: 'med-purpose-tags', actor: 7, patient: 7,
    name: createHash('sha256').update(purpose.normalizeName(name)).digest('hex'), ...match, ...override,
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}
let lookup, savedEnv;
beforeEach(() => {
  savedEnv = { JWT_SECRET: process.env.JWT_SECRET, MED_MEDIA_SIGNING_KEY: process.env.MED_MEDIA_SIGNING_KEY };
  process.env.JWT_SECRET = 'assistant-purpose-unit-fixture'; delete process.env.MED_MEDIA_SIGNING_KEY;
  lookup = jest.spyOn(purpose, 'lookup').mockResolvedValue(result());
  callTextAi.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const claims = preview => jwt.verify(preview.planToken, process.env.JWT_SECRET,
  { algorithms: ['HS256'], audience: 'asinu:assistant-medication', subject: '7' });

test('source-backed tags become a read-only preview and owner/name-bound signed operation without AI calls', async () => {
  const db = { query: jest.fn() }, input = action();
  const preview = await medication.prepareWithPurpose(db, [input], context, 7, input.evidence);
  expect(lookup).toHaveBeenCalledWith(db, 7, 7, { name: input.name, kind: 'MEDICINE' }, { signal: undefined });
  expect(preview.changes[0].purpose).toEqual({ status: 'matched', tags: ['fever_reduction', 'pain_relief'], productName: input.name, source });
  const operation = claims(preview).operations[0];
  expect(purpose.confirmedTags(7, 7, { display_name: operation.name, kind: 'MEDICINE', tag_confirmation: operation.tag_confirmation }).codes)
    .toEqual(preview.changes[0].purpose.tags);
  expect(preview.changes[0].purpose).not.toHaveProperty('token');
  expect(db.query).not.toHaveBeenCalled(); expect(callTextAi).not.toHaveBeenCalled();
});
test('displayed tags come from verified claims, never unsigned lookup metadata', async () => {
  lookup.mockResolvedValue({ ...result(), productName: 'Invented product', source: { name: 'Invented source', url: 'https://example.test' } });
  const input = action(), preview = await medication.prepareWithPurpose({}, [input], context, 7, input.evidence);
  expect(preview.changes[0].purpose).toMatchObject({ productName: input.name, source });
});
test('a new reminder retains only the explicitly selected verified purpose tag', async () => {
  const input = { ...action(), purpose_codes: ['pain_relief'] }; input.evidence += ', chỉ chọn tag giảm đau';
  const preview = await medication.prepareWithPurpose({}, [input], context, 7, input.evidence);
  expect(preview.changes[0].purpose.tags).toEqual(['pain_relief']);
  expect(claims(preview).operations[0].tag_confirmation.codes).toEqual(['pain_relief']);
});
test('explicitly excluding all tags skips lookup and saves no purpose capability', async () => {
  const input = { ...action(), purpose_codes: [] }; input.evidence += ', không gắn tag';
  const preview = await medication.prepareWithPurpose({}, [input], context, 7, input.evidence);
  expect(preview.changes[0].purpose).toEqual({ status: 'not_selected', tags: [] });
  expect(claims(preview).operations[0]).not.toHaveProperty('tag_confirmation'); expect(lookup).not.toHaveBeenCalled();
});
test('a requested but unverified purpose never becomes a saved reminder tag', async () => {
  const input = { ...action(), purpose_codes: ['diabetes'] }; input.evidence += ', chọn tag đường huyết';
  await expect(medication.prepareWithPurpose({}, [input], context, 7, input.evidence)).rejects.toMatchObject({ code: 'MED_TAG_NOT_VERIFIED' });
});
test.each(['ambiguous', 'unavailable', 'not_found'])('%s leaves the requested name unchanged and does not sign any purpose tags', async status => {
  lookup.mockResolvedValue({ status, tags: [] });
  const input = action('Hapacol'), preview = await medication.prepareWithPurpose({}, [input], context, 7, input.evidence);
  expect(preview.changes[0]).toMatchObject({ name: 'Hapacol', purpose: { status, tags: [] } });
  expect(claims(preview).operations[0]).not.toHaveProperty('tag_confirmation');
});
test.each([{ actor: 8 }, { patient: 8 }, { name: 'wrong-name' }])('a lookup capability for another owner or medicine cannot be attached (%j)', async override => {
  lookup.mockResolvedValue(result('Hapacol 650', override));
  const input = action();
  await expect(medication.prepareWithPurpose({}, [input], context, 7, input.evidence)).rejects.toMatchObject({ code: 'MED_TAG_CONFIRMATION_INVALID' });
});
test('invalid or model-invented names are rejected before any public catalog query', async () => {
  await expect(medication.prepareWithPurpose({}, [action()], context, 7, 'Nhắc uống thuốc khác')).rejects.toMatchObject({ code: 'APP_ASSISTANT_INVALID_REQUEST' });
  expect(lookup).not.toHaveBeenCalled();
});
test('already confirmed tags are shown and preserved without looking up or reclassifying an existing medicine', async () => {
  const current = { ...context, items: [{ id: 'saved-med', name: 'Hapacol 650', kind: 'MEDICINE', purpose_tags: {
    codes: ['pain_relief'], productName: 'Hapacol 650', source,
  } }] };
  const input = action(), preview = await medication.prepareWithPurpose({}, [input], current, 7, input.evidence);
  expect(preview.changes[0].purpose.tags).toEqual(['pain_relief']);
  expect(claims(preview).operations[0]).toMatchObject({ item_id: 'saved-med' });
  expect(claims(preview).operations[0]).not.toHaveProperty('tag_confirmation');
  expect(medication.modelContext(current)).not.toHaveProperty('purpose_tags');
  expect(JSON.stringify(medication.modelContext(current))).not.toContain(source.url);
  expect(lookup).not.toHaveBeenCalled();
});
test('moving a reminder has no catalog lookup', async () => {
  const current = { ...context, items: [{ id: 'a', name: 'Hapacol', kind: 'MEDICINE' }],
    schedules: [{ id: 's', item_ids: ['a'], active: true, consent: 'ACTIVE', time: '07:00' }] };
  const preview = await medication.prepareWithPurpose({}, [{ type: 'medication_move', medicine_ref: 'm1', schedule_ref: 's1', time_local: '08:00' }], current, 7);
  expect(preview.changes[0].operation).toBe('move'); expect(lookup).not.toHaveBeenCalled();
});
test('cancelling before preparation does not start a lookup', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(medication.prepareWithPurpose({}, [action()], context, 7, action().evidence, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(lookup).not.toHaveBeenCalled();
});
test('cancelling a lookup prevents signing or looking up the next medicine', async () => {
  const abort = new AbortController();
  lookup.mockImplementation(async () => { abort.abort(); return result(); });
  const inputs = [action(), action('Another medicine')];
  await expect(medication.prepareWithPurpose({}, inputs, context, 7, inputs.map(i => i.evidence).join('\n'), { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(lookup).toHaveBeenCalledTimes(1);
});
test('closing a chat releases its pending public lookup promptly without writing or creating a confirmation', async () => {
  lookup.mockRestore();
  const common = require('../../src/services/v21/common');
  jest.spyOn(common, 'patientAccess').mockResolvedValue(7);
  jest.spyOn(common, 'assertFeature').mockResolvedValue(undefined);
  let release, started;
  const fetching = new Promise(resolve => { started = resolve; });
  jest.spyOn(global, 'fetch').mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const abort = new AbortController(), db = { query: jest.fn() };
  const pending = purpose.lookup(db, 7, 7, { name: 'Cancel fixture medicine', kind: 'MEDICINE' }, { signal: abort.signal });
  await fetching;
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort(); await rejected;
  release(new Response('<urlset><url><loc>' + source.url + '</loc></url></urlset>'));
  expect(db.query).not.toHaveBeenCalled();
});
test('explicit commands still cost zero AI calls and use the same purpose preparation', async () => {
  jest.spyOn(medication, 'contextForPlan').mockResolvedValue(context);
  lookup.mockResolvedValue(result('Hapacol'));
  const preview = await assistant.plan({ text: action('Hapacol').evidence, current: { language: 'vi', fontSize: 'normal' } }, 'vi', { pool: {}, userId: 7 });
  expect(preview.status).toBe('ready'); expect(preview.actions[0].changes[0].purpose.tags).toHaveLength(2);
  expect(lookup).toHaveBeenCalledTimes(1); expect(callTextAi).not.toHaveBeenCalled();
});
test('AI-reviewed commands use the lookup only after review and never send product provenance back to Dr7', async () => {
  jest.spyOn(medication, 'contextForPlan').mockResolvedValue(context);
  const text = 'Nhờ Asinu nhắc uống Hapacol 650 hằng ngày, vào 7 giờ sáng';
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', actions: [{ ...action(), evidence: text }] }) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  const preview = await assistant.plan({ text, current: { language: 'vi', fontSize: 'normal' } }, 'vi', { pool: {}, userId: 7 });
  expect(preview.status).toBe('ready'); expect(preview.actions[0].changes[0].purpose.tags).toHaveLength(2);
  expect(callTextAi).toHaveBeenCalledTimes(2); expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup.mock.invocationCallOrder[0]).toBeGreaterThan(callTextAi.mock.invocationCallOrder[1]);
  expect(JSON.stringify(callTextAi.mock.calls)).not.toContain(source.url);
});
