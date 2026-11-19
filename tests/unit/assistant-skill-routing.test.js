jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const service = require('../../src/services/assistant/app-assistant.service');
const router = require('../../src/services/assistant/skill-router.service');
const medication = require('../../src/services/assistant/medication-assistant.service');
const tools = require('../../src/services/assistant/app-tools.service');
const request = text => ({ text, current: { language: 'vi', fontSize: 'normal' } });
const ready = action => ({ content: JSON.stringify({ status: 'ready', actions: Array.isArray(action) ? action : [action] }) });
let medContext, profileContext, secret;
beforeEach(() => {
  callTextAi.mockReset();
  secret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'skill-routing-synthetic-test-secret';
  medContext = jest.spyOn(medication, 'contextForPlan').mockResolvedValue({ available: true, items: [], schedules: [], doses: [] });
  jest.spyOn(require('../../src/services/v21/medication-purpose.service'), 'lookup').mockResolvedValue({ status: 'not_found', tags: [] });
  profileContext = jest.spyOn(tools, 'profileContext').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
});

test.each([
  ['Tôi vừa uống 200 ml nước', { type: 'water', volume_ml: 200 }],
  ['Ghi 200 ml nước', { type: 'water', volume_ml: 200 }],
  ['Ghi nước uống 0,5 lít', { type: 'water', volume_ml: 500 }],
  ['Ghi huyết áp 120/80 mmHg, nhịp tim 70', { type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 70 }],
  ['Ghi đường huyết 120 mg/dL lúc đói', { type: 'glucose', value: 120, unit: 'mg/dL', context: 'fasting' }],
  ['Đường huyết tôi vừa đo là 120 mg/dL', { type: 'glucose', value: 120, unit: 'mg/dL' }],
])('explicit current journal command needs zero Dr7 calls or unrelated profile reads: %s', async (text, expected) => {
  const db = { query: jest.fn(() => { throw Error('A preview must not write'); }) };
  const result = await service.plan(request(text), 'vi', { pool: db, userId: 7 });
  expect(result).toMatchObject({ status: 'ready', actions: [expected] });
  expect(callTextAi).not.toHaveBeenCalled();
  expect(medContext).not.toHaveBeenCalled(); expect(profileContext).not.toHaveBeenCalled();
  expect(db.query).not.toHaveBeenCalled();
});

test('a complete daily reminder has zero model calls but retains owner-bound signed confirmation', async () => {
  const text = 'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ sáng và 7 giờ tối';
  const result = await service.plan(request(text), 'vi', { pool: {}, userId: 7 });
  expect(result).toMatchObject({ status: 'ready', actions: [{ type: 'medication', changes: [{ operation: 'create', name: 'Hapacol', times: ['07:00', '19:00'] }] }] });
  const claims = require('jsonwebtoken').verify(result.actions[0].planToken, process.env.JWT_SECRET, { subject: '7', audience: 'asinu:assistant-medication' });
  expect(claims.operations).toMatchObject([{ kind: 'create', name: 'Hapacol', times: ['07:00', '19:00'] }]);
  expect(callTextAi).not.toHaveBeenCalled(); expect(profileContext).not.toHaveBeenCalled();
});

test('daily reminder frequency after the time also needs zero model calls', async () => {
  const text = 'Nhắc uống Hapacol lúc 7 giờ sáng mỗi ngày';
  const result = await service.plan(request(text), 'vi', { pool: {}, userId: 7 });
  expect(result).toMatchObject({ status: 'ready', actions: [{ type: 'medication', changes: [{ operation: 'create', name: 'Hapacol', times: ['07:00'] }] }] });
  expect(callTextAi).not.toHaveBeenCalled();
});

test.each([
  ['Mở ghi huyết áp', 'journal', 'blood_pressure'],
  ['Mở nhắc thuốc', 'medication', 'medication'],
])('selected skill can still open its existing screen: %s', async (text, scope, destination) => {
  expect(router.select(request(text)).sort()).toEqual((Array.isArray(scope) ? [...scope] : [scope]).sort());
  callTextAi.mockResolvedValueOnce(ready({ type: 'navigate', destination, evidence: text })).mockResolvedValueOnce({ content: '{"approved":true}' });
  expect(await service.plan(request(text))).toMatchObject({ status: 'ready', actions: [{ type: 'navigate', destination }] });
});

test.each([
  ['Ghi giúp tôi 200 ml nước lọc', 'journal'],
  ['Bật quyền thông báo nhắc thuốc', ['medication', 'settings', 'notifications']],
  ['Ghi 200 ml nước rồi mở kho lộc', ['journal', 'gifts']],
  ['Nhắc thuốc và chia sẻ kết quả cho người thân', ['medication', 'family']],
  ['Nhắc thuốc và ghi huyết áp 120/80', ['journal', 'medication']],
  ['Bật nhắc buổi sáng lúc 7 giờ', 'reminders'],
])('routing preserves mixed and system actions: %s', (text, scope) => {
  expect(router.select(request(text)).sort()).toEqual((Array.isArray(scope) ? [...scope] : [scope]).sort());
});

test.each([
  'Mẹ tôi vừa uống 200 ml nước', 'Tôi định uống 200 ml nước', 'Tôi không uống 200 ml nước',
  'Ví dụ tôi vừa uống 200 ml nước', 'Tôi vừa uống 200 ml nước có đủ không?',
  'Đừng ghi nước 200 ml', 'Ghi huyết áp 12/8', 'Ghi đường huyết 6,2 mmol/L',
  'Nhắc tôi uống Hapacol 2 viên mỗi ngày lúc 7 giờ sáng',
  'Nhắc tôi uống thuốc mỗi ngày lúc 7 giờ sáng',
  'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ',
  'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ sáng trong 3 ngày',
  'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ sáng và xóa tài khoản',
])('zero-model grammar never strips away uncertainty, another owner, doses or unsupported qualifiers: %s', text => {
  expect(router.explicitCommand(request(text))).toBeNull();
});

test('range validation still rejects an explicitly phrased invalid journal quantity before saving', async () => {
  callTextAi.mockResolvedValueOnce({ content: '{"status":"clarify","question":"Bạn kiểm tra lại lượng nước nhé.","actions":[]}' });
  const result = await service.plan(request('Ghi nước 10000 ml'));
  expect(result.status).toBe('clarify'); expect(result.actions).toEqual([]);
});

test('journal AI sees only its skill and current words, not medicine names, profile or old commands', async () => {
  const text = 'Bạn ghi giúp tôi lượng nước vừa uống là 200 ml nhé';
  callTextAi.mockResolvedValueOnce(ready({ type: 'water', volume_ml: 200, evidence: text })).mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await service.plan({ ...request(text), conversation: [{ role: 'user', text: 'UNRELATED_PRIVATE_OLD_COMMAND' }] });
  expect(result.actions[0]).toMatchObject({ type: 'water', volume_ml: 200 });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  let size = 0;
  for (const [options] of callTextAi.mock.calls) {
    size += options.system.length + options.prompt.length;
    expect(options).toMatchObject({ provider: 'medgemma', strictProvider: true, maxRetries: 0 });
    expect(options.system).not.toContain('family.invite');
    expect(options.prompt).not.toMatch(/MEDICATION_CONTEXT|PROFILE_CONTEXT|UNRELATED_PRIVATE_OLD_COMMAND/);
  }
  expect(size).toBeLessThan(6000);
  expect(medContext).not.toHaveBeenCalled(); expect(profileContext).not.toHaveBeenCalled();
});

test('a new conversational reminder checks saved schedules privately without sending other medicines to AI', async () => {
  const text = 'Nhờ Asinu nhắc uống Hapacol hằng ngày, vào 7 giờ rưỡi sáng';
  callTextAi.mockResolvedValueOnce(ready({ type: 'medication_create', name: 'Hapacol', times: ['07:30'], evidence: text })).mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await service.plan(request(text), 'vi', { pool: {}, userId: 7 });
  expect(result.actions[0]).toMatchObject({ type: 'medication', changes: [{ name: 'Hapacol', times: ['07:30'] }] });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  const calls = callTextAi.mock.calls.map(([params]) => params);
  expect(calls.reduce((n, p) => n + p.system.length + p.prompt.length, 0)).toBeLessThan(8000);
  for (const options of calls) { expect(options.prompt).not.toContain('MEDICATION_CONTEXT'); expect(options.prompt).not.toContain('PROFILE_CONTEXT'); expect(options.system).not.toContain('family.invite'); }
  expect(medContext).toHaveBeenCalledTimes(1);
  expect(profileContext).not.toHaveBeenCalled();
});

test('one scoped skill cannot emit a valid-shaped action from another capability', async () => {
  const text = 'Ghi giúp tôi 200 ml nước';
  callTextAi.mockResolvedValueOnce(ready({ type: 'app_tool', tool: 'notifications.delete_all', parameters: {}, evidence: text }));
  const result = await service.plan(request(text));
  expect(result.actions).toEqual([]); expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('inferred quantities and a failed semantic review cannot become a journal preview', async () => {
  const text = 'Ghi giúp tôi 200 ml nước';
  callTextAi.mockResolvedValueOnce(ready({ type: 'water', volume_ml: 250, evidence: text }));
  expect((await service.plan(request(text))).actions).toEqual([]);
  callTextAi.mockReset();
  callTextAi.mockResolvedValueOnce(ready({ type: 'water', volume_ml: 200, evidence: text })).mockResolvedValueOnce({ content: '{"approved":false}' });
  expect((await service.plan(request(text))).actions).toEqual([]);
});

test('a mixed request loads only its two skills instead of dropping the second requested action', async () => {
  const text = 'Tôi vừa uống 200 ml nước và đổi ngôn ngữ sang tiếng Anh';
  expect(router.select(request(text))).toEqual(['journal', 'settings']);
  callTextAi.mockResolvedValueOnce(ready([
    { type: 'water', volume_ml: 200, evidence: 'uống 200 ml nước' },
    { type: 'language', value: 'en', evidence: 'đổi ngôn ngữ sang tiếng Anh' },
  ])).mockResolvedValueOnce({ content: '{"approved":true}' });
  expect((await service.plan(request(text))).actions.map(action => action.type)).toEqual(['water', 'language']);
});

test('skill loading uses only the fixed registry, and a clarification retains the full original request', () => {
  expect(() => router.getSkill('../../.env')).toThrow('Unknown assistant skill');
  const value = { ...request('7 giờ sáng'), clarification: { original: 'Nhắc tôi uống Hapacol mỗi ngày', question: 'Bạn muốn nhắc lúc mấy giờ?' } };
  expect(router.select(value)).toEqual(['medication']); expect(router.explicitCommand(value)).toBeNull();
  expect(router.inputForModel(value, ['medication']).clarification).toEqual(value.clarification);
});

const cases = require('../fixtures/assistant-skill-cases.cjs');
const domains = require('../../src/services/assistant/domain-tools.service');
test('every existing tool, screen and query belongs to exactly one skill', () => {
  const definitions = router.definitions;
  const fields = [
    ['tools', Object.keys(require('../../src/services/assistant/domain-tools.schema').definitions)],
    ['screens', tools.navigateSchema.shape.destination.options],
    ['queries', tools.querySchema.shape.topic.options],
  ];
  expect(Object.keys(definitions)).toHaveLength(15);
  for (const [field, supported] of fields) {
    const owned = Object.values(definitions).flatMap(row => row[field] || []);
    expect([...owned].sort()).toEqual([...supported].sort());
    expect(new Set(owned).size).toBe(owned.length);
  }
  expect(cases.filter(row => row.actions[0].type === 'app_tool').map(row => row.actions[0].tool).sort())
    .toEqual(Object.keys(require('../../src/services/assistant/domain-tools.schema').definitions).sort());
  const {manager} = require('../../src/services/assistant/skills');
  expect(manager.list()).toHaveLength(115);
  for (const item of manager.list()) {
    expect(item.description.length).toBeGreaterThan(5);
    expect(router.getSkill(item.name).spec.name).toBe(item.name);
  }

});

test.each(cases.map(value => [value.id, value]))('existing command remains in its selected skill: %s', async (_id, value) => {
  expect(router.select(request(value.text))).toContain(value.skill);
  profileContext.mockResolvedValue({ name: 'Người thử', chronicDiseases: [], version: 'synthetic:1' });
  const prepared = jest.spyOn(domains, 'prepare').mockImplementation(async (_db, _owner, raw) => ({ action: { ...raw, planToken: 'synthetic-only' } }));
  jest.spyOn(tools, 'prepareReminders').mockResolvedValue({ type: 'routine_reminders', planToken: 'synthetic-only', changes: [] });
  const {manager} = require('../../src/services/assistant/skills');
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:value.actions.map(action=>manager.callForAction(action))})}).mockResolvedValueOnce({ content: '{"approved":true}' });
  const db = { query: jest.fn(() => { throw Error('Preview must not write'); }) };
  const result = await service.plan(request(value.text), 'vi', { pool: db, userId: 7 });
  expect(result.status).toBe('ready');
  if (value.actions[0].type === 'app_tool') expect(prepared.mock.calls[0][2]).toEqual(value.actions[0]);
  expect(db.query).not.toHaveBeenCalled();
  for (const [options] of callTextAi.mock.calls) {
    expect(options.system).toMatch(/CATALOG GROUPS:/);
    if (options.system.startsWith('Independently review')) expect(options.system).toContain('INVOKED SKILL');
    expect(options.system.length + options.prompt.length).toBeLessThan(12000);
  }
});

test('a missed mixed task can load its skill once before any preparation', async () => {
  const text = 'Ghi giúp tôi 200 ml nước, rồi làm thao tác tôi nói tiếp';
  const prepare = jest.spyOn(domains, 'prepare');
  callTextAi.mockResolvedValueOnce({ content: '{"status":"route","skills":["settings"]}' })
    .mockResolvedValueOnce(ready({ type: 'water', volume_ml: 200, evidence: text }))
    .mockResolvedValueOnce({ content: '{"approved":false}' });
  expect((await service.plan(request(text))).actions).toEqual([]);
  expect(callTextAi).toHaveBeenCalledTimes(3);
  expect(callTextAi.mock.calls[1][0].system).toContain('set-font-size');
  expect(prepare).not.toHaveBeenCalled();
});

test('semantic review can detect an omitted task and require another skill before confirming', async () => {
  const text = 'Ghi giúp tôi 200 ml nước và đổi giao diện sang English';
  callTextAi.mockResolvedValueOnce(ready({ type: 'water', volume_ml: 200, evidence: '200 ml nước' }))
    .mockResolvedValueOnce({ content: '{"approved":false,"skills":["settings"]}' })
    .mockResolvedValueOnce(ready([
      { type: 'water', volume_ml: 200, evidence: '200 ml nước' },
      { type: 'language', value: 'en', evidence: 'đổi giao diện sang English' },
    ])).mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await service.plan(request(text));
  expect(result.actions.map(action => action.type)).toEqual(['water', 'language']);
  expect(callTextAi).toHaveBeenCalledTimes(4);
});

test.each(['../../.env','expert','__proto__'])('directory routing cannot load arbitrary skill %s', async id => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ skills: [id] }) });
  expect((await service.plan(request('Bạn giúp tôi việc này'))).actions).toEqual([]);
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(medContext).not.toHaveBeenCalled(); expect(profileContext).not.toHaveBeenCalled();
});

test('directory resolves an unclear feature using no private profile or medicine context', async () => {
  const text = 'Tên tôi đâu rồi?';
  callTextAi.mockResolvedValueOnce({ content: '{"skills":["profile"]}' })
    .mockResolvedValueOnce({ content: '{"status":"clarify","question":"Bạn muốn xem hay sửa tên?","actions":[]}' });
  expect((await service.plan(request(text))).status).toBe('clarify');
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(callTextAi.mock.calls[0][0].prompt).not.toMatch(/MEDICATION_CONTEXT|PROFILE_CONTEXT/);
});

test('skill expansion is bounded and cannot become a costly recursion', async () => {
  callTextAi.mockResolvedValueOnce({ content: '{"status":"route","skills":["settings"]}' })
    .mockResolvedValueOnce({ content: '{"status":"route","skills":["family"]}' });
  expect((await service.plan(request('Ghi giúp tôi 200 ml nước'))).actions).toEqual([]);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(router.expand(['journal'], ['journal'])).toBeNull();
  expect(router.validIds(['journal','medication','profile','settings','calls','app'])).toBe(false);
  expect(router.validIds([['journal']])).toBe(false);
  expect(router.validIds([null])).toBe(false);
  expect(router.validIds(['journal','journal'])).toBe(false);
});

test('directory clarification stays helpful without loading instructions or executing an action', async () => {
  const question = 'Bạn có thể đăng xuất trong phần Tài khoản nhé.';
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({skills:[],question}) });
  expect(await service.plan(request('Tôi muốn đăng xuất'))).toEqual({status:'clarify',actions:[],question});
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(medContext).not.toHaveBeenCalled(); expect(profileContext).not.toHaveBeenCalled();
});

test('invalid null model output cannot crash the app operation', async () => {
  callTextAi.mockResolvedValueOnce({content:'null'});
  expect(await service.plan(request('Ghi giúp tôi 200 ml nước'))).toMatchObject({status:'clarify',actions:[]});
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('new skill calls bind actual source text and still reject invented readings', async () => {
  const text = 'Bạn ghi giúp tôi lượng nước vừa uống là 200 ml nhé';
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:[{name:'log-water',arguments:{volume_ml:200}}]})})
    .mockResolvedValueOnce({content:'{"approved":true}'});
  expect(await service.plan(request(text))).toMatchObject({status:'ready',actions:[{type:'water',volume_ml:200,evidence:text}]});
  callTextAi.mockReset();
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:[{name:'log-water',arguments:{volume_ml:250}}]})});
  expect((await service.plan(request(text))).actions).toEqual([]);
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('large clarifications request exact excerpts without truncating original user instructions', () => {
  const input = {...request('200 ml'),clarification:{original:'Ghi nước '+'.'.repeat(3100),question:'Bao nhiêu?'}};
  expect(router.prompts(['journal'],input).system).toContain('Long clarification: supply evidence');
  expect(router.inputForModel(input,['journal']).clarification.original).toBe(input.clarification.original);
});

test('profile values needed only to sign a height preview never enter either model prompt', async () => {
  const text = 'Đổi chiều cao của tôi thành 170 cm';
  profileContext.mockResolvedValue({name:'PRIVATE_NAME',dateOfBirth:'1968-01-01',chronicDiseases:['PRIVATE_CONDITION'],version:'private-version'});
  callTextAi.mockImplementationOnce(async () => {
    expect(profileContext).not.toHaveBeenCalled();
    return {content:JSON.stringify({status:'ready',calls:[{name:'update-profile',arguments:{changes:{heightCm:170}}}]})};
  }).mockResolvedValueOnce({content:'{"approved":true}'});
  expect(await service.plan(request(text),'vi',{pool:{},userId:7})).toMatchObject({status:'ready',actions:[{type:'profile',changes:{heightCm:170},planToken:expect.any(String)}]});
  expect(profileContext).toHaveBeenCalledTimes(1);
  for (const [options] of callTextAi.mock.calls) expect(options.prompt).not.toMatch(/PROFILE_CONTEXT|PRIVATE_NAME|PRIVATE_CONDITION|1968-01-01|private-version/);
});

test('changing declared conditions shares only the necessary existing condition list with the model', async () => {
  const text = 'Xóa bệnh nền Bệnh A khỏi hồ sơ';
  profileContext.mockResolvedValue({name:'PRIVATE_NAME',dateOfBirth:'1968-01-01',chronicDiseases:['Bệnh A','Bệnh B'],version:'private-version'});
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:[{name:'update-profile',arguments:{changes:{chronicDiseases:['Bệnh B']}}}]})})
    .mockResolvedValueOnce({content:'{"approved":true}'});
  expect(await service.plan(request(text),'vi',{pool:{},userId:7})).toMatchObject({status:'ready',actions:[{type:'profile',changes:{chronicDiseases:['Bệnh B']}}]});
  for (const [options] of callTextAi.mock.calls) {
    const context=JSON.parse(options.prompt).PROFILE_CONTEXT;
    expect(context).toEqual({chronicDiseases:['Bệnh A','Bệnh B']});
    expect(options.prompt).not.toMatch(/PRIVATE_NAME|1968-01-01|private-version/);
  }
});

test.each([
  ['Đổi ảnh đại diện giúp tôi','profile-avatar',{}],
  ['Xem lịch sử uống thuốc Hapacol','medication-history',{target:'Hapacol'}],
])('native/read actions need no unrelated private model context: %s', async (text,name,parameters) => {
  jest.spyOn(domains,'prepare').mockResolvedValue({native:{type:'native',kind:'profile.avatar',parameters:{}}});
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:[{name,arguments:{parameters}}]})})
    .mockResolvedValueOnce({content:'{"approved":true}'});
  expect((await service.plan(request(text),'vi',{pool:{},userId:7})).status).toBe('ready');
  expect(profileContext).not.toHaveBeenCalled(); expect(medContext).not.toHaveBeenCalled();
  for (const [options] of callTextAi.mock.calls) expect(options.prompt).not.toMatch(/PROFILE_CONTEXT|MEDICATION_CONTEXT/);
});

test('out-of-catalog legacy model actions are rejected before reading a private profile', async () => {
  callTextAi.mockResolvedValueOnce(ready({type:'profile',changes:{heightCm:170},evidence:'200 ml nước'}));
  expect((await service.plan(request('Ghi giúp tôi 200 ml nước'))).actions).toEqual([]);
  expect(profileContext).not.toHaveBeenCalled(); expect(medContext).not.toHaveBeenCalled();
});

test('a disabled medicine feature returns its real reason instead of asking to repeat the command', async () => {
  medContext.mockResolvedValue({available:false,items:[],schedules:[],doses:[]});
  callTextAi.mockResolvedValueOnce({content:JSON.stringify({status:'ready',calls:[{name:'create-medication-reminder',arguments:{name:'Hapacol',times:['07:00']}}]})});
  expect(await service.plan(request('Nhờ Asinu nhắc uống Hapacol mỗi ngày lúc 7 giờ sáng'),'vi',{pool:{},userId:7}))
    .toMatchObject({status:'clarify',actions:[],question:expect.stringContaining('chưa được bật')});
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('existing medicine edits retain references while new reminders/read requests stay private', () => {
  expect(router.contextFor(['medication'],request('Đổi giờ uống thuốc Hapacol sang 8 giờ tối')).medication).toBe(true);
  expect(router.contextFor(['medication'],{...request('Đổi'),clarification:{original:'Nhắc uống Hapacol mỗi ngày',question:'Thêm hay đổi?'}}).medication).toBe(true);
  expect(router.contextFor(['medication'],request('Nhờ nhắc uống Hapacol mỗi ngày lúc 7 giờ sáng')).medication).toBe(false);
  expect(router.contextFor(['medication'],request('Xem lịch sử thuốc đã uống')).medication).toBe(false);
});

test('a disabled medicine feature needs no paid model call for an already explicit reminder', async () => {
  medContext.mockResolvedValue({available:false,items:[],schedules:[],doses:[]});
  expect(await service.plan(request('Nhắc uống Hapacol lúc 7 giờ sáng mỗi ngày'),'vi',{pool:{},userId:7}))
    .toMatchObject({status:'clarify',actions:[],question:expect.stringContaining('chưa được bật')});
  expect(callTextAi).not.toHaveBeenCalled();
});

test('a diastolic reading cannot be recycled as an unreported pulse', () => {
  const text = 'Ghi giúp tôi huyết áp 120/80';
  const action = {type:'blood_pressure',systolic:120,diastolic:80,pulse:80,evidence:text};
  expect(service.validatePlan({status:'ready',actions:[action]},request(text))).toBeNull();
  for (const evidence of ['Ghi huyết áp 120/80, nhịp tim 80','Ghi blood pressure 120/80 pulse 80','Ghi huyết áp 120/80/80'])
    expect(service.validatePlan({status:'ready',actions:[{...action,evidence}]},request(evidence))).not.toBeNull();
  expect(service.validatePlan({status:'ready',actions:[{...action,pulse:80,evidence:'Ghi huyết áp 120/80/70'}]},request('Ghi huyết áp 120/80/70'))).toBeNull();
});

test('cancelling after parsing prevents a second paid AI call even if the provider completes late', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  callTextAi.mockImplementationOnce(async options => {
    expect(options.signal).toBe(controller.signal);
    controller.abort(reason);
    return {content:JSON.stringify({status:'ready',calls:[{name:'log-water',arguments:{volume_ml:200}}]})};
  });
  await expect(service.plan(request('Ghi giúp tôi 200 ml nước'),'vi',{userId:7,signal:controller.signal})).rejects.toBe(reason);
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('an already cancelled explicit request does not read data or call AI', async () => {
  const controller = new AbortController();controller.abort();
  await expect(service.plan(request('Ghi 200 ml nước'),'vi',{signal:controller.signal})).rejects.toHaveProperty('name','AbortError');
  expect(callTextAi).not.toHaveBeenCalled();expect(medContext).not.toHaveBeenCalled();expect(profileContext).not.toHaveBeenCalled();
});

test('short read follow-ups retain bounded prior user requests without assistant results', async () => {
  const value = { ...request('Thế hôm qua?'), conversation: [
    { role: 'user', text: 'Xem huyết áp hôm nay' },
    { role: 'assistant', text: 'PRIVATE_SHARED_RESULT' },
  ] };
  expect(router.inputForModel(value, ['journal']).READ_CONTEXT).toEqual(['Xem huyết áp hôm nay']);
  expect(JSON.stringify(router.inputForModel(value, ['journal']))).not.toContain('PRIVATE_SHARED_RESULT');
});

test.each([0, 1, 2])('a context rejection at model stage %i retries once without changing the current read request', async (stage) => {
  const text = 'Thế hôm nay?';
  const prior = 'Xem huyết áp hôm qua ' + 'mô tả '.repeat(60);
  const value = { ...request(text), conversation: [
    { role: 'user', text: 'Yêu cầu cũ hơn' },
    { role: 'assistant', text: 'PRIVATE_SHARED_RESULT' },
    { role: 'user', text: prior },
  ] };
  const resultByStage = [{ content: '{"skills":["journal"]}' },
    ready({ type: 'query', topic: 'blood_pressure', range: 'today', evidence: text }), { content: '{"approved":true}' }];
  resultByStage.forEach((result, i) => {
    if (i === stage) callTextAi.mockRejectedValueOnce(Object.assign(new Error('maximum context length'), { code: 'AI_CONTEXT_LIMIT' }));
    callTextAi.mockResolvedValueOnce(result);
  });
  const db = { query: jest.fn() };
  const query = jest.spyOn(tools, 'query').mockResolvedValue('Huyết áp đã ghi hôm nay.');
  await expect(service.plan(value, 'vi', { pool: db, userId: 7 })).resolves.toMatchObject({
    status: 'answer', actions: [], answer: 'Huyết áp đã ghi hôm nay.',
  });
  expect(callTextAi).toHaveBeenCalledTimes(4);
  const prompts = callTextAi.mock.calls.map(([option]) => JSON.parse(option.prompt));
  expect(prompts[stage].INPUT.READ_CONTEXT).toHaveLength(2);
  for (const prompt of prompts.slice(stage + 1)) {
    expect(prompt.INPUT).toEqual({ text, READ_CONTEXT: [prior.slice(0, 120)] });
    expect(JSON.stringify(prompt)).not.toContain('PRIVATE_SHARED_RESULT');
  }
  expect(query).toHaveBeenCalledTimes(1);
  expect(db.query).not.toHaveBeenCalled();
});
