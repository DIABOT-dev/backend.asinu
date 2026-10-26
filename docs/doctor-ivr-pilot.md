# Dr.Asinu × Asinu: bản thử thu thập thông tin

Ngày: 21/10/2026. Bản thử chạy local, mặc định tắt khi triển khai mới.

## Luồng đã nối

1. Bác sĩ phụ trách ca mở tab **Tổng đài** ở cột công cụ bên phải. Tab cũng có trong chi tiết ca để đọc lại báo cáo sau khi đóng.
2. Tạo nháp bằng AI, tự soạn hoặc dùng mẫu riêng. Sửa câu hỏi, lựa chọn, thứ tự và nhánh; bác sĩ tự xác nhận những đáp án phải báo ngay. Gợi ý red flag của AI chưa được bật sẵn.
3. **Duyệt & gửi vào app** tạo phiên bất biến. Asinu gửi thông báo và hiển thị lời mời trong hội thoại của bệnh nhân.
4. Bệnh nhân bấm **Trả lời ngay**, nghe và chọn. Chọn Khác mới xin quyền micro, đồng ý ghi âm và thu tối đa 30 giây; câu kết cho phép 60 giây. Có nghe lại và quay lại câu trước.
5. Câu trả lời lưu ngay phía server, có mã chống gửi trùng và revision chống hai thiết bị ghi đè. Ghi âm lưu trong thư mục riêng của app trước khi gửi; file upload thất bại được giữ lại để gửi bù bằng cùng mã yêu cầu. Có thể đăng ký câu trả lời đang chờ upload để tiếp tục phiên. Nếu toàn bộ mạng mất, app giữ bản ghi và chờ gửi được tiến độ rồi mới đi tiếp.
6. Báo cáo gồm bảng câu trả lời, chữ chuyển từ ghi âm, liên kết nghe file gốc, dấu hiệu cần xem ngay và nháp AI. Không có điểm confidence từ nhà cung cấp hiện tại: trả `null`, hiển thị **Cần nghe lại**, không tự tạo điểm.
7. Bác sĩ kiểm tra, sửa và gửi kết quả. Bệnh nhân đọc/nghe và bấm **Đã hiểu**; nếu không bấm thì đóng sau 24 giờ kể từ khi gửi kết quả.

Đây là **thông báo + phiên nghe/chọn trong app**. Chưa nối kênh gọi SIM/PSTN, phím DTMF, CallKit/Telecom hay cuộc gọi trên màn hình khóa. API trả `capabilities.call=false`; không hiển thị lựa chọn gọi chưa hoạt động. Giọng đọc câu hỏi được chuẩn bị/cache ở backend, app dùng giọng đọc của thiết bị khi âm thanh chưa sẵn sàng. Cần đánh giá giọng thực tế trên iOS/Android trước khi chốt trải nghiệm.

## Cấu trúc theo hệ thống hiện tại

Các JSON trong SRS là tham khảo. Ca vẫn dùng `doctor_tasks.id` ở Dr.Asinu và `source_task_id`/`app_user_id` khi qua cầu nối Asinu. Thông tin phiên nằm ở Asinu backend; không tạo thêm một danh sách bệnh nhân độc lập.

- Doctor API: `GET /v1/tasks/:taskId/ivr`; `POST /v1/tasks/:taskId/ivr/:operation`, với operation `generate`, `save`, `approve`, `template`, `cancel`, `reply`.
- Cầu nối Doctor → Asinu: `POST /api/doctor/ivr/doctor`, ký HMAC bằng cơ chế đã có. Doctor kiểm tra tài khoản được phân công và sự đồng ý chia sẻ trước khi gọi.
- Bệnh nhân: `/api/doctor/ivr/config`, `/sessions`, `/sessions/:id`, `/sessions/:id/action`, `/sessions/:id/voice`, `/sessions/:id/audio/:questionId`.
- Cầu nối Asinu → Doctor: `POST /v1/integrations/asinu/ivr-events`, có HMAC, hộp thư chống nhận trùng và outbox retry.
- Bảng mới có tiền tố `doctor_ivr_`; migrations Asinu `116`–`118`, Doctor `030`. Migrations chỉ thêm cấu trúc.

`draft` ở phiên là bước chuẩn bị sau khi bác sĩ đã duyệt; bản nháp câu hỏi chưa gửi nằm riêng trong question set. Phiên mới có 3–7 câu nội dung và câu kết; phiên bổ sung có 1–3 câu và câu kết, tối đa một lần. Nhánh chỉ trỏ về phía sau. Câu hỏi số đo cần đơn vị và các khoảng liên tục, không hở/chồng lấn. Validator kiểm tra cấu trúc; bác sĩ vẫn phải kiểm tra tính phù hợp và việc đáp án có trùng nghĩa hay không.

Mục tiêu ba phút được ước tính từ lượng chữ đọc và thời gian bấm. Người bệnh ghi âm nhiều lần có thể vượt ba phút. Một phiên bình thường gọi LLM một lần tạo câu hỏi và một lần lập báo cáo; tối đa hai lần sinh lại câu hỏi khi output lỗi theo FR-01/EX-01. Vì vậy giới hạn tuyệt đối hai lượt LLM trong NFR-02 không đồng thời áp dụng cho nhánh sửa output lỗi.

## Bật local

Asinu backend `.env`:

```dotenv
DOCTOR_IVR_ENABLED=true
DOCTOR_IVR_QUESTION_PROVIDER=openai
DOCTOR_IVR_QUESTION_MODEL=
DOCTOR_IVR_ENCRYPTION_KEY=<64 ký tự hex ngẫu nhiên, lưu bí mật>
DOCTOR_IVR_RED_FLAG_PHRASES=
DOCTOR_IVR_SAFETY_MESSAGE=
```

Doctor frontend `.env.local`:

```dotenv
NEXT_PUBLIC_DOCTOR_IVR_ENABLED=true
```

Chạy migrations ở hai backend rồi khởi động lại backend/Next. Máy chạy Asinu cần `ffprobe`; Dockerfile hiện có `ffmpeg`. Các URL cầu nối, TTS/STT và sự đồng ý xử lý AI dùng cấu hình hiện có. Không bật bằng cách bỏ qua consent hoặc tự cấp consent cho bệnh nhân.

Danh mục phát hiện trong transcript lấy từ `DOCTOR_IVR_RED_FLAG_PHRASES`, phân cách bằng `|`; nội dung hướng dẫn cuối phiên lấy từ `DOCTOR_IVR_SAFETY_MESSAGE`. Cần người phụ trách chuyên môn duyệt cấu hình. Đáp án do bác sĩ đánh dấu vẫn báo ngay dù danh mục transcript chưa cấu hình. Chưa có màn admin quản lý danh mục này.

### Kiểm soát chất lượng nội dung

- Phần tạo câu hỏi dùng cấu hình AI riêng, mặc định OpenAI và model trong `OPENAI_MODEL`; có thể ghi đè bằng `DOCTOR_IVR_QUESTION_MODEL`. Các luồng AI khác giữ cấu hình hiện có. Consent hiện tại vẫn được kiểm tra trước khi gọi nhà cung cấp. Bản nháp luôn cần bác sĩ duyệt.
- AI lập kế hoạch gọn theo `focus` và `answer_kind`: Có/Không, tần suất, ảnh hưởng sinh hoạt, khoảng số hoặc lựa chọn riêng. Server tạo các đáp án chuẩn, số phím, Khác và câu kết. Dạng ảnh hưởng sinh hoạt dùng cả câu hỏi chuẩn tương ứng, tránh hỏi về giấc ngủ nhưng trả lời bằng mức hoạt động. Với khoảng số, server tạo các khoảng liên tục từ `unit` và `thresholds`; AI không phải tự ghép range. Đây chỉ là định dạng sinh nháp nội bộ; JSON phiên đã duyệt và API app giữ cấu trúc cũ.
- Có kiểm tra câu trùng ý theo focus; một số dạng gộp biểu hiện, đáp án mơ hồ và câu hỏi lại thời điểm đã khai báo. Từ 23/10, câu Có/Không hoặc tần suất bị gộp ý bằng “hoặc” được gửi lại AI để sửa riêng phần chữ; giữ nguyên câu hợp lệ, focus và đáp án. Bản sửa chỉ được đổi đúng các vị trí yêu cầu, sau đó phải qua toàn bộ validator và kiểm tra dữ kiện đã biết. Khoảng số, đáp án riêng hoặc lỗi cấu trúc vẫn dùng nhánh sinh lại cả bộ. Tối đa hai lần sửa/sinh lại trong cùng ngân sách 10 giây; không bắt đầu lượt mới khi còn dưới 500 ms và không nhận output đến sau hạn. Bản nháp vẫn cần bác sĩ duyệt, không tự gửi khi chưa hợp lệ. Audit mã hóa lưu cả phần chữ trước/sau mỗi lần sửa.
- App không tự bỏ qua câu khi người bệnh im lặng. Người bệnh tự bấm **Chưa rõ, bỏ qua câu này**; backend lưu là thiếu thông tin. Quy tắc này thay QR-10 cho kênh app; kênh gọi điện chưa triển khai.
- Báo cáo phân biệt dấu hiệu hiện tại và lịch sử đáp án đã sửa, gộp cảnh báo trùng nhưng giữ audit gốc. Câu trả lời trình bày theo bảng và thứ tự câu hỏi, kèm ghi âm gốc.
- Nháp AI còn hỏi thêm, hoặc báo cáo một phần/thiếu nhiều dữ liệu, không được đưa thành kết quả cuối. Bác sĩ thấy lý do cần bổ sung và có thể gửi phiên bổ sung hoặc tiếp tục hội thoại. Kết quả cuối chứa câu hỏi yêu cầu người bệnh trả lời thêm bị chặn ở cả giao diện và API. Bác sĩ vẫn được soạn kết quả sau khi kiểm tra đủ thông tin.
- Khi tạo phiên bổ sung, AI nhận các câu trả lời trước để tránh hỏi lại. Nếu ghi âm/chữ đến sau khi báo cáo đã lập, giao diện ẩn nút dùng nháp cũ và yêu cầu bác sĩ kiểm tra dữ liệu mới.

Các kiểm tra này bắt lỗi nội dung đã biết; không chứng minh mọi câu hỏi đều phù hợp về chuyên môn hoặc người dùng sẽ hài lòng. Bác sĩ cần kiểm tra nội dung, và thử với người dùng mục tiêu trên điện thoại vẫn là bước nghiệm thu riêng.

## Xử lý lỗi và dữ liệu

- Bác sĩ không sửa được phiên đã bắt đầu. Thay phiên chưa bắt đầu tạo version mới và hủy phiên cũ. Không chỉnh trực tiếp trạng thái ca để giả lập việc bệnh nhân đang trả lời.
- Thời hạn 24 giờ và thời gian nhắc do server quyết định. Lịch nhắc tối nay trong bản thử dùng giờ Việt Nam. Chưa có bộ lập lịch gọi theo múi giờ từng bệnh nhân.
- Worker chạy mỗi hai giây, phục hồi outbox còn thiếu sau sự cố, retry có backoff. Cảnh báo red flag có hàng xử lý riêng. Không thể bảo đảm SLA cảnh báo khi cầu nối/nhà cung cấp mất kết nối.
- Hết hạn có câu trả lời thì lập báo cáo một phần. Khi chờ STT hoặc file gửi bù, worker chờ tối đa khoảng 40 giây trước khi lập báo cáo bằng dữ liệu hiện có. File gốc/chữ tới sau vẫn nằm ở bảng câu trả lời; không gọi lại LLM để viết lại bản nháp đã được bác sĩ xem.
- File gốc, câu hỏi, câu trả lời dạng chữ, báo cáo và audit được mã hóa AES-256-GCM. Khóa gắn nội dung với chủ thể và mục đích. Liên kết nghe ký HMAC, hạn 15 phút, không cache. Không in nội dung bệnh nhân hoặc khóa vào log.
- Thu hồi chia sẻ chặn truy cập của bác sĩ và xử lý phiên. Xóa/ẩn danh qua luồng quyền riêng tư xóa cả dữ liệu IVR và các mẫu được tạo từ dữ liệu bệnh nhân đó. Xuất dữ liệu bổ sung các phiên IVR.
- Không tự đặt thời hạn xóa hồ sơ/ghi âm. Thời hạn lưu trữ, quy trình chuyên môn và kiểm thử giọng Bắc/Trung/Nam trên thiết bị thật cần chốt trước khi dùng rộng rãi. Không coi bản thử này là đã nghiệm thu toàn bộ SRS.

## Kiểm tra

Kết quả thử hai backend với dịch vụ AI/TTS/STT thật và các sửa lỗi ngày 21/10 nằm trong [báo cáo kiểm thử local](doctor-ivr-test-report-20261021.md).

### Điều chỉnh nhịp hỏi đáp và giao diện ngày 21/10

- Màn hỏi đáp dùng nền, header, logo, màu, khoảng cách và nút quay lại của luồng tư vấn hiện có. Mỗi bước hiển thị một câu cùng toàn bộ lựa chọn; đáp án bấm được cả khi âm thanh đang tải/phát. Đã kiểm tra bố cục JSX qua bản dựng trình duyệt ở 320/393px, chữ tăng 30%, giao diện sáng/tối và các trạng thái mời trả lời/kết quả/ghi âm. Đây là kiểm tra bố cục, chưa thay thế thử native trên điện thoại.
- Chọn đáp án dừng giọng đọc và gửi API ngay. Sau khi lưu thành công, giữ nguyên câu cùng đáp án đã chọn và đọc “Bạn đã chọn: [đáp án]”; đọc xong mới chuyển câu. Poll và upload đến muộn không được vượt qua bước xác nhận. Gửi lỗi giữ câu hiện tại để thử lại, không đọc xác nhận. Âm thanh lỗi hoặc không hoàn tất trong 10 giây thì tiếp tục bằng phần chữ để tránh kẹt phiên. Khóa thao tác chặn bấm trùng; rời app dừng xác nhận và khi trở lại tải tiến độ đã lưu từ server. Màn xem thử development có cùng nhịp xác nhận bằng giọng đọc thiết bị.
- Nội dung TTS của từng câu và giọng dự phòng trong app dùng chung `speech_text` do backend tạo: chỉ chào ở câu đầu, đọc câu hỏi cùng những lựa chọn của chính câu đó trong một đoạn. Prompt sinh câu hỏi được chỉnh để hỏi cụ thể, nối mạch và tránh hỏi lại dữ kiện đã có. Bộ đã gửi vẫn bất biến; cách soạn câu hỏi mới áp dụng khi tạo bộ mới.
- Kiểm tra hành vi chạy hàm `act`/`select` thật và render `DoctorIvrQuestion`; có tình huống hủy âm thanh chưa hoàn tất, bấm liên tiếp, mất focus, lỗi lưu, quyền ghi âm và sáng/tối. Bundle iOS được kiểm tra lại qua Metro.

- `tests/doctor-ivr.test.js`: validator, mã hóa, PostgreSQL trong schema fixture riêng, toàn luồng, quyền sở hữu, gửi trùng, revision, nhánh, phiên bổ sung, hết hạn, file gốc, upload bù, STT và signed URL. Bật DB test bằng `DOCTOR_IVR_TEST_DATABASE_URL` trỏ PostgreSQL local; fixture tự dọn sau khi chạy, không gọi AI/TTS/STT/push thật.
- `tests/doctor-ivr-http.test.js`: hợp đồng đầu vào qua HTTP và JWT middleware; chấp nhận cả `user_skip` của app, không tự biến bỏ qua thành đáp án Không; chặn lý do lạ, thiếu revision/mã yêu cầu, token hết hạn hoặc đã thu hồi. Phần biến đổi dữ liệu IVR được mock trong bộ này; bộ PostgreSQL và lượt trình duyệt/API kiểm tra việc lưu thực tế.
- Doctor `tests/ivr-events.test.ts`: phân quyền bác sĩ, trạng thái chờ, sự kiện đến sai thứ tự, red flag, nhận trùng và thu hồi consent.
- App `npm run test:doctor-ivr`: file chờ gửi, phạm vi tài khoản/phiên, dọn file và phản hồi đến sau khi đổi tài khoản. Đã chạy hồi quy bộ phát âm thanh đang tái sử dụng.
- UI bác sĩ đã thử bằng trình duyệt với API fixture: bản nháp hợp lệ/không hợp lệ, duyệt gửi, đọc báo cáo và sửa/gửi câu trả lời. Không thay thế thử micro, silence detection, cuộc gọi và push thực tế trên điện thoại.

## Sao lưu và quay về chat

Mốc trước thay đổi ở cả ba repo: `backup/pre-doctor-ivr-20261021-122332`. Nhánh thử: `feat/doctor-ivr-pilot-20261021-122332`.

Thư mục backup local: `/Users/ducytcg123456/Desktop/APP/backups/doctor-ivr-20261021-122332`, có manifest commit, ba archive code và hai bản `pg_dump` trước migration. Các bản cấu hình riêng có quyền đọc giới hạn; không đưa vào Git.

Để dừng thử: xử lý/hủy các phiên còn mở; chuyển các ca có `ivr_active_session_id` và đang chờ về hàng bác sĩ để tiếp tục chat, xóa cột chờ IVR ở những ca đó; tắt hai cờ trên và khởi động lại. Giữ nguyên khóa mã hóa và các bảng để còn đọc/xuất dữ liệu đã thu thập. Có thể mở worktree từ nhánh backup để so sánh/chạy bản cũ. Không cần khôi phục toàn bộ DB; việc đó sẽ mất những thay đổi phát sinh sau backup.
