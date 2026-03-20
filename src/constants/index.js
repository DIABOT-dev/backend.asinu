const TZ = 'Asia/Ho_Chi_Minh';

const TYPE_PRIORITY = {
  emergency: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  checkin_followup_urgent: 'critical',
  morning_checkin: 'medium',
  care_circle_invitation: 'medium',
  reminder_glucose: 'medium',
  reminder_bp: 'medium',
  evening_checkin: 'low',
  milestone: 'low',
};

const SEVERITY_COLORS = {
  low: '#16a34a',
  medium: '#f59e0b',
  high: '#dc2626',
};

const NOTIF_MAP = {
  reminder_log_morning:      { title: 'Nhắc nhở buổi sáng',           body: 'Đã đến giờ ghi chỉ số sức khoẻ buổi sáng.' },
  reminder_log_evening:      { title: 'Nhắc nhở buổi tối',            body: 'Đừng quên ghi chỉ số sức khoẻ trước khi ngủ nhé.' },
  reminder_water:            { title: 'Uống nước nào!',               body: 'Đã đến giờ uống nước. Hãy giữ cơ thể luôn đủ nước nhé.' },
  reminder_glucose:          { title: 'Đo đường huyết',               body: 'Đã đến giờ kiểm tra đường huyết.' },
  reminder_bp:               { title: 'Đo huyết áp',                  body: 'Đã đến giờ kiểm tra huyết áp.' },
  reminder_medication_morning:{ title: 'Uống thuốc buổi sáng',        body: 'Nhớ uống thuốc đúng giờ nhé.' },
  reminder_medication_evening:{ title: 'Uống thuốc buổi tối',         body: 'Đừng quên uống thuốc tối nhé.' },
  weekly_recap:              { title: 'Tổng kết tuần',                body: 'Tuần này bạn đã ghi 15 lần log. Rất tuyệt!' },
  engagement:                { title: 'Asinu nhớ bạn!',               body: 'Lâu rồi chưa check-in. Sức khoẻ bạn thế nào?' },
  streak_7:                  { title: 'Chuỗi 7 ngày!',               body: 'Bạn đã log liên tục 7 ngày. Tiếp tục phát huy!' },
  streak_14:                 { title: 'Chuỗi 14 ngày!',              body: 'Tuyệt vời! 14 ngày liên tục.' },
  streak_30:                 { title: 'Chuỗi 30 ngày!',              body: 'Phi thường! 1 tháng liên tục ghi log!' },
  morning_checkin:           { title: 'Check-in sức khoẻ',            body: 'Chào buổi sáng! Hôm nay bạn thấy thế nào?' },
  checkin_followup:          { title: 'Cập nhật sức khoẻ',            body: 'Asinu muốn hỏi thăm tình trạng của bạn.' },
  checkin_followup_urgent:   { title: 'Cần cập nhật',                body: 'Bạn chưa phản hồi. Tình trạng hiện tại thế nào?' },
  emergency:                 { title: 'Khẩn cấp!',                  body: 'Người thân của bạn cần hỗ trợ ngay!' },
  care_circle_invitation:    { title: 'Lời mời Care Circle',          body: 'Nguyễn Văn A đã mời bạn vào nhóm chăm sóc.' },
  care_circle_accepted:      { title: 'Đã chấp nhận',                body: 'Nguyễn Văn B đã tham gia nhóm chăm sóc của bạn.' },
  caregiver_alert:           { title: 'Cảnh báo người thân',         body: 'Người thân của bạn đang cần sự quan tâm.' },
  health_alert:              { title: 'Cảnh báo sức khoẻ',            body: 'Chỉ số đường huyết bất thường được phát hiện.' },
};

module.exports = { TZ, TYPE_PRIORITY, SEVERITY_COLORS, NOTIF_MAP };
