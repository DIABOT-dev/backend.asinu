# IVR release gate — 28/10/2026

## Kết quả trước khi phát hành

- Backend Asinu: 1.488 kiểm thử qua, 202 được skip do các cổng tích hợp không bật trong lần chạy unit local. Chạy riêng PostgreSQL IVR: 52/52 qua, gồm migration 120–122 và khả năng native gắn đúng token từng nền tảng.
- Doctor backend: 118 qua, 2 skip ở local; build, lint và format qua. CI chạy thêm database security suite trên PostgreSQL riêng.
- Doctor frontend: TypeScript, lint, i18n, format và production build qua.
- App: TypeScript, hợp đồng API, các hồi quy IVR và bảo vệ Doctor trong production qua. Android Gradle/JVM build qua; các kiểm tra native handoff iOS/Android qua.
- Luồng HTTP/UI chạy hai backend và giao diện component thật trên trình duyệt, với PostgreSQL schema cô lập, HMAC/JWT thật và Dr7/TTS/STT thật. Chỉ thay phần phát push bằng bảng ghi nhận fixture; không liên hệ người dùng thật. Dr7 tạo bộ hợp lệ sau khoảng 6 giây.

## Các bước đã qua

1. Sinh câu hỏi mới, chặn nháp rỗng, sửa, lưu và duyệt phiên bất biến.
2. Ghi nhận thông báo, nhắc sau 15 phút, hiển thị câu hỏi cùng các lựa chọn.
3. Bỏ qua/quay lại; mất mạng không lưu hoặc đọc xác nhận sai; bấm lựa chọn trong lúc đang nghe.
4. Đọc xác nhận một lần, giữ câu hiện tại đến khi đọc xong, chống bấm lặp.
5. Red flag đến Doctor trước khi kết thúc; tải lại tiếp tục đúng câu và sửa đáp án trước.
6. Từ chối micro, bản ghi rỗng thử lại một lần, ra nền dừng ghi âm.
7. Khác ghi âm 30 giây, câu kết 60 giây; upload lỗi vẫn giữ bản gốc và tự gửi lại.
8. STT, hai file gốc, báo cáo và nháp AI hiện ở Doctor; chặn dùng câu hỏi thêm làm kết quả cuối.
9. Bác sĩ duyệt gửi, bệnh nhân xem kết quả và Đã hiểu; chỉ đúng ca liên kết được đóng. Không có lỗi JavaScript.

Dữ liệu/schema, khóa fixture được xóa sau kiểm thử. Không xóa dữ liệu người dùng.

## Giới hạn và cờ phát hành

Đây là bằng chứng component/UI trình duyệt và kiểm thử native tự động; không thay cho iPhone/Android thật khi khóa màn hình, micro/Bluetooth hay đánh giá STT giọng vùng miền/người lớn tuổi. Chưa xác nhận SLA production bằng tải thực tế. Không có PSTN/DTMF hệ điều hành.

Triển khai server với DOCTOR_IVR_ENABLED=true, DOCTOR_IVR_CALL_ENABLED=false cho tới khi nghiệm thu cuộc gọi trên thiết bị thật. Doctor web cho phép soạn/gửi vào app; app cài từ store vẫn giữ Doctor ẩn theo yêu cầu trước. Dùng bản development mới để kiểm tra trên VPS; commit/native code không cập nhật các IPA đã cài.

## Ngoại lệ bổ sung theo yêu cầu ngày 28/10

Bộ PostgreSQL IVR tăng từ 52 lên **56/56** kiểm thử qua. Bốn tình huống mới: từ chối câu trả lời sau expires_at dù cron chưa chạy; STT provider lỗi ba lần vẫn giữ đúng byte bản gốc và không bịa transcript; upload cũ gửi muộn sau Back/sửa đáp án không ghi đè lựa chọn mới; AI báo cáo lỗi (kể cả hết credit) vẫn giữ bảng trả lời, cho bác sĩ duyệt trả lời thủ công và tự đóng sau 24 giờ đúng một lần.

Sau deploy, cả backend Asinu, Doctor và web Doctor đều trả health/readiness HTTP 200. Bản đọc/ghi kiểm chứng OpenBao giữ nguyên digest dữ liệu cũ. Kiểm tra HTTP có xác thực trên VPS xác nhận IVR app bật, kênh gọi tắt, cầu nối HMAC Doctor→Asinu hoạt động và các request thiếu/sai JWT hoặc dữ liệu sai bị chặn. Các probe không tạo ca bệnh hoặc gửi thông báo cho người dùng; phiên xác thực kiểm thử tạm được xóa.
