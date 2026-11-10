# Rà soát cách hỏi và chất lượng nội dung check-in

Ngày: 09/11/2026. Phạm vi triển khai: development local, nhánh `release/doctor-ivr-srs-20261028`.

## Tiêu chí đọc lại hội thoại

- Người dùng hiểu ngay câu đang hỏi về việc gì và vùng nào.
- Các lựa chọn trả lời đúng ý hỏi; có đường nhập/nói thêm khi không khớp.
- Xưng hô theo cùng hồ sơ ở màn hình, mẫu câu cũ, mẫu chi tiết và AI bổ sung.
- Chỉ gọi tên ở lời mở đầu, không lặp lời chào hoặc lời mời chia sẻ ở mỗi câu.
- Không ghép nguyên văn câu người dùng hoặc bản tổng hợp AI vào chỗ dành cho tên triệu chứng.
- Phân biệt thông tin chưa biết với câu phủ nhận, triệu chứng đã hết, việc chưa thử và việc thử nhưng không đỡ.
- Câu hỏi về chăm sóc chung không lặp lại sau từng vùng cơ thể.

Tham khảo nguyên tắc giao tiếp rõ ràng của [AHRQ, Communicate Clearly, Tool 4](https://www.ahrq.gov/health-literacy/improve/precautions/tool4.html): dùng lời thông thường, câu cụ thể và tiếp nhận cách người dùng mô tả vấn đề. Đây là cơ sở rà ngôn ngữ, không phải tài liệu phê duyệt thuật toán phân loại y tế.

## Những điểm đã sửa

| Vấn đề tìm thấy | Cách xử lý |
| --- | --- |
| Câu hành động truyền `Honorific` trong khi mẫu cần `honorific`, có thể hiện dấu giữ chỗ | Truyền đủ bộ xưng hô và kiểm tra tất cả bước mẫu ở cả hai ngôn ngữ |
| Luồng rollback tự tính cách xưng hô khác luồng hiện tại | Dùng chung chính sách tuổi và giới tính |
| AI bổ sung không nhận được quy tắc xưng hô | Truyền quy tắc vào ngữ cảnh sinh và duyệt; từ chối cách gọi “Bạn” không phù hợp hoặc “anh/chị” chung chung |
| Lặp câu “đã thử cách nào” và “đã làm gì” sau mỗi vùng | Giữ câu hiệu quả từng vùng; hỏi một lần về việc chăm sóc thêm, đo chỉ số hoặc tìm hỗ trợ |
| Nhánh tinh thần có lựa chọn “Cử động vùng khó chịu” | Tách lựa chọn phù hợp cho tinh thần, da và toàn thân |
| Không có lựa chọn hiện đã hết đau/khó chịu | Thêm lựa chọn mô tả đúng tình trạng hiện tại; không thay quy tắc cảnh báo đã có |
| Câu hỏi diễn tiến không nhắc trường hợp “vẫn vậy”; câu liên tục/từng lúc không khớp lựa chọn “một lần” | Sửa câu hỏi để bao quát đúng các lựa chọn |
| Hai mức ảnh hưởng sinh hoạt chồng ý | Phân biệt làm chậm hơn nhưng vẫn tự làm với có việc không tự làm được |
| Chỉ cho chọn một nơi đau lan tới | Cho phép chọn nhiều nơi; vẫn có “Không rõ” và câu trả lời riêng |
| Câu hỏi bối cảnh cũ có thể chỉ có “Không rõ”, hoặc yêu cầu tự đoán nguyên nhân bệnh | Đưa các việc có thể tự ghi nhận, có lựa chọn không có thay đổi và nhập/nói thêm |
| Bản tổng hợp cũ hoặc câu “Tôi…” được đưa vào câu hỏi như một tên triệu chứng | Dùng câu hỏi tham chiếu chung khi không có tên triệu chứng ngắn, rõ |
| Luồng hỏi chi tiết làm mất thông tin vùng ở câu triệu chứng đầu tiên | Lấy lại vùng từ trạng thái của lượt hỏi; câu hỏi tinh thần/toàn thân dùng cách hỏi phù hợp |
| Lựa chọn hiển thị các chú thích như “nghi …”, “hội chứng đuôi ngựa” | Ẩn chú thích chẩn đoán nội bộ ở phần hiển thị; giữ nguyên giá trị gửi về server và số đo/thời lượng cần thiết |
| Hướng dẫn thực hành hỏi diễn tiến nhưng không có lựa chọn | Bổ sung lựa chọn diễn tiến và một câu chia sẻ thêm riêng cho bước thực hành nhập/nói |
| Phần xem trước hướng dẫn không truyền từ xưng hô | Dùng cùng cách xưng hô với màn check-in |

Ví dụ câu đã đọc lại:

- “Chú thấy khó chịu như thế nào ở đầu và tay chân?”
- “Chỗ khó chịu ở bụng bắt đầu từ khi nào vậy?”
- “Từ lúc mới bị đến giờ, chỗ khó chịu ở bụng đỡ hơn, vẫn vậy hay nặng hơn?”
- “Với chỗ khó chịu ở bụng, chú đã thử cách nào và thấy thế nào?” Đi kèm các lựa chọn nghỉ ngơi thấy đỡ, đã thử nhưng chưa giảm, chưa thử, chưa rõ và câu trả lời riêng.
- “Ngoài các cách vừa kể, chú đã làm gì thêm để chăm sóc sức khỏe?” Câu này hỏi một lần sau các vùng.

Các câu và đáp án đã lưu ở phiên trước được giữ nguyên khi tiếp tục. Câu chăm sóc theo vùng của phiên cũ vẫn được đọc vào báo cáo, không ép trả lời lại bằng câu mới.

## Bằng chứng kiểm tra

- Ma trận 112 hội thoại tự động: 7 nhóm biểu hiện × 8 hồ sơ tuổi/giới tính × 2 ngôn ngữ. Kiểm tra đi đến kết luận, bước không lặp, từ xưng hô, lựa chọn có nội dung và các nhánh đau/không đau.
- Đọc lại 9 hội thoại xuất từ các hàm thực tế: từng nhóm, nhiều vùng, câu đau lan/từng đợt và tiếng Anh. Đây là dữ liệu giả lập, không phải dữ liệu sức khỏe người dùng.
- Kiểm tra các nhánh cũ đang tiếp tục, lựa chọn không rõ, câu tự nhập, mẫu sai từ AI, AI từ chối thêm câu, sai xưng hô và các trường hợp nguy hiểm theo bộ hồi quy hiện có.
- Gọi thật Dr7 với hai tình huống giả lập, xác nhận endpoint Dr7 và model `medgemma-4b-it`. Cả hai trả về không cần câu AI bổ sung sau khi đã nhận kế hoạch câu mẫu; không ghi nhận đó là bằng chứng AI đã sinh và duyệt một câu mới. Nhánh sinh/duyệt câu mới có kiểm tra riêng bằng phản hồi giả lập.
- Kiểm tra TypeScript, i18n, hướng dẫn, Home, tiến độ, khung nhìn câu hỏi, màn chờ kết luận và cơ chế ưu tiên hiển thị.
- Kết quả cuối: `npm test` backend có 2.217 bài đạt, 354 bài bỏ qua theo cấu hình hiện tại; nhóm nội dung, AI bổ sung và dữ liệu kết luận có 334 bài đạt. App có 111 kiểm tra thực hành, 71 hướng dẫn, 47 kết luận và 13 kiểm tra ưu tiên hiển thị đạt. Bundle iOS development trả HTTP 200.
- Câu trả lời “Chưa làm gì thêm” được giữ riêng trong dữ liệu kết luận, không biến thành một việc đã làm và không xoá thông tin “Nghỉ ngơi thấy đỡ” ở câu trước.

## Lỗi nút Tiếp tục sau khi huỷ

Agent kiểm tra riêng xác nhận server đã huỷ, nhưng Home còn cache phiên cũ. Đồng thời, khi form được bật lại trước lúc điều hướng hoàn tất, autosave có thể tạo lại bản nháp vừa xoá.

Đã sửa: làm mất hiệu lực cache theo tài khoản sau khi huỷ thành công, chặn phản hồi lấy dữ liệu bắt đầu trước thời điểm huỷ và giữ form khoá cho đến khi rời màn hình. Kiểm tra 44 ca Home, 25 ca tiến độ và 3 ca vòng đời huỷ, gồm tái hiện cách xử lý cũ để xác nhận bài kiểm tra bắt đúng lỗi.

Bản nháp vị trí được tạo lại từ bản code cũ không có mã phiên server, nên không tự xoá mọi bản nháp khi cập nhật. Nếu còn bản nháp như vậy, mở và huỷ một lần trên code mới sẽ xoá đúng bản nháp đó; bản nháp chưa gửi hợp lệ vẫn được tiếp tục.

## Giới hạn đánh giá

Đã rà nội dung thực tế và các nhánh phần mềm; chưa thực hiện thử nghiệm độ dễ hiểu với người dùng thật trong đợt này. Kiểm tra tự động không thay thế đánh giá đó. Chưa triển khai thay đổi này lên VPS.
