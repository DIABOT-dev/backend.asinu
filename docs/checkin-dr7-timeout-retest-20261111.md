# Chạy lại Dr7 sau timeout — 11/11/2026

## Kết quả

**44 lời gọi Dr7, không có timeout hoặc lỗi HTTP trong đợt chạy lại tuần tự.** Gồm ba lần chạy hết hội thoại của hai tình huống giả và một kiểm tra riêng bộ sinh câu hỏi. Ca khó ngủ đã bị dừng do timeout trước đó nay đã đi đến kết luận.

Không tăng thời hạn chờ trong production và không chuyển sang nhà cung cấp AI khác. Các lời gọi kiểm thử cách nhau ít nhất sáu giây sau khi lời gọi trước kết thúc. Thời gian chờ này chỉ ở công cụ đánh giá, không được thêm vào ứng dụng.

| Lượt | Mục đích | Lời gọi Dr7 | Kết luận | Nhận xét |
|---|---|---:|---:|---|
| Khó ngủ đầu giấc đã mô tả rõ | Chạy lại ca từng timeout sau sửa prompt | 13 | 2.211 ký tự | Không hỏi lại tính chất đã có; hết hội thoại. Một câu cảnh báo chuyển dự phòng vì chữ hoa/thường, đã tái hiện và sửa |
| Khó ngủ chưa mô tả kiểu | Tìm lỗi ở trường hợp khác của cùng nhóm | 13 | 2.057 ký tự | Hết hội thoại. Câu đầu chuyển dự phòng vì mã lựa chọn bằng tiếng Việt, đã tái hiện và sửa |
| Cùng ca trên, sau sửa mã lựa chọn | Kiểm tra lại bằng Dr7 thật | 15 | 2.590 ký tự | Câu đầu đã có đáp án AI. Một câu cảnh báo bị từ chối do lời dẫn thừa; đã sửa và replay chính đầu ra đó bằng hồi quy |
| Tính chất khó ngủ còn thiếu — kiểm tra riêng bộ sinh câu hỏi | Kiểm tra thực tế đáp án không lẫn chóng mặt | 3 | Không áp dụng | Câu/đáp án có nguồn AI; không phải một hội thoại đầy đủ hay bằng chứng rằng planner luôn chọn đủ chi tiết |

Lời gọi đơn lẻ lâu nhất: **6.442 ms**. Các giới hạn đang dùng vẫn là 10 giây tạo câu, 5 giây duyệt, trích xuất 10–18 giây tùy nội dung và tối đa 60 giây cho phần kết luận. Các số đo này thuộc tình huống giả khi gọi có khoảng nghỉ, không đại diện tải production hoặc cam kết dịch vụ ngoài sẽ không bao giờ timeout.

## Các lỗi gây gọi lại thừa đã sửa

1. **Hoa/thường ở cảnh báo:** Dr7 trả “Mất ngủ kèm sụt cân nhanh” thay cho câu được quản lý “mất ngủ kèm sụt cân nhanh”. Server khôi phục đúng nhãn đã duyệt khi mã và nội dung trùng hoàn toàn sau chuẩn hóa hoa/thường. Đổi dấu hiệu, tốc độ sụt cân hay mã cảnh báo vẫn bị từ chối.
2. **Mã lựa chọn mở:** Dr7 dùng `khó ngủ`, `ngủ không sâu giấc` làm ID. Server sinh mã nội bộ hợp lệ cho các lựa chọn mở, giữ nguyên đáp án hiển thị. Thang mức độ, thời gian, nguồn gốc, cảnh báo và các mã được quy định không được đổi theo cách này. ID có nội dung không hợp lệ vẫn bị chặn. Prompt cũng chỉ rõ định dạng ID.
3. **Lời dẫn thừa:** “Chị cho mình hỏi, ngoài việc khó ngủ…” làm cả câu và đáp án bị bỏ dù phần câu hỏi phía sau đã đầy đủ. Server bỏ đúng lời dẫn có thể tách rời, giữ câu hỏi và đáp án. Đoạn cụt như “cho mình hỏi về…” không được biến thành câu hợp lệ.

Các sửa này giảm lời gọi lại do định dạng, không nới kiểm tra ý nghĩa đáp án hay sửa nội dung cảnh báo. Các lần chuyển dự phòng do kiểm tra nội dung trong các lượt trước vẫn được ghi nhận, không tính thành lỗi timeout hoặc giấu khỏi bằng chứng.

## Đọc lại câu hỏi và kết luận

Kiểm tra riêng phần tính chất trả:

> Chị khó ngủ cụ thể là như thế nào?

- Khó đi vào giấc ngủ.
- Hay thức giấc giữa đêm.
- Thức dậy quá sớm và không ngủ lại được.
- Ngủ dậy vẫn thấy mệt mỏi, không sảng khoái.
- Không rõ; Khác, nhập hoặc nói câu trả lời.

Không lẫn quay cuồng, muốn xỉu hoặc mất thăng bằng như đầu ra lỗi trước sửa. Các kết luận đã đọc giữ đúng thời gian, ảnh hưởng sinh hoạt và lo công việc ở dạng dữ kiện/khả năng liên quan; không bịa chỉ số hay chẩn đoán mới. Văn phong vẫn còn chỗ dài và chung. Trong một hội thoại, model không yêu cầu thêm tính chất cho “khó ngủ”; kiểm tra riêng bộ sinh câu hỏi không chứng minh quyết định chọn câu của planner đã hoàn thiện. Kết quả không timeout không thay cho nghiệm thu toàn bộ chất lượng y tế.

## Kiểm chứng và phạm vi

- Bộ mặc định sau sửa mã/hoa-thường: **147 suite, 12.664 test pass**, gồm **10.240 mô phỏng**; 21 suite/381 test skip.
- Sau sửa lời dẫn cuối cùng: **155/155** hồi quy liên quan pass.
- HTTP với PostgreSQL local: **52/52** pass; lint và `git diff --check` pass.
- Hội thoại Dr7 dùng người giả trong transaction rollback; không thêm kết quả sức khỏe của tài khoản thật.
- Bằng chứng mới được thêm vào [checkin-quality-evidence-20261111.json](checkin-quality-evidence-20261111.json), giữ lại cả lượt timeout cũ và các lượt chưa sửa.
- Sau kiểm thử, người dùng đã yêu cầu commit và push riêng từng phần trên `change/check-in`. Đợt này không merge vào `main` hoặc deploy.
