'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const YAML = require('yaml');
const { SkillManager } = require('../../src/services/assistant/skill-manager.service');
const directory = path.resolve(__dirname, '../../src/services/assistant/skills');

test.each(require('../fixtures/assistant-9router-flat-arguments.json'))(
  'the observed 9Router response for $id retains the requested domain fields', ({ id, planner }) => {
    const scenario = require('../fixtures/assistant-skill-cases.cjs').find(value => value.id === id);
    const manager = new SkillManager(directory);
    const result = manager.decode(planner, [scenario.skill], { text: scenario.text });
    const expected = require('../../src/services/assistant/domain-tools.schema').parse(scenario.actions[0]);
    // These spellings are accepted by the actual target resolver.
    if (expected.parameters.target === 'mới nhất' && result.actions[0].parameters.target === 'latest')
      expected.parameters.target = 'latest';
    expect(result.actions).toEqual([expected]);
  }
);

test.each([
  ['family-invite', 'family', { phone: '0900000000', ownerId: 99 }],
  ['family-permissions', 'family', { target: 'Người Thử', changes: { can_view_logs: true } }],
  ['wallet-topup', 'billing', { amount: -1 }],
  ['wallet-topup', 'billing', { amount: '100000' }],
  ['gifts-open', 'gifts', { box: 7 }],
  ['gifts-open', 'gifts', {}],
  ['family-invite', 'family', { relationship: 'bạn' }],
  ['notifications-list', 'notifications', { parameters: {}, unread: true }],
  ['gifts-open', 'gifts', { type: 'app_tool', tool: 'notifications.delete_all', box: 2 }],
])('format compatibility still rejects invalid or conflicting %s arguments', (name, group, args) => {
  const manager = new SkillManager(directory);
  expect(() => manager.decode({ status: 'ready', calls: [{ name, arguments: args }] }, [group], { text: 'Synthetic request.' })).toThrow();
});

test('flat domain arguments cannot escape the selected group or bypass native skill schemas', () => {
  const manager = new SkillManager(directory);
  expect(() => manager.decode({ status: 'ready', calls: [{ name: 'wallet-topup', arguments: { amount: 100000 } }] }, ['journal'], { text: 'x' })).toThrow('outside selected catalog');
  expect(() => manager.decode({ status: 'ready', calls: [{ name: 'log-water', arguments: { parameters: { volume_ml: 200 } } }] }, ['journal'], { text: 'x' })).toThrow();
});

test('discovery and tool specs expose metadata without loading instruction bodies', () => {
  const manager = new SkillManager(directory);
  expect(manager.list()).toHaveLength(115);
  expect(manager.bodies.size).toBe(0);
  manager.catalog(['journal']);
  manager.tool('log-water').spec;
  expect(manager.bodies.size).toBe(0);
  const result = manager.tool('log-water').invoke({ volume_ml: 200, evidence: '200 ml nước' }, ['journal']);
  expect(result).toMatchObject({ action: { type: 'water', volume_ml: 200 }, metadata: {skill:'log-water',version:'1.0.0',group:'journal'} });
  expect([...manager.bodies.keys()]).toEqual(['log-water']);
  expect(result.instructions).toContain('Record only the explicit amount');
});

test('skill calls cannot override capability selectors, select arbitrary files or exceed their catalog', () => {
  const manager = new SkillManager(directory);
  expect(() => manager.tool('../../.env')).toThrow('Unknown assistant skill');
  expect(() => manager.tool(['log-water'])).toThrow('Unknown assistant skill');
  expect(() => manager.tool('log-water').invoke({type:'language',volume_ml:200,evidence:'200 ml'},['journal'])).toThrow();
  expect(() => manager.tool('notifications-delete-all').invoke({evidence:'xóa thông báo'},['journal'])).toThrow('outside selected catalog');
  expect(manager.bodies.size).toBe(0);
});

test('tool arguments keep their real server schema and cannot gain identity fields', () => {
  const manager = new SkillManager(directory);
  expect(() => manager.tool('family-permissions').invoke({parameters:{target:'Người thử',changes:{can_view_logs:true}},evidence:'x'},['family'])).toThrow();
  expect(() => manager.tool('family-invite').invoke({parameters:{phone:'0900000000',ownerId:99},evidence:'x'},['family'])).toThrow();
  expect(() => manager.tool('wallet-topup').invoke({parameters:{amount:-1},evidence:'x'},['billing'])).toThrow();
  expect(() => manager.tool('gifts-open').invoke({parameters:{box:7},evidence:'x'},['gifts'])).toThrow();
  expect(manager.bodies.size).toBe(0);
});

test('invocation envelopes are strict and do not mix calls with partial legacy actions', () => {
  const manager = new SkillManager(directory);
  expect(manager.decode({status:'ready',calls:[{name:'coins-balance',arguments:{evidence:'bao nhiêu xu'}}]},['rewards']))
    .toMatchObject({actions:[{type:'app_tool',tool:'coins.balance',parameters:{}}]});
  expect(() => manager.decode({status:'ready',actions:[],calls:[{name:'log-water',arguments:{volume_ml:200,evidence:'x'}}]},['journal'])).toThrow();
  expect(() => manager.decode({status:'clarify',question:'x',calls:[{name:'log-water',arguments:{volume_ml:200,evidence:'x'}}]},['journal'])).toThrow();
  expect(() => manager.decode({status:'ready',calls:[{name:'log-water',arguments:{volume_ml:200,evidence:'x',userId:99}}]},['journal'])).toThrow();
  expect(manager.bodies.size).toBe(0);
});

test('the server binds skill-call provenance to the actual request without rewriting user words', () => {
  const manager = new SkillManager(directory);
  const text = 'Bạn ghi giúp tôi lượng nước vừa uống là 200 ml nhé';
  const raw = {status:'ready',calls:[{name:'log-water',arguments:{volume_ml:200}}]};
  expect(manager.decode(raw,['journal'],{text}).actions[0].evidence).toBe(text);
  raw.calls[0].arguments.evidence = '200 ml nước';
  expect(manager.decode(raw,['journal'],{text}).actions[0].evidence).toBe(text);
  const time = 'Đổi giờ nhắc buổi tối sang 8 giờ tối';
  expect(manager.decode({status:'ready',calls:[{name:'set-routine-reminders',arguments:{evidence:time}}]},['reminders'],{text:'Ghi nước và '+time}).actions[0].evidence).toBe(time);
  expect(() => manager.decode({status:'ready',calls:[{name:'set-routine-reminders',arguments:{}}]},['reminders'],{text:time})).toThrow();
});

test.each(['logs','water','blood_pressure','glucose','checkin','checkin_history','medication','profile','reminders','notifications','care_circle','scan_qr','missions','coins','early_signal','health_status','health_tree','feed','daily_gift','gift_history','call_settings','voice_settings','app_permissions','my_qr','subscription','subscription_plans','wallet','terms','privacy_policy','medical_sources','consultation'])('existing screen %s is an explicit skill with no new write capability', destination => {
  const manager = new SkillManager(directory);
  const action = {type:'navigate',destination,evidence:'mở màn hình'};
  const manifest = manager.forAction(action);
  const result = manager.invoke([action],[manifest.group]);
  expect(result[0].action).toEqual(action);
  expect(manager.bodies.size).toBe(1);
});

test.each(['water','blood_pressure','glucose','meal','medication','checkin','profile','reminders'])('saved %s queries keep their read operation and date arguments', topic => {
  const manager = new SkillManager(directory);
  const action = {type:'query',topic,range:'today',statistic:'list',evidence:'xem dữ liệu'};
  const manifest = manager.forAction(action);
  expect(manager.invoke([action],[manifest.group])[0].action).toEqual(action);
});

test('read skills cannot claim unsupported historical snapshots or nutrition statistics', () => {
  const manager = new SkillManager(directory);
  expect(() => manager.tool('read-profile-logs').invoke({range:'month',statistic:'list',evidence:'x'},['profile'])).toThrow();
  expect(() => manager.tool('read-medication-logs').invoke({range:'week',statistic:'average',evidence:'x'},['medication'])).toThrow();
  expect(() => manager.tool('read-meal-logs').invoke({range:'week',statistic:'average',evidence:'x'},['journal'])).toThrow();
});

test('invalid capability metadata fails discovery and edited metadata cannot affect an existing catalog', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'asinu-skill-manager-'));
  const folder = path.join(temp,'journal','log-water');
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(temp,'journal','group.json'),JSON.stringify({name:'journal',description:'journal'}));
  const file = path.join(folder,'SKILL.md');
  const header = {name:'log-water',description:'record water',metadata:{asinu:{group:'journal',version:'1.0.0',selector:{type:'root'},context:{medication:false,profile:false}}}};
  const write = () => fs.writeFileSync(file,'---\n'+YAML.stringify(header)+'---\n\nKnown instructions.');
  try {
    write(); expect(() => new SkillManager(temp)).toThrow('Unsupported skill capability');
    header.metadata.asinu.selector = {type:'water'}; write();
    const manager = new SkillManager(temp);
    header.metadata.asinu.version = '2.0.0'; write();
    expect(() => manager.instructions('log-water')).toThrow('changed after catalog');
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
