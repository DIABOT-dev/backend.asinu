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

- Backend: lần chạy cuối 136 suite qua, 2.002 test qua; 338 test bỏ qua theo cấu hình suite.
- HTTP với database: 40 test qua; có cả các vùng cơ thể, tiếng Việt/Anh, tiếp tục phiên, câu hỏi sinh mới, provider lỗi và kết luận được lưu.
- App: TypeScript qua; hợp đồng API qua; 86 kiểm tra hành vi check-in, 6 kiểm tra thứ tự layout/bàn phím, 71 kiểm tra hướng dẫn và 8 kiểm tra trạng thái chuẩn bị câu hỏi qua. Bộ hiển thị kết luận cũng qua.
- i18n backend/app qua. ESLint không có lỗi; backend còn một cảnh báo có sẵn ở `src/services/v21/audio.service.js`.
- Ba ca giả lập được gọi thật tới DR7: nhận câu hỏi bổ sung phù hợp; bỏ các câu trùng với phần nền; duyệt lại hoặc chuyển trả lời mở khi nội dung không đạt. Đây là kiểm tra kỹ thuật với dữ liệu giả, không phải nghiệm thu lâm sàng.
- Một số lần chạy trước gặp 401 trong fixture HTTP và một 404 ở suite QR không liên quan phần sửa. Các vòng HTTP chạy riêng tiếp theo và lần chạy toàn bộ cuối đã qua; chưa xác định nguyên nhân các lỗi không ổn định này, không thay logic xác thực để bỏ qua kiểm tra.

## Giới hạn nghiệm thu

- Chưa có máy thật kết nối để xác nhận cảm giác cuộn, bàn phím và thao tác đọc/nói trên iOS/Android. Test thứ tự sự kiện native dùng adapter mô phỏng.
- Duyệt bằng model và validator giảm lỗi, không chứng minh mọi câu hỏi y tế đều chính xác. Cần người phụ trách chuyên môn xem mẫu và thử với người dùng trước khi kết luận chất lượng sử dụng.
- Bản này được kiểm tra và áp dụng ở local; chưa triển khai thay đổi này lên VPS.
