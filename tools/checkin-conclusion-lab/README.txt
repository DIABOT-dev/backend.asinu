SRS 29/10/2026: bước 0, phòng thử kết luận check-in

Không import thư mục thử nghiệm này từ runtime. Founder đã đồng ý hướng P2
và các quy tắc chỉ số sau bài thử bước 0. Phần tích hợp hiện ở
src/core/checkin/triage-conclusion.js; xem docs/checkin-conclusion-srs-20261029.txt.

node --test tools/checkin-conclusion-lab/lab.test.cjs
node tools/checkin-conclusion-lab/run.cjs          (chỉ dựng báo cáo, không gọi AI)
node tools/checkin-conclusion-lab/run.cjs --live   (tối đa 15 lần gọi thật)

Chỉ fixture cố định giả lập, không đọc database hoặc dữ liệu người dùng.
Dùng MEDGEMMA_ENDPOINT/API_KEY cấu hình trong .env, bắt buộc HTTPS; không in key.
Yêu cầu model medgemma-27b-it, temperature 0.2, tối đa 700 token.
Không tự retry, không fallback sang provider/model khác; dừng nếu 401/402/403.
Lưu ngay sau mỗi lần gọi; chạy lại tự bỏ qua các lần đã ghi.
Timeout đo 60 giây để quan sát độ trễ; mục tiêu app 10 giây vẫn chấm riêng.
P1 được chụp lại nguyên bản trong baseline.json từ source lúc bước 0,
không đọc prompt đã nâng cấp để làm giả một baseline cũ.
P2 trích nguyên văn từ DOCX, P3 bỏ ví dụ, P4 giới hạn 4 câu, P5 giải thích 4–5 câu.
Không sửa bộ luật mức độ, luồng cấp cứu, câu dự phòng hay màn app hiện tại.

Kết quả: APP/preview/checkin-conclusion-20261029/index.html, JSON, CSV,
phiếu chấm để trống và P1–P5.html dùng chụp ảnh. Không ghi phê duyệt giả.
Giữ riêng số token và credits, không tự suy ra credits từ số token.
Founder đã chốt hướng prompt trong hội thoại. Người có chuyên môn y tế
vẫn cần duyệt 30 ca và các con số trước khi bật cho người dùng thật.

Bộ lọc thử dùng từ điển hữu hạn và regex, không phải bộ kiểm chứng y khoa.
Lưu raw response để phát hiện loại oan/bỏ sót. SRS FR-2 và E2 mâu thuẫn về
việc trích số đo 7 ngày khi 24h chưa đo; bộ lọc thử ưu tiên E2 và ghi rõ lỗi.

Bài thử bản tích hợp:
node tools/checkin-conclusion-lab/eval-structured.cjs --live --round=r2
(mỗi vòng mới tối đa 3 + 30 lượt trả phí, không retry; resume tự bỏ lượt đã lưu)
node tools/checkin-conclusion-lab/replay-structured.cjs
(chỉ replay raw response r2 đã lưu, không gọi nhà cung cấp)
node tools/checkin-conclusion-lab/replay-structured.cjs --round=deep-recheck
(replay vòng kiểm thử sâu, giữ thời điểm đánh giá gốc cho luật 24h/hôm nay/hôm qua)
Xem docs/checkin-conclusion-deep-test-20261029.txt cho kết quả hồi quy mới nhất.

Đối chiếu SRS đầy đủ mới nhất:
node tools/checkin-conclusion-lab/srs-audit.cjs --round=retest-2-fix
Chỉ dùng raw response đã lưu; không đọc .env/DB hoặc gọi API. Giữ thời điểm
đánh giá gốc, lưu srs-audit.json riêng, không ghi đè raw response hoặc báo cáo cũ.
Đo AC-4 từ log thực của generator, gồm cả lỗi bố cục/hành động có con số.
Vòng cuối retest-2-fix đạt AC-4 (0/30); giữ các vòng cũ để đối chiếu. Vòng
retest-20261029-1 bị phát hiện lỗi tiếng Việt trong ca tiếng Anh, đã sửa và
thêm 9 hồi quy trước vòng retest-lang-fix.
Vòng retest-20261029-2 có 3/30 = 10%, chưa đạt; sau đó sửa ngân sách câu cho
số đo, loại oan câu xác nhận thiếu thông tin và chiều kiểm tra ngôn ngữ ngược.
Xem docs/checkin-conclusion-retest2-20261029.txt.
eval-structured.cjs hỗ trợ --credit-before=<số dư đã quan sát> để lưu chênh lệch
header credits riêng với token; chênh lệch có thể gồm sử dụng đồng thời của tài khoản.

AC-9: hồ sơ cho người có chuyên môn và P6 duyệt:
node tools/checkin-conclusion-lab/prepare-clinical-review.cjs --round=retest-2-fix
(tạo packet + phiếu HTML + template để trống; từ chối ghi đè hồ sơ đã có)
npm run check:checkin-conclusion-approval -- --packet=<packet.json> --approval=<biên-bản-người-duyệt.json>
(chỉ đọc, không dùng .env/DB/provider; exit 1 nếu chưa duyệt đủ hoặc không khớp)
Người duyệt đọc từng ca trong clinical-review.html, điền tên/chuyên môn, chọn
từng quyết định; P6 đọc disclaimer Việt/Anh, sau đó xuất JSON. Không tự phê
duyệt bằng AI. Bundle và hash từng kết luận/source giúp phát hiện hồ sơ cũ
hoặc đã thay đổi. Phần mềm không xác minh bằng cấp/danh tính và không thay
người duyệt y tế. Lệnh này chưa gắn CI/deploy hoặc runtime; chưa bật người thật.
