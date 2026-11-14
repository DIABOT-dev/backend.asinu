'use strict';
// Synthetic commands and contexts only. No patient DB access or real changes.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
if (process.env.ASSISTANT_EVAL_DEBUG === 'true') {
  const ai = require('../src/services/ai/ai.service'), original = ai.callTextAi;
  ai.callTextAi = async options => { const result = await original(options); console.log(JSON.stringify({ stage: 'synthetic', result: result.content })); return result; };
}
const medication = require('../src/services/assistant/medication-assistant.service');
const tools = require('../src/services/assistant/app-tools.service');
const domains = require('../src/services/assistant/domain-tools.service');
const schema = require('../src/services/assistant/domain-tools.schema');
medication.contextForPlan = async () => ({ available: true, items: [{ id: 'synthetic-only', name: 'Metformin' }], schedules: [{ id: 'synthetic-schedule', time: '07:00', item_ids: ['synthetic-only'], active: true, consent: 'ACTIVE' }], doses: [] });
tools.profileContext = async () => ({ name: 'Người dùng thử', dateOfBirth: '1970-01-01', gender: 'Nam', chronicDiseases: [], version: 'synthetic:1' });
let prepared;
domains.prepare = async (_pool, _owner, raw) => {
  prepared = schema.parse(raw);
  return { action: { type: 'app_tool', tool: raw.tool, label: 'synthetic preview', planToken: 'synthetic only' } };
};
const assistant = require('../src/services/assistant/app-assistant.service');
const { withPublicAiTemplate } = require('../src/services/ai/ai-consent.service');
const cases = [
  ['Tôi còn thông báo nào chưa đọc?', 'notifications.list', { unread: true }],
  ['Đánh dấu tất cả thông báo đã đọc', 'notifications.read_all', {}],
  ['Xoá tất cả thông báo', 'notifications.delete_all', {}],
  ['Xoá thông báo mới nhất', 'notifications.delete', { target: 'mới nhất' }],
  ['Hôm nay tôi còn nhiệm vụ nào chưa làm?', 'missions.status', {}],
  ['Tôi có bao nhiêu xu sức khỏe?', 'coins.balance', {}],
  ['Cho xem lịch sử nhận và dùng xu', 'coins.history', {}],
  ['Cách nhận xu và dùng xu thế nào?', 'coins.rules', {}],
  ['Hôm nay có lộc chưa?', 'gifts.today', {}],
  ['Mở hộp lộc số 2 hôm nay', 'gifts.open', { box: 2 }],
  ['Ai đang kết nối với tôi?', 'family.list', {}],
  ['Có ai gửi lời mời kết nối cho tôi không?', 'family.invitations', {}],
  ['Chấp nhận lời mời kết nối của Trần An', 'family.accept', { target: 'Trần An' }],
  ['Tắt chia sẻ sức khỏe của tôi với Trần An', 'family.share', { target: 'Trần An', enabled: false }],
  ['Cho tôi xem lại kết luận check-in gần nhất', 'checkin.conclusion', {}],
  ['Huỷ lượt check-in đang dở', 'checkin.cancel', {}],
  ['Đổi giờ cuộc gọi hỏi thăm sang 9 giờ sáng', 'calls.configure', { checkin_time: '09:00' }],
  ['Từ giờ xưng hô với tôi là chú', 'calls.personalize', { address: 'chu' }],
  ['Bật nhắc nhiệm vụ', 'settings.configure', { reminders_enabled: true }],
  ['Tắt bản tin sức khỏe', 'settings.configure', { health_feed_enabled: false }],
  ['Tôi có tín hiệu sớm gì cần chú ý?', 'early_signal.latest', {}],
  ['Cây sức khỏe hiện giờ thế nào?', 'tree.status', {}],
  ['Ví của tôi còn bao nhiêu tiền?', 'wallet.status', {}],
  ['Tôi đang dùng gói chăm sóc gì?', 'subscription.status', {}],
  ['So sánh quyền lợi các gói chăm sóc', 'subscription.compare', {}],
  ['Mở cấp quyền camera cho tôi', 'device.permission', { kind: 'camera', enabled: true }],
  ['Đổi ảnh đại diện giúp tôi', 'profile.avatar', {}],
  ['Kiểm tra cập nhật ứng dụng', 'app.update', {}],
  ['Tôi muốn nạp 100000 đồng vào ví', 'wallet.topup', { amount: 100000 }],
  ['Tôi muốn mua gói An Tâm 4 theo năm', 'subscription.upgrade', { plan: 'antam_4', billing: 'yearly' }],
  ['Nghe lại kết luận check-in gần nhất', 'checkin.conclusion', { speak: true }],
  ['Bật thông tin thời tiết ở Hà Nội', 'calls.personalize', { weather_enabled: true, region: 'hanoi' }],
  ['Đổi tên Metformin thành Metformin mới', 'medication.rename', { target: 'Metformin', name: 'Metformin mới' }],
  ['Xem lịch sử uống Metformin', 'medication.history', { target: 'Metformin' }],
  ['Cho tôi xem các bài viết về giấc ngủ', 'feed.search', { query: 'giấc ngủ' }],
  ['Chia sẻ ứng dụng Asinu', 'app.share', {}],
  ['Mở hỗ trợ qua Zalo', 'app.support', {}],
  ['Cho tôi xem lại hướng dẫn sử dụng app', 'app.guide', {}],
  ['Xem sức khỏe của Trần An', 'family.health', { target: 'Trần An' }],
  ['Đổi chiều cao của tôi thành 170 cm', 'profile', { heightCm: 170 }],
  ['Cập nhật nhóm máu của tôi thành A+', 'profile', { bloodType: 'A+' }],
  ['Tôi vừa ăn cơm và cá', 'meal', { meal_text: 'cơm và cá' }],
  ['Tôi muốn nạp 100 nghìn đồng vào ví', 'wallet.topup', { amount: 100000 }],
  ['Cho tôi báo cáo uống thuốc tuần này', 'medication.weekly', {}],
  ['Bật thời tiết theo vị trí hiện tại', 'calls.weather_device', {}],

];
(async () => {
  let failed = 0;
  const offset = Number(process.env.ASSISTANT_EVAL_OFFSET || 0), limit = Number(process.env.ASSISTANT_EVAL_LIMIT || cases.length);
  const selected = process.env.ASSISTANT_EVAL_INDICES ? process.env.ASSISTANT_EVAL_INDICES.split(',').map(index => cases[Number(index)]) : cases.slice(offset, offset + limit);
  for (const [text, tool, parameters] of selected) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.ASSISTANT_EVAL_PAUSE_MS || 3000)));
    const start = Date.now(); prepared = null;
    try {
      const result = await withPublicAiTemplate(() => assistant.plan({ text, current: { language: 'vi', fontSize: 'normal' } }, 'vi', { userId: 1 }));
      assert.equal(result.status, 'ready', result.question);
      if (tool === 'profile') { assert.equal(result.actions[0].type, 'profile'); assert.deepEqual(result.actions[0].changes, parameters); }
      else if (tool === 'meal') { assert.equal(result.actions[0].type, 'meal'); for (const [key, value] of Object.entries(parameters)) assert.equal(result.actions[0][key], value); }
      else { assert.equal(prepared?.tool, tool); const actual = { ...prepared.parameters };
        if (tool === 'checkin.conclusion' && parameters.speak === undefined && actual.speak === false) delete actual.speak;
        if (parameters.target === 'mới nhất' && ['latest', 'newest', 'mới nhất', 'moi nhat'].includes(actual.target)) actual.target = 'mới nhất';
        assert.deepEqual(actual, parameters); }
      console.log(JSON.stringify({ pass: true, text, tool, ms: Date.now() - start }));
    } catch (error) { failed++; console.log(JSON.stringify({ pass: false, text, tool, prepared, error: error.message, ms: Date.now() - start })); }
  }
  process.exitCode = failed ? 1 : 0;
})();
