'use strict';
// Fixed synthetic utterances only. No patient records or writes are involved.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const medication = require('../src/services/assistant/medication-assistant.service');
const schedule = require('../src/services/notification/smart.schedule.service');
const getPreferences = schedule.getPreferences;
schedule.getPreferences = async () => ({ reminders_enabled: true, morning_time: '07:00', afternoon_time: '13:00', evening_time: '19:00',
  effective_morning_time: '07:00', effective_afternoon_time: '13:00', effective_evening_time: '19:00' });
if (process.env.ASSISTANT_EVAL_DEBUG === 'true') {
  const ai = require('../src/services/ai/ai.service'), call = ai.callTextAi;
  ai.callTextAi = async options => {
    const result = await call(options);
    console.log(JSON.stringify({ stage: 'synthetic-model-output', content: result.content }));
    return result;
  };
}
const assistant = require('../src/services/assistant/app-assistant.service');
const tools = require('../src/services/assistant/app-tools.service');
tools.profileContext = async () => ({ name: 'Người dùng thử', dateOfBirth: '1970-01-01', gender: 'Nam', chronicDiseases: ['Tiểu đường'], version: 'synthetic:1' });
tools.query = async (_db, userId, action) => {
  assert.equal(userId, 1);
  return `${action.topic}:${action.range}:${action.statistic}`;
};
const { withPublicAiTemplate } = require('../src/services/ai/ai-consent.service');
const context = { available: true, items: [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Metformin', kind: 'MEDICINE' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Vitamin D3', kind: 'SUPPLEMENT' },
], schedules: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', time: '07:00', revision: 1,
  item_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], consent: 'ACTIVE', anchor: null, note: '' }],
  doses: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', time: '07:00', state: 'SCHEDULED', scheduled_at: new Date(Date.now() - 15 * 60000),
    item_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }] };
const cases = [
  { text: 'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ sáng', times: ['07:00'] },
  { text: 'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ', noActions: true, question: /sáng|tối/ },
  { text: 'Nhắc tôi uống thuốc mỗi ngày lúc 7 giờ sáng', noActions: true, question: /tên|thuốc (nào|gì)/ },
  { text: 'Nhắc tôi uống Hapacol lúc 7 giờ sáng', noActions: true, question: /hằng|hàng|mỗi ngày/ },
  { text: 'Nhắc tôi uống Hapacol vào thứ hai và thứ sáu lúc 7 giờ sáng', noActions: true },
  { text: 'Đổi giờ uống Metformin từ 7 giờ sáng sang 8 giờ sáng', times: ['08:00'], operation: 'move', name: 'Metformin' },
  { text: 'Đổi giờ uống thuốc huyết áp sang 8 giờ sáng', noActions: true },
  { text: '7 giờ rưỡi sáng', clarification: { original: 'Nhắc tôi uống Hapacol mỗi ngày', question: 'Bạn muốn được nhắc vào mấy giờ?' }, times: ['07:30'] },
  { text: 'Tôi nên uống Hapacol lúc 7 giờ sáng không?', noActions: true },
  { text: 'Nhắc tôi uống Hapacol mỗi ngày lúc 7 giờ sáng và 7 giờ tối', times: ['07:00', '19:00'] },
  { text: 'Hôm nay tôi uống bao nhiêu nước?', answer: 'water:today:list' },
  { text: 'Cho xem huyết áp 7 ngày gần đây', answer: 'blood_pressure:week:list' },
  { text: 'Đường huyết trung bình tháng này của tôi là bao nhiêu?', answer: 'glucose:this_month:average' },
  { text: 'Mở tư vấn chuyên gia', type: 'navigate', destination: 'consultation' },
  { text: 'Tiếp tục lần check-in đang dở', type: 'navigate', destination: 'checkin' },
  { text: 'Đổi tên tôi thành Trần An', type: 'profile', changes: { name: 'Trần An' } },
  { text: 'Thêm bệnh nền Gút vào hồ sơ', type: 'profile', conditions: ['Tiểu đường', 'Gút'] },
  { text: 'Đổi giờ nhắc buổi tối sang 8 giờ 30 tối', type: 'routine_reminders', reminderTime: '20:30' },
  { text: 'Tạm dừng lịch nhắc 7 giờ sáng cho tất cả thuốc trong khung đó', times: ['07:00'], operation: 'pause', name: 'Metformin, Vitamin D3' },
  { text: 'Tôi đã uống đủ tất cả các thuốc trong lần nhắc vừa rồi', times: ['07:00'], operation: 'taken', name: 'Metformin, Vitamin D3' },
];
const readContext = medication.contextForPlan;
medication.contextForPlan = async () => context;
(async () => {
  let failures = 0;
  const offset = Number(process.env.ASSISTANT_EVAL_OFFSET || 0);
  for (const scenario of cases.slice(offset, offset + Number(process.env.ASSISTANT_EVAL_LIMIT || cases.length))) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.ASSISTANT_EVAL_PAUSE_MS || 3000)));
    const start = Date.now();
    try {
      const result = await withPublicAiTemplate(() => assistant.plan({ text: scenario.text,
        current: { language: 'vi', fontSize: 'normal' }, ...(scenario.clarification ? { clarification: scenario.clarification } : {}) }, 'vi', { userId: 1 }));
      if (scenario.answer) {
        assert.equal(result.status, 'answer'); assert.equal(result.answer, scenario.answer); assert.deepEqual(result.actions, []);
      } else if (scenario.type) {
        assert.equal(result.status, 'ready'); assert.equal(result.actions[0].type, scenario.type);
        if (scenario.destination) assert.equal(result.actions[0].destination, scenario.destination);
        if (scenario.changes) assert.deepEqual(result.actions[0].changes, scenario.changes);
        if (scenario.conditions) assert.deepEqual(result.actions[0].changes.chronicDiseases.sort(), scenario.conditions.sort());
        if (scenario.reminderTime) assert.equal(result.actions[0].changes[0].time, scenario.reminderTime);
      } else if (scenario.noActions) {
        assert.notEqual(result.status, 'ready'); assert.deepEqual(result.actions, []);
        if (scenario.question) assert.match(result.question, scenario.question);
      }
      else {
        assert.equal(result.status, 'ready');
        assert.equal(result.actions[0].type, 'medication');
        assert.equal(result.actions[0].changes[0].name, scenario.name || 'Hapacol');
        assert.deepEqual(result.actions[0].changes[0].times, scenario.times);
        assert.equal(result.actions[0].changes[0].operation, scenario.operation || 'create');
      }
      console.log(JSON.stringify({ pass: true, text: scenario.text, ms: Date.now() - start, status: result.status,
        question: result.question, answer: result.answer, changes: result.actions.flatMap(action => action.changes || []) }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ pass: false, text: scenario.text, ms: Date.now() - start, error: error.code || error.message }));
    }
  }
  process.exitCode = failures ? 1 : 0;
})().finally(() => { medication.contextForPlan = readContext; schedule.getPreferences = getPreferences; });
