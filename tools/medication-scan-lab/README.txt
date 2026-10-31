Thử đọc ảnh thuốc — lab độc lập với ứng dụng

Quyết định sản phẩm: docs/srs-v21-decisions-20261030.txt.
Bằng chứng local: ../../preview/medication-scan-20261030 (tính từ thư mục app).

Bộ dữ liệu: 20 ảnh sản phẩm tải từ trang công khai, 7 sản phẩm, gồm ảnh nhiều góc
và bao bì cũ/mới. Đã xem ảnh trước khi chấm, 19 ảnh có tên và 1 mặt bên không
thấy tên. Không có bệnh nhân, đơn in/viết tay, hồ sơ DB hoặc dữ liệu tài khoản.

Cách chạy từ gốc backend.asinu:
  node --test tools/medication-scan-lab/evaluate.test.cjs
  node tools/medication-scan-lab/run.cjs --out=/path/to/dataset
  node tools/medication-scan-lab/report.cjs --out=/path/to/dataset

run.cjs mặc định chỉ kiểm tra dữ liệu, không gọi AI. Thêm --live mới gọi tối đa
20 ảnh chưa có kết quả. Khóa/endpoint đọc từ .env backend, không lưu trong
artifact. Ảnh gửi bằng byte base64, không kèm URL, tên tệp hoặc đáp án.
Không dùng adapter text của app cho ảnh, không thay config/provider runtime.

Lần thử 30/10/2026 dùng med-gemini do Dr7 trả về. Catalog Dr7 đánh dấu
MedGemma hiện tại không hỗ trợ ảnh. Trọng số thực tế của provider không được
lab xác thực độc lập.

Hai prompt, mỗi prompt chạy đủ 20 ảnh: tổng 40 yêu cầu thực tế; không retry.
Lượt đầu đã gọi image-01 qua script smoke; metadata được đối chiếu lại với
ảnh gốc/prompt giữ nguyên và tái sử dụng kết quả đó, không gọi lại cùng lượt.
Nếu một request timeout/crash chưa biết kết quả, pendingRequest giữ nguyên
để người vận hành đối soát; không tự thử lại gây mất credit.

report.cjs giữ nguyên các phản hồi và evaluation ban đầu, rồi chấm cả 2 lượt
bằng cùng bộ chấm cuối (có thêm kiểm tra số món và readable/items nhất quán).
Không dùng ground truth để sửa tên hoặc làm đẹp câu trả lời.

Kết quả lượt v2: 19/19 ảnh có tên đọc đúng tên và số món; ảnh không thấy tên
được từ chối. Không liều/giờ uống tự suy ra trên 20/20. Hợp đồng nghiêm ngặt
đạt 18/20: ảnh 06 thiếu uncertain/phân loại OTHER, ảnh 16 tên hiển thị dài 31
ký tự. Chưa coi kết quả này là nghiệm thu toàn bộ AC-A14 hoặc duyệt y tế.

Trước khi tích hợp: kiểm tra schema phía server, xử lý phản hồi thiếu dữ liệu,
buộc người dùng xác nhận gợi ý, kiểm tên hiển thị 30 ký tự bằng lựa chọn sửa
thay vì cắt cụt tên thuốc; thử thêm đơn nhiều món, đơn viết tay, ảnh mờ/lóa.
Chưa có triển khai nhắc thuốc, migration, native build hay deploy trong lab.
