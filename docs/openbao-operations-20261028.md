# OpenBao trên VPS CRM — 28/10/2026

## Phạm vi triển khai

OpenBao 2.7.2 chạy bằng systemd trên **103.173.227.247**, tách khỏi backend
Asinu và Doctor trên VPS 36. Dịch vụ dùng Raft một node, TLS 1.3 và xác thực
chứng chỉ hai chiều. Cổng TCP 8200 cho phép VPS 36 và bridge Docker riêng của CRM (10.0.5.0/24);
mọi kết nối vẫn bắt buộc mTLS. Cổng cluster 8201 nằm trên loopback. Giao diện web không bật.

**Đã chuyển App backend, Doctor backend, CRM backend và CRM worker sang
OpenBao**, gồm khóa mở volume LUKS trên VPS 36. Đã đối chiếu dữ liệu trước/sau
và kiểm tra ghi mới. Không bật IVR hoặc phát hành phần SRS đang phát triển.
Các bản chạy triển khai được dựng từ phiên bản production đang hoạt động;
chỉ thêm tích hợp quản lý khóa.

## Dịch vụ và quyền

| Hạng mục | Cấu hình |
| --- | --- |
| Service trên VPS 103 | `openbao.service` |
| Binary | `/usr/local/lib/openbao/2.7.2/bao` |
| Cấu hình | `/etc/openbao/openbao.hcl` |
| Storage | `/var/lib/openbao`, user `openbao`, mode 0700 |
| Tài nguyên | RAM tối đa 512 MiB, CPU tối đa tương đương 1 core, không swap |
| Audit | File `/var/log/openbao/audit.jsonl` và systemd journal |
| Logrotate | Hằng ngày hoặc 20 MiB, giữ 14 bản |
| App | Chứng chỉ `asinu-backend`, chỉ khóa `asinu-health` |
| Doctor | Chứng chỉ `doctor-backend`, chỉ khóa `asinu-doctor` |
| CRM | Chứng chỉ `crm-backend`, chỉ khóa `asinu-crm` |
| Backup | Chỉ đọc Raft snapshot, không có quyền giải mã dữ liệu |
| Operator | Quyền đọc metadata khóa, snapshot và đổi phiên bản khóa |

Các khóa Transit không cho phép xuất khóa hoặc sao lưu khóa dưới dạng rõ.
Token xác thực ứng dụng có thời hạn 15 phút, tối đa 1 giờ. Token root khởi
tạo đã thu hồi. Chứng chỉ có thời hạn 365 ngày kể từ 28/10/2026; cần gia hạn
trước khi hết hạn. CA riêng không được thêm vào trust store toàn hệ thống.

Thông tin kết nối nằm trên host, không nằm trong Git hay image ứng dụng:

- VPS 36: `/etc/asinu/openbao/asinu-backend/client.json`, thư mục tương ứng
  cho `doctor-backend` và `snapshot-backup`.
- VPS 103: `/etc/asinu/openbao/crm-backend/client.json`.
- Thư mục riêng của từng ứng dụng được mount chỉ đọc tại `/run/asinu-openbao`.
  File credential có mode 0400, thư mục 0700, thuộc UID của ứng dụng. App và
  Doctor dùng UID 100; CRM dùng UID 1000. Không chia sẻ chứng chỉ giữa các vai trò.
- `wrapped-keys.json` chỉ chứa ciphertext Transit và tên slot, không chứa khóa rõ.
  Mỗi slot được ràng buộc vai trò và tên bằng associated data.

## Mở khóa sau khi khởi động lại

Dùng Shamir, cần **3 trong 5** mảnh khóa. Các mảnh khóa chỉ được lưu trong
gói age mã hóa trên máy quản trị, không đặt trên VPS 103 hoặc 36. Bản triển
khai ban đầu do một chủ tài khoản giữ gói khôi phục; chưa phân phối cho năm
người quản trị độc lập.

Trên máy Mac quản trị, tại repo backend:

```sh
python3 scripts/openbao-operator.py status
python3 scripts/openbao-operator.py unseal
```

Lệnh dùng SSH tunnel và kiểm tra CA/chứng chỉ. SSH có thể hỏi mật khẩu quản
trị nếu chưa cấu hình SSH key. Không truyền khóa mở hệ thống qua tham số
dòng lệnh, không in khóa ra terminal. Script đọc ba mảnh cần thiết trực tiếp
từ gói khôi phục mã hóa trong bộ nhớ.

Tài liệu khôi phục trên máy quản trị:

- `~/.config/asinu-security/openbao-20261028/recovery.json.age`: mảnh Shamir
  và metadata; không còn token root đang hoạt động.
- `~/.config/asinu-security/openbao-20261028/tls-recovery.tar.age`: CA
  private key và chứng chỉ/private key để khôi phục kết nối.
- `~/.config/asinu-security/openbao-recovery.identity`: danh tính age để
  mở các bản mã trên. File này có mode 0600 và không gửi lên VPS.

Chủ tài khoản cần giữ thêm bản sao ngoại tuyến của bộ khôi phục và danh tính
age, bảo vệ riêng. Không gửi các file này vào chat hoặc đưa lên Git.

## Sao lưu ngoài máy chủ

VPS **36** lấy snapshot trực tiếp qua TLS bằng quyền snapshot riêng, mã hóa
thêm bằng age và lưu vào `/var/backups/asinu-openbao/`. Khóa age riêng không
có trên cả hai VPS. Bản snapshot mã hóa cũng đã được kéo về máy quản trị.

```sh
systemctl status asinu-openbao-backup.timer
systemctl start asinu-openbao-backup.service
cat /var/backups/asinu-openbao/status.json
```

Timer chạy khoảng **02:30 giờ Việt Nam mỗi ngày**, có độ lệch ngẫu nhiên tối
đa 5 phút, chạy bù sau khi bật máy. Giữ 14 ngày và tối thiểu hai bản gần nhất.
Lỗi lấy snapshot hoặc lỗi mã hóa không được công bố thành bản sao hoàn tất.

File nguồn: [snapshot.py](../deploy/openbao/snapshot.py), service/timer trong
`deploy/openbao/`. Script sao lưu không nhận khóa Shamir hoặc age identity.

## Khôi phục và giới hạn vận hành

Khôi phục cần cả snapshot và mảnh Shamir gốc. Gói TLS cũng cần để phục hồi
kết nối và các vai trò xác thực bằng chứng chỉ. Khôi phục phải thực hiện
trong môi trường cách ly trước khi trỏ backend vào.

Quy trình thử khôi phục đã xác nhận hai điểm cần giữ khi làm thật:

1. Restore snapshot là bất đồng bộ. Chờ Raft hoàn tất áp dụng snapshot và
   invalidation, sau đó restart node khôi phục, kiểm tra seal config là 3/5
   rồi dùng mảnh Shamir gốc. Không dùng seal config của kho tạm vừa khởi tạo.
2. Audit khai báo trong cấu hình phải giữ nguyên tên và `file_path` đã lưu
   trong snapshot. Khi thử trên cùng host, dùng mount namespace/bind mount
   riêng cho file audit; không sửa chuỗi đường dẫn và không ghi vào log thật.

Kiểm thử 28/10/2026 đã khôi phục bản snapshot age lấy từ VPS 36 trong một
network namespace riêng; dùng mảnh Shamir gốc, đăng nhập bằng chứng chỉ gốc
và giải mã được ciphertext đã tạo ở dịch vụ chính. Môi trường khôi phục tạm
đã xóa sau kiểm thử. Dịch vụ chính cũng đã qua thử restart → sealed → mở
bằng `scripts/openbao-operator.py unseal` → giải mã lại dữ liệu thử trước đó.

Một node không có khả năng tự chuyển sang máy dự phòng. Sau khi OpenBao
restart hoặc bị sealed, người quản trị phải mở lại; các dịch vụ tích hợp
đang chạy chỉ dùng cache khóa trong bộ nhớ trong thời gian còn hiệu lực.
Không tự fallback sang ghi dữ liệu rõ khi kho khóa lỗi.

OpenBao này là dịch vụ quản lý khóa bằng phần mềm trên VPS, không phải HSM.
Người chiếm quyền root của VPS 103 vẫn nằm trong phạm vi tin cậy của kho khóa.


## Cơ chế đang sử dụng

- App: giữ nguyên 10 khóa dữ liệu của người dùng, bọc thêm bằng AES-256-GCM.
  Khóa bọc được OpenBao Transit bảo vệ. File mới ở
  `/etc/asinu/health-user-keys-openbao` có định dạng `asinu:key:v2:` (93 byte).
  Các trường dữ liệu cũ không cần mã hóa lại; chức năng xóa khóa vẫn giữ nguyên.
- Doctor: giữ đúng khóa mã hóa dữ liệu và khóa HMAC định danh cũ, chuyển chúng
  thành bản mã Transit. Mã hóa tài khoản ngân hàng và mã định danh bệnh nhân
  không thay đổi kết quả.
- CRM: đã thay hai khóa PII/AI từng có trong image cũ. Một giao dịch đã mã hóa
  lại 69 giá trị liên hệ và 1 khóa tích hợp, đồng thời tạo lại hash tra cứu.
  Image mới không chứa `.env`. Image cũ đã được lưu dưới dạng age trên máy
  quản trị rồi gỡ khỏi Docker. Bộ khóa bảo trì chứa khóa cũ cũng đã gỡ.
- LUKS: giữ nguyên khóa mở volume, bọc bằng Transit; không thay hay format ổ.
  Helper chỉ truyền khóa qua stdin của cryptsetup. Không còn file khóa rõ
  `/etc/asinu/keys/database-volume.key` trên VPS.

Launcher `start-with-keyring.cjs` nạp khóa trước khi import ứng dụng. Khóa
rõ chỉ được giữ trong bộ nhớ; không đưa ngược vào biến môi trường. Cache có
hiệu lực 300 giây, làm mới khoảng 100 giây/lần. Khi cache hết hạn mà OpenBao
không sẵn sàng, thao tác cần khóa trả lỗi tạm thời; không dùng khóa dự phòng
lưu trên đĩa. TLS bảo vệ khóa khi truyền giữa backend và OpenBao. Dữ liệu
bệnh nhân không được gửi sang OpenBao.

Container App giới hạn RAM 1 GiB; Doctor, CRM API và worker giới hạn 512 MiB.
Các container này tắt swap và core dump. Khóa thông thường như mật khẩu DB,
JWT và token nhà cung cấp nằm ngoài phạm vi di chuyển khóa mã hóa lần này.

## Mở volume sau khi VPS 36 khởi động

Drop-in `systemd-cryptsetup@asinu_data.service.d/openbao.conf` gọi helper
`/opt/asinu-openbao/unlock-volume.py`. crypttab/fstab dùng `_netdev` để chờ
mạng; Docker giữ `RequiresMountsFor=/srv/asinu-data`, tránh chạy DB trên thư
mục chưa được mount.

OpenBao trên VPS 103 phải được unseal trước. Nếu lần khởi động VPS 36 đã thất
bại vì OpenBao chưa mở khóa, sau khi unseal hãy chạy trên VPS 36:

```sh
systemctl start systemd-cryptsetup@asinu_data.service
systemctl start 'srv-asinu\x2ddata.mount'
systemctl start docker.service
```

Kiểm tra khóa mà không tháo hay mở lại volume đang hoạt động:

```sh
python3 /opt/asinu-openbao/unlock-volume.py \
  --config /etc/asinu/openbao/volume-config.json --test
```

Đã kiểm tra khóa thật sau khi xóa file khóa rõ và kiểm tra cấu hình unit có
hiệu lực. **Chưa reboot toàn VPS 36** để tránh dừng các cơ sở dữ liệu đang chạy.

## Sao lưu và rollback sau chuyển đổi

Bộ sao lưu khóa hằng ngày trên VPS 36 chứa khóa người dùng đã bọc và metadata
`openbao/{asinu-backend,doctor-backend,crm-backend,volume}.json`, sau đó mã hóa
thêm bằng age. Metadata CRM được sao chép sang VPS 36 trong lần chuyển đổi;
khi thay bundle khóa CRM lần tới phải cập nhật bản sao đó trước khi sao lưu.
Không sao chép chứng chỉ CRM hoặc khóa rõ sang VPS 36. Receiver trên máy Mac
đã cập nhật để xác thực định dạng mới; vẫn đọc được bản sao lưu cũ.

Ngoài snapshot OpenBao, máy quản trị giữ các capsule age trong:
`~/.config/asinu-security/openbao-20261028/migration-20261028T035650Z/`.
Có cấu hình cũ, các khóa khôi phục, dump CRM trước/sau đổi khóa và image CRM
cũ. Không đặt age identity hoặc khóa unseal trên VPS.

**Không rollback CRM chỉ bằng image/env cũ**: dữ liệu đang dùng khóa mới.
Cần phục hồi dump trước chuyển đổi cùng khóa cũ trong môi trường bảo trì,
hoặc mã hóa lại theo chiều ngược đã kiểm thử. App/Doctor cũng phải dùng đúng
bundle, chứng chỉ và định dạng file khóa tương ứng với bản phục hồi.

Mọi lần triển khai tiếp theo phải giữ launcher, mount credential chỉ đọc và
`KEY_MANAGEMENT_PROVIDER=openbao`. Bản vá source và cấu hình deploy được lưu
trong các repo backend, Doctor, CRM; không đưa `.env` vào build context.

## Kết quả kiểm tra tích hợp

Đã chạy probe trong các container production sau chuyển đổi:

| Kiểm tra | Kết quả |
| --- | --- |
| App đọc 45 giá trị đã lưu trước chuyển đổi | Khớp digest trước chuyển đổi |
| Doctor đọc dữ liệu ngân hàng và tạo mã bệnh nhân | Khớp trước chuyển đổi |
| CRM đọc 70 giá trị đã đổi khóa | Khớp trước chuyển đổi |
| 69 hash tra cứu điện thoại/email CRM | Khớp với khóa mới |
| Ghi/đọc ciphertext mới trong Postgres | Qua; giao dịch thử đã rollback |
| File khóa người dùng mới | Định dạng bọc 93 byte |
| Mất kết nối OpenBao trong probe | Cache còn hạn dùng được; hết hạn bị chặn |
| Kết nối lại OpenBao sau lỗi trong probe | Đọc được khóa trở lại |
| App/Doctor thử giải mã bằng vai trò của nhau | HTTP 403 |
| Restart OpenBao thật rồi unseal bằng bộ khôi phục ngoại tuyến | Qua, 2,75 giây |
| Health/ready của App, Doctor, CRM và frontend | HTTP 200 |
| Backup DB, backup khóa và snapshot sau chuyển đổi | Thành công; có bản age ngoài VPS |

Probe đọc nội dung trong bộ nhớ, chỉ lưu digest tổng hợp và số lượng; không
in dữ liệu bệnh nhân hoặc khóa. Thử mất kết nối/đổi đồng hồ chỉ diễn ra trong
process bảo trì riêng, không sửa đồng hồ hoặc chặn mạng của dịch vụ thật.
Báo cáo kỹ thuật và các digest nằm trong thư mục migration riêng phía trên.

Kiểm tra source: 14 test crypto/keyring, 8 test Sentry và 5 test backup qua;
Doctor/CRM build TypeScript qua. Trước cutover cũng đã chạy bộ test Doctor
(118 qua, 1 test bỏ qua sẵn có) và CRM (80 qua). Chưa thực hiện lại toàn bộ
luồng giao diện người dùng trên điện thoại trong thay đổi quản lý khóa này.

## Tham chiếu

- [TLS listener](https://openbao.org/docs/configuration/listener/tcp/)
- [Certificate authentication](https://openbao.org/docs/auth/cert/)
- [Transit encryption](https://openbao.org/docs/secrets/transit/)
- [Seal/unseal](https://openbao.org/docs/concepts/seal/)
- [Audit devices](https://openbao.org/docs/configuration/audit/)
