'use strict';
const c = require('../../src/services/v21/common');
const med = require('../../src/services/v21/medication.service');
const drafts = require('../../src/services/v21/medication-drafts.service');
const purposes = require('../../src/services/v21/medication-purpose.service');
const tools = require('../../src/services/assistant/domain-tools.service');
const manager = require('../../src/services/assistant/skills').manager;
const medication = require('../../src/services/assistant/medication-assistant.service');
const raw = (tool, parameters = {}) => ({ type: 'app_tool', tool, parameters, evidence: 'explicit fixture request' });
let originalSecret;
beforeEach(() => { originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'assistant-management-fixture'; });
afterEach(() => { jest.restoreAllMocks(); if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret; });

test('all new operation skills reject identity injection and remain in their selected catalog', () => {
  for (const name of ['medication-drafts', 'resume-medication-draft', 'delete-medication-draft', 'read-medication-purposes', 'set-medication-purpose', 'subscription-members', 'add-subscription-member', 'remove-subscription-member']) {
    expect(manager.tool(name).manifest.context).toEqual({ medication: false, profile: false });
    expect(() => manager.tool(name).invoke({ parameters: { ownerId: 99 }, evidence: 'request' }, ['medication', 'billing'])).toThrow();
  }
});
test('AI cannot clear all purpose tags when the user named one, or add a tag absent from the request', () => {
  const { validatePlan } = require('../../src/services/assistant/app-assistant.service');
  const input = text => ({ text, current: { language: 'vi', fontSize: 'normal' } });
  const preview = (mode, tags, evidence) => ({ status: 'ready', actions: [{ type: 'app_tool', tool: 'medication.purpose', parameters: { target: 'Hapacol', mode, tags }, evidence }] });
  const text = 'Bỏ tag hạ sốt của thuốc Hapacol';
  expect(validatePlan(preview('remove', ['fever_reduction'], text), input(text))).not.toBeNull();
  expect(validatePlan(preview('clear', [], text), input(text))).toBeNull();
  expect(validatePlan(preview('remove', ['pain_relief'], text), input(text))).toBeNull();
  const all = 'Bỏ tất cả tag công dụng của thuốc Hapacol';
  expect(validatePlan(preview('clear', [], all), input(all))).not.toBeNull();
});
test('empty chat draft reads do not recover scans, create drafts or write anything', async () => {
  const spy = jest.spyOn(drafts, 'read').mockResolvedValue({ drafts: [] });
  const db = { query: jest.fn() };
  expect(await tools.prepare(db, 7, raw('medication.drafts'))).toEqual({ answer: 'Bạn chưa có bản nháp lịch thuốc nào.' });
  expect(spy).toHaveBeenCalledWith(db, 7, 7, { recoverLegacy: false }); expect(db.query).not.toHaveBeenCalled();
});
test('several drafts require a choice, while an explicit draft can be resumed or deleted in a signed preview', async () => {
  const rows = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 2, snapshot: { step: 2, items: [{ display_name: 'Hapacol' }] } },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 4, snapshot: { step: 3, items: [{ display_name: 'Vitamin D3' }] } }];
  jest.spyOn(drafts, 'read').mockResolvedValue({ drafts: rows });
  expect((await tools.prepare({}, 7, raw('medication.draft_delete'))).clarify).toMatch(/bản nháp nào/);
  expect(await tools.prepare({}, 7, raw('medication.draft_resume', { target: 'Vitamin D3' }))).toEqual({ screen: { screen: 'medication_draft', params: { id: rows[1].id } } });
  const preview = await tools.prepare({}, 7, raw('medication.draft_delete', { target: 'Hapacol' }));
  const claims = require('jsonwebtoken').decode(preview.action.planToken);
  expect(claims.payload).toEqual({ id: rows[0].id, revision: 2 }); expect(claims.sub).toBe('7');
});
const house = (members = [{ user_id: 7, name: 'Chủ gói', added_at: '2026-01-01' }], patch = {}) => ({ id: 20, owner_user_id: 7, plan_code: 'antam_2', status: 'active', current_period_end: new Date(Date.now() + 86400000), members, ...patch });
function householdDb(h, candidates = [{ user_id: 8, name: 'Người Thử' }]) {
  return { query: jest.fn(async sql => ({ rows: sql.includes('SELECT * FROM subscription_households') ? h ? [h] : [] : sql.includes('FROM subscription_household_members') ? h.members : candidates })) };
}
test.each([null, house([], { owner_user_id: 7, plan_code: 'free' }), house([], { current_period_end: new Date(Date.now() - 1000) })])('missing, free or expired own plans never gain a member', async h => {
  const db = householdDb(h);
  const result = await tools.prepare(db, 7, raw('subscription.member_add', { target: 'Người Thử' }));
  expect(result.clarify).toMatch(/chủ gói/);
  expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});
test('a full plan never silently replaces the owner, and same-name relatives never match by list order', async () => {
  const full = householdDb(house([{ user_id: 7, name: 'Chủ gói' }, { user_id: 9, name: 'Người Cũ' }]));
  expect((await tools.prepare(full, 7, raw('subscription.member_add', { target: 'Người Thử' }))).clarify).toMatch(/không tự thay suất/);
  const ambiguous = householdDb(house(), [{ user_id: 8, name: 'Trần An' }, { user_id: 9, name: 'Nguyễn An' }]);
  expect((await tools.prepare(ambiguous, 7, raw('subscription.member_add', { target: 'An' }))).clarify).toMatch(/tên đầy đủ/);
});
test('a member change is only an owner-bound confirmation preview and does not purchase or share data', async () => {
  const db = householdDb(house());
  const result = await tools.prepare(db, 7, raw('subscription.member_add', { target: 'Người Thử' }));
  expect(result.action.label).toContain('Người Thử');
  const claims = require('jsonwebtoken').decode(result.action.planToken);
  expect(claims.payload).toMatchObject({ householdId: 20, memberId: 8 });
  expect(claims.payload).not.toHaveProperty('permissions');
  await expect(tools.execute(db, 8, result.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
  expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});
test('vitamin/supplement creation retains its type and bypasses medicine-purpose lookup', async () => {
  const lookup = jest.spyOn(purposes, 'lookup');
  const action = { type: 'medication_create', kind: 'SUPPLEMENT', name: 'Vitamin D3', times: ['07:00'], evidence: 'Nhắc dùng Vitamin D3 mỗi ngày lúc 7 giờ sáng' };
  const preview = await medication.prepareWithPurpose({}, [action], { available: true, items: [], schedules: [] }, 7, action.evidence);
  expect(preview.changes[0]).toMatchObject({ itemKind: 'SUPPLEMENT', name: 'Vitamin D3' });
  expect(preview.changes[0]).not.toHaveProperty('purpose'); expect(lookup).not.toHaveBeenCalled();
  expect(medication.validateAction({ ...action, name: 'Hapacol' }, { available: true, items: [] }, 'Nhắc uống Hapacol')).toBe(false);
  expect(medication.validateAction({ ...action, kind: 'MEDICINE' }, { available: true, items: [] }, action.evidence)).toBe(false);
});
test('purpose clear and remove never invent manufacturer indications or new tag values', async () => {
  jest.spyOn(c, 'patientAccess').mockResolvedValue(7); jest.spyOn(c, 'assertFeature').mockResolvedValue(); jest.spyOn(med, 'requireEncryption').mockImplementation(() => {});
  jest.spyOn(med, 'reveal').mockImplementation((_owner, _field, value) => value);
  const row = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', patient_user_id: 7, display_name: 'Hapacol 650', kind: 'MEDICINE', tags_json: JSON.stringify({ codes: ['pain_relief', 'fever_reduction'], productName: 'Hapacol 650' }) };
  const db = { query: jest.fn(async () => ({ rows: [row] })) };
  const lookup = jest.spyOn(purposes, 'lookup').mockResolvedValue({ status: 'unavailable', tags: [] });
  const remove = await tools.prepare(db, 7, raw('medication.purpose', { target: 'Hapacol 650', mode: 'remove', tags: ['fever_reduction'] }));
  expect(require('jsonwebtoken').decode(remove.action.planToken).payload.codes).toEqual(['pain_relief']); expect(lookup).not.toHaveBeenCalled();
  expect((await tools.prepare(db, 7, raw('medication.purpose', { target: 'Hapacol 650', mode: 'add', tags: ['diabetes'] }))).clarify).toMatch(/chưa xác nhận/);
  expect(() => tools.parse(raw('medication.purpose', { target: 'Hapacol', mode: 'add', tags: ['invented'] }))).toThrow();
});
