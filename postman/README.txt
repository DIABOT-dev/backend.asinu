ASINU — POSTMAN

1. Import

Trong Postman, chọn Import rồi chọn 4 file:
  Asinu.postman_collection.json
  Asinu-Smoke.postman_collection.json
  Asinu-Local.postman_environment.json
  Asinu-Production.postman_environment.json

Hướng dẫn chính thức:
https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data/

2. Chọn môi trường và đăng nhập

Asinu — Local:      http://localhost:3300
Asinu — Production: https://asinu.top

Collection có đúng 2 thư mục cấp đầu: Local API và Production API.
Mỗi thư mục có 277 request trong 27 nhóm chức năng. URL và token riêng:
  Local API: local_base_url, local_access_token
  Production API: production_base_url, production_access_token
Nếu backend local chạy cổng khác, sửa local_base_url. Bạn có thể dùng
Variables của collection hoặc chọn environment tương ứng.

Điền local_email/local_password hoặc production_email/production_password
(có thể dùng số điện thoại trong biến email). Mở thư mục môi trường cần
test > 01. Authentication > POST /api/auth/email/login rồi Send.
Body đúng của backend là { "identifier": "{{email}}", "password": "{{password}}" }.
Response thành công tự lưu token và user_id với tiền tố môi trường.
Các API kế thừa Bearer token riêng từ thư mục Local API/Production API. Đăng ký tài khoản test mới bằng
POST /api/auth/email/register nếu cần; password phải đáp ứng validation.

3. Chạy test

Asinu — All Backend APIs gồm 277 endpoint HTTP cho mỗi môi trường
(554 request trong 2 thư mục cấp đầu), bao gồm
API mobile, check-in, thuốc, xu/thưởng, Care Circle, bác sĩ, IAP và nội bộ.
Các API Asinu Brain đã ngừng sử dụng không nằm trong collection.
3 endpoint trong folder 90 chỉ được mount khi NODE_ENV khác production.
Mỗi request có nguồn route, xác thực, body hoặc form upload phù hợp.
api-inventory.json liệt kê đầy đủ method/path và vị trí mã nguồn.

Chọn từng request hoặc nhóm chức năng cần test. Điền ID thật trong
Variables của collection hoặc environment (environment được ưu tiên).
Tất cả biến cấu hình có tiền tố local_ hoặc production_. Ví dụ:
local_checkin_id, local_schedule_id, production_task_id, production_gift_id.
Script của thư mục tự cấp giá trị đúng cho các biến rút gọn trong body.
Các tham số query tùy chọn được để tắt; bật trong Params khi cần dùng.
Các query bắt buộc như tenant_id, revision hoặc signed media đã bật.

Request upload: chọn file trong Body > form-data, đúng field đã tạo.
Postman tự tạo Content-Type và multipart boundary.

AI: GET /api/mobile/ai-consent trước để lấy ai_consent_version, sau đó
PUT cùng URL khi chủ động cấp consent cho tài khoản test. Một số chức
năng còn cần đúng gói dịch vụ, feature flag và quyền Care Circle.

API nội bộ cần cron_secret (header x-cron-secret).
Health chi tiết cần health_check_token (header x-health-token).
API tích hợp bác sĩ cần doctor_integration_secret; script tự tính
HMAC-SHA256 trên timestamp + "." + đúng raw JSON gửi đi.
SePay webhook cần sepay_api_key. Google Pub/Sub webhook cần OIDC token
trong google_pubsub_oidc_token. Apple/Google IAP cần giao dịch sandbox
và dữ liệu ký hợp lệ từ nhà cung cấp.

Không có khóa hoặc dữ liệu tài khoản thật trong các file. Điền các
giá trị bí mật ở local environment của Postman.

Mặc định script kiểm tra HTTP 2xx/3xx và JSON hợp lệ. Để kiểm tra lỗi
đầu vào hoặc quyền truy cập, đặt mã 400/401/403...
trong local_expected_status hoặc production_expected_status, rồi xóa
giá trị này sau khi test trường hợp lỗi.

request_id được giữ riêng cho từng request để retry có cùng idempotency
key. Để tạo hành động mới, xóa biến __local_request_id_<tên request> hoặc
__production_request_id_<tên request> tương ứng trong collection, hoặc
đặt local_request_id/production_request_id rõ ràng.
Các ID của tài nguyên đã tồn tại luôn cần thay bằng dữ liệu test thật.

Bộ đầy đủ có API xóa tài khoản, gửi thông báo, đổi cấu hình, giao dịch
và gọi AI. Không chạy toàn bộ bằng Runner trên production.
Asinu — Public smoke checks chỉ gồm 4 GET công khai, có thể chạy để
kiểm tra kết nối mà không cần tài khoản.

4. Ví dụ các loại health log

POST /api/mobile/logs dùng chung envelope:
{
  "log_type": "bp",
  "occurred_at": "{{now_iso}}",
  "source": "postman",
  "data": { "systolic": 120, "diastolic": 80, "pulse": 70, "unit": "mmHg" }
}

Thay log_type và data tương ứng:
  glucose:    { "value": 100, "unit": "mg/dL", "context": "fasting" }
  weight:     { "weight_kg": 65 }
  water:      { "volume_ml": 250 }
  meal:       { "meal_text": "Bữa ăn test", "calories_kcal": 500 }
  insulin:    { "dose_units": 1, "timing": "pre_meal" }
  medication: { "med_name": "Thuốc test", "dose_text": "Dữ liệu giả lập" }
  care_pulse: { "status": "NORMAL" }
Đây là dữ liệu giả lập kiểm tra API; không phải hướng dẫn điều trị.

5. WebSocket Doctor chat

HTTP collection v2.1 không chứa native WebSocket request.
Tạo New > WebSocket Request trong Postman:
  wss://asinu.top/api/doctor/chat/ws?tenant_id={{tenant_id}}&task_id={{task_id}}
  Local: ws://localhost:3300/api/doctor/chat/ws?... tương tự.
Header:
  Sec-WebSocket-Protocol: asinu-chat, {{production_access_token}}
Với WebSocket, dùng production_tenant_id/production_task_id (hoặc các
biến local_ khi test local) trong URL, vì request này tạo riêng.

Cần JWT còn hiệu lực và task thuộc đúng tài khoản/tenant. Khi kết nối
thành công, server gửi message chat.ready. Server phát sự kiện thay đổi
hội thoại; các thao tác gửi/sửa tin nhắn dùng API HTTP trong collection.
Nguồn: src/services/integrations/doctor-chat-realtime.js.

6. Cập nhật lại collection khi thêm/sửa route

Từ thư mục backend.asinu:
  node scripts/export-postman.cjs

Exporter phân tích tĩnh server.js và các router được mount, không khởi
động backend, đọc .env hay truy cập database. Các body mẫu và script
Postman nằm trong postman/examples.cjs. Nếu thêm một endpoint cần body
đặc biệt hoặc schema mới, bổ sung ví dụ trong file này rồi export lại.

Kiểm tra công khai bằng Newman:
  npm exec --yes --package=newman -- newman run postman/Asinu-Smoke.postman_collection.json --folder "Production API" -e postman/Asinu-Production.postman_environment.json

Kết quả kiểm tra của lần tạo này nằm trong validation-report.json.
