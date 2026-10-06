# Phiên bản âm thanh check-in call

App kiểm tra `GET /api/mobile/checkin-call/audio-config` trước mỗi lần phát để lấy phiên bản theo ngôn ngữ đang chọn. Khóa cache gồm phiên bản backend, ngôn ngữ, nội dung, attempt và snapshot lời nhắc nếu có. Backend trả phiên bản thật của bản ghi qua `audioVersion` trong âm thanh câu cố định, lời nhắc cá nhân hóa, thông báo người thân và kết luận.

App chỉ dùng lại file đã xác minh thuộc phiên bản hiện tại. Nếu metadata không có hoặc chưa tải được, app tải mới thay vì dùng file cũ. Nếu backend đổi cấu hình giữa lúc lấy metadata và tải âm thanh, file được lưu theo phiên bản trả về trong response âm thanh.

## Cấu hình giọng

Catalogue VieNeu v4 đã được kiểm tra trực tiếp ngày 06/10/2026. Giọng Tuấn Anh có `id: "Tuấn Anh"`, nam miền Bắc. API tổng hợp trên VPS trả `200`, định dạng `audio/mpeg` cho giọng này.

```dotenv
VIENEU_VOICE=Tuấn Anh
CHECKIN_CALL_AUDIO_REVISION=1
```

Những lần sau, đổi `VIENEU_VOICE` cho tiếng Việt hoặc `VIENEU_VOICE_EN` cho tiếng Anh rồi khởi động lại backend. Phiên bản tự thay đổi theo giọng, ngôn ngữ và nội dung câu cố định; cache Postgres và lời nhắc cá nhân hóa dùng cùng phiên bản. Tăng `CHECKIN_CALL_AUDIO_REVISION` nếu nhà cung cấp thay âm sắc nhưng giữ nguyên tên giọng. Khóa API và thông tin cá nhân không được đưa vào phiên bản.

Giọng tiếng Anh chưa cấu hình thì dùng cơ chế tiếng Anh hiện tại của app. Tiếng Việt không tự đổi sang giọng thiết bị khi tải âm thanh thất bại.

## iPhone khóa máy

Hướng dẫn mở app trong `VoipCallManager.swift` dùng bản ghi đóng gói để hoạt động khi máy khóa hoặc mạng không có. Bản ghi này đã được tạo lại bằng Tuấn Anh; script tạo bản ghi đọc `VIENEU_VOICE` từ cấu hình backend. Nó không cập nhật qua API: cần build app mới để thay bản ghi khi khóa máy. Bản app đã cài vẫn giữ bản ghi cũ.

Bốn loại âm thanh nhận qua API đổi giọng theo backend sau khi người dùng cài app có cơ chế phiên bản. Không cần build lại app cho những lần đổi giọng của các loại này.

## Triển khai và kiểm tra

Triển khai backend trước, rồi phân phối app mới. Cơ chế phiên bản không cần migration; phần cá nhân hóa kèm theo cần migration `103_checkin_call_voice_preferences.sql`. Migrator chuẩn chạy khi container bắt đầu; rollback image không xóa bảng hoặc dữ liệu mới.

```bash
# Backend
npm test -- tests/unit/checkin-call-audio-version.test.js tests/unit/checkin-call-audio-controller.test.js tests/unit/checkin-call-personalization.test.js tests/unit/checkin-call-weather.test.js tests/checkin-call.failure.test.js tests/checkin-call.family-contact.test.js tests/unit/checkin-call-http-routes.test.js
npm run lint
npm run i18n:check

# App
npm run type-check
npm run test:checkin-audio
npm run test:checkin-native
npm run test:api-contract
```

Kiểm tra ngày 06/10/2026: 107 ca backend, 84 ca âm thanh/thao tác app, 10 ca giao diện, TypeScript và hợp đồng API qua. Kiểm thử native kiểm tra bản ghi, checksum, mức âm thanh và vòng đời CallKit/PushKit; cần nghe lại trên iPhone thật sau khi phát hành.
