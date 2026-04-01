const TZ = 'Asia/Ho_Chi_Minh';

const TYPE_PRIORITY = {
  emergency:                  'critical',
  checkin_followup_urgent:    'critical',
  health_alert:               'high',
  caregiver_alert:            'high',
  checkin_followup:           'high',
  morning_checkin:            'medium',
  care_circle_invitation:     'medium',
  care_circle_accepted:       'medium',
  reminder_glucose:           'medium',
  reminder_bp:                'medium',
  reminder_medication:        'medium',
  reminder_afternoon:         'low',
  reminder_morning:           'low',
  evening_checkin:            'low',
  caregiver_confirmed:        'low',
  milestone:                  'low',
  streak_start:               'low',
  streak_milestone:           'low',
  weekly_recap:               'low',
  engagement:                 'low',
};

const SEVERITY_COLORS = {
  low: '#16a34a',
  medium: '#f59e0b',
  high: '#dc2626',
};

// NOTIF_MAP — dùng cho dev test push. Mỗi type có title + body mẫu với emoji.
const NOTIF_MAP = {
  // ── Nhắc nhở sức khoẻ ──────────────────────────────────────────
  // NOTE: Các message dưới đây là mẫu dev test (profile 68M). Production dùng i18n t() cá nhân hoá.
  reminder_log_morning:       { title: '☀️ Cháu cùng chú bắt đầu ngày mới', body: 'Chào buổi sáng! 🌿 Ghi lại chỉ số sức khỏe để cháu theo dõi cùng chú nhé.' },
  reminder_log_evening:       { title: '🌙 Trước khi nghỉ — cháu nhắc nhẹ', body: 'Sắp nghỉ rồi! Ghi thêm số liệu để cháu nắm tình hình cùng chú nha 💙' },
  reminder_afternoon:         { title: '⛅ Cháu ghé thăm buổi chiều',      body: 'Buổi chiều rồi! 💙 Chú thấy thế nào? Cập nhật cho cháu biết nhé.' },
  reminder_morning:           { title: '🌅 Cháu ở đây cùng chú',           body: 'Sáng tốt lành! ☀️ Cháu cùng chú theo dõi sức khoẻ hôm nay nhé.' },
  reminder_water:             { title: '💧 Cháu nhắc chú uống nước nè',    body: 'Uống ly nước đi chú ơi! 💧 Cháu muốn chú luôn đủ nước nhé.' },
  reminder_glucose:           { title: '🩸 Đến giờ đo đường huyết',        body: 'Đo xong nhớ ghi kết quả vào app để theo dõi chính xác hơn 🩸' },
  reminder_bp:                { title: '💓 Đến giờ đo huyết áp',           body: 'Đo xong nhớ ghi kết quả vào app để Asinu theo dõi cùng 💓' },
  reminder_medication_morning:{ title: '💊 Uống thuốc buổi sáng',          body: 'Uống thuốc sáng đúng giờ nhé! 💊 Uống đều đặn là chìa khóa sức khỏe tốt.' },
  reminder_medication_evening:{ title: '🌙💊 Uống thuốc buổi tối',         body: 'Trước khi ngủ, nhớ uống thuốc tối nhé! 💊 Đừng bỏ liều nào bạn ơi.' },
  reminder_medication:        { title: '💊 Nhắc uống thuốc',               body: 'Đến giờ uống thuốc rồi! 💊 Uống đúng liều, đúng giờ nhé.' },

  // ── Check-in ────────────────────────────────────────────────────
  // NOTE: NOTIF_MAP chỉ dùng cho dev test push. Production dùng i18n t() với xưng hô cá nhân hoá.
  morning_checkin:            { title: '☀️ Cháu ghé hỏi thăm buổi sáng',   body: 'Chào buổi sáng! 🌿 Hôm nay chú thấy thế nào? Cháu luôn ở đây cùng chú.' },
  evening_checkin:            { title: '🌙 Cháu ghé hỏi thăm buổi tối',    body: 'Tối rồi! Một ngày dài của chú thế nào? Cháu ở đây nghe chú kể 💙' },
  checkin_followup:           { title: '💙 Cháu vẫn ở đây — chú khoẻ hơn chưa?', body: '🌿 Cháu vẫn nhớ lúc nãy chú hơi mệt. Giờ đỡ hơn chưa? Cho cháu biết nhé.' },
  checkin_followup_urgent:    { title: '💙 Cháu vẫn đang ở đây nè',        body: 'Chú ơi, cháu lo quá. Cho cháu biết chú thế nào nhé — cháu đang theo dõi cùng chú 💙' },

  // ── Cảnh báo / khẩn cấp ────────────────────────────────────────
  emergency:                  { title: '🚨 Khẩn cấp — Cần giúp đỡ ngay!',  body: '🚨 Người thân của bạn đang cần hỗ trợ khẩn cấp. Kiểm tra ngay!' },
  health_alert:               { title: '⚠️ Cảnh báo sức khoẻ',             body: 'Phát hiện chỉ số bất thường. Hãy kiểm tra và cập nhật tình trạng nhé.' },
  caregiver_alert:            { title: '⚠️ Cần quan tâm người thân',        body: 'Người thân của bạn đang cần sự quan tâm. Vui lòng liên lạc kiểm tra.' },
  caregiver_confirmed:        { title: '✅ Người thân đã phản hồi',         body: '💙 Người thân đã nhận thông báo và đang hỗ trợ bạn rồi.' },

  // ── Care Circle ─────────────────────────────────────────────────
  care_circle_invitation:     { title: '🤝 Lời mời Care Circle',            body: 'Có người muốn kết nối với bạn trong Care Circle — cùng chăm sóc nhau nhé!' },
  care_circle_accepted:       { title: '✅ Lời mời được chấp nhận',         body: '🎉 Thành viên mới đã tham gia nhóm chăm sóc của bạn!' },

  // ── Streak / thành tích ─────────────────────────────────────────
  streak_7:                   { title: '🔥 Chuỗi 7 ngày liên tục!',        body: '🔥 Tuyệt vời! Bạn đã log 7 ngày liên tục — thói quen tốt đang hình thành rồi!' },
  streak_14:                  { title: '🔥🔥 Chuỗi 14 ngày liên tục!',     body: '🔥🔥 Rất tốt! 14 ngày không bỏ lỡ — bạn đang trên đà tuyệt vời đó!' },
  streak_30:                  { title: '🏆 Chuỗi 30 ngày liên tục!',       body: '🏆 Xuất sắc! 30 ngày liên tục — bạn đã xây dựng thói quen sức khỏe đáng nể!' },
  streak_start:               { title: '✨ Bắt đầu chuỗi mới!',            body: '✨ Ngày đầu tiên của chuỗi mới! Cùng giữ thói quen mỗi ngày nhé 💪' },
  streak_milestone:           { title: '🏅 Mốc streak mới!',               body: '🏅 Bạn vừa đạt một mốc streak mới. Tuyệt vời lắm, tiếp tục nhé!' },
  milestone:                  { title: '🎯 Đạt mục tiêu!',                 body: '🎉 Bạn vừa hoàn thành một mục tiêu sức khỏe. Tự hào lắm!' },

  // ── Tổng kết / gắn kết ─────────────────────────────────────────
  weekly_recap:               { title: '📊 Tổng kết tuần',                 body: '📊 Xem lại hành trình sức khoẻ tuần này của bạn nhé!' },
  engagement:                 { title: '💙 Asinu nhớ bạn!',                body: 'Lâu rồi chưa gặp! 🌿 Sức khoẻ bạn dạo này thế nào rồi?' },
};

module.exports = { TZ, TYPE_PRIORITY, SEVERITY_COLORS, NOTIF_MAP };
