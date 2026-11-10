'use strict';

const variables = {
  base_url: 'http://localhost:3300', language: 'vi', email: '', password: '', access_token: '',
  user_id: '', tenant_id: 'clinic-demo', doctor_id: '', task_id: '', checkin_id: '',
  ai_consent_version: '', cron_secret: '', health_check_token: '', doctor_integration_secret: '',
  google_pubsub_oidc_token: '', expected_status: '', request_id: '', consent_version: '',
  new_password: '', capability: '', notice_version: '', guidance_epoch: '0', draft_revision: '0',
};
const requests = {};
function set(method, path, config) { requests[method + ' ' + path] = config; }
function body(path, data, extra = {}, method = 'POST') { set(method, path, { body: data, ...extra }); }
function query(path, params, required = []) { set('GET', path, { query: params, requiredQuery: required }); }
const store = (pairs) => `
if (pm.response.code >= 200 && pm.response.code < 300) {
  const b = pm.response.json();
  const save = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    const key = (pm.variables.get('asinu_mode') || 'local') + '_' + k;
    (pm.environment.name ? pm.environment : pm.collectionVariables).set(key, String(v));
  };
  ${pairs}
}`;
const loginTest = store("save('access_token', b.token); save('user_id', b.user && b.user.id);");
body('/api/auth/email/register', { email: '{{email}}', password: '{{password}}', full_name: 'Asinu Postman Test' }, { test: loginTest });
body('/api/auth/email/login', { identifier: '{{email}}', password: '{{password}}' }, { test: loginTest, note: 'identifier nhận email hoặc số điện thoại đã đăng ký.' });
body('/api/auth/google', { token: '{{google_id_token}}' }, { test: loginTest, note: 'Dùng Google ID token hợp lệ từ ứng dụng OAuth đã cấu hình.' });
body('/api/auth/apple', { token: '{{apple_identity_token}}', full_name: 'Asinu Test' }, { test: loginTest });
body('/api/auth/zalo', { code: '{{oauth_code}}', code_verifier: '{{oauth_code_verifier}}' }, { test: loginTest });
body('/api/auth/facebook/token', { access_token: '{{facebook_access_token}}' }, { test: loginTest });
body('/api/auth/oauth/exchange', { code: '{{oauth_code}}', code_verifier: '{{oauth_code_verifier}}' }, { test: loginTest });
query('/api/auth/me', {}, []);
requests['GET /api/auth/me'].test = store("save('user_id', b.user && b.user.id);");
query('/api/auth/users/search', { q: '{{search_phone}}' }, ['q']);
for (const provider of ['google', 'facebook', 'zalo']) {
  query('/api/auth/' + provider + '/initiate', { code_challenge: '{{oauth_code_challenge}}' }, ['code_challenge']);
  query('/api/auth/' + provider + '/callback', { code: '{{provider_oauth_code}}', state: '{{oauth_state}}' }, ['code', 'state']);
}

body('/api/mobile/logs', { log_type: 'glucose', occurred_at: '{{now_iso}}', source: 'postman', data: { value: 100, unit: 'mg/dL', context: 'fasting' } }, { note: 'Các log_type khác: bp, weight, water, meal, insulin, medication, care_pulse. Xem các body mẫu trong README.txt.' });
query('/api/mobile/logs', { type: 'glucose', limit: 20, all: false });
query('/api/mobile/logs/today', { type: 'glucose' });
query('/api/mobile/caregiver/logs/:patientId', { type: 'glucose', limit: 20 });
query('/api/mobile/caregiver/checkins/:patientId', { days: 7 });
body('/api/mobile/chat', { message: 'Cho tôi gợi ý thói quen sinh hoạt lành mạnh.', client_ts: '{{now_ms}}' });
body('/api/mobile/chat/feedback', { messageId: '{{chat_message_id}}', messageText: 'Nội dung tin nhắn test', feedbackType: 'like' });
query('/api/mobile/chat/history', { limit: 20 });
query('/api/mobile/chat/notes', { page: 1, limit: 20 });
set('GET', '/api/mobile/ai-consent', { test: store("save('ai_consent_version', b.version);") });
body('/api/mobile/ai-consent', { version: '{{ai_consent_version}}', granted: true }, { note: 'Chạy GET /ai-consent trước để lấy version hiện tại.' }, 'PUT');
body('/api/mobile/onboarding/complete-v2', {
  full_name: 'Asinu Postman Test', birth_year: 1980, gender: 'male', height_cm: 170, weight_kg: 65,
  phone: '{{test_phone}}', blood_type: 'O', medical_conditions: [], daily_medication: false,
  checkup_freq: 'yearly', exercise_freq: 'sometimes', sleep_hours: 7, meals_per_day: 3,
  post_meal_drowsy: false, dinner_time: '18:30', sweet_intake: 'sometimes', user_goal: ['healthy_lifestyle'],
});
body('/api/mobile/profile', { name: 'Asinu Postman Test', gender: 'male', heightCm: 170, weightKg: 65, language: 'vi' }, {}, 'PUT');
body('/api/mobile/auth/change-password', { currentPassword: '{{password}}', newPassword: '{{new_password}}' }, { test: loginTest });
body('/api/mobile/profile/push-token', { fcm_token: '{{fcm_token}}' });
set('GET', '/api/mobile/guidance', { test: store("save('guidance_epoch', (b.progress || b).epoch);") });
body('/api/mobile/guidance', { epoch: '{{guidance_epoch}}', role: 'self', welcomeSeen: true, completed: ['home.fine'] }, {}, 'PUT');
body('/api/mobile/checkin/start', { status: 'fine', source: 'instant' }, { test: store("save('checkin_id', b.session && b.session.id); save('gift_id', b.gift && b.gift.id);") });
body('/api/mobile/checkin/cancel', { checkin_id: '{{checkin_id}}' });
body('/api/mobile/checkin/followup', { checkin_id: '{{checkin_id}}', status: 'fine' });
body('/api/mobile/checkin/triage', { checkin_id: '{{checkin_id}}', previous_answers: [], assessment_version: 2, adaptive_questions: true }, { note: 'Dùng check-in có triệu chứng; lần tiếp theo gửi lại question, answer và step đúng từ response trong previous_answers.' });
body('/api/mobile/checkin/emergency', { location: { lat: 10.7769, lng: 106.7009, accuracy: 50 } });
body('/api/mobile/checkin/confirm-alert', { alert_id: '{{alert_id}}', action: 'seen' });
query('/api/mobile/checkin/report', { period: 'week', month: '{{month}}' });
set('POST', '/api/mobile/checkin/simulate-time', {});
body('/api/mobile/test-notification', { type: 'test' });
body('/api/mobile/checkin/script/start', { status: 'tired', symptom_input: 'Tôi hơi đau đầu.' }, { test: store("save('script_session_id', b.session_id); save('question_id', b.question && b.question.id);"), note: 'Response chứa session và câu hỏi để trả lời tiếp; cũng có thể truyền cluster_key lấy từ GET /checkin/script.' });
body('/api/mobile/checkin/script/answer', { session_id: '{{script_session_id}}', question_id: '{{question_id}}', answer: '{{option_id}}' });
body('/api/mobile/checkin/script/clusters', { symptoms: ['headache'] });
body('/api/mobile/engagement/screen-view', { screen_name: 'Home', feature_code: 'home' });
query('/api/mobile/tree/history', { days: 30 });
set('POST', '/api/mobile/auth/logout', { test: `if (pm.response.code >= 200 && pm.response.code < 300) { const key = pm.variables.get('asinu_mode') + '_access_token'; pm.environment.unset(key); pm.collectionVariables.set(key, ''); }` });
set('DELETE', '/api/mobile/profile', { note: 'Xóa tài khoản đang đăng nhập. Chỉ Send khi chủ động kiểm tra luồng xóa tài khoản test.' });

body('/api/care-circle/invitations', { addressee_id: '{{addressee_user_id}}', relationship_type: 'ban', role: 'than-nhan', permissions: { can_view_logs: true, can_receive_alerts: true } }, { test: store("save('invitation_id', (b.invitation || b.data || {}).id);") });
body('/api/care-circle/qr-token/preview', { token: '{{qr_token}}' });
body('/api/care-circle/qr-token/invitations', { token: '{{qr_token}}', relationship_type: 'ban', role: 'than-nhan' });
set('POST', '/api/care-circle/qr-token', { test: store("save('qr_token', b.token || (b.qr && b.qr.token));") });
query('/api/care-circle/invitations', { direction: 'incoming' });
body('/api/care-circle/connections/:id', { relationship_type: 'ban', role: 'than-nhan' }, {}, 'PUT');
body('/api/care-circle/connections/:id/permissions', { permissions: { can_view_logs: true, can_receive_alerts: true, can_ack_escalation: true } }, {}, 'PUT');
body('/api/care-circle/connections/:id/health-access', { can_view_logs: true }, {}, 'PUT');
query('/api/care-circle/member/:memberId/health-calendar', { month: '{{month}}' }, ['month']);
body('/api/care-pulse/events', { event_type: 'APP_OPENED', event_id: '{{request_id}}', client_ts: '{{now_ms}}', client_tz: 'Asia/Ho_Chi_Minh', ui_session_id: '{{request_id}}', source: 'manual' });
body('/api/wellness/activity', { activity_type: 'APP_OPEN', activity_data: {}, session_id: '{{request_id}}' });
body('/api/wellness/calculate', { checkAlert: false });
for (const suffix of ['history', 'summary']) query('/api/wellness/' + suffix, { days: 7 });
query('/api/wellness/alerts', { status: 'pending', limit: 20 });
query('/api/wellness/caregiver/alerts', { unreadOnly: true, limit: 20 });
body('/api/wellness/help-request', { message: 'Yêu cầu hỗ trợ từ tài khoản test Postman' });
body('/api/health/alert-care-circle', { alertData: { severity: 'low', message: 'Thông báo test Postman' } });
body('/api/early-signals/evaluate', {});
query('/api/early-signals/latest', { user_id: '{{patient_user_id}}' });
body('/api/health-feed/event', { content_id: '{{content_id}}', feed_item_id: '{{feed_item_id}}', event_type: 'view', metadata: { source: 'postman' } });
body('/api/subscription-household/members', { user_id: '{{protected_user_id}}' });
body('/api/payments/qr', { amount: 10000 });
body('/api/payments/webhook', { id: '{{payment_event_id}}', transferType: 'in', transferAmount: 10000, content: '{{payment_transfer_content}}' }, { note: 'Webhook cần Authorization đúng từ nhà cung cấp. Điền sepay_api_key trong header; payload phải khớp giao dịch test.' });
query('/api/payments/history', { page: 1, limit: 20 });
query('/api/iap/products', { platform: 'google' }, ['platform']);
body('/api/iap/verify', { platform: 'google', productId: '{{iap_product_id}}', purchaseToken: '{{google_purchase_token}}' }, { note: 'Dùng purchase token từ Google Play test. Apple dùng platform apple và dữ liệu theo iap.controller.js.' });
body('/api/iap/apple-notifications', { signedPayload: '{{apple_signed_payload}}' });
body('/api/iap/google-notifications', { message: { data: '{{google_pubsub_data_base64}}', messageId: '{{google_pubsub_message_id}}' }, subscription: '{{google_pubsub_subscription}}' });

body('/api/notifications', { type: 'system', title: 'Postman test', message: 'Thông báo thử nghiệm', data: {} });
query('/api/notifications', { page: 1, limit: 20 });
body('/api/notifications/preferences', { reminders_enabled: true, health_feed_enabled: true, morning_time: '08:00', afternoon_time: '14:00', evening_time: '20:00' }, {}, 'PUT');
body('/api/notifications/engagement/run', { hour: 9, minute: 0 });
body('/api/notifications/basic/run', { hour: 9, minute: 0 });

body('/api/mobile/checkin-call/settings', { enabled: false, checkin_time: '08:00', grace_hours: 4 }, {}, 'PUT');
body('/api/mobile/checkin-call/voice-preferences', { use_name: false, use_health: false, address: 'auto', weather_enabled: false, region: null, location: null }, {}, 'PUT');
body('/api/mobile/checkin-call/test-call', { local_simulation: true, single_device: true }, { test: store("save('episode_id', b.episode && b.episode.id); save('attempt_id', b.attempt && b.attempt.id);") });
body('/api/mobile/checkin-call/audio/conclusion', { text: 'Đây là nội dung kết luận thử nghiệm.' });
body('/api/mobile/checkin-call/native/attempts/:id/decline', { capability: '{{capability}}' });
body('/api/mobile/checkin-call/episodes/:id/answer', { choice: 1 });
body('/api/mobile/checkin-call/episodes/:id/triage/complete', { body_location: 'head', symptom: 'headache', intensity: 'MILD' });
body('/api/mobile/checkin-call/episodes/:id/family-confirm', { action: 'ACCEPT_AND_CHECK' });
query('/api/internal/checkin-call/exhausted', { limit: 20 });
body('/api/mobile/gift/open', { gift_id: '{{gift_id}}', box: 1 });
query('/api/mobile/gift/history', { before: '{{gift_cursor}}' });
body('/api/internal/gifts/config', { enabled: false, loc_weight: 100, ticket_weight: 0, coupon_weight: 0, lucky_draw_enabled: false, coupon_enabled: false, coupon_max_vnd: 0 }, {}, 'PUT');
body('/api/internal/gifts/loc-items/:code', { type: 'wish', text: 'Chúc bạn một ngày bình an.', text_en: 'Wishing you a peaceful day.', conditions: [], serif: false, active: false, reviewed_by: null }, {}, 'PUT');
body('/api/internal/gifts/draws/:code', { prize_name: 'Phần quà test', starts_at: '{{draw_starts_at}}', closes_at: '{{draw_closes_at}}', draw_at: '{{draw_at}}', rules: { vi: 'Thể lệ minh họa cho kỳ quay thử nghiệm nội bộ.', en: 'Illustrative rules for an internal test draw period.' }, registration_reference: 'POSTMAN-TEST', active: false }, { note: 'closes_at phải đúng 23:59 giờ Việt Nam ngày trước draw_at. Điền ngày test hợp lệ.' }, 'PUT');
body('/api/internal/gifts/draws/:id/results', { ticket_numbers: ['{{ticket_number}}'] });

const meals = { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' };
body('/api/mobile/rewards/:code/redeem', { request_id: '{{request_id}}', payload: {} });
query('/api/mobile/coins/history', { before: '{{coin_cursor}}' });
for (const suffix of ['medication/weekly-report', 'med-schedules', 'med-doses/today', 'med-items/scan', 'med-items/transcribe']) {
  if (!suffix.startsWith('med-items')) query('/api/mobile/' + suffix, { patientId: '{{patient_user_id}}', ...(suffix === 'med-schedules' ? { includePaused: true } : {}) });
}
query('/api/mobile/med-media/:id', { token: '{{media_token}}' }, ['token']);
body('/api/mobile/med-native/:id/decline', { capability: '{{med_capability}}' });
body('/api/mobile/med-native/:id/status', { capability: '{{med_capability}}' });
body('/api/mobile/medication/draft', { id: '{{draft_id}}', revision: '{{draft_revision}}', snapshot: { version: 1, step: 1, items: [], meals, slots: [], photoMediaId: null } }, { query: { patientId: '{{patient_user_id}}' }, test: store("save('draft_id', b.id); save('draft_revision', b.revision);") }, 'PUT');
set('DELETE', '/api/mobile/medication/draft/:id', { query: { patientId: '{{patient_user_id}}', revision: '{{draft_revision}}' }, requiredQuery: ['revision'] });
body('/api/mobile/medication/consents', { schedule_ids: ['{{schedule_id}}'], accept: true });
body('/api/mobile/medication/setup', { request_id: '{{request_id}}', merge_existing: true, items: [{ display_name: 'Vitamin C', kind: 'SUPPLEMENT', source: 'CHIP', confirmed: true }], meals, slots: [{ time_local: '07:00', item_indexes: [0], note: '' }] }, { query: { patientId: '{{patient_user_id}}' }, note: 'Dữ liệu giả lập cho tài khoản test; không dùng làm hướng dẫn dùng thuốc.' });
body('/api/mobile/med-items/lookup', { name: 'Vitamin C', kind: 'SUPPLEMENT' }, { query: { patientId: '{{patient_user_id}}' } });
body('/api/mobile/med-schedules/:id', { time_local: '07:00', item_ids: ['{{med_item_id}}'], active: true }, { query: { patientId: '{{patient_user_id}}' } }, 'PUT');
body('/api/mobile/med-schedules/:id/move-item', { item_id: '{{med_item_id}}', time_local: '08:00', request_id: '{{request_id}}' }, { query: { patientId: '{{patient_user_id}}' } });
body('/api/mobile/med-schedules/:id/consent', { accept: true });
body('/api/mobile/med-doses/:id/answer', { button: 1, request_id: '{{request_id}}' });
body('/api/mobile/med-doses/:id/checkin', { status: 'fine' });
body('/api/mobile/medication/device', { platform: 'android', token: '{{fcm_token}}', supported: true });
body('/api/mobile/medication/family-preferences', { problems_only: true }, { query: { patientId: '{{patient_user_id}}' } }, 'PUT');
query('/api/mobile/med-doses/:id/audio', { phase: 'prompt' });
body('/api/internal/config', { medication_enabled: false, coins_enabled: false, scan_enabled: false, native_call_enabled: false, rollout_user_ids: [] }, {}, 'PUT');
body('/api/internal/coins/rules', { rules: [{ task_code: 'CHECKIN', coins: 1, daily_limit: 1, weekly_limit: 0, active: true }] }, {}, 'PUT');
body('/api/internal/rewards/:code', { cost: 10, active: false }, {}, 'PUT');
body('/api/internal/greeting-templates/:code', { title: 'Lời chúc test', title_en: 'Test greeting', body: 'Chúc bạn bình an.', body_en: 'Wishing you peace.', active: false, approved_by: 'Postman Test' }, {}, 'PUT');

const doctorContext = { tenant_id: '{{tenant_id}}', app_user_id: '{{user_id}}', task_id: '{{task_id}}' };
body('/api/doctor/screening', { summary: 'Tôi muốn trao đổi về thói quen ngủ.', answers: [], locale: 'vi' });
body('/api/doctor/tasks', { tenant_id: '{{tenant_id}}', specialty: 'general', service_flow: 'clinical', priority: 'normal', summary: 'Dữ liệu test: trao đổi về thói quen ngủ.', clinical_intake: { symptom_onset: 'ongoing', progression: 'stable', severity: 'mild', emergency_confirmation: true }, consent_version: '{{consent_version}}', task_id: '{{task_id}}' }, { pre: "if (!pm.variables.get('task_id')) { const id = pm.variables.replaceIn('{{$guid}}'); const key = pm.variables.get('asinu_mode') + '_task_id'; (pm.environment.name ? pm.environment : pm.collectionVariables).set(key, id); pm.variables.set('task_id', id); }" });
for (const suffix of ['tasks', 'tasks/:taskId/messages', 'privacy', 'specialty-options']) query('/api/doctor/' + suffix, { tenant_id: '{{tenant_id}}' }, ['tenant_id']);
body('/api/doctor/tasks/:taskId/messages', { tenant_id: '{{tenant_id}}', content: 'Tin nhắn thử nghiệm từ Postman.', message_type: 'reply', client_message_id: '{{request_id}}' });
body('/api/doctor/tasks/:taskId/messages/action', { tenant_id: '{{tenant_id}}', action: 'typing', is_typing: true });
body('/api/doctor/tasks/:taskId/rating', { tenant_id: '{{tenant_id}}', score: 5, comment: 'Đánh giá thử nghiệm', request_id: '{{request_id}}' });
body('/api/doctor/privacy', { tenant_id: '{{tenant_id}}', action: 'grant_consent', consent_version: '{{consent_version}}', request_id: '{{request_id}}', confirmation: 'CONFIRM_DOCTOR_DATA_REQUEST' });
body('/api/doctor/specialists', { specialty: 'general', service_flow: 'clinical', limit: 6 });
body('/api/doctor/clinics', { tenant_id: '{{tenant_id}}' });
query('/api/doctor/specialists/:doctorId/reviews', { limit: 10 });
body('/api/doctor/profile', doctorContext);
body('/api/doctor/patient-files', { ...doctorContext, file_name: '{{file_name}}', mime_type: '{{file_mime_type}}', content_base64: '{{file_content_base64}}', size_bytes: '{{file_size_bytes}}' });
body('/api/doctor/lifecycle', { event_id: '{{request_id}}', event_type: 'service.accepted', source: 'asinu-doctor', version: 1, occurred_at: '{{now_iso}}', correlation_id: '{{task_id}}', payload: { tenant_id: '{{tenant_id}}', app_order_id: '{{task_id}}', app_user_id: '{{user_id}}', service_code: 'doctor-consultation', source_channel: 'asinu-mobile', specialty: 'general', service_flow: 'clinical', priority: 'normal', summary: 'Dữ liệu test Postman', status: 'accepted' } });
body('/api/doctor/messages/query', doctorContext);
body('/api/doctor/messages/send', { ...doctorContext, content: 'Tin nhắn test từ chuyên gia.', message_type: 'consultation', client_message_id: '{{request_id}}', sender_ref: '{{doctor_id}}', sender_name: 'Chuyên gia Test' });
body('/api/doctor/messages/action', { ...doctorContext, action: 'typing', is_typing: true, actor_ref: '{{doctor_id}}' });
body('/api/doctor/messages/voice', { ...doctorContext, content_base64: '{{audio_base64}}', file_name: 'test.m4a', mime_type: 'audio/mp4', size_bytes: '{{audio_size_bytes}}', duration_ms: 1000, client_message_id: '{{request_id}}', sender_ref: '{{doctor_id}}' });
for (const suffix of ['ai-assist', 'ai-context-version']) body('/api/doctor/' + suffix, { ...doctorContext, touchpoint: 'patient_summary', task_summary: 'Dữ liệu giả lập phục vụ test.', locale: 'vi' });
body('/api/doctor/ivr/doctor', { ...doctorContext, doctor_id: '{{doctor_id}}', doctor_name: 'Chuyên gia Test', operation: 'list', data: {} });
body('/api/doctor/ivr/admin', { tenant_id: '{{tenant_id}}', admin_id: '{{admin_id}}', operation: 'get', data: {} });
body('/api/doctor/ivr/calls/device', { supported: true, platform: 'android', token: '{{fcm_token}}' });
body('/api/doctor/ivr/calls/:id/action', { action: 'accept' });
body('/api/doctor/ivr/native/calls/:id/decline', { capability: '{{ivr_capability}}' });
query('/api/doctor/ivr/sessions', { tenant_id: '{{tenant_id}}', task_id: '{{task_id}}' }, ['tenant_id', 'task_id']);
body('/api/doctor/ivr/sessions/:id/action', { action: 'start' });
set('POST', '/api/doctor/ivr/sessions/:id/voice', { form: { file: { file: true }, revision: '{{ivr_revision}}', question_id: '{{question_id}}', request_id: '{{request_id}}', recording_consent: 'true', duration_s: '1' } });
query('/api/doctor/ivr/media/:id', { expires: '{{media_expires}}', signature: '{{media_signature}}', actor: '{{media_actor}}' }, ['expires', 'signature', 'actor']);
for (const suffix of ['attachments', 'voice']) set('POST', '/api/doctor/tasks/:taskId/' + suffix, { form: { file: { file: true }, tenant_id: '{{tenant_id}}', client_message_id: '{{request_id}}', ...(suffix === 'voice' ? { duration_ms: '1000' } : {}) } });

body('/api/health/ai/route', { taskType: 'chat', input: 'Dữ liệu thử nghiệm' });
body('/api/health/ai/route-triage', { severity: 'low', input: 'Dữ liệu thử nghiệm' });
body('/api/health/ai/cache-test', { messages: [{ role: 'user', content: 'Xin chào, đây là dữ liệu test.' }], model: '{{ai_model}}' });
body('/api/health/ai/distillation-collect', { taskType: 'chat', input: 'Dữ liệu test', output: 'Phản hồi test' });
body('/api/health/cache/reuse', { userId: '{{user_id}}', clusterKey: '{{cluster_key}}' });
query('/api/health/cache/top-reused', { limit: 10 });

const numericVariables = ['now_ms', 'guidance_epoch', 'draft_revision', 'protected_user_id', 'file_size_bytes', 'audio_size_bytes'];
module.exports = {
  variables, requests, numericVariables,
  environmentKeys: ['base_url', 'language', 'email', 'password', 'access_token', 'user_id', 'tenant_id', 'ai_consent_version', 'cron_secret', 'health_check_token', 'doctor_integration_secret', 'google_pubsub_oidc_token', 'expected_status'],
  fieldValues: { limit: 20, page: 1, days: 7, period: 'week', month: '{{month}}', patientId: '{{patient_user_id}}', userId: '{{user_id}}', type: 'glucose', status: 'fine', before: '', token: '{{media_token}}', action: 'start', q: '{{search_phone}}' },
  pathVariable(p, name) {
    if (name !== 'id' && name !== 'code' && name !== 'key') return ({ userId: 'user_id', patientId: 'patient_user_id', memberId: 'member_user_id', taskId: 'task_id', doctorId: 'doctor_id', questionId: 'question_id', days: 'inactive_days', taskType: 'task_type', triggerType: 'notification_trigger' })[name] || name;
    if (name === 'key') return 'audio_key';
    if (name === 'code') return p.includes('loc-items') ? 'loc_code' : p.includes('draws') ? 'draw_code' : p.includes('greeting-templates') ? 'greeting_template_code' : 'reward_code';
    for (const [part, key] of [['invitations','invitation_id'], ['connections','connection_id'], ['attempts','attempt_id'], ['episodes','episode_id'], ['med-native','dose_id'], ['med-media','med_media_id'], ['med-doses','dose_id'], ['med-schedules','schedule_id'], ['medication/draft','draft_id'], ['cards','redemption_id'], ['ivr/calls','ivr_call_id'], ['ivr/native/calls','ivr_call_id'], ['ivr/sessions','ivr_session_id'], ['ivr/media','ivr_media_id'], ['draw','draw_id'], ['gift','gift_id'], ['content','content_id'], ['feed','feed_item_id'], ['notifications','notification_id'], ['alerts','alert_id'], ['chat/notes','chat_note_id']]) if(p.includes(part)) return key;
    return 'resource_id';
  },
  group(r) {
    if (r.group === 'system') return '00. Server health & public pages';
    if (r.group === 'auth') return '01. Authentication';
    if (r.group === 'mobile') {
      if (/\/checkin\//.test(r.path)) return '05. Health check-in & scripts';
      if (/\/chat|\/ai-consent/.test(r.path)) return '04. AI chat & consent';
      if (/caregiver|care-circle/.test(r.path)) return '07. Care Circle';
      if (/\/logs|\/tree|health-score|missions/.test(r.path)) return '03. Health logs, missions & score';
      return '02. Profile, onboarding & guidance';
    }
    const map = { careCircle: '07. Care Circle', carePulse: '08. Care Pulse', wellness: '09. Wellness', healthFeed: '10. Health feed', 'early-signal': '11. Early signals', 'checkin-call': '06. Check-in calls', 'checkin-gifts': '12. Check-in gifts', v21: '13. Medication, coins & rewards', 'doctor-task': '14. Patient consultations', 'doctor-ivr': '15. Doctor IVR', 'doctor-profile': '16. Doctor integration (HMAC)', payment: '17. Payments', subscription: '18. Subscriptions & household', household: '18. Subscriptions & household', iap: '19. In-app purchases', notifications: '20. Notifications', logs: '21. Voice health logs', asinuBrain: '22. Asinu Brain', health: '80. Internal health operations', 'checkin-call.ops': '81. Internal check-in call operations', 'checkin-gifts.ops': '82. Internal gift operations', 'v21.ops': '83. Internal medication & coin operations' };
    return map[r.group] || r.group;
  },
  description: `Bộ API của backend Asinu, sinh trực tiếp từ các router đang mount trong server.js.

Bộ API được chia thành 2 folder: Local API và Production API. Mỗi folder có đầy đủ API theo nhóm chức năng. URL, token, tài khoản và ID được lưu riêng bằng tiền tố local_ hoặc production_.

Bắt đầu: điền local_email/local_password hoặc production_email/production_password trong Variables hoặc environment tương ứng, rồi Send POST /api/auth/email/login trong đúng folder. Token được lưu tự động riêng cho từng môi trường.

Biến ID lấy từ dữ liệu test thật. Các query tùy chọn được để tắt; bật ở Params nếu cần. Cần kiểm tra điều kiện gói dịch vụ, feature flag, quyền Care Circle và AI consent cho các chức năng tương ứng.

Không chạy toàn bộ collection bằng Runner trên production: bộ đầy đủ có API xóa tài khoản, gửi thông báo, thay đổi cấu hình, thanh toán và dịch vụ AI. Dùng collection Asinu — Public smoke checks để kiểm tra kết nối.

Collection và environment không chứa mật khẩu, token, khóa nội bộ hoặc dữ liệu sức khỏe thật. Điền giá trị local trong Postman.`,
  collectionPre: `
pm.variables.set('now_iso', new Date().toISOString());
pm.variables.set('now_ms', String(Date.now()));
pm.variables.set('month', new Date().toISOString().slice(0, 7));
`,
  collectionTest: `
const expected = String(pm.variables.get('expected_status') || '');
pm.test(expected ? 'HTTP status matches expected_status' : 'HTTP response is successful (2xx/3xx)', function () {
  if (expected) pm.expect(pm.response.code).to.eql(Number(expected));
  else { pm.expect(pm.response.code).to.be.at.least(200); pm.expect(pm.response.code).to.be.below(400); }
});
const contentType = pm.response.headers.get('Content-Type') || '';
if (/json/i.test(contentType)) {
  pm.test('Response is valid JSON', function () { pm.response.json(); });
  if (pm.response.code >= 200 && pm.response.code < 300) {
    pm.test('Response does not report ok=false', function () { pm.expect(pm.response.json().ok).not.to.eql(false); });
  }
}
`,
  doctorSignature: `
const secret = pm.variables.get('doctor_integration_secret');
if (!secret) throw new Error('Điền doctor_integration_secret trong environment trước khi gửi API tích hợp bác sĩ.');
const raw = pm.variables.replaceIn(pm.request.body && pm.request.body.raw || '{}');
pm.request.body.update(raw);
const timestamp = String(Math.floor(Date.now() / 1000));
const asinuCrypto = require('crypto-js');
const signature = asinuCrypto.HmacSHA256(timestamp + '.' + raw, secret).toString(asinuCrypto.enc.Hex);
pm.request.headers.upsert({ key: 'x-doctor-timestamp', value: timestamp });
pm.request.headers.upsert({ key: 'x-doctor-signature', value: 'sha256=' + signature });
`,
};
