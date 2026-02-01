# Tổng hợp Logic Hệ thống Sức Khỏe

## 1. CÂY SỨC KHỎE (Health Tree)
**File:** [tree.controller.js](../src/controllers/tree.controller.js)

### Logic tính điểm (Score)
```javascript
Score = (logScore * 50%) + (missionScore * 50%)
```

**Log Score (50%):**
- Tính từ số logs 7 ngày gần nhất
- Tối đa: 14 logs/tuần (2 logs/ngày)
- Công thức: `min(logCount / 14, 1) * 0.5`

**Mission Score (50%):**
- Tính từ số missions hoàn thành tuần này
- Công thức: `(completedCount / totalMissions) * 0.5`
- Nếu không có missions: default = 0.25

### Streak Days (Chuỗi ngày liên tục)
- Kiểm tra 30 ngày gần nhất
- Đếm số ngày liên tiếp có activity (logs)
- Break streak nếu thiếu 1 ngày

### API Response
```json
{
  "ok": true,
  "score": 0.75,           // 0-1.0
  "streakDays": 5,          // Số ngày liên tục
  "completedThisWeek": 3,   // Missions hoàn thành tuần này
  "totalMissions": 12       // Tổng missions
}
```

---

## 2. BIỂU ĐỒ CHỈ SỐ SỨC KHỎE (Health Chart)
**File:** [tree.controller.js](../src/controllers/tree.controller.js) - `getTreeHistory()`

### Logic tính value cho biểu đồ
```javascript
value = min(logCount * 25, 100)
```

- Mỗi log = 25 điểm
- Tối đa: 100 điểm/ngày (4 logs)
- Tự động map 0-100 cho chart

### Dữ liệu 7 ngày
```json
[
  { "label": "T2", "value": 75 },
  { "label": "T3", "value": 100 },
  { "label": "T4", "value": 50 },
  { "label": "T5", "value": 100 },
  { "label": "T6", "value": 75 },
  { "label": "T7", "value": 25 },
  { "label": "CN", "value": 0 }
]
```

**Nhãn ngày:**
- CN, T2, T3, T4, T5, T6, T7
- Hiển thị 7 ngày gần nhất

---

## 3. WELLNESS MONITORING
**File:** [wellness.monitoring.service.js](../src/services/wellness.monitoring.service.js)

### Điểm Wellness (0-100)
**Công thức tổng:**
```javascript
Wellness Score = 
  (Consistency * 25%) +    // Tính đều đặn
  (Mood * 30%) +           // Tâm trạng
  (Engagement * 20%) +     // Tương tác
  (Health Data * 25%)      // Dữ liệu sức khỏe
```

### Phân loại trạng thái
| Score | Status | Ý nghĩa |
|-------|--------|---------|
| ≥80 | OK | Tốt |
| 60-79 | MONITOR | Theo dõi |
| 40-59 | CONCERN | Cần quan tâm |
| <40 | DANGER | Nguy hiểm |

### Mood Values
```javascript
{
  'OK': 100,
  'NORMAL': 80,
  'TIRED': 50,
  'NOT_OK': 20,
  'EMERGENCY': 0
}
```

### Alert System
**Điều kiện gửi alert:**
1. Status = DANGER + alert_on_danger = true
2. Không response sau N lần prompt (default: 3)
3. Cooldown: 24 giờ giữa các alert

**Prompt Settings:**
- Cooldown: 120 phút
- Max prompts/ngày: 4

---

## 4. MISSIONS (Nhiệm vụ)
**Files:** 
- [missions.service.js](../src/services/missions.service.js)
- [015_mission_history.sql](../db/migrations/015_mission_history.sql)

### Reset Logic
**Tự động reset mỗi ngày mới:**
```sql
UPDATE user_missions
SET progress = 0, status = 'active'
WHERE last_incremented_date < CURRENT_DATE
```

### History Tracking
**Bảng `mission_history`:**
- Tự động lưu khi mission completed (trigger)
- Lưu vĩnh viễn cho thống kê
- Index: user_id + completed_date

**Trigger:**
```sql
CREATE TRIGGER trigger_save_completed_mission
  AFTER INSERT OR UPDATE ON user_missions
  FOR EACH ROW
  EXECUTE FUNCTION save_completed_mission_to_history();
```

### API Endpoints
1. `GET /api/mobile/missions` - Missions hiện tại
2. `GET /api/mobile/missions/history?days=30` - Lịch sử
3. `GET /api/mobile/missions/stats` - Thống kê

---

## 5. CARE CIRCLE (Vòng kết nối)
**File:** [invite.tsx](../../p0100-asinu/app/(tabs)/care-circle/invite.tsx)

### Mối quan hệ (Relationship Options)
1. **Gia đình gần:**
   - Vợ / Chồng
   - Con trai / Con gái
   - Mẹ / Bố
   
2. **Anh chị em:**
   - Anh trai / Chị gái
   - Em trai / Em gái
   
3. **Ông bà:**
   - Ông nội / Bà nội
   - Ông ngoại / Bà ngoại
   
4. **Khác:**
   - Bạn thân
   - Người yêu

### Vai trò (Role Options)
1. **Y tế:**
   - Bác sĩ gia đình
   - Y tá
   - Dược sĩ
   - Tư vấn tâm lý
   
2. **Chăm sóc:**
   - Người chăm sóc chính
   - Người hỗ trợ
   - Người giúp việc
   
3. **Chuyên môn:**
   - Chuyên gia dinh dưỡng
   - Huấn luyện viên
   
4. **Khác:**
   - Thân nhân

### Quyền truy cập (Permissions)
1. **can_view_logs:** Xem nhật ký sức khỏe
2. **can_receive_alerts:** Nhận cảnh báo
3. **can_ack_escalation:** Xác nhận & xử lý cảnh báo

---

## KẾT LUẬN

### ✅ Logic đã chuẩn:
1. **Cây sức khỏe:** Tính score từ logs + missions
2. **Biểu đồ:** 7 ngày, mỗi log = 25 điểm
3. **Missions:** Auto reset mỗi ngày, có lịch sử
4. **Wellness:** 4 factors, phân loại 4 levels
5. **Care Circle:** Dropdown cho relationship + role

### 📊 Metrics quan trọng:
- **Score:** 0-1.0 (tree), 0-100 (wellness)
- **Streak:** Số ngày liên tục
- **Logs:** 2/ngày = tốt (14/tuần)
- **Missions:** Reset mỗi ngày 00:00

### 🔔 Alert System:
- Wellness < 40 → DANGER
- No response 3 lần → Alert người thân
- Cooldown: 24h giữa alerts
