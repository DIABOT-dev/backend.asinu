# Kiểm thử và đánh giá chất lượng Dr.Asinu × App Asinu

Lượt mới sau cải thiện bắt đầu 15:21:05 21/10/2026 (giờ Việt Nam). Có backup code trước sửa: `/Users/ducytcg123456/Desktop/APP/backups/doctor-ivr-quality-20261021-145321.tar.gz`.

## Kết luận và giới hạn

Đã sửa các vấn đề quan sát được ở câu hỏi, nháp kết quả, báo cáo bác sĩ và thời gian chờ trong app. Lượt mới qua 17 kiểm tra giao diện/API, gồm toàn luồng 13 bước và các kiểm tra bổ sung; 48 kiểm tra tự động backend về hợp đồng, chất lượng và quy trình qua với PostgreSQL local trong schema riêng. Không chuyển kết quả này thành điểm hài lòng hoặc xác nhận chất lượng y khoa.

Các component thật DoctorIvrPanel và DoctorInterviewScreen chạy qua adapter trình duyệt, kết nối hai backend HTTP/HMAC và AI/TTS/STT thực tế. Micro, quyền hệ điều hành và audio bridge là adapter; bản ghi upload là giọng tổng hợp. Thông báo được thu lại trong fixture, không gửi đến người dùng thật. Chưa nghiệm thu trên iOS/Android thật, giọng người lớn tuổi/vùng miền hoặc cuộc gọi màn hình khóa.

## Chất lượng đã cải thiện

| Phần | Thay đổi và bằng chứng | Giới hạn |
| --- | --- | --- |
| Câu hỏi | AI lập kế hoạch theo mục tiêu, server dựng đáp án Có/Không, tần suất, ảnh hưởng sinh hoạt và khoảng số; chặn các dạng mơ hồ/gộp biểu hiện đã phát hiện; có kiểm tra hỏi lại thời điểm đã khai báo | Bác sĩ vẫn cần duyệt tính liên quan và tính đầy đủ theo từng ca |
| Kết quả cuối | Nháp còn hỏi thông tin bị giữ lại cho bác sĩ; có lý do cần bổ sung. Câu hỏi không được gửi thành kết quả cuối ở UI/API | Không thay thế đánh giá chuyên môn của bác sĩ |
| Báo cáo | Bảng câu hỏi/đáp án gọn hơn; cảnh báo có câu hỏi đi kèm, gộp trùng; lịch sử đã sửa tách riêng; ẩn thông báo chuẩn bị giọng cũ | Chưa đo thời gian đọc báo cáo của bác sĩ thật |
| Người lớn tuổi | Nút nghe lại cao 56; app không tự bỏ qua khi im lặng; có thao tác bỏ qua rõ ràng. Đã mô phỏng 45 giây bằng đồng hồ trình duyệt và xác nhận không tự tiến câu | Chưa quan sát người lớn tuổi tự thao tác trên điện thoại |
| Sự hài lòng | Chưa đo | Cần thử với người dùng mục tiêu, quan sát hiểu sai, phải nhờ trợ giúp, tỷ lệ Khác/bỏ qua và cảm nhận sau khi nhận kết quả |

Phần sinh câu hỏi dùng cấu hình riêng mặc định OpenAI JSON mode, model theo `OPENAI_MODEL` (local đang là gpt-4o). TTS/STT và phần tổng hợp báo cáo dùng cấu hình hiện có. Consent vẫn được kiểm tra trước xử lý AI. Không có thanh toán hay triển khai VPS trong lượt sửa này.

## Kiểm thử mở rộng ngày 23/10/2026, buổi trưa

Theo yêu cầu kiểm tra kỹ lại, lượt này chạy dữ liệu fixture mới và mở rộng sang các nhánh lỗi. **Tìm thấy thêm một lỗi thật:** app gửi `skip_reason=user_skip` khi bấm **Chưa rõ, bỏ qua câu này**, nhưng schema HTTP chỉ nhận `no_speech/no_response`. API trả 400 mặc dù service bên trong đã hỗ trợ thao tác này; các test gọi service trực tiếp trước đó không phát hiện được. Đã thêm `user_skip` vào schema HTTP. Test hồi quy xác nhận lỗi trước sửa, qua sau sửa; thao tác thật ở giao diện nối hai backend cũng đã qua, lưu là thiếu thông tin với `option_id=null`.

| Phần kiểm tra | Kết quả của lượt mới | Phạm vi thực tế |
| --- | --- | --- |
| Asinu backend | 79/79, không bỏ qua test | PostgreSQL trong schema riêng; sinh/sửa câu hỏi, quyền, gửi trùng, hai thiết bị, phiên hủy/hết hạn, ghi âm, chữ STT và signed URL; hợp đồng HTTP dùng JWT middleware thật và mock phần biến đổi dữ liệu |
| Cầu nối Doctor | 7/7 | Sự kiện, quyền phụ trách, nhận trùng, đến sai thứ tự, red flag và thu hồi consent |
| App | 9 nhóm hồi quy qua | Chạy handler/component TypeScript thật với phụ thuộc native được kiểm soát |
| Bộ phát âm thanh dùng chung | 131/131 | Hồi quy runtime với audio bridge mô phỏng; không phải kiểm tra nghe trên điện thoại |
| Gallery development | 14/14 | Bảy trạng thái ở giao diện sáng/tối; qua adapter trình duyệt, không gọi API/micro |
| Toàn luồng mở rộng | 23/23 | Component app/Doctor thật, hai backend HTTP/HMAC và AI/TTS/STT thật; thông báo thu vào fixture, micro/audio bridge dùng adapter |
| AI tạo nháp mới | 8/8 bộ hợp lệ | Khó ngủ, đau đầu, ho, đường huyết, sốt và đau bụng; hồ sơ 32–70 tuổi; 1.220–5.351 ms trong mẫu nhỏ |
| Kiểm tra build | Qua | App TypeScript; bundle iOS qua Metro HTTP 200; ESLint, Prettier và kiểm tra khoảng trắng của file backend thay đổi |

Toàn luồng mới đã thử thêm: bỏ qua câu rồi quay lại; mất mạng lúc gửi đáp án (không đổi tiến độ, không đọc xác nhận sai, cho thử lại); ghi âm im lặng hai lần (mời thử lại một lần rồi lưu `no_speech`); xuống nền lúc ghi âm và trở lại cùng câu chưa trả lời; bấm nhanh hai lần; từ chối micro rồi cấp lại; upload file thất bại, đăng ký tiến độ chờ file và tự gửi bù cùng yêu cầu, không tạo đáp án trùng. Các kiểm tra cũ về đọc xác nhận xong mới chuyển câu, red flag trước hết phiên, tải lại, giới hạn câu kết 60 giây, báo cáo, bác sĩ trả lời và đóng đúng ca tiếp tục qua.

Test mới với PostgreSQL còn xác nhận: hai thiết bị trả lời cùng revision thì chỉ một thiết bị ghi được; hai lượt gửi cùng mã yêu cầu chỉ tăng tiến độ/ghi audit một lần; phiên đã hủy không thể mở trả lời lại; phiên hết hạn chưa có đáp án không tự tạo báo cáo. Test sinh nháp mới kiểm tra hai câu gộp ý được sửa đúng vị trí dù AI trả bản sửa khác thứ tự.

Đánh giá nội dung: AI vẫn có ca cần 2–3 lượt sinh/sửa. Mẫu đường huyết cuối cùng hợp lệ về cấu trúc nhưng chỉ hỏi Có/Không, chưa thu số đo đường huyết. Đây là điểm cần bác sĩ kiểm tra/chỉnh trước khi gửi, không được coi các bộ qua validator là đã đủ thông tin chuyên môn. Chưa đo hài lòng của người bệnh hoặc nghiệm thu giọng người lớn tuổi/vùng miền.

Đã mở app trên iPhone 17 Pro / iOS 26.3 Simulator và kiểm tra bundle, nhưng **chưa hoàn tất tương tác IVR native**: gặp hộp thoại mở URL/menu development, màn khởi tạo có log `expo-notifications` và kết nối inspector đóng với mã 1006. Không gộp lần thử này vào số lượt qua, không xem nó là bằng chứng micro, giọng đọc hoặc cuộc gọi màn hình khóa đã hoạt động trên thiết bị.

[Báo cáo và bằng chứng lượt mở rộng](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-thorough-2026-10-23T05-21-01-425Z/verification-summary.json) kèm báo cáo gốc, ảnh giao diện và bản ghi tổng hợp đã upload. Toàn bộ schema/tài khoản/ca/phiên fixture đã dọn. Không xóa dữ liệu thật. Backup trước sửa lỗi HTTP: `/Users/ducytcg123456/Desktop/APP/backups/doctor-ivr-thorough-20261023-121821.tar.gz`.

## Sửa lỗi sinh câu hỏi ngày 23/10/2026

Lỗi ghi nhận ngày 22/10: AI trả “Bác có uống cà phê hoặc trà vào buổi chiều không?” sau 7.589 ms. Validator chặn câu gộp hai ý; việc sinh lại toàn bộ câu hỏi không kịp ngân sách 10 giây. Thử lại thành công hôm đó chưa phải sửa nguyên nhân.

Bản sửa rút gọn chỉ dẫn sinh nháp và thêm nhánh sửa riêng chữ của câu lỗi với đáp án chuẩn Có/Không hoặc tần suất. Các câu hợp lệ và cấu trúc đáp án được giữ lại. JSON bản sửa phải chứa đúng vị trí yêu cầu; bộ sau ghép vẫn qua validator, kiểm tra hỏi lại thời điểm/thuốc, giới hạn thời lượng và bước bác sĩ duyệt. Giới hạn ba lượt AI tổng cộng và ngân sách 10 giây được giữ; audit mã hóa ghi trước/sau khi sửa. Không đổi model hoặc bỏ kiểm tra chất lượng để cho qua.

Kết quả local:

- **61/61** kiểm tra tự động backend qua, gồm PostgreSQL trong schema riêng. Có hồi quy đúng câu lỗi cũ, lần đầu mất 7.589 ms, bản sửa sai vị trí/trùng vị trí/thêm trường, câu sửa vẫn gộp ý/hỏi lại/trùng câu, hết ngân sách, thu hồi consent và phiên bổ sung.
- **17/17** kiểm tra giao diện/API qua: AI tạo nháp, bác sĩ sửa/lưu/duyệt, mời/nhắc sau, chọn đáp án và đọc xác nhận xong mới chuyển câu, red flag, tải lại/quay lại, ghi âm/STT/báo cáo, gửi kết quả và xác nhận đóng ca. Trong lượt này AI thật tạo một câu gộp “lo âu hoặc căng thẳng”; nhánh sửa riêng hoàn tất trong 1.785 ms, toàn bước tạo nháp mất 5.481 ms.
- **9 bộ sinh mới bằng AI thật** về khó ngủ, đau đầu và ho đều trả về nháp qua kiểm tra server; thời gian từ 1.583 đến 5.481 ms trong mẫu thử nhỏ này.
- **1 lần phát lại có kiểm soát**: đưa đúng output lỗi cũ vào sau 7.589 ms, sau đó gọi AI thật để sửa; tổng API mất 9.948 ms, phần sửa mất 2.274 ms và giữ các câu còn lại. Đây là kiểm tra phục hồi lỗi, không phải một bộ sinh mới hoàn toàn bằng AI thật.
- Hai ca cuối ban đầu bị giới hạn số lần tạo câu hỏi chặn (`IVR_RATE_LIMIT`); được kiểm tra riêng trong fixture mới và đều qua. Không sửa hay tắt giới hạn đó. Các lượt bị chặn vẫn có trong báo cáo gốc.
- ESLint, Prettier và kiểm tra khoảng trắng qua. Toàn bộ schema, tài khoản, ca và phiên fixture được dọn; không xóa dữ liệu thật.

[Bằng chứng tổng hợp](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-generation-probes-20261023/verification-summary.json) giữ đường dẫn tới ba báo cáo gốc. Ảnh và báo cáo toàn luồng ở `/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-confirmation-retest-2026-10-22T19-06-59-659Z` (thời gian UTC; ngày 23/10 ở Việt Nam). Backup trước sửa: `/Users/ducytcg123456/Desktop/APP/backups/doctor-ivr-generation-20261023-020357.tar.gz`.

Giới hạn: đây là mẫu kỹ thuật nhỏ, chưa phải cam kết tỷ lệ thành công hay đánh giá hài lòng/chất lượng y khoa. Nhà cung cấp vẫn có thể trả lỗi hoặc quá hạn 10 giây; khi đó hệ thống báo tạo nháp thất bại. Giao diện dùng component thật qua adapter trình duyệt; micro/audio bridge được mô phỏng, bản ghi là giọng tổng hợp, chưa nghiệm thu thiết bị iOS/Android thật trong lượt này.

## Bộ câu hỏi và nháp thực tế của lượt mới

- Bác có cảm thấy khó ngủ vào ban đêm không? → Có / Không / Khác, nói câu trả lời
- Tình trạng này ảnh hưởng đến sinh hoạt của bác thế nào? → Vẫn sinh hoạt như thường / Cần nghỉ rồi mới làm tiếp / Không làm được việc thường ngày / Khác, nói câu trả lời
- Bác có thay đổi thói quen sinh hoạt nào gần đây không? → Có / Không / Khác, nói câu trả lời

Nháp AI hiển thị để bác sĩ duyệt trong lượt này:

> Chào bác, tôi hiểu bác đang gặp khó khăn với giấc ngủ và muốn tìm cách sắp xếp giờ nghỉ ngơi hợp lý. Tình trạng thức giấc giữa đêm và khó ngủ lại có thể ảnh hưởng đến sức khỏe. Bác nên cố gắng duy trì lịch ngủ đều đặn, đi ngủ và thức dậy vào cùng một thời điểm mỗi ngày, kể cả cuối tuần. Tránh sử dụng thiết bị điện tử, ăn no hoặc uống nhiều chất lỏng gần giờ đi ngủ. Nếu tình trạng này kéo dài, bác nên trao đổi thêm với bác sĩ điều trị để có lời khuyên cụ thể hơn.

Đây là dữ liệu kỹ thuật của ca thử, không phải mẫu tư vấn được duyệt chuyên môn để gửi hàng loạt.

## Chức năng và hồi quy

- AI sinh nháp mới, sửa/kiểm tra/lưu/duyệt; gửi lời mời và nhắc sau 15 phút.
- Hiện câu cùng đáp án; chọn khi nghe; lưu và chuyển câu; tiếp tục sau tải lại; quay lại sửa.
- Red flag truyền về Doctor trước khi hỏi hết; gộp cảnh báo trùng; cảnh báo nêu cả câu hỏi thay vì chỉ hiện Có. Nhãn cảnh báo trong fixture được đánh dấu thủ công để thử truyền sự kiện, không phải kết luận lâm sàng của AI.
- Khác thu âm có consent; giữ bản gốc và STT; câu cuối giữ 60 giây sau mở lại.
- Báo cáo và file gốc xuất hiện; chặn nội dung hỏi tiếp ở ô kết quả; bác sĩ gửi kết quả; người bệnh xác nhận đóng đúng ca.
- Không có lỗi JavaScript trong lượt trình duyệt. Có các kiểm tra backend cho nhánh cần hỏi bổ sung, API chặn trả lời sai loại và không cho bệnh nhân đóng khi chưa có kết quả.
- App IVR, Doctor conversations, TypeScript hai frontend và lint file thay đổi qua (lint app không có error, còn warning style). Bundle iOS qua Metro trả HTTP 200.

AI tạo nháp trong lượt chính: 3450 ms. Chọn → ghi nhận câu tiếp: 331 ms. Đây là số đo một lượt kỹ thuật, không phải thời gian sử dụng trung bình.

- headache: 1826 ms, đã sinh và kiểm tra cấu trúc bộ câu hỏi.
- cough: 2699 ms, đã sinh và kiểm tra cấu trúc bộ câu hỏi.

## Dữ liệu và ảnh đối chiếu

Toàn bộ ca, tài khoản và phiên thử nằm trong schema fixture riêng, đã dọn ở cuối lượt. Không sửa dữ liệu bệnh nhân/ca ngoài fixture.

- [Màn hỏi đáp](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-quality-2026-10-21T08-21-06-257Z/05-cau-hoi-benh-nhan.png)
- [Báo cáo bác sĩ](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-quality-2026-10-21T08-21-06-257Z/10-bao-cao-bac-si.png)
- [Kết quả bệnh nhân](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-quality-2026-10-21T08-21-06-257Z/11-ket-qua-benh-nhan.png)
- [Bộ câu hỏi đã duyệt](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-quality-2026-10-21T08-21-06-257Z/question-set.json)
- [Các ca sinh câu hỏi bổ sung để rà soát](/Users/ducytcg123456/Desktop/APP/preview/doctor-ivr-quality-2026-10-21T08-21-06-257Z/additional-scenarios.json)

Thiết kế và giới hạn triển khai: [doctor-ivr-pilot.md](doctor-ivr-pilot.md).
