# Đối chiếu SRS ngày 27/10/2026

## Phạm vi bản thay đổi

Bổ sung trên các thực thể IVR đã có, giữ `doctor_tasks` và cầu nối HMAC làm nguồn liên kết ca. JSON trong SRS được ánh xạ vào hợp đồng hiện tại; không tạo hệ thống bệnh nhân hay chat thứ hai.

Route chỉ khai báo đường dẫn và middleware. Controller kiểm tra hợp đồng HTTP rồi gọi service. Nghiệp vụ câu hỏi, phiên, gọi, chính sách, báo cáo và quản trị nằm trong service tương ứng. Doctor cũng tách sự kiện IVR thành schema/controller/service.

App dùng chung `DoctorInterviewView`, `DoctorIvrQuestion`, `DoctorIvrBackdrop`, màu/theme, chữ và nút của các màn Asinu hiện tại. Doctor dùng DoctorShell/AntD và cùng bộ sửa khoảng số cho bác sĩ/quản trị. Gallery development dùng nguyên view thật với dữ liệu trong bộ nhớ; không thu âm hay bỏ qua xác thực của phiên thật.

### Kênh gọi cần hiểu đúng

Tái sử dụng cuộc gọi **trong ứng dụng** của Asinu: PushKit/CallKit trên iOS, FCM/Telecom trên Android. Sau khi người dùng chấp nhận có xác thực, ứng dụng đợi native nhả audio rồi mở phiên nghe/chọn. Màn khóa không tự mở dữ liệu y tế trước khi xác thực.

Trong phiên có đáp án đánh số, nghe lại 9, quay lại 0, dừng ghi âm #. **Chưa tích hợp cuộc gọi SIM/PSTN hay nhận DTMF từ bàn phím cuộc gọi của hệ điều hành.** Nếu FR-11/US-04 yêu cầu chính xác hai chức năng đó thì phần này chưa đạt; cần thêm nhà cung cấp tổng đài/PSTN và webhook riêng. Không coi nhãn phím trên app là bằng chứng đã có DTMF.

## Đối chiếu chức năng

“Có” nghĩa là có đường mã và kiểm tra đã ghi bên dưới, không thay cho nghiệm thu thiết bị thật hoặc chuyên môn y tế.

| Yêu cầu | Hiện trạng | Đường thực thi |
| --- | --- | --- |
| FR-01, FR-07 | Có | Sinh từ ca, hồ sơ, thuốc, hội thoại và lịch sử; kiểm định nội dung/schema, sửa tối đa hai lần trong ngân sách 10 giây, lỗi có thể thử lại hoặc soạn tay/template. |
| FR-02 | Có | Sửa/thêm/xóa/đổi thứ tự câu và đáp án, khoảng số, nghe thử, bác sĩ xác nhận red flag; giữ Khác cuối và câu kết bất biến. Đổi thứ tự bằng nút lên/xuống thay cho kéo thả. |
| FR-03 | Có | Mẫu riêng và mẫu dùng chung trong tenant; nội dung mã hóa, không lưu lời chào có tên bệnh nhân trong mẫu dùng chung. |
| FR-04 | Có, sau cờ | App/call/both; kênh gọi chỉ khả dụng khi server bật cờ và thiết bị đăng ký năng lực native tương thích. |
| FR-05, FR-09 | Có | Báo cáo bảng câu trả lời, red flag, STT/file gốc, nháp trả lời và bác sĩ duyệt gửi. Có báo cáo một phần, cờ chưa đủ dữ liệu. |
| FR-06 | Có | Sự kiện tiến độ/reported/replied/unreachable tới Doctor; tải lại chống mất sự kiện; thông báo cần chú ý hiện ngay. |
| FR-08 | Có | STT chỉ cho voice, giữ file gốc; điểm suy ra từ log-probability thật của nhà cung cấp, không có thì null và Cần nghe lại. |
| FR-10 | Chưa làm (Could) | Không tự ánh xạ chữ STT thành đáp án khác. Bản gốc và chữ vẫn hiện cho bác sĩ. |
| FR-11 | Có cho cuộc gọi trong app | PushKit/CallKit và FCM/Telecom; xem giới hạn PSTN/DTMF ở trên. |
| FR-12 | Có | Khác mới xin quyền/đồng ý, ghi tối đa 30 giây; câu kết 60 giây. Silence, thử lại, upload bù và STT nền. |
| FR-13, FR-14, FR-15 | Có | Nhánh theo đáp án, lưu revision sau mỗi câu, tiếp tục khi mở lại, answer/session events chống gửi trùng. |
| FR-16 | Có | Mỗi lần một câu và đáp án; bấm ngay khi đang nghe; đọc xác nhận xong mới hiện câu tiếp, chữ ≥22 và nút ≥56. |
| FR-17 | Có | Nhắc sau 15 phút, 1 giờ hoặc 19:00 tiếp theo theo múi giờ bệnh nhân. |
| FR-18 | Có | Đọc/nghe kết quả, Đã hiểu hoặc đóng sau 24 giờ tính từ lúc bác sĩ trả lời. |
| FR-19 | Có | Quản trị theo tenant: quy tắc, cụm cảnh báo, hướng dẫn an toàn và mẫu dùng chung. Audit thay đổi, không sửa chính sách snapshot của phiên đã gửi. |

## Quy tắc và ngoại lệ

- Bộ ban đầu 3–7 câu nội dung, bổ sung tối đa 3 câu; giữ câu kết và Khác. Giới hạn câu/đáp án, khoảng số liên tục, nhánh hợp lệ và ước tính thời lượng được kiểm ở server; AI chỉ đề xuất red flag, bác sĩ duyệt.
- Tối đa một phiên hoạt động/ca; câu trả lời có request ID và revision. Bộ đã gửi bất biến. Chưa bắt đầu có thể hủy và tạo bản mới; đã bắt đầu chỉ thêm một phiên bổ sung. Phiên không liên lạc được và chưa có câu trả lời có thể gửi lại bộ đầy đủ.
- QR-10: sau khi **đọc xong** mới tính 10 giây; đọc lại một lần, tiếp tục im lặng thì lưu Bỏ qua/no_response. Không chạy timer lúc thu âm, xin quyền/đồng ý, upload, đọc xác nhận hoặc app ở nền. Nền → trở lại cùng câu sẽ phát lại câu đang dở.
- Thu âm kết thúc khi im lặng 3 giây sau khi có tiếng, người dùng dừng hoặc đạt 30/60 giây. Bản rỗng mời lại một lần rồi ghi no_speech. Gallery chỉ mô phỏng trạng thái ghi âm.
- Giữ file trên máy khi upload lỗi, gửi lại cùng request ID; không nói “đã chọn” nếu lưu thất bại. Đổi tài khoản dừng phản hồi đến muộn và dọn file đúng phạm vi.
- Cuộc gọi mới chỉ trong 07:00–21:00 theo múi giờ bệnh nhân, tối đa ba lần tổng cộng, cách nhau ít nhất 30 phút; có outbox/attempt bền vững và chặn gọi chồng check-in. Bắt đầu trả lời trong app hủy cuộc gọi chưa chấp nhận.
- Red flag lựa chọn được đẩy ngay khi lưu câu trả lời. Transcript quét danh mục theo snapshot; STT thử lại không gửi lặp cùng cảnh báo. Hướng dẫn cuối phiên do admin cấu hình.
- Quá 24 giờ có câu trả lời → báo cáo một phần; chưa trả lời → hết hạn. Mất hơn nửa dữ liệu đánh dấu chưa đủ. Các quyền sở hữu, chữ ký cầu nối, signed media và event đến sai thứ tự vẫn được giữ.

## Cấu hình và dữ liệu

Migration **120** thêm chính sách, audit, năng lực gọi, call attempts và STT review; **121** thêm mã nhóm câu hỏi cho thống kê. Đã áp dụng vào PostgreSQL **local**, chưa đưa lên VPS trong task này. Doctor migration 030 IVR trước đó đã có ở local.

- Backend: `DOCTOR_IVR_ENABLED`; riêng native call: `DOCTOR_IVR_CALL_ENABLED=true` (mặc định false).
- Doctor: `DOCTOR_IVR_ENABLED` và `NEXT_PUBLIC_DOCTOR_IVR_ENABLED`; cấu hình HMAC sẵn có giữa Doctor và Asinu.
- Native call cần cấu hình APNs/FCM của Asinu và bản native có `getCapabilities().doctorIvr=true`. Bản development cũ không tự có phương thức native mới qua Metro/OTA.
- STT mặc định `DOCTOR_IVR_STT_MODEL=whisper-1`; dùng verbose_json tiếng Việt. Không lưu API key vào Git.
- App Doctor vẫn chỉ bật trong local/development; staging/production vẫn ẩn theo cờ runtime hiện có.

Confidence là ước lượng xác suất token/segment từ mô hình, **không phải độ đúng đã hiệu chuẩn cho nội dung y tế**. Không có điểm thì null và Cần nghe lại; không tự gán 0,8 hoặc 1. Ngưỡng dưới 0,6 có tối đa ba lần STT nền, luôn giữ file gốc.

Hai lần LLM là luồng bình thường sinh câu hỏi + báo cáo. SRS đồng thời cho phép hai lần sửa output sai; hai lần sửa này là ngoại lệ, vẫn trong tổng ngân sách sinh 10 giây. Không cam kết số cuộc gọi LLM tuyệt đối ≤2 khi phải sửa output lỗi.

Thống kê 30 ngày chỉ dùng dữ liệu đã có, không điền số đẹp vào màn trống. Nhóm câu hỏi là HMAC theo tenant trên nội dung chuẩn hóa, không gộp mọi q1 khác nhau hoặc ghi nguyên nội dung sức khỏe vào nhãn thống kê. Thời gian nhận ca → đóng ca lấy từ Doctor DB, không thay bằng thời gian riêng phiên IVR.

## Biên bản kiểm tra local

Lượt xuyên suốt bổ sung sau phản hồi của người dùng: [20 kiểm tra qua HTTP/UI với AI, TTS, STT thật](doctor-ivr-test-report-20261027.md). Dữ liệu fixture đã dọn; giới hạn native/giọng tổng hợp được ghi riêng trong biên bản đó.

Ngày 27/10/2026:

| Lớp | Kết quả và phạm vi |
| --- | --- |
| Asinu backend | 99 test / 5 suite qua. PostgreSQL schema fixture riêng + HTTP/validator, policy, sinh câu hỏi, STT/call delivery mô phỏng; không gọi push/AI thật trong Jest. |
| Doctor backend | 118 qua, 1 bỏ qua có sẵn, 0 lỗi; typecheck qua. Có kiểm quyền admin/cross-tenant và HMAC thật trên mock transport. |
| App | TypeScript qua; hành vi màn thật, xác nhận trước khi chuyển câu, file chờ gửi, QR-10, guard toàn src và hồi quy native call qua. |
| Android | 50 test JVM/Robolectric qua; không phải thử FCM/Telecom qua mạng trên máy thật. |
| iOS | Xcode build Simulator thành công. Hai XCUITest qua: câu hỏi/nút tốc độ và màn ghi âm/kết quả, dùng chính view của app. Gallery dùng dữ liệu trong bộ nhớ, không thu micro thật. |
| Doctor UI | Route Next thật với API fixture tách biệt: desktop/tablet, mẫu rỗng không lưu được, câu kết cố định, không tràn ngang hay lỗi JavaScript. Không phải phiên backend thật. |
| STT thực | Một file TTS tổng hợp công khai, không chứa bệnh nhân, gửi provider thật: khoảng 1,9 giây, điểm từ mô hình ≈0,847. Không đại diện giọng Bắc/Trung/Nam hay người trên 60 tuổi. |

Các artifact local nằm tại `asinu/.expo/doctor-ivr-srs-native/` (bỏ qua trong Git). Không có dữ liệu người bệnh trong các ảnh/âm thanh fixture mới.

Bản Simulator được build với `CODE_SIGNING_ALLOWED=NO` đang có cảnh báo `expo-notifications` khi đọc đăng ký push đã lưu. Chưa dùng lượt kiểm UI này để kết luận push hoạt động. Cần kiểm chứng riêng trên development build có ký; không tắt log lỗi trong mã nguồn để làm đẹp kết quả.

### Chưa nghiệm thu

Không kết luận toàn SRS đạt 100%: cần bản development native mới để thử iPhone/Android thật nhận cuộc gọi khi khóa màn hình, quyền micro, Bluetooth/audio handoff, gián đoạn mạng và tiến trình bị hệ điều hành dừng. Chưa đo SLA ≤30 giây red flag/≤60 giây báo cáo hoặc tỷ lệ hoàn thành với tải production. Chưa nghiệm thu giọng vùng miền/người cao tuổi; chưa có thử nghiệm chứng minh người dùng hài lòng hay thời lượng trung bình ≤3 phút.

Chính sách giữ bản ghi vẫn cần chủ sản phẩm xác nhận. OpenBao đã tích hợp ngày 28/10/2026; xem tài liệu vận hành OpenBao. Việc tích hợp không thay cho xác nhận tuân thủ pháp lý.

## Sao lưu / rollback

Mốc trước task ở cả ba repo: `refs/backups/doctor-ivr-srs-20261027-195641`. Thư mục `APP/backups/doctor-ivr-srs-20261027-195641` giữ manifest và patch nhị phân cho thay đổi có sẵn. Không ghi đè ba file app đã sửa trước task.

Cần dừng thử: tắt cờ gọi và cờ IVR phù hợp, xử lý/hủy phiên còn hoạt động và đưa ca về hàng chat. Giữ khóa mã hóa, bảng và file để còn đọc báo cáo. Không khôi phục nguyên DB hoặc chạy down migration có thể làm mất câu trả lời mới. Có thể mở worktree từ backup ref để so sánh code, giữ riêng patch công việc đang có. Chưa deploy hay phát hành production trong lần thay đổi này.


## Ứng viên phát hành 28/10/2026

Đợt phát hành được kiểm tra trên nhánh riêng trước khi cập nhật production. Migration 122 ràng buộc khả năng nhận cuộc gọi vào đúng push token của từng nền tảng; một bản Android mới không bật cuộc gọi cho iOS cũ cùng tài khoản. Đăng ký khả năng native chỉ chạy sau khi lưu token thành công.

Profile EAS `development-vps` kết nối https://asinu.top, vẫn dùng môi trường development. App Store/Google Play hiện tại tiếp tục giữ ẩn Doctor. Việc commit mã native không tự cập nhật ứng dụng đã cài.
