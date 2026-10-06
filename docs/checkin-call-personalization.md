# Cá nhân hóa lời nhắc check-in

## Phạm vi

Phần mới thay đổi lời thoại trong màn hình trả lời cuộc gọi của chính người dùng, không thay đổi lịch gọi, thời hạn phản hồi, phân loại tình trạng, liên hệ người thân hoặc quyền An Tâm. Đây là lời nhắc tự động, không phải cuộc tư vấn của bác sĩ và không nhận câu trả lời bằng giọng nói.

Trong app: **Cài đặt check-in → Cá nhân hóa lời nhắc cuộc gọi** (`/checkin-call/voice-settings`). Có thể chọn Bác/Cô/Chú/Anh/Chị/Bạn hoặc tự động theo tuổi và giới tính trong hồ sơ. Thiếu thông tin thì dùng Bạn; người từ 60 tuổi mặc định là Bác. Ngày sinh được tính theo múi giờ đã lưu, không dùng ngày UTC thay cho ngày địa phương. Có thể chọn lại cách xưng hô mà không sửa hồ sơ.

Ba lựa chọn dùng tên, nhắc số liệu và thời tiết đều **tắt mặc định**. Bật từng lựa chọn phải đồng ý trong modal của app rồi bấm Lưu. Modal có nội dung cuộn được và hai nút xếp dọc. Việc bật các lựa chọn cần quyền tổng đài của gói; vẫn được tắt tất cả khi gói hết hạn.

## Lời thoại

1. Giới thiệu ngắn: “Chào bác Nguyễn Thị Lan. Đây là cuộc gọi nhắc check-in từ tổng đài tự động Asinu, đồng hành cùng bạn và gia đình.” Tên chỉ dùng nếu được đồng ý và có tên hợp lệ; không đọc email, số điện thoại hoặc mã tài khoản thay tên.
2. Nếu được cho phép, nhắc **một** số đo huyết áp hoặc đường huyết hợp lệ trong 48 giờ gần nhất, kèm thời gian ghi nhận và đơn vị. Đọc lại số đã ghi, không suy đoán tình trạng hoặc khuyên điều chỉnh thuốc. Không có số đo thì hỏi thăm chung. Không chèn số đo vào cảnh báo khẩn cấp.
3. Giữ ba nút trả lời hiện tại: Tôi vẫn ổn / Tôi hơi mệt / Tôi cần hỗ trợ ngay. Có thể bấm ngay, không phải chờ đọc xong. Việc bấm lựa chọn ngắt tiếng cũ ngay, kể cả khi tải âm thanh hoặc chờ API.
4. Thời tiết chỉ đọc thêm sau khi ghi nhận **Tôi vẫn ổn**, không chen vào bước cần hỗ trợ hay cảnh báo khẩn cấp. Thiếu dự báo thì bỏ qua. Dự báo là cho khu vực đã chọn, không tuyên bố đó là địa chỉ nhà hoặc số đo nhiệt độ trực tiếp tại thiết bị.

Tiếng Việt và tiếng Anh đều dùng giọng nhân bản riêng Asinu Tuấn Anh v4 qua cùng `VIENEU_VOICE`. Không dùng giọng Ngọc Lan hay tự chuyển sang giọng Apple khi tải âm thanh thất bại; vẫn giữ các nút phản hồi, nội dung chữ và nghe lại. Các nhánh cảnh báo tín hiệu sớm và thông báo người thân giữ lời cảnh báo/nghiệp vụ đang có.

## Thời tiết và dữ liệu

- Có sáu khu vực chọn thủ công: Hà Nội, TP.HCM, Đà Nẵng, Hải Phòng, Cần Thơ, Huế. Hoặc bấm lấy vị trí hiện tại một lần; chỉ lúc đó mới xin quyền vị trí khi dùng app.
- Tọa độ làm tròn đến 0,1 độ **trước khi gửi** đến backend và được kiểm tra lại ở backend. Không theo dõi liên tục, không xin vị trí nền. Khi đổi nơi, người dùng chọn/lấy lại khu vực; không tự cho rằng vị trí hiện tại là nơi sinh sống.
- Backend gọi MET Norway qua HTTPS cố định với tọa độ khu vực; không gửi tên, tài khoản, số liệu sức khỏe hoặc IP thiết bị người dùng cho MET Norway. Không cần khóa API thời tiết mới.
- Có User-Agent nhận diện app, timeout 1,8 giây, cache theo khu vực và Expires/Last-Modified, gộp request đồng thời, tối đa bốn request nguồn đồng thời. Lỗi thường được giữ 5 phút; 403/429 tạm dừng lấy mới một giờ. Dự báo không gần thời điểm hiện tại được bỏ qua.
- Ghi nguồn MET Norway/CC BY 4.0 và thời điểm dự báo; có liên kết giấy phép trong cấu hình. Nguồn: https://api.met.no/doc/TermsOfService và https://api.met.no/doc/License.
- Gửi VieNeu chỉ văn bản cần đọc. Có giải thích riêng trước khi đồng ý dùng tên hoặc số liệu; không gửi toàn bộ hồ sơ.
- Nội dung cá nhân không đưa vào PushKit, CallKit hoặc lời nhắc màn hình khóa. Lời nhắc khóa máy là bản ghi chung đóng gói trong app, đã tạo lại bằng giọng nhân bản riêng Asinu Tuan Anh cho bản app mới. App ngắt tiếng khi rời màn hình/vào nền.
- Lời đọc và transcript có version khớp nhau; nếu snapshot thay đổi, backend trả 409 thay vì phát nội dung khác. Cache âm thanh có định danh người nhận/cuộc gọi/version và thời hạn; snapshot không lưu trong bảng âm thanh dùng chung. Tắt lựa chọn rồi lưu có hiệu lực với lời nhắc tiếp theo, không xóa lịch sử sức khỏe.

## API và triển khai

Các endpoint đều nằm sau middleware xác thực:

| Method | Đường dẫn | Mục đích |
| --- | --- | --- |
| GET | `/api/mobile/checkin-call/voice-preferences` | Đọc lựa chọn của tài khoản đang đăng nhập |
| PUT | `/api/mobile/checkin-call/voice-preferences` | Lưu lựa chọn, không nhận `user_id` hoặc trường lịch gọi |
| GET | `/api/mobile/checkin-call/attempts/:id/user-notice` | Lời đọc/transcript cho chính chủ episode và attempt USER |
| GET | `/api/mobile/checkin-call/attempts/:id/user-audio/:key` | Âm thanh của key có sẵn trong snapshot; header `X-Checkin-Notice-Version` đảm bảo khớp transcript |

Không cấp dữ liệu USER cho người thân hay người khác, dù có ID attempt. Notice/audio dùng limiter tổng hợp âm thanh hiện tại. Response riêng tư có `Cache-Control: no-store`.

Migration `103_checkin_call_voice_preferences.sql` tạo bảng riêng liên kết `users` với `ON DELETE CASCADE`, không sửa cấu hình/lịch sử cũ. Triển khai **backend trước**, chạy migrator chuẩn qua quy trình deploy hiện tại. Giữ `VIENEU_API_KEY`, đặt `VIENEU_VOICE=clone_b935a451-7d65-4b73-a083-d46e56c47d4f`; `CHECKIN_WEATHER_USER_AGENT` là tùy chọn nếu muốn thay User-Agent bằng URL/email liên hệ của đơn vị. Không đưa khóa vào app. Cơ chế phiên bản/cache được mô tả trong [checkin-call-audio-version.md](checkin-call-audio-version.md).

Sau backend, build/phân phối app mới. Purpose string vị trí iOS đã bổ sung mục đích thời tiết nên cần bản iOS mới để hệ thống hiển thị lời xin quyền mới. Chỉ cập nhật JavaScript không thay được thông báo quyền native trong bản cũ.

Nếu rollback: quay về phiên bản ứng dụng/backend trước bằng quy trình phát hành; không drop bảng mới hoặc xóa dữ liệu người dùng. Migration chỉ thêm bảng nên phiên bản trước không phụ thuộc vào bảng này. Nếu backend mới chưa có hoặc lỗi notice, app vẫn dùng luồng lời nhắc chung/các nút cũ; màn cấu hình báo lỗi và có nút Thử lại.

## Kiểm tra trước demo

Đã có test tự động cho lựa chọn mặc định, validation, quyền An Tâm, IDOR, ngày sinh/múi giờ, số đo cũ/sai/thiếu đơn vị, lời đọc/transcript, cache riêng, thời tiết, lưu lỗi/nhấn lặp/đổi tài khoản và ngắt tiếng cũ. Migration và query được kiểm tra trên PostgreSQL riêng trong transaction rollback; không dùng dữ liệu VPS.

Lệnh FE: `npm run test:checkin-personalization`, `npm run test:checkin-audio`, `npm run test:checkin-state`. Test backend chạy bằng `npm test`; PostgreSQL opt-in qua `CHECKIN_PERSONALIZATION_TEST_DATABASE_URL` và CI dùng PostgreSQL test riêng.

Trên iPhone thật sau khi phát hành bản mới:

1. Bật dùng tên + số đo, chọn cách xưng hô, chọn khu vực và Lưu. Có thể test từ chối GPS rồi chọn thành phố thủ công.
2. Nhận một cuộc gọi check-in thử, mở màn trả lời: kiểm tra intro, tên/cách xưng hô, thời gian/đơn vị số đo và transcript. Khi không có số đo 48 giờ gần đây, kiểm tra câu hỏi trung tính.
3. Khi đang đọc, bấm Tôi vẫn ổn: tiếng cũ dừng, ghi nhận thành công rồi mới đọc thời tiết. Kiểm tra nguồn/thời điểm dự báo. Nghe lại/Dừng đọc phải hoạt động.
4. Thử Tôi hơi mệt và Tôi cần hỗ trợ ngay: không đọc thời tiết; giữ đúng luồng liên hệ người thân hiện tại, không tự nhận đã cứu hộ.
5. Khóa máy: không đọc tên/số đo trong lời nhắc CallKit. Chuyển app vào nền rồi mở lại: không đè tiếng hoặc phát câu hỏi cũ.
6. Tắt các lựa chọn và Lưu; cuộc gọi tiếp theo không dùng tên/số đo/thời tiết. Thử mất mạng ở cả VI/EN: vẫn trả lời bằng nút, không tự chuyển sang giọng Apple. Kiểm tra kết quả check-in thường và lời nhắc khóa máy cũng cùng giọng Tuấn Anh.

Test tự động và export bundle không thay thế kiểm tra loa, Bluetooth, CallKit và quyền vị trí trên iPhone thật. Việc deploy không tự gửi cuộc gọi hoặc bật consent cho tài khoản demo.

### Kết quả kiểm tra ngày 06/10/2026

- Backend: 83 suite / 685 test qua, gồm các integration PostgreSQL thật trên database local riêng `asinu_security_test_personalization`.
- Toàn bộ migration đến 103 chạy thành công trên database test riêng.
- FE: 18 kiểm tra cấu hình cá nhân hóa, 74 kiểm tra âm thanh/handler cuộc gọi, 10 kiểm tra screen và 25 kiểm tra vòng đời modal qua. Các bộ state/native/signaling/security/Care Circle/interaction hiện tại cũng qua.
- Type-check, lint và i18n FE/BE qua; 171 call site của app khớp method/path backend.
- Export bundle iOS và Android qua. Đây là kiểm tra bundle, **không phải build IPA/APK hoặc phát hành bản mới**.
- Lấy dự báo thật theo khu vực Hà Nội qua MET Norway thành công; không gửi dữ liệu tài khoản hoặc tạo cuộc gọi thật.

Các kết quả trên là tại snapshot tính năng cá nhân hóa. Phần tích hợp phiên bản/cache âm thanh đã hoàn tất sau đó: backend có `GET /api/mobile/checkin-call/audio-config` và trả `audioVersion` trong bốn loại response âm thanh. 107 ca backend qua, 84 ca âm thanh và 10 ca screen qua; kiểm tra contract có 172 call site, 141 request và 229 route backend, không thiếu endpoint.
