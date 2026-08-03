# Asinu - Notification copy hiện tại

Tài liệu này ghi lại các notification đang được backend tạo và nội dung tiếng
Việt hiện tại. Điều kiện gửi và logic không nằm trong tài liệu này.

Các biến trong dấu `{...}` được thay bằng dữ liệu thực tế.

## Nguyên tắc văn phong

- Ngắn, rõ việc, ưu tiên dữ liệu và hành động.
- Thân thiện nhưng trung tính; không nhân cách hóa Asinu như người thân.
- Reminder hằng ngày gần như không dùng cảm xúc hoặc emoji.
- Cảnh báo sức khỏe dùng câu trực tiếp, nêu rõ việc nên làm.
- Tiêu đề ngắn; nội dung thường gồm một hoặc hai câu.

## 1. Notification hằng ngày

### `morning_checkin` - 07:00

Gửi khi người dùng chưa check-in trong ngày.

> **Tiêu đề:** ☀️ Cập nhật sức khỏe buổi sáng
>
> **Nội dung:** Hôm nay chưa có dữ liệu sức khỏe. Cập nhật trong khoảng 1 phút.

### `reminder_morning_summary` - mặc định 08:00

Gộp các việc còn thiếu trong ngày: đo đường huyết, đo huyết áp, ghi chỉ số
hoặc ghi nhận thuốc.

> **Tiêu đề:** ☀️ Cập nhật sức khỏe buổi sáng

Mẫu nội dung theo tình trạng gần đây:

- Triệu chứng đang nặng hơn:

  > Triệu chứng {symptom} đang nặng hơn. Hãy cập nhật check-in hôm nay để theo dõi tình trạng.

- Triệu chứng ổn định:

  > Triệu chứng {symptom} vẫn còn được ghi nhận. Cập nhật check-in để theo dõi thay đổi.

- Triệu chứng đang giảm:

  > Triệu chứng {symptom} đang giảm. Ghi thêm check-in hôm nay để theo dõi tiếp.

- Ghi nhận mệt mỏi liên tiếp:

  > {tiredDays} ngày liên tiếp bạn ghi nhận mệt mỏi. Cập nhật hôm nay để theo dõi thêm.

- Sức khỏe ổn định nhiều ngày:

  > Bạn đã ghi nhận sức khỏe ổn định {streakDays} ngày liên tiếp. Tiếp tục cập nhật đều đặn.

- Lần gần nhất có triệu chứng nặng:

  > Lần trước bạn ghi nhận triệu chứng nặng. Hãy cập nhật tình trạng hôm nay để theo dõi tiếp.

- Trường hợp mặc định:

  > Hôm nay chưa có dữ liệu sức khỏe. Cập nhật trong khoảng 1 phút để theo dõi chính xác hơn.

Sau mẫu trên, hệ thống thêm phần việc còn thiếu:

> Còn thiếu: đo đường huyết, đo huyết áp, uống thuốc.

### `reminder_afternoon` - mặc định 14:00

> **Tiêu đề:** 🌤️ Cập nhật sức khỏe buổi chiều

- Khi có triệu chứng:

  > Triệu chứng {symptom} chiều nay thế nào? Nghỉ vài phút và uống nước nếu cần.

- Khi không có triệu chứng cần nhắc:

  > Dành vài phút nghỉ ngơi và uống nước trước khi tiếp tục ngày của bạn.

Với hồ sơ có tiểu đường, nội dung có thể nhắc thêm đo đường huyết. Với hồ sơ
có cao huyết áp, nội dung có thể nhắc thêm đo huyết áp.

### `reminder_evening_summary` - mặc định 21:00

Gửi khi còn thiếu log buổi tối hoặc chưa ghi nhận thuốc tối.

> **Tiêu đề:** 🌙 Cập nhật sức khỏe buổi tối

- Khi có triệu chứng:

  > Triệu chứng {symptom} hôm nay thế nào? Trước khi nghỉ, hãy hoàn tất: {tasks}.

- Khi tình trạng đang cải thiện:

  > Tình trạng hôm nay đã tốt hơn. Trước khi nghỉ, hãy hoàn tất: {tasks}.

- Trường hợp mặc định:

  > Còn thiếu trước khi nghỉ: {tasks}. Hoàn tất để dữ liệu hôm nay đầy đủ.

`{tasks}` có thể gồm `uống thuốc tối` và `ghi chỉ số sức khỏe`.

### `reengagement` - khoảng 09:00

Chỉ áp dụng cho người đã từng check-in nhưng không quay lại. Loại này chỉ lưu
trong app, không gửi push.

> **Tiêu đề:** Cập nhật sức khỏe

- Không hoạt động 1-2 ngày, không có triệu chứng:

  > Hôm nay chưa có cập nhật sức khỏe. Mở app để ghi lại tình trạng hiện tại.

- Không hoạt động 1-2 ngày, có triệu chứng:

  > Triệu chứng {symptom} đã được ghi nhận lần trước. Nếu vẫn còn, hãy cập nhật hôm nay.

- Không hoạt động 3-4 ngày, có triệu chứng:

  > Bạn chưa cập nhật vài ngày. Nếu {symptom} vẫn còn, hãy theo dõi thêm hoặc đi khám nếu nặng hơn.

- Không hoạt động 3-4 ngày, từng có triệu chứng nặng:

  > Lần trước bạn ghi nhận triệu chứng nặng. Nếu chưa đỡ, nên liên hệ cơ sở y tế.

- Không hoạt động 3-4 ngày, không có triệu chứng:

  > Đã {days} ngày chưa có cập nhật sức khỏe. Ghi lại tình trạng hiện tại khi thuận tiện.

- Không hoạt động 5-7 ngày, có triệu chứng:

  > Đã {days} ngày từ lần cập nhật gần nhất. Nếu {symptom} còn kéo dài, nên đi khám.

- Không hoạt động 5-7 ngày, không có triệu chứng:

  > Đã {days} ngày chưa có cập nhật. Mở app để ghi lại tình trạng hôm nay.

- Không hoạt động từ 8 ngày:

  > Đã {days} ngày chưa có cập nhật sức khỏe. Nếu bạn đang không ổn, hãy liên hệ người thân hoặc cơ sở y tế.

### `engagement` - khi được gọi cho người dùng không mở app

Luồng này dùng dữ liệu hoạt động để tạo một lời nhắc ngắn. Nội dung phải theo
cùng quy tắc: nêu dữ liệu còn thiếu hoặc lý do cập nhật, không dùng câu cảm xúc,
không nhân cách hóa Asinu và không quá 120 ký tự khi có thể.

Tiêu đề mặc định:

> Cập nhật sức khỏe

Ví dụ nội dung hợp lệ:

> Hôm nay chưa có dữ liệu sức khỏe. Mở app để cập nhật trong khoảng 1 phút.

## 2. Thành tích và tổng kết

### `streak_7`, `streak_14`, `streak_30`

Gửi khi người dùng ghi log liên tục đủ 7, 14 hoặc 30 ngày.

> **Tiêu đề:** Ghi log: {streak} ngày
>
> **Nội dung:** Bạn đã ghi log sức khỏe {streak} ngày liên tiếp. Tiếp tục duy trì thói quen này.

### `weekly_recap` - Chủ nhật khoảng 20:00

> **Tiêu đề:** Tổng kết sức khỏe tuần

- 7/7 ngày:

  > Bạn đã ghi log đủ 7/7 ngày. Dữ liệu tuần này đã đầy đủ.

- 5-6/7 ngày:

  > Bạn đã ghi log {days}/7 ngày. Thêm vài lần cập nhật để theo dõi đều hơn tuần tới.

- 3-4/7 ngày:

  > Bạn đã ghi log {days}/7 ngày. Cập nhật đều hơn sẽ giúp theo dõi xu hướng rõ hơn.

- 0-2/7 ngày:

  > Tuần này có {days}/7 ngày được ghi nhận. Bạn có thể bắt đầu cập nhật từ hôm nay.

### `weekly_wellness_summary` - Chủ nhật

Chỉ lưu trong app khi người dùng có ít nhất một log trong 7 ngày gần nhất.

> **Tiêu đề:** Báo cáo sức khỏe tuần
>
> **Nội dung:** Tuần này bạn đã ghi log {count} lần. Mở báo cáo để xem chi tiết.

## 3. Premium, tài khoản và thanh toán

| Type | Tiêu đề | Nội dung |
|---|---|---|
| `subscription_activated` | Premium đã được kích hoạt | Gói Premium có hiệu lực đến {date}. |
| `subscription_expiring_soon` | Premium sắp hết hạn | Gói Premium còn {days} ngày. Gia hạn để tiếp tục sử dụng đầy đủ tính năng. |
| `subscription_expired` | Premium đã hết hạn | Gói Premium đã hết hạn. Tài khoản hiện ở gói miễn phí. |
| `profile_incomplete` | Hoàn thiện hồ sơ | Hồ sơ còn thiếu thông tin. Cập nhật để nhận theo dõi phù hợp hơn. |
| `payment_failed` | Thanh toán chưa hoàn tất | Giao dịch {amount}đ chưa thành công. Kiểm tra lại phương thức thanh toán. |
| `wallet_topup_success` | Nạp tiền thành công | {amount}đ đã được cộng vào ví. Số dư hiện tại: {balance}đ. |
| `wallet_low_balance` | Số dư ví sắp hết | Số dư ví còn {balance}đ. Nạp thêm để tiếp tục sử dụng dịch vụ. |
| `subscription_gift_confirmed` | Đã tặng Premium | Premium đã được tặng cho {name} đến {date}. |

`profile_incomplete`, `wallet_topup_success` và `wallet_low_balance` chỉ hiển
thị trong app, không gửi push.

## 4. Care Circle

| Type | Tiêu đề | Nội dung |
|---|---|---|
| `care_circle_invitation` | Lời mời Care Circle | {name} muốn kết nối với bạn trong Care Circle. |
| `care_circle_accepted` | Đã kết nối Care Circle | {name} đã chấp nhận lời mời kết nối. |
| `care_circle_rejected` | Lời mời bị từ chối | {name} đã từ chối lời mời kết nối. |
| `care_circle_removed` | Kết nối đã bị hủy | {name} đã hủy kết nối Care Circle. |
| `care_circle_permission_changed` | Quyền Care Circle thay đổi | {name} đã cập nhật quyền truy cập của bạn. |

`care_circle_permission_changed` chỉ lưu trong app.

## 5. Check-in và cảnh báo sức khỏe

### `checkin_followup`

Gửi khi người dùng chưa hoàn tất phiên check-in.

> **Tiêu đề:** Cập nhật check-in
>
> **Nội dung bình thường:** Bạn chưa hoàn tất check-in. Cập nhật tình trạng hiện tại khi có thể.
>
> **Nội dung cảnh báo cao:** Bạn chưa hoàn tất check-in mức cảnh báo. Cập nhật ngay nếu vẫn không khỏe.

### `checkin_followup_urgent`

> **Tiêu đề:** Chưa nhận được cập nhật
>
> **Nội dung:** Bạn đã báo không khỏe trước đó nhưng chưa hoàn tất check-in. Cập nhật tình trạng hiện tại.

### `caregiver_alert`

Gửi cho người thân khi cần kiểm tra người dùng hoặc người dùng không phản hồi.

> **Tiêu đề:** Cần kiểm tra sức khỏe
>
> **Nội dung mặc định:** {name} chưa phản hồi sau khi báo không khỏe. Vui lòng liên hệ kiểm tra.

Nếu phiên có kết luận riêng, kết luận đó có thể được dùng làm nội dung thay cho
mẫu mặc định.

### `emergency`

> **Tiêu đề:** Cần hỗ trợ khẩn cấp
>
> **Nội dung:** {name} cần hỗ trợ khẩn cấp{location}. Vui lòng kiểm tra ngay.

### Nhắc lại cảnh báo cho người thân

> **Cảnh báo khẩn cấp:** Nhắc lại: cảnh báo khẩn cấp
>
> **Cần kiểm tra:** Nhắc lại: cần kiểm tra
>
> **Nội dung:** {name} vẫn cần hỗ trợ. Vui lòng xác nhận sau khi đã liên hệ.

### `caregiver_confirmed`

> {name} đã nhận thông báo và {action}.

`{action}` có thể là “đang trên đường đến”, “đã gọi điện” hoặc “đã xem thông
báo”.

### `health_alert`

Gửi khi triệu chứng có mức độ cao hoặc có xu hướng nặng hơn.

> **Tiêu đề:** Cần chú ý sức khỏe
>
> **Mức độ cao:** 🚨 Triệu chứng {symptom} có mức độ nặng. Bạn nên đi khám để được kiểm tra.
>
> **Xu hướng nặng hơn:** Triệu chứng {symptom} có xu hướng nặng hơn. Nếu chưa đỡ, bạn nên đi khám.

### Thông báo cho người dùng sau khi đã báo người thân

> **Tiêu đề:** Đã báo người thân
>
> **Nội dung:** Người thân đã nhận thông tin về tình trạng của bạn.

## 6. Key reminder còn để tương thích

Các key sau vẫn còn trong locale nhưng hiện không chạy như job độc lập:

- `reminder_log_morning`
- `reminder_log_evening`
- `reminder_water`
- `reminder_glucose`
- `reminder_bp`
- `reminder_medication_morning`
- `reminder_medication_evening`

Nhắc đường huyết, huyết áp, thuốc và ghi chỉ số hiện được gộp vào
`reminder_morning_summary` hoặc `reminder_evening_summary` tùy dữ liệu còn
thiếu.

## 7. Ghi chú kỹ thuật

- Nội dung tiếng Anh nằm trong cùng các template/i18n tương ứng.
- Luồng `engagement` có bản tiếng Anh tương ứng và chịu cùng giới hạn độ dài.
- Scheduler dùng múi giờ `Asia/Ho_Chi_Minh`.
- Reminder định kỳ chỉ xử lý người dùng đã hoàn tất onboarding, bật reminder
  và có push token.
- Các reminder cùng người dùng cách nhau tối thiểu 5 phút.
- Trong khung giờ yên tĩnh `22:00-05:00`, hệ thống chỉ xử lý follow-up
  check-in và cảnh báo cần phản hồi.
