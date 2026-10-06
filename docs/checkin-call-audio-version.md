# Phiên bản âm thanh check-in call

App kiểm tra `GET /api/mobile/checkin-call/audio-config` trước mỗi lần phát để lấy phiên bản theo ngôn ngữ đang chọn. Khóa cache gồm phiên bản backend, ngôn ngữ, nội dung, attempt và snapshot lời nhắc nếu có. Backend trả phiên bản thật của bản ghi qua `audioVersion` trong âm thanh câu cố định, lời nhắc cá nhân hóa, thông báo người thân và kết luận.

App chỉ dùng lại file đã xác minh thuộc phiên bản hiện tại. Nếu metadata không có hoặc chưa tải được, app tải mới thay vì dùng file cũ. Nếu backend đổi cấu hình giữa lúc lấy metadata và tải âm thanh, file được lưu theo phiên bản trả về trong response âm thanh.

## Cấu hình giọng

Dùng giọng nhân bản riêng **Asinu Tuan Anh**, `id: clone_b935a451-7d65-4b73-a083-d46e56c47d4f`, nam miền Bắc, engine v4. Đây là giọng của mẫu người dùng đã nghe và chọn; giọng catalogue cùng tên có ID `Tuấn Anh` là một giọng khác.

Adapter VieNeu chọn `/api/v1/tts` cho `clone_*`, chờ job hoàn tất rồi tải file WAV bằng URL HTTPS không kèm khóa API. Giọng catalogue vẫn dùng `/api/v1/audio/speech` và MP3. `/audio-config` trả thêm `mimeType`; app lưu đúng đuôi WAV/MP3 và kiểm tra phiên bản thật của response. Các job lỗi, hết thời gian chờ hoặc trả sai giọng không được đổi sang giọng catalogue.
```dotenv
VIENEU_VOICE=clone_b935a451-7d65-4b73-a083-d46e56c47d4f
CHECKIN_CALL_AUDIO_REVISION=1
```

Toàn bộ lời đọc tiếng Việt và tiếng Anh dùng chung `VIENEU_VOICE`, mặc định là giọng riêng Asinu Tuấn Anh v4 ở trên. Biến cũ `VIENEU_VOICE_EN` không còn được dùng. Khi thay cấu hình giọng, khởi động lại backend; phiên bản/cache của cả hai ngôn ngữ tự thay đổi. Tăng `CHECKIN_CALL_AUDIO_REVISION` nếu nhà cung cấp thay âm sắc nhưng giữ nguyên ID giọng. Khóa API và thông tin cá nhân không được đưa vào phiên bản.

Câu cố định, câu cá nhân hóa, thông báo người thân và kết quả check-in trong app đều dùng cùng dịch vụ âm thanh và cache có phiên bản. Không dùng giọng Ngọc Lan hay giọng Apple dự phòng ở bất kỳ ngôn ngữ nào. Nếu tải/giải mã thất bại, vẫn giữ transcript, nút phản hồi và nút nghe lại; không ghi nhận check-in thay người dùng. Nội dung tiếng Anh vẫn là tiếng Anh, chỉ thống nhất người đọc.

## iPhone khóa máy

Hướng dẫn mở app trong `VoipCallManager.swift` dùng hai bản ghi VI/EN đóng gói bằng giọng riêng Asinu Tuấn Anh v4 để hoạt động khi máy khóa hoặc mạng không có. Script `scripts/generate-checkin-handoff-voice.mjs ../backend.asinu/.env --lang vi` (hoặc `--lang en`) ở repo app đọc `VIENEU_VOICE`; kiểm tra checksum, localization và loudness trước khi đóng gói. Cần build app mới để thay bản ghi native. Bản app đã cài vẫn giữ bản ghi cũ.

CallKit báo cuộc gọi có nội dung trực quan vì màn app chứa câu hỏi và nút phản hồi. Không bật camera hay truyền video. Theo [Apple DTS](https://developer.apple.com/forums/thread/798090), iOS có thể xác thực/mở khóa và đưa app lên khi nhận cuộc gọi trực quan; không vượt qua khóa máy và không đảm bảo tự mở nếu người dùng chưa mở khóa. React chỉ chuyển màn sau khi đăng nhập và navigation sẵn sàng; nhận cuộc gọi không đồng nghĩa đã trả lời check-in. Các sự kiện focus/active trùng nhau không phát lại lời đang tải/đang đọc/đã hoàn tất.

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

Kiểm tra ngày 06/10/2026: 119 ca backend, 89 ca âm thanh/thao tác app, 10 ca giao diện, TypeScript và hợp đồng API qua. Kiểm thử native kiểm tra bản ghi, checksum, mức âm thanh và vòng đời CallKit/PushKit; cần nghe lại trên iPhone thật sau khi phát hành.
