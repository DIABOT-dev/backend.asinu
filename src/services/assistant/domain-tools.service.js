'use strict';
const jwt = require('jsonwebtoken');
const { randomUUID, createHash } = require('node:crypto');
const c = require('../v21/common');
const schema = require('./domain-tools.schema');
const data = require('./domain-tools.read');
const audience = 'asinu:app-operation';
const conflict = () => c.error('APP_ASSISTANT_TOOL_CONFLICT', 409);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (value, patch) => Object.fromEntries(Object.keys(patch).map(key => [key, typeof value[key] === 'string' && key.endsWith('_time') ? value[key].slice(0, 5) : value[key] ?? null]));
const equal = (left, right) => require('node:util').isDeepStrictEqual(left, right);
const labelFor = (tool, en) => ({
  'notifications.read': en ? 'Mark notification read' : 'Đánh dấu đã đọc',
  'notifications.delete': en ? 'Delete notification' : 'Xoá thông báo',
  'notifications.read_all': en ? 'Mark current notifications read' : 'Đánh dấu đã đọc các thông báo hiện có',
  'notifications.delete_all': en ? 'Delete current notifications' : 'Xoá các thông báo hiện có',
  'checkin.cancel': en ? 'Cancel unfinished check-in' : 'Huỷ lần check-in đang dở',
  'calls.configure': en ? 'Change check-in call settings' : 'Đổi cài đặt cuộc gọi hỏi thăm',
  'calls.personalize': en ? 'Change call personalization' : 'Đổi cách Asinu hỏi thăm',
  'settings.configure': en ? 'Change app reminders and feed settings' : 'Đổi nhắc nhiệm vụ và bản tin',
  'family.invite': en ? 'Send family invitation, without health sharing' : 'Gửi lời mời kết nối, chưa chia sẻ sức khỏe',
  'family.accept': en ? 'Accept family invitation' : 'Chấp nhận lời mời kết nối',
  'family.reject': en ? 'Reject family invitation' : 'Từ chối lời mời kết nối',
  'family.cancel': en ? 'Cancel sent invitation' : 'Huỷ lời mời đã gửi',
  'family.remove': en ? 'Disconnect relative' : 'Ngắt kết nối người thân',
  'family.edit': en ? 'Change family relationship' : 'Đổi quan hệ người thân',
  'family.share': en ? 'Change sharing of MY health' : 'Đổi chia sẻ sức khỏe của mình',
  'family.permissions': en ? 'Change outgoing family alerts' : 'Đổi quyền nhận cảnh báo của người thân',
  'gifts.open': en ? 'Open today fortune box' : 'Mở hộp lộc hôm nay',
  'coins.redeem': en ? 'Redeem health coins' : 'Dùng xu sức khỏe đổi quà',
  'medication.rename': en ? 'Rename medicine' : 'Đổi tên thuốc',
  'medication.configure': en ? 'Change medication note or meal association' : 'Đổi ghi chú hoặc bữa ăn của lịch thuốc',
  'feed.save': en ? 'Save article' : 'Lưu bài viết',
  'feed.unsave': en ? 'Unsave article' : 'Bỏ lưu bài viết',
  'feed.hide': en ? 'Hide article' : 'Ẩn bài viết',
}[tool] || tool);
const humanFields = {
  enabled: ['Cuộc gọi hỏi thăm', 'Check-in calls'], checkin_time: ['Giờ gọi', 'Call time'], grace_hours: ['Thời gian chờ (giờ)', 'Grace period (hours)'],
  user_timeout_seconds: ['Chuông của mình (giây)', 'User ring (seconds)'], family_ring_seconds: ['Chuông người thân (giây)', 'Family ring (seconds)'],
  family_confirm_minutes: ['Chờ xác nhận (phút)', 'Confirmation wait (minutes)'], max_rounds: ['Số vòng', 'Rounds'],
  use_name: ['Gọi tên', 'Use name'], use_health: ['Dùng thông tin sức khỏe', 'Use health context'], address: ['Xưng hô', 'Address'],
  weather_enabled: ['Thời tiết', 'Weather'], region: ['Khu vực', 'Region'], reminders_enabled: ['Nhắc nhiệm vụ', 'Task reminders'], health_feed_enabled: ['Bản tin sức khỏe', 'Health feed'],
  can_receive_alerts: ['Nhận cảnh báo', 'Receive alerts'], can_ack_escalation: ['Xác nhận cảnh báo', 'Acknowledge alerts'],
  note: ['Ghi chú', 'Note'], meal_anchor: ['Bữa ăn', 'Meal association'],
};
const humanValues = { device: ['Vị trí hiện tại', 'Current area'], auto: ['Tự động', 'Automatic'], bac: ['Bác', 'Bác'], co: ['Cô', 'Cô'], chu: ['Chú', 'Chú'], anh: ['Anh', 'Anh'], chi: ['Chị', 'Chị'], ban: ['Bạn', 'Bạn'],
  before_breakfast: ['Trước bữa sáng', 'Before breakfast'], after_breakfast: ['Sau bữa sáng', 'After breakfast'], after_lunch: ['Sau bữa trưa', 'After lunch'], after_dinner: ['Sau bữa tối', 'After dinner'], bedtime: ['Trước khi ngủ', 'Bedtime'], hanoi: ['Hà Nội', 'Hanoi'], hcm: ['TP. Hồ Chí Minh', 'Ho Chi Minh City'], danang: ['Đà Nẵng', 'Da Nang'], haiphong: ['Hải Phòng', 'Hai Phong'], cantho: ['Cần Thơ', 'Can Tho'], hue: ['Huế', 'Hue'] };
function changesLabel(patch, en) {
  return Object.entries(patch).map(([key, value]) => `${humanFields[key]?.[Number(en)] || key}: ${typeof value === 'boolean'
    ? value ? en ? 'on' : 'bật' : en ? 'off' : 'tắt' : humanValues[value]?.[Number(en)] || value || (en ? 'none' : 'không')}`).join('\n');
}
function sign(owner, tool, payload, label) {
  if (!process.env.JWT_SECRET) throw c.error('APP_ASSISTANT_UNAVAILABLE', 503);
  return { type: 'app_tool', tool, label, planToken: jwt.sign({ kind: 'app_tool', tool, payload, label }, process.env.JWT_SECRET,
    { algorithm: 'HS256', subject: String(owner), audience, jwtid: randomUUID(), expiresIn: '10m' }) };
}
const question = (vi, en, lang) => ({ clarify: lang === 'en' ? en : vi });
function assertAvailable(tool) {
  const { envBool } = require('../../middleware/care-circle.gate.middleware');
  if (tool.startsWith('family.') && !envBool('CARE_CIRCLE_ENABLED')) throw c.error('CARE_CIRCLE_DISABLED', 403);
  if (tool === 'family.health' && !envBool('CAREGIVER_VIEW_LOGS_ENABLED')) throw c.error('CAREGIVER_VIEW_DISABLED', 403);
}
async function prepare(db, owner, raw, lang = 'vi', context = {}) {
  const { tool, parameters: args } = schema.parse(raw), en = lang === 'en';
  assertAvailable(tool);
  const management = require('./management-tools.service');
  if (management.handles(tool)) {
    const prepared = await management.prepare(db, owner, tool, args, lang, context);
    return prepared.payload ? { action: sign(owner, tool, prepared.payload, prepared.label) } : prepared;
  }
  if (tool === 'calls.weather_device' && !(await require('../payment/entitlement.service').getEntitlement(db, owner)).callCenterEnabled)
    return question('Thông tin thời tiết trong lời hỏi thăm cần gói An Tâm. Bạn có thể xem các gói chăm sóc nhé.', 'Weather in check-in calls requires an An Tam plan. You can view the available care plans.', lang);
  if (schema.readTools.has(tool)) return data.read(db, owner, tool, args, lang, context);
  if (tool.startsWith('device.') || ['profile.avatar', 'app.share', 'app.support', 'app.update', 'app.guide', 'calls.weather_device'].includes(tool))
    return { native: { type: 'native', kind: tool, parameters: args } };
  if (tool === 'wallet.topup') return { screen: { screen: 'wallet_topup', params: { amount: String(args.amount) } } };
  if (tool === 'subscription.upgrade') return { screen: { screen: 'upgrade', params: args } };
  let payload = { ...args }, detail = '';
  if (tool.startsWith('notifications.')) {
    if (tool.endsWith('_all')) {
      const hidden = require('../notification/health-metric-reminders.policy').getHiddenNotificationTypes();
      const row = (await db.query('SELECT max(id)::text last,count(*)::int count FROM notifications WHERE user_id=$1 AND NOT(type=ANY($2::text[]))', [owner, hidden])).rows[0];
      if (!row.last) return { answer: en ? 'There are no notifications to change.' : 'Chưa có thông báo nào để thay đổi nhé.' };
      payload = { beforeId: row.last }; detail = String(row.count);
    } else {
      const rows = await data.notifications(db, owner), row = data.choose(rows, args.target, row => row.title);
      if (!row) return question(`Bạn muốn chọn thông báo nào: ${rows.slice(0, 6).map(row => row.title).join('; ')}?`, 'Which notification title or position do you mean?', lang);
      payload = { id: row.id }; detail = `${row.title}\n${row.message}`;
    }
  } else if (tool === 'checkin.cancel') {
    const row = await data.latestCheckin(db, owner);
    const cancel = require('../checkin/checkin-cancellation.service');
    if (!row || !cancel.unfinished(row)) return { answer: en ? 'There is no unfinished check-in to cancel.' : 'Hiện không có lần check-in đang dở để huỷ nhé.' };
    payload = { id: row.id, phase: cancel.phaseIdOf(row) };
  } else if (tool === 'calls.configure' || tool === 'calls.personalize' || tool === 'settings.configure') {
    const current = tool === 'calls.configure' ? await require('../checkin-call/checkin-call.service').settings(db, owner)
      : tool === 'calls.personalize' ? (await require('../checkin-call/personalization.service').preferences(db, owner)).preferences
        : await require('../notification/smart.schedule.service').getPreferences(db, owner, { refreshInferred: false });
    if ((tool === 'calls.configure' || tool === 'calls.personalize' && ['use_name', 'use_health', 'weather_enabled'].some(key => ({ ...current, ...args })[key])) &&
        !(await require('../payment/entitlement.service').getEntitlement(db, owner)).callCenterEnabled)
      return question('Cài đặt hỏi thăm này cần gói An Tâm. Bạn có thể xem các gói chăm sóc nhé.', 'These check-in call settings require an An Tam plan. You can view the available care plans.', lang);
    if (tool === 'calls.personalize' && args.weather_enabled === true && !args.region && !current.region)
      return question('Bạn muốn nghe thời tiết ở tỉnh, thành nào nhé?', 'Which city would you like weather for?', lang);
    payload = { patch: args, before: fields(current, args) }; detail = changesLabel(args, en);
  } else if (tool.startsWith('family.')) {
    if (tool === 'family.invite') {
      const phone = args.phone.startsWith('+84') ? '0' + args.phone.slice(3) : args.phone;
      const rows = (await db.query(`SELECT id,COALESCE(full_name,display_name) name FROM users WHERE deleted_at IS NULL
        AND id<>$2 AND phone_number=ANY($1::text[])`, [[phone, '+84' + phone.slice(1)], owner])).rows;
      if (rows.length !== 1) return question('Chưa tìm thấy duy nhất một tài khoản với số này. Bạn kiểm tra lại số điện thoại nhé.', 'Could not find a unique account with this phone. Please check it.', lang);
      payload = { otherId: rows[0].id, relationship: args.relationship || null };
      detail = `${rows[0].name || ''} · ${args.phone}${args.relationship ? ` · ${args.relationship}` : ''}`;
    } else {
      const invite = ['family.accept', 'family.reject', 'family.cancel'].includes(tool);
      let rows = invite ? await data.invitations(db, owner, lang) : await data.connections(db, owner, lang);
      if (invite) rows = rows.filter(row => tool === 'family.cancel' ? !row.received : row.received);
      const row = data.choose(rows, args.target, row => row.name);
      if (!row) return question(`Bạn muốn chọn người nào: ${rows.slice(0, 8).map(row => row.name).join(', ')}?`, 'Which relative or invitation do you mean?', lang);
      payload = { id: row.id, otherId: row.otherId }; detail = row.name || (en ? 'Relative' : 'Người thân');
      if (tool === 'family.edit') { payload.relationship = args.relationship; payload.before = row.relationship_type; detail += `\n${args.relationship}`; }
      if (tool === 'family.share') { payload.enabled = args.enabled; payload.before = row.sharingMine; detail += `\n${en ? 'Share my health' : 'Chia sẻ sức khỏe của mình'}: ${args.enabled ? en ? 'on' : 'bật' : en ? 'off' : 'tắt'}`; }
      if (tool === 'family.permissions') {
        if (Number(row.requester_id) !== Number(owner)) return question('Bạn chỉ có thể đổi quyền nhận cảnh báo do mình cấp cho người thân này nhé.', 'You can only change outgoing permissions you granted to this relative.', lang);
        payload.patch = args.changes; payload.before = fields(Object.fromEntries(Object.keys(args.changes).map(key => [key, row.permissions?.[key] === true])), args.changes); detail += '\n' + changesLabel(args.changes, en);
      }
    }
  } else if (tool === 'gifts.open') {
    const today = await require('../checkin-gifts/gift.service').today(db, owner, lang);
    if (!today.enabled || !today.gift) return question('Chưa có lộc đủ điều kiện hôm nay. Bạn hoàn thành check-in trước nhé.', 'There is no eligible fortune yet. Please complete your check-in first.', lang);
    if (today.gift.openedAt) return { answer: data.describeGift(today.gift) };
    payload = { id: today.gift.id, box: args.box - 1 }; detail = `${en ? 'Box' : 'Hộp'} ${args.box}`;
  } else if (tool === 'coins.redeem') {
    const catalog = await require('../v21/coins.service').catalog(db, owner);
    const reward = catalog.items.find(row => row.code === args.reward);
    if (!reward) return question('Quà này hiện chưa khả dụng. Bạn xem lại danh sách đổi xu nhé.', 'This reward is currently unavailable. Please check the reward catalog.', lang);
    payload = { reward: reward.code, cost: reward.cost, requestId: randomUUID(), redemption: {} };
    detail = `${reward.title || (reward.code === 'GREETING_CARD' ? en ? 'Greeting card' : 'Thiệp gửi người thân' : en ? 'Lucky draw ticket' : 'Vé dự thưởng')} · ${reward.cost} ${en ? 'coins' : 'xu'}`;
    if (reward.code === 'GREETING_CARD') {
      const recipient = data.choose(catalog.recipients, args.recipient, row => row.name);
      const template = data.choose(catalog.templates, args.template, row => en ? row.title_en || row.title : row.title);
      if (!recipient || !template) return question(`Bạn muốn gửi cho ai và dùng mẫu thiệp nào? Người nhận: ${catalog.recipients.map(row => row.name).join(', ')}. Mẫu thiệp: ${catalog.templates.map(row => row.title).join('; ')}.`,
        `Who should receive it and which template? Recipients: ${catalog.recipients.map(row => row.name).join(', ')}. Templates: ${catalog.templates.map(row => row.title_en || row.title).join('; ')}.`, lang);
      payload.redemption = { recipientId: recipient.id, templateCode: template.code };
      detail += `\n${recipient.name}\n${en ? template.body_en || template.body : template.body}`;
    }
  } else if (tool === 'medication.rename' || tool === 'medication.configure') {
    const context = await require('./medication-assistant.service').contextForPlan(db, owner);
    const item = data.choose(context.items, args.target, row => row.name);
    if (!context.available || !item) return question('Bạn muốn sửa thuốc nào trong danh sách đang có nhé?', 'Which existing medicine would you like to change?', lang);
    if (tool === 'medication.rename') {
      require('../v21/medication.service').itemSchema.shape.display_name.parse(args.name);
      payload = { id: item.id, before: item.name, name: args.name }; detail = `${item.name} → ${args.name}`;
    } else {
      const rows = context.schedules.filter(row => row.item_ids.includes(item.id) && (!args.time || row.time === args.time));
      if (rows.length !== 1) return question(`Thuốc này có các khung giờ ${rows.map(row => row.time).join(', ')}. Bạn muốn sửa khung giờ nào?`, 'Which scheduled time would you like to change?', lang);
      const row = rows[0], patch = args.changes;
      require('../v21/medication.service').scheduleSchema.parse({ time_local: row.time, item_ids: row.item_ids, ...patch });
      const before = { note: row.note, meal_anchor: row.anchor };
      payload = { id: row.id, patch, before: fields(before, patch), membership: fingerprint([row.item_ids, row.time, row.active, row.consent]) };
      detail = `${row.item_ids.map(id => context.items.find(item => item.id === id)?.name).filter(Boolean).join(', ')} · ${row.time}\n${changesLabel(patch, en)}`;
    }
  } else if (tool.startsWith('feed.')) {
    const rows = tool === 'feed.unsave' ? await require('../health_feed/repository').listSaved(db, owner) : await data.feed(db, owner, lang, context);
    const row = data.choose(rows, args.target, row => row.title);
    if (!row) return question('Bạn cho mình tên bài viết muốn chọn nhé.', 'Please tell me which article title you mean.', lang);
    if (row.localOnly) {
      if (tool === 'feed.hide') return { native: { type: 'native', kind: 'feed.hide', parameters: { id: row.id } } };
      return { answer: en ? 'This bundled article is always available in the app and has no save option.' : 'Bài viết có sẵn trong app, bạn có thể mở lại trong Bản tin sức khỏe nhé.' };
    }
    payload = { id: row.content_id || row.id, feedId: row.content_id ? row.id : null }; detail = row.title;
  } else throw c.error('APP_ASSISTANT_INVALID_REQUEST');
  const requirements = tool === 'calls.configure' && args.enabled === true ? ['notifications', 'calls'] : tool === 'settings.configure' && args.reminders_enabled === true ? ['notifications'] : [];
  return { action: { ...sign(owner, tool, payload, [labelFor(tool, en), detail].filter(Boolean).join('\n')), ...(requirements.length ? { requirements } : {}) } };
}

// Every operation delegates to the app's existing service. Fixed event IDs,
// bounded inbox IDs, desired states and existing cancellation/redemption receipts
// make a retry safe without replaying a user's later, unrelated command.
async function execute(db, owner, token, lang = 'vi') {
  let plan;
  try {
    plan = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], audience, subject: String(owner) });
    if (plan.kind !== 'app_tool' || !schema.definitions[plan.tool] || schema.readTools.has(plan.tool) || !plan.payload || !plan.jti) throw Error('invalid');
  } catch { throw c.error('APP_ASSISTANT_PLAN_EXPIRED', 409); }
  if (!(await require('../ai/ai-consent.service').hasAiConsent(db, owner))) throw c.error('AI_CONSENT_REQUIRED', 403);
  const { tool, payload: p } = plan;
  assertAvailable(tool);
  if (require('./management-tools.service').handles(tool)) return require('./management-tools.service').execute(db, owner, plan, token, lang);
  let result, answer;
  if (tool.startsWith('notifications.')) {
    const service = require('../notification/notification.service');
    if (tool === 'notifications.read_all') result = await service.markAllAsRead(db, owner, { beforeId: p.beforeId });
    else if (tool === 'notifications.delete_all') result = await service.deleteAllNotifications(db, owner, { beforeId: p.beforeId });
    else if (tool === 'notifications.delete') result = await service.deleteNotification(db, p.id, owner);
    else {
      const row = (await db.query('SELECT id FROM notifications WHERE user_id=$1 AND id=$2', [owner, p.id])).rows[0];
      if (row) result = await service.markAsRead(db, p.id, owner);
    }
    data.checked(result);
  } else if (tool === 'checkin.cancel') result = await require('../checkin/checkin-cancellation.service').cancelCheckin(db, owner, p.id, p.phase);
  else if (tool === 'calls.configure' || tool === 'calls.personalize' || tool === 'settings.configure') {
    result = await c.transaction(db, async client => {
      await c.lockPatient(client, owner);
      await client.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [owner]);
      if (!(await require('../ai/ai-consent.service').hasAiConsent(client, owner))) throw c.error('AI_CONSENT_REQUIRED', 403);
      const table = { 'calls.configure': 'checkin_call_settings', 'calls.personalize': 'checkin_call_voice_preferences', 'settings.configure': 'user_notification_preferences' }[tool];
      await client.query(`SELECT user_id FROM ${table} WHERE user_id=$1 FOR UPDATE`, [owner]);
      const service = tool === 'calls.configure' ? require('../checkin-call/checkin-call.service') : tool === 'calls.personalize'
        ? require('../checkin-call/personalization.service') : require('../notification/smart.schedule.service');
      const current = tool === 'calls.configure' ? await service.settings(client, owner) : tool === 'calls.personalize'
        ? (await service.preferences(client, owner)).preferences : await service.getPreferences(client, owner, { refreshInferred: false });
      const now = fields(current, p.patch);
      if (equal(now, p.patch)) return { replay: true };
      if (!equal(now, p.before)) throw conflict();
      return tool === 'calls.configure' ? service.saveSettings(client, owner, p.patch) : tool === 'calls.personalize'
        ? service.savePreferences(client, owner, { ...current, ...p.patch }) : service.updatePreferences(client, owner, p.patch);
    });
    if (result?.replay) return { status: 'applied', replay: true };
  } else if (tool.startsWith('family.')) {
    const service = require('../care-circle/careCircle.service');
    if (tool === 'family.invite') {
      const existing = (await db.query(`SELECT id,status FROM user_connections WHERE
        (requester_id=$1 AND addressee_id=$2) OR(requester_id=$2 AND addressee_id=$1)`, [owner, p.otherId])).rows[0];
      if (existing) {
        if (['pending', 'accepted'].includes(existing.status)) return { status: 'applied', replay: true };
        throw conflict();
      }
      result = await service.createInvitation(db, owner, { addressee_id: p.otherId, relationship_type: p.relationship, role: 'than-nhan',
        permissions: { can_view_logs: false, can_receive_alerts: false, can_ack_escalation: false } }, lang);
    } else {
      const row = (await db.query('SELECT * FROM user_connections WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)', [p.id, owner])).rows[0];
      if (!row && ['family.remove', 'family.cancel', 'family.reject'].includes(tool)) return { status: 'applied', replay: true };
      if (!row) throw conflict();
      if (['family.accept', 'family.reject'].includes(tool) && Number(row.addressee_id) !== Number(owner)) throw conflict();
      if (tool === 'family.accept' && row.status === 'accepted') return { status: 'applied', replay: true };
      if (tool === 'family.reject' && row.status === 'rejected') return { status: 'applied', replay: true };
      if (tool === 'family.cancel' && Number(row.requester_id) !== Number(owner)) throw conflict();
      if (tool === 'family.accept') result = await service.acceptInvitation(db, p.id, owner, lang);
      else if (tool === 'family.reject') result = await service.rejectInvitation(db, p.id, owner, lang);
      else if (tool === 'family.cancel') result = await service.cancelInvitation(db, p.id, owner, lang);
      else if (tool === 'family.remove') result = await service.deleteConnection(db, p.id, owner, lang);
      else if (tool === 'family.edit') {
        if (row.relationship_type === p.relationship) return { status: 'applied', replay: true };
        if (row.relationship_type !== p.before) throw conflict();
        result = await service.updateConnection(db, p.id, owner, { relationship_type: p.relationship }, lang);
      } else if (tool === 'family.share') {
        const before = Number(row.requester_id) === Number(owner) ? row.permissions?.can_view_logs === true : row.addressee_can_view_logs === true;
        if (before === p.enabled) return { status: 'applied', replay: true };
        if (before !== p.before) throw conflict();
        result = await service.updateHealthAccess(db, p.id, owner, p.enabled, lang);
      } else if (tool === 'family.permissions') {
        if (Number(row.requester_id) !== Number(owner)) throw conflict();
        const now = fields(Object.fromEntries(Object.keys(p.patch).map(key => [key, row.permissions?.[key] === true])), p.patch);
        if (equal(now, p.patch)) return { status: 'applied', replay: true };
        if (!equal(now, p.before)) throw conflict();
        result = await service.updateConnectionPermissions(db, p.id, owner, p.patch, lang, { patch: true, expected: p.before });
      }
      if (row.status !== 'accepted' && !['family.accept', 'family.reject', 'family.cancel'].includes(tool)) throw conflict();
    }
    if (result?.ok === false) throw Object.assign(c.error(result.code || 'APP_ASSISTANT_TOOL_REJECTED', result.statusCode || 409), { publicMessage: result.error });
  } else if (tool === 'gifts.open') {
    const gift = await require('../checkin-gifts/gift.service').open(db, owner, p.id, p.box, lang);
    answer = data.describeGift(gift);
  } else if (tool === 'coins.redeem') {
    const service = require('../v21/coins.service');
    // The displayed cost must still be valid at confirmation time.
    const catalog = await service.catalog(db, owner);
    if (!catalog.items.some(row => row.code === p.reward && Number(row.cost) === Number(p.cost))) throw conflict();
    result = await service.redeem(db, owner, p.reward, { request_id: p.requestId, payload: p.redemption });
  } else if (tool === 'medication.rename') {
    const med = require('../v21/medication.service');
    await c.assertFeature(db, owner, 'medication');
    await c.transaction(db, async client => {
      await c.lockPatient(client, owner);
      await client.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [owner]);
      if (!(await require('../ai/ai-consent.service').hasAiConsent(client, owner))) throw c.error('AI_CONSENT_REQUIRED', 403);
      const row = (await client.query('SELECT * FROM med_items WHERE patient_user_id=$1 AND id=$2 AND active FOR UPDATE', [owner, p.id])).rows[0];
      if (!row) throw conflict();
      const name = med.reveal(owner, 'med_items.display_name', row.display_name);
      if (name === p.name) return;
      if (name !== p.before) throw conflict();
      med.itemSchema.shape.display_name.parse(p.name);
      await client.query('UPDATE med_items SET display_name=$3,tags_json=NULL WHERE patient_user_id=$1 AND id=$2', [owner, p.id, med.protect(owner, 'med_items.display_name', p.name)]);
    });
  } else if (tool === 'medication.configure') {
    result = await c.transaction(db, async client => {
      await c.lockPatient(client, owner);
      await client.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [owner]);
      if (!(await require('../ai/ai-consent.service').hasAiConsent(client, owner))) throw c.error('AI_CONSENT_REQUIRED', 403);
      const context = await require('./medication-assistant.service').contextForPlan(client, owner);
      const row = context.schedules.find(row => row.id === p.id);
      if (!context.available || !row || fingerprint([row.item_ids, row.time, row.active, row.consent]) !== p.membership) throw conflict();
      const now = fields({ note: row.note, meal_anchor: row.anchor }, p.patch);
      if (equal(now, p.patch)) return { replay: true };
      if (!equal(now, p.before)) throw conflict();
      return require('../v21/medication.service').saveSchedule(client, owner, owner, p.id, {
        time_local: row.time, item_ids: row.item_ids, note: row.note, meal_anchor: row.anchor, active: row.active, ...p.patch,
      });
    });
    if (result?.replay) return { status: 'applied', replay: true };
  } else if (tool.startsWith('feed.')) {
    if (!require('../health_feed/config').isHealthFeedEnabled()) throw conflict();
    const repo = require('../health_feed/repository');
    if (!(await repo.getContent(db, owner, p.id))) throw conflict();
    if (tool === 'feed.save') await repo.saveContent(db, owner, p.id);
    else if (tool === 'feed.unsave') await repo.unsaveContent(db, owner, p.id);
    else if (p.feedId) await repo.dismiss(db, owner, p.feedId);
    else throw conflict();
  } else throw c.error('APP_ASSISTANT_INVALID_REQUEST');
  return { status: 'applied', ...(answer ? { answer } : {}) };
}
module.exports = { prepare, execute, schema: schema.schema, parse: schema.parse, contract: schema.contract, fingerprint, changesLabel };
