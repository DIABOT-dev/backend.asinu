# Kiểm thử xuyên suốt Doctor IVR — 27/10/2026

Lượt chạy mới bắt đầu 22:22:30 giờ Việt Nam. **20 kiểm tra qua**, không có lỗi JavaScript trong lượt trình duyệt. Dữ liệu/ca thử nằm trong schema PostgreSQL riêng và đã dọn sau khi kết thúc.

## Những gì đã chạy thật

- Hai backend HTTP dùng route/controller/service hiện tại, JWT/session middleware và cầu nối HMAC thật.
- `DoctorIvrPanel` và `DoctorInterviewScreen` từ mã nguồn hiện tại chạy trên trình duyệt. Thành phần native có adapter; không gọi màn này là bản iOS thật.
- AI tạo bộ câu hỏi, TTS, STT và tổng hợp báo cáo gọi provider đang cấu hình thật, với tình huống bệnh nhân hư cấu và đồng ý AI trong fixture.
- Chặn gửi thông báo ra ngoài: thông báo lưu trong bảng fixture để kiểm tra nội dung/sự kiện. Không gửi push cho tài khoản thật.
- Micro dùng file giọng tổng hợp thử nghiệm. Hai bản gốc được upload, lấy lại qua URL ký và chuyển thành chữ; không dùng giọng người bệnh.

## Kết quả

| Nhóm | Bằng chứng quan sát |
| --- | --- |
| Tạo và duyệt | AI tạo bộ hợp lệ trong khoảng 4,4 giây tính từ thao tác UI; nháp rỗng không duyệt được, sửa/lưu nháp rồi duyệt tạo phiên bất biến mới. |
| Lời mời | Có thông báo trong fixture; bệnh nhân mở lời mời, đặt nhắc sau 15 phút rồi bắt đầu trả lời. |
| Lựa chọn | Đáp án bấm được khi đang nghe. Lưu rồi đọc xác nhận một lần, giữ câu cũ và khóa bấm lặp tới khi đọc xong. |
| Lỗi mạng | Lưu thất bại không chuyển câu hay nói đã chọn; upload giọng lỗi giữ file/tiến độ và gửi bù, không tạo đáp án trùng. |
| Bỏ qua và quay lại | `user_skip` qua HTTP hợp lệ; tải lại tiếp tục đúng câu, quay lại sửa được đáp án trước. |
| Ghi âm | Hai lần im lặng ghi no_speech; từ chối quyền vẫn giữ câu; ra nền dừng capture. Chọn Khác mới đồng ý/thu âm; câu cuối có giới hạn 60 giây. |
| Cần chú ý | Đáp án được đánh dấu thủ công trong fixture làm Doctor nhận trạng thái Khẩn trước khi trả lời hết. Đây là kiểm tra chuyển sự kiện, không phải xác nhận nội dung cảnh báo có ý nghĩa lâm sàng. |
| Báo cáo | Hai câu voice có chữ STT, liên kết file gốc, tóm tắt và nháp AI ở giao diện Doctor; lấy file gốc bằng signed URL thành công. |
| Gửi kết quả | Câu hỏi bổ sung bị chặn khi định gửi làm kết quả cuối. Bác sĩ duyệt kết quả, bệnh nhân nhận kết quả mới. |
| Đóng ca | Bệnh nhân bấm Đã hiểu → đúng ca liên kết chuyển completed. |

Các kiểm tra trong bảng được tách thành 20 assertion/bước có log riêng. Không diễn giải số bước qua thành điểm hài lòng của người dùng.

## Hồi quy sau sửa

Hai handler IVR còn nằm trong `task.routes.ts` từ pilot đã chuyển vào `task-ivr.controller.ts`; controller gọi `requestPatientIvr` trong service. TypeScript Doctor qua. Toàn bộ test Doctor backend chạy lại: 118 qua, 1 bỏ qua có sẵn, 0 lỗi. Bộ kiểm tra cũng phát hiện mã lỗi xác thực mới chưa có bản dịch; đã dùng lại mã chuẩn `AUTHENTICATION_REQUIRED` hiện có và chạy lại toàn bộ.

## Artifact và giới hạn

Artifact local: `asinu/.expo/doctor-ivr-srs-native/e2e/result.json`; ảnh, bộ câu hỏi, báo cáo và file giọng tổng hợp ở thư mục `artifacts-2026-10-27T15-22-31-482Z` bên cạnh. Không có token/mật khẩu trong báo cáo kết quả.

iOS Simulator đã kiểm riêng hai XCUITest cho câu hỏi/tốc độ và ghi âm/kết quả, dùng view native thật nhưng dữ liệu gallery. Lượt xuyên suốt ở trên không thay cho thử micro, CallKit/Telecom, Bluetooth hoặc push khi khóa màn hình trên điện thoại thật. Hai thiết bị Apple đã ghép đôi hiện có tunnel unavailable/disconnected, chưa thể thao tác từ máy Mac trong lượt kiểm này.

Chưa xác nhận SLA production, giọng người trên 60 tuổi/vùng miền hoặc trải nghiệm người dùng thực tế. Kênh gọi hiện là cuộc gọi trong app rồi chuyển vào phiên nghe/chọn, chưa có PSTN/DTMF của hệ điều hành. Phạm vi SRS và cấu hình xem [bảng đối chiếu](doctor-ivr-srs-20261027.md).
