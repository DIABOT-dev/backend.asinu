'use strict';

const fs = require('fs');
const path = require('path');

const { FLOWS } = require('./logic');

const seedPath = path.join(__dirname, 'seedData.json');

function flowFromEntry(entry) {
  const roles = Array.isArray(entry.target_roles) ? entry.target_roles : [];
  if (entry.content_type === 'warning') return FLOWS.ALERT;
  if (roles.includes('role_family') || roles.includes('role_caregiver')) return FLOWS.FAMILY;
  if (String(entry.id || '').includes('first-7-days')) return FLOWS.ONBOARDING;
  return FLOWS.NURTURE;
}

function topicFromEntry(entry) {
  const id = String(entry.id || '');
  if (id.includes('diet') || id.includes('meal') || id.includes('glucose')) return 'diet';
  if (id.includes('exercise') || id.includes('walk')) return 'exercise';
  if (id.includes('med') || id.includes('medication')) return 'medication';
  if (id.includes('stress') || id.includes('sleep') || id.includes('mental')) return 'mental';
  if (entry.content_type === 'family_note') return 'family';
  return 'general';
}

function normalizeConditions(conditions) {
  if (!Array.isArray(conditions)) return [];
  return conditions.map((value) => String(value));
}

function normalizeEntry(entry, idx) {
  return {
    id: String(entry.id),
    title: entry.title,
    summary: entry.summary || entry.body?.slice(0, 180) || '',
    body: entry.body || entry.summary || '',
    checklist: Array.isArray(entry.checklist) ? entry.checklist : [],
    content_type: entry.content_type || 'article',
    target_conditions: normalizeConditions(entry.target_conditions),
    target_flow: flowFromEntry(entry),
    target_cluster_key: entry.target_tags?.[0] || null,
    topic_category: topicFromEntry(entry),
    flow_step: flowFromEntry(entry) === FLOWS.ONBOARDING ? ((idx % 5) + 1) : null,
    severity_level: entry.severity_level || 'low',
    engagement_score: entry.content_type === 'warning' ? 95 : 60,
    shareable: entry.shareable !== false,
    saveable: entry.saveable !== false,
    status: 'active',
    action_label: entry.cta_label || 'Đọc chi tiết',
    action_target: entry.cta_target || `/feed/${entry.id}`,
  };
}

function generatedEntries() {
  return [
    {
      id: 'onboarding-profile-summary',
      title: 'Hồ sơ sức khỏe đầu tiên của bác có ý nghĩa gì?',
      summary: 'Bản tóm tắt này giúp Asinu cá nhân hóa các hướng dẫn theo bệnh nền và thói quen của bác.',
      body: 'Trong 7 ngày đầu, bác nên xem lại hồ sơ sức khỏe để hiểu vì sao Asinu gợi ý những nội dung nhất định. Hồ sơ càng đầy đủ, bản tin càng sát nhu cầu thực tế.',
      checklist: ['Mở lại hồ sơ sức khỏe', 'Kiểm tra bệnh nền đã khai đúng chưa', 'Nhờ người thân hỗ trợ nếu cần'],
      content_type: 'article',
      target_conditions: [],
      target_flow: FLOWS.ONBOARDING,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: 1,
      severity_level: 'low',
      engagement_score: 70,
      shareable: true,
      saveable: true,
      status: 'active',
      action_label: 'Xem hồ sơ',
      action_target: '/profile',
    },
    {
      id: 'onboarding-three-daily-signals',
      title: '3 tín hiệu nên theo dõi mỗi ngày',
      summary: 'Một vài chỉ số nhỏ mỗi ngày giúp bác phát hiện thay đổi sớm hơn rất nhiều.',
      body: 'Trong tuần đầu, bác nên tập trung vào 3 tín hiệu: năng lượng sau ăn, mức độ đau hoặc tê khó chịu, và việc uống thuốc đúng giờ.',
      checklist: ['Ghi lại cảm giác sau ăn', 'Để ý triệu chứng lặp lại', 'Đánh dấu đã uống thuốc'],
      content_type: 'checklist',
      target_conditions: [],
      target_flow: FLOWS.ONBOARDING,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: 2,
      severity_level: 'low',
      engagement_score: 72,
      shareable: true,
      saveable: true,
      status: 'active',
      action_label: 'Mở check-in',
      action_target: '/checkin',
    },
    {
      id: 'reactivate-high-value-article',
      title: 'Quay lại với một bài hướng dẫn ngắn nhưng hữu ích',
      summary: 'Nếu bác đang bận, chỉ cần đọc nhanh 2 phút bài này để lấy lại nhịp chăm sóc sức khỏe.',
      body: 'Không cần quay lại thật nhiều việc cùng lúc. Chỉ cần đọc một bài ngắn, xem lại triệu chứng gần đây và chọn một việc nhỏ để làm hôm nay.',
      checklist: ['Đọc nhanh bài viết', 'Nhớ lại triệu chứng gần đây', 'Chọn một việc nhỏ để bắt đầu lại'],
      content_type: 'article',
      target_conditions: [],
      target_flow: FLOWS.REACTIVATE,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: null,
      severity_level: 'low',
      engagement_score: 90,
      shareable: false,
      saveable: true,
      status: 'active',
      action_label: 'Bắt đầu lại',
      action_target: '/feed/reactivate-high-value-article',
    },
    {
      id: 'winback-welcome-back-1',
      title: 'Mừng bác quay lại Asinu',
      summary: 'Asinu đã chuẩn bị sẵn một vài gợi ý nhẹ nhàng để bác quay lại nhịp theo dõi sức khỏe.',
      body: 'Nếu đã lâu bác chưa mở lại ứng dụng, không sao cả. Hãy bắt đầu từ việc đọc bản tin này và kiểm tra xem cơ thể mình dạo gần đây thế nào.',
      checklist: ['Đọc lại bản tin', 'Nhớ lại triệu chứng nổi bật', 'Mở check-in khi sẵn sàng'],
      content_type: 'article',
      target_conditions: [],
      target_flow: FLOWS.WINBACK,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: null,
      severity_level: 'low',
      engagement_score: 88,
      shareable: false,
      saveable: true,
      status: 'active',
      action_label: 'Quay lại check-in',
      action_target: '/checkin',
    },
    {
      id: 'winback-welcome-back-2',
      title: 'Khi quay lại, nên bắt đầu từ đâu?',
      summary: 'Bác không cần làm hết mọi thứ. Chỉ cần bắt đầu từ một tín hiệu sức khỏe gần đây nhất.',
      body: 'Nếu bác thấy mệt sau ăn, đau đầu, chóng mặt hoặc quên thuốc gần đây, hãy bắt đầu bằng mục đó. Một bước nhỏ vẫn tốt hơn bỏ trống hoàn toàn.',
      checklist: ['Chọn một tín hiệu gần đây', 'Mở check-in', 'Lưu lại bài này nếu cần'],
      content_type: 'article',
      target_conditions: [],
      target_flow: FLOWS.WINBACK,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: null,
      severity_level: 'low',
      engagement_score: 87,
      shareable: false,
      saveable: true,
      status: 'active',
      action_label: 'Chọn một việc nhỏ',
      action_target: '/checkin',
    },
    {
      id: 'winback-welcome-back-3',
      title: 'Một lần cập nhật ngắn cũng có giá trị',
      summary: 'Chỉ cần một lần cập nhật ngắn hôm nay là đủ để Asinu gợi ý đúng hơn cho bác ngày mai.',
      body: 'Hệ thống không cần bác hoàn hảo. Chỉ cần bác quay lại với một lần đo, một lần ghi triệu chứng hoặc một lần check-in ngắn.',
      checklist: ['Đo một chỉ số', 'Ghi một triệu chứng', 'Check-in ngắn trong hôm nay'],
      content_type: 'checklist',
      target_conditions: [],
      target_flow: FLOWS.WINBACK,
      target_cluster_key: null,
      topic_category: 'general',
      flow_step: null,
      severity_level: 'low',
      engagement_score: 86,
      shareable: false,
      saveable: true,
      status: 'active',
      action_label: 'Cập nhật ngay',
      action_target: '/checkin',
    },
  ];
}

async function upsertContent(client, entry) {
  await client.query(
    `INSERT INTO health_feed_content_items (
       id, title, summary, body, checklist, content_type, target_conditions,
       target_flow, target_cluster_key, topic_category, flow_step,
       severity_level, engagement_score, shareable, saveable, status,
       action_label, action_target, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       body = EXCLUDED.body,
       checklist = EXCLUDED.checklist,
       content_type = EXCLUDED.content_type,
       target_conditions = EXCLUDED.target_conditions,
       target_flow = EXCLUDED.target_flow,
       target_cluster_key = EXCLUDED.target_cluster_key,
       topic_category = EXCLUDED.topic_category,
       flow_step = EXCLUDED.flow_step,
       severity_level = EXCLUDED.severity_level,
       engagement_score = EXCLUDED.engagement_score,
       shareable = EXCLUDED.shareable,
       saveable = EXCLUDED.saveable,
       status = EXCLUDED.status,
       action_label = EXCLUDED.action_label,
       action_target = EXCLUDED.action_target,
       updated_at = NOW()`,
    [
      entry.id,
      entry.title,
      entry.summary,
      entry.body,
      JSON.stringify(entry.checklist || []),
      entry.content_type,
      JSON.stringify(entry.target_conditions || []),
      entry.target_flow,
      entry.target_cluster_key,
      entry.topic_category,
      entry.flow_step,
      entry.severity_level,
      entry.engagement_score,
      entry.shareable,
      entry.saveable,
      entry.status,
      entry.action_label,
      entry.action_target,
    ]
  );
}

async function seedNotificationTemplates(client) {
  const templates = [
    ['health_feed_alert', FLOWS.ALERT, 'Asinu thấy có điều cần bác lưu ý', 'Có một cảnh báo nhẹ nhàng mới trong bản tin sức khỏe của bác'],
    ['health_feed_family', FLOWS.FAMILY, 'Asinu có gợi ý chăm sóc người thân', 'Có một bản tin mới để bác hỏi thăm người thân cụ thể hơn'],
    ['health_feed_onboarding', FLOWS.ONBOARDING, 'Asinu chuẩn bị sẵn một hướng dẫn mới', 'Có một bản tin sức khỏe mới phù hợp với giai đoạn hiện tại của bác'],
  ];

  for (const [id, flow, title, body] of templates) {
    await client.query(
      `INSERT INTO health_feed_notification_templates(id, target_flow, title_template, body_template, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (id) DO UPDATE SET
         target_flow = EXCLUDED.target_flow,
         title_template = EXCLUDED.title_template,
         body_template = EXCLUDED.body_template,
         updated_at = NOW()`,
      [id, flow, title, body]
    );
  }
}

async function seedHealthFeed(client) {
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const items = (raw.content_items || []).map(normalizeEntry);
  const extras = generatedEntries();
  const finalItems = [...items, ...extras];

  for (const item of finalItems) {
    await upsertContent(client, item);
  }
  await seedNotificationTemplates(client);
  return { contentCount: finalItems.length, templateCount: 3 };
}

module.exports = { seedHealthFeed };
