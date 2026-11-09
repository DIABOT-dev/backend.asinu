# Check-in: câu hỏi bổ sung và đáp án — 09/11/2026

## Tiêu chí

1. Thu thập theo từng vùng khó chịu và thông tin của người dùng; đưa các câu trả lời bổ sung vào dữ liệu tổng hợp kết luận.
2. Đáp án phải trả lời đúng câu hỏi. Câu chọn một không được trộn các thuộc tính có thể đồng thời đúng; khoảng thời gian không chồng nhau.
3. Câu hỏi dùng lời thông thường, hỏi một ý; bỏ câu trùng hoặc đã có thông tin. Không dùng số lượng câu cố định để ép kết thúc phần khai báo chi tiết.

## Hành vi triển khai

- Giữ các câu hỏi có sẵn, câu hỏi dấu hiệu nguy hiểm và các nhánh điều kiện. Mô tả tự do về từng cơn hoặc đau lan vẫn mở câu hỏi tiếp theo tương ứng.
- Câu trả lời ngoài lựa chọn tạo nguồn thông tin cần làm rõ. DR7 sinh thêm câu hỏi cùng lựa chọn, dựa trên câu trả lời gốc, tuổi, bệnh nền, vị trí, số đo, thông tin đã hỏi và các mục sẽ hỏi tiếp.
- Kiểm tra cấu trúc, độ dài, câu trùng, khoảng số và một số lỗi lựa chọn trước khi duyệt nội dung bằng DR7. Tối đa hai lần sinh; mỗi lần có thể thêm một lần duyệt. Không chuyển sang nhà cung cấp khác khi lỗi.
- Model sinh theo `CHECKIN_QUESTION_MODEL`, nếu không đặt thì dùng `MEDGEMMA_MODEL`. Model duyệt mặc định `medgemma-27b-it`; điều chỉnh bằng `CHECKIN_QUESTION_REVIEW_MODEL`.
- DR7 lỗi hoặc nội dung không qua kiểm tra: hiển thị câu trả lời mở có nhắc lại nội dung gốc, cho nhập/nói hoặc chọn “Không có gì thêm”. Ghi nhận việc thu thập chưa đủ; không giả lập câu hỏi/đáp án từ AI.
- “Khác” mở nhánh nhập/nói, không gửi chính nhãn “Khác” làm câu trả lời. Câu trả lời mới có thể dẫn tới câu hỏi bổ sung; các lựa chọn có sẵn không tự gây thêm lần sinh.
- Câu hỏi đã sinh được lưu cùng phiên, giữ nguyên khi mở lại. Trạng thái bổ sung được bảo vệ bằng cơ chế mã hóa trường hiện có; không trả payload nội bộ ra API màn hình.
- Dấu hiệu nguy hiểm được kiểm tra trên câu trả lời thực tế, không lấy toàn bộ đáp án chưa được chọn làm triệu chứng.
- Kết luận nhận nguyên văn câu hỏi/câu trả lời bổ sung cùng hồ sơ và dữ liệu theo từng vùng; không coi dữ liệu thiếu là đã được xác nhận.
- Giới hạn 128 câu trả lời là giới hạn kích thước request. Dành chỗ cho các câu hỏi nền/nhánh điều kiện; nếu chạm giới hạn thì đánh dấu thu thập chưa đủ.
- App đưa câu mới về đầu sau khi nội dung và bàn phím cập nhật. Chọn thêm đáp án trong cùng câu hoặc chủ động kéo màn hình không bị tự kéo lại.

## Cấu hình và tương thích

- App mới gửi `adaptive_questions: true`. Client cũ giữ hợp đồng luồng hiện có; các đáp án thời gian cũ vẫn được đọc.
- `CHECKIN_ADAPTIVE_QUESTIONS_ENABLED=false` hoặc `0` ngừng nhánh sinh mới.
- Các lời gọi AI trong check-in dùng adapter MedGemma với `strictProvider: true`. Endpoint local đã kiểm tra bằng lời gọi thật là `dr7.ai`.
- Không thêm migration hoặc native module. Thay đổi app là JavaScript/TypeScript.
- Logic bổ sung ở service; controller nhận/kiểm tra payload và gọi service.

## Kiểm tra

- Backend: 136 suite, 2.047 test qua; 344 test được bỏ qua theo cấu hình suite. Các suite database cần cờ riêng và được chạy tách ở local.
- HTTP với database: 43 test qua; có cả các vùng cơ thể, tiếng Việt/Anh, tiếp tục phiên, hai request mở lại đồng thời, câu hỏi sinh mới, provider lỗi, kết luận được lưu và chặn ID câu hỏi từ phiên trước khi bắt đầu hỏi lại.
- App: TypeScript qua; hợp đồng API qua; 93 kiểm tra hành vi check-in, 21 kiểm tra lưu/khôi phục nháp, 6 kiểm tra thứ tự layout/bàn phím, 71 kiểm tra hướng dẫn và 8 kiểm tra trạng thái chuẩn bị câu hỏi qua. Bộ hiển thị kết luận 47 kiểm tra cũng qua.
- i18n backend/app qua. ESLint ở các file thay đổi không có lỗi; app vẫn có cảnh báo style/hook ở màn check-in và các file liên quan. Chưa xử lý toàn bộ cảnh báo trong lần sửa này.
- Ba ca giả lập được gọi thật tới DR7: nhận câu hỏi bổ sung phù hợp; bỏ các câu trùng với phần nền; duyệt lại hoặc chuyển trả lời mở khi nội dung không đạt. Đây là kiểm tra kỹ thuật với dữ liệu giả, không phải nghiệm thu lâm sàng.
- Test lại đã bắt và sửa: bí danh “Không chắc chắn” bị hiện trùng “Không rõ”; kiểu dữ liệu đáp án không phải chuỗi; khoảng số chứa `null` sai chỗ; đơn vị `mg/dL` bị nhầm với liều thuốc; câu hỏi ghép nguyên câu xưng “tôi”; xác nhận có đau sau đó nhưng thiếu nhánh hỏi đau; tiêu đề vùng bị lấy từ câu nền kế tiếp; lựa chọn nhiều bị mất đáp án đã chọn khi bấm “Khác”; kết luận nói thiếu tiền sử dù đã khai.
- Một số lần chạy trước gặp 401/404 không ổn định trong HTTP fixture. Đã chuyển fixture sang server giữ suốt bài test, bind IPv4 đúng địa chỉ Supertest kết nối. Suite QR chạy lại 15 lượt đều qua; toàn bộ suite chạy sau đó cũng qua. Đây là thay đổi cách dựng test, không bỏ qua kiểm tra quyền hoặc sửa logic xác thực để làm test qua.
- Phiên HTTP trên backend local đang chạy, dùng DR7 thật: hoàn thành 19 câu (3 câu AI có lựa chọn, 1 câu trả lời mở và các câu nền). Kiểm tra đã ghi nhận nhánh đau xuất hiện thêm, câu hỏi không lặp nguyên văn, giữ tiến độ khi mở lại, gửi hai request đồng thời, lưu kết luận và trả lại cùng kết luận khi retry. Dữ liệu tài khoản thử được dọn sau bài test. Kết luận có nguồn `ai`, nhắc lại đúng các thông tin bổ sung và không còn nói thiếu tiền sử đã khai.
- Chạy lại phiên HTTP với DR7 thật sau khi bổ sung bảo vệ tiến độ: 19 câu trong khoảng 29 giây cho dữ liệu giả, có 3 câu AI sinh kèm lựa chọn và 1 câu trả lời mở sau kiểm tra chất lượng. Kết luận có `conclusionSource=ai`, nhắc đúng thông tin tai trái; request có `phase_id`, yêu cầu cũ bị trả 409, mở lại/gửi trùng không thay đổi câu đang hỏi. Tài khoản thử được xóa sau phiên. Đây không phải số đo độ trễ trên thiết bị người dùng.
- Lần test tiếp bắt được hai nhóm lỗi tiến độ: request cũ ghi lùi lịch sử chưa hoàn tất; phản hồi cũ xóa nháp mới cùng phiên hoặc khác lần hỏi bổ sung. Backend hiện chỉ chấp nhận lịch sử đã lưu hoặc phần nối tiếp có cùng tiền tố; app reload tiến độ khi nhận `TRIAGE_CHANGED`. Khóa nháp tách theo lần hỏi, thao tác xóa kiểm tra đúng bộ đáp án đã được xác nhận và chạy tuần tự với thao tác lưu. Có kiểm thử dữ liệu nháp phiên bản cũ.
- App xử lý riêng trường hợp tải lại tiến độ thất bại: không mở các nút trả lời của câu cũ. Nhánh retry mất mạng vẫn gửi lại nguyên yêu cầu đang chờ.
- Qua thử giao diện native đã rút gọn câu kiểm tra dấu hiệu nguy hiểm; không ghép cả câu nhập tự do vào vị trí danh từ trong mẫu câu. Thông tin gốc vẫn được giữ trong dữ liệu tổng hợp; bài test HTTP kiểm lại đáp án cảnh báo theo triệu chứng nền.
- GitHub Actions của lần trước (`08fc9b6`) đã qua: https://github.com/DIABOT-dev/backend.asinu/actions/runs/42554725093. Lần sửa này phải xem run tương ứng commit mới nhất.

## Thử giao diện native iOS ở local

Dùng bản Debug build từ source hiện tại, Metro local, iOS 26.5 trên Simulator iPhone 17 Pro riêng tên `Asinu Checkin QA 20261109`. Dùng tài khoản giả đã khai xong hồ sơ; không sửa tài khoản người dùng thật.

| Thao tác | Kết quả đã quan sát/kiểm tra |
| --- | --- |
| Đăng nhập và mở Không ổn → Hơi mệt | Mở đúng luồng thật, không dùng màn preview |
| Chọn Đầu + Ngực, sau đó Trán + Giữa ngực | Mỗi vùng có câu vị trí riêng; câu tiếp theo nằm trong phần nhìn thấy |
| Chọn Đau đầu trong câu nhiều lựa chọn | Giữ phần câu hỏi trong màn hình, không nhảy xuống cuối |
| Nhập thêm câu tự do | Bàn phím iOS xuất hiện, nội dung nhập hiển thị và giữ cùng đáp án đã chọn |
| Gửi câu trả lời rồi sang câu kế | Màn hình về đầu; bàn phím đã đóng, số câu đã trả lời tăng đúng một |
| Tắt/mở lại app rồi mở đường dẫn check-in | Tiếp tục câu đang hỏi; lịch sử giữ cả đáp án chọn và nội dung nhập |
| Kiểm database và dọn tài khoản giả | Chỉ một câu trả lời được lưu; đã xóa tài khoản cùng dữ liệu phát sinh |

Ảnh và kết quả XCTest lưu ở `/tmp/asinu-checkin-ui-20261109/`: `positions.xcresult`, `keyboard-point.xcresult`, `next-top.xcresult`, `resume-history.xcresult`. Bài keyboard ban đầu dừng vì bộ chọn XCTest tìm nút Tiếp tục dưới dạng StaticText, trong khi native xuất phần tử Other; phần nhập và bàn phím đã có ảnh, thao tác gửi/chuyển câu được kiểm tiếp bằng selector đúng ở bài `next-top`. Không ghi nhận cả bài keyboard đó là pass. Không phải toàn bộ phiên 19 câu đã được thao tác qua UI native; phiên hoàn chỉnh được thử riêng qua HTTP.

## Giới hạn nghiệm thu

- Đã có bằng chứng thao tác native trên iOS Simulator như bảng trên. Chưa nghiệm thu micro/nhận dạng giọng nói trên máy iOS/Android thật; chưa có bài UI Android cho lần sửa này. Test thứ tự sự kiện layout/bàn phím tự động còn có adapter mô phỏng.
- Duyệt bằng model và validator giảm lỗi, không chứng minh mọi câu hỏi y tế đều chính xác. Cần người phụ trách chuyên môn xem mẫu và thử với người dùng trước khi kết luận chất lượng sử dụng.
- Bản này được kiểm tra và áp dụng ở local; chưa triển khai thay đổi này lên VPS.


## Rà soát cuộc gọi/notification chen vào kết luận

Đã xác nhận trên log local một lượt `EARLY_SIGNAL` mức `URGENT` được tạo ngay sau khi ghi kết quả check-in. Phần câu hỏi check-in dùng chung hạ tầng cuộc gọi để liên hệ lại chính người vừa trả lời, trong khi màn kết luận đang chờ audio. Đây là lỗi phối hợp trải nghiệm, không phải người dùng chủ động gọi tổng đài.

Các bản sửa lần này:

- Bộ dò Tín hiệu sớm chỉ dùng câu trả lời và nhật ký triệu chứng đã khai báo, có lọc phủ định; không quét toàn bộ câu hỏi, lựa chọn chưa chọn hay lời dặn trong kết luận. Giữ cờ cấp cứu rõ ràng từ check-in và mức critical từ phiên có kịch bản.
- Server đánh dấu `patientPresent` khi người dùng vừa bắt đầu/trả lời/hoàn tất check-in. Tín hiệu sớm còn xử lý liên hệ người thân phù hợp, nhưng không tạo thêm cuộc gọi/notification cuộc gọi tới chính người đang check-in.
- Nếu một cuộc gọi tới người đó đã được xếp trước khi họ quay lại check-in, hủy lượt gọi và delivery của chính họ; giữ nhánh hỗ trợ người thân, không đặt lại thời hạn hay gọi trùng người thân khi retry.
- Không có người thân phù hợp thì không dùng cuộc gọi lại bản thân làm phương án thay thế. Đánh giá vẫn được lưu trong Tín hiệu sớm.
- Hướng dẫn đi khám đã có trong kết luận API không phát thêm self-push ngay trước khi app nhận kết quả. Các nhánh báo người thân và xử lý cấp cứu vẫn được giữ.

Bằng chứng test mới: toàn bộ 136 suite local có 2.047 test qua (344 test bỏ qua theo cấu hình); 43 test HTTP/database và 3 ca PostgreSQL về định tuyến khi người dùng đang có mặt qua khi chạy riêng. Các ca dùng lời dặn có điều kiện và đáp án phủ định đã tái hiện báo nhầm trước khi sửa; sau sửa chỉ triệu chứng đã khai báo/cờ cấp cứu mới tạo red flag. Test với PostgreSQL kiểm tra liên hệ người thân trực tiếp, không tạo incoming delivery tới người vừa check-in, không có người thân, hủy cuộc gọi của chính người dùng khi họ quay lại, và retry không tạo thêm cuộc gọi người thân. Chỉ dùng tài khoản giả và dọn dữ liệu sau test. Không thay đổi dữ liệu cảnh báo cũ của người dùng. Lượt CI đầy đủ đầu tiên bắt lỗi fixture cũ dùng chung mảng tài khoản với các ca mới; đã tách nhóm tài khoản theo ca. Sau đó tạo database local riêng, chạy toàn bộ migrations và cả 6 test của bộ cuộc gọi đều qua; database thử đã được xóa.

Phát lại thuần logic trên snapshot local (không ghi database, không phát thông báo) cho thấy các red flag lấy nhầm từ lời dặn đã mất, nhưng mức urgent còn tồn tại theo quy tắc hai lần “Rất mệt” trong 7 ngày. Quy tắc phân tầng này cần được người phụ trách sản phẩm/chuyên môn rà lại riêng; bản sửa không tự thay ngưỡng.

### Luồng kết luận được người dùng xác nhận

Người dùng đã xác nhận phải giữ màn “Asinu đang tạo kết luận” trong lúc chuẩn bị cả nội dung và giọng đọc. Chỉ khi nội dung cùng audio tương ứng sẵn sàng mới mở phần kết luận và đọc cho người dùng nghe. Không mở màn kết luận trước rồi mới bắt đầu tải audio tại màn đó. Đề xuất trước đây về việc hiện chữ trước, tải audio sau không đúng yêu cầu này và đã được rút lại.

Cơ chế chờ audio hiện có được giữ nguyên. Việc cần xử lý là cuộc gọi/self-notification chen vào khi đang chuẩn bị kết luận; nhánh cảnh báo người thân vẫn hoạt động theo mức độ. Nhánh dự phòng khi audio lỗi hoặc timeout là xử lý ngoại lệ, không phải luồng tải bình thường.

### Khoảng trống nghiệm thu trải nghiệm còn lại

Rà soát độc lập chỉ ra các test qua chưa đủ để coi toàn bộ luồng đã mượt:

- Cần nghiệm thu sự đồng bộ giữa màn chuẩn bị, nội dung và audio theo luồng đã xác nhận ở trên, cùng các tình huống âm thanh lỗi/chậm. Việc chờ audio trước khi mở kết luận là yêu cầu sản phẩm, không được coi là lỗi trải nghiệm để tự bỏ.
- Hai phần trăm loading là ước tính theo thời gian. Câu nền trả nhanh, câu bổ sung có thể qua sinh/duyệt/sinh lại; hiện chưa thể hiện nhất quán các giai đoạn đó.
- Câu chọn một tự gửi, câu nhiều lựa chọn cần Tiếp tục; frontend còn suy đoán chế độ chọn từ câu chữ. Tổng số câu có thể tăng khi mở nhánh mới.
- Cơ chế khôi phục giữ các câu đã gửi và yêu cầu đang chờ đồng bộ. Chưa lưu phần đang gõ/tick trong câu hiện tại trước khi bấm gửi.
- HTTP suite hiện mock tác vụ Tín hiệu sớm để tách kiểm thử. Vì thế nó không chứng minh được toàn bộ chuỗi câu hỏi → kết luận/audio → cảnh báo/notification cùng hoạt động trên thiết bị. Cần nghiệm thu hành trình này với các module bật đồng thời, kể cả lúc thoát app/mất mạng.

Các vấn đề trên là khoảng trống thiết kế/triển khai và cách nghiệm thu, không phải bằng chứng rằng chỉ thêm một agent mới sẽ giải quyết được. Thay đổi lần này áp dụng ở local; chưa deploy VPS.
