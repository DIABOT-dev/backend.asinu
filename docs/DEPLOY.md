# Deploy Backend lên VPS

## Tổng quan kiến trúc

| Thành phần | Container | Port | Note |
|---|---|---|---|
| Backend Node.js | `asinu-backend` | `127.0.0.1:3000` | Image `backendasinu-asinu-api:latest`, build từ `Dockerfile` |
| Reverse proxy | `asinu-public-proxy` | `80` / `443` | Caddy, auto SSL Let's Encrypt |
| PostgreSQL | `asinu_postgres` | 5432 (internal) | Persistent data |
| Redis | `asinu_redis` | 6379 (internal) | Cache + queue |

- **Domain:** `asinu.top` → VPS `36.50.176.55`
- **Caddy upstream:** `asinu-backend:3000` (qua Docker network `asinu_net`)
- **Repo backend:** `https://github.com/DIABOT-dev/backend.asinu` (branch `main`)
- **Source path trên VPS:** `/root/backend.asinu`
- **Tất cả container chia sẻ network `asinu_net`** (external) → Caddy reach backend bằng DNS Docker.

---

## ⚙️ SETUP 1 LẦN (lần đầu chuyển sang compose)

> Chỉ cần chạy 1 lần. Sau đó về sau dùng workflow update ngắn gọn ở dưới.

```bash
ssh root@36.50.176.55
cd /root/backend.asinu

# 1. Discard local mod cũ (Coolify) trên docker-compose.yml
git checkout -- docker-compose.yml
git stash drop 2>/dev/null   # bỏ stash cũ nếu có

# 2. Pull code mới (đã có docker-compose.yml clean + .env.example)
git pull --ff-only origin main

# 3. Tạo file .env từ template, điền secret thật
cp .env.example .env
nano .env
# → điền JWT_SECRET, OPENAI_API_KEY (sk-proj-...)
# → nếu dùng patient files/Doctor chat, cấu hình đủ Cloudinary credentials;
#   URL private được ký ở backend bằng CLOUDINARY_API_SECRET
# → các giá trị khác (DATABASE_URL, REDIS_URL, BACKEND_PUBLIC_URL) giữ default

# 4. Stop container cũ (đang chạy bằng docker run thủ công, không phải compose)
docker stop asinu-backend && docker rm asinu-backend

# 5. Khởi động bằng compose
docker compose up -d --build

# 6. Verify healthy + smoke
docker compose ps
docker compose logs -f --tail=30      # Ctrl+C khi thấy "Server running on port 3000"
curl -sS -o /dev/null -w "%{http_code}\n" https://asinu.top/
```

---

## 🚀 WORKFLOW UPDATE thường xuyên

Mỗi khi anh push code mới lên GitHub, chỉ cần:

### Cách 1 — SSH thủ công (rõ ràng từng bước)

```bash
ssh root@36.50.176.55
cd /root/backend.asinu
git pull --ff-only origin main
docker compose up -d --build
```

### Cách 2 — One-liner từ máy local (nhanh nhất)

```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && git pull --ff-only origin main && docker compose up -d --build'
```

Compose sẽ tự:
- Phát hiện file thay đổi → rebuild image
- Stop container cũ + start container mới (zero-downtime nhỏ ~5s)
- Giữ nguyên network `asinu_net` → Caddy không bị break

### Verify sau update

```bash
docker compose ps                                                       # status
docker compose logs --tail=30                                           # log gần nhất
curl -sS -o /dev/null -w "HTTPS %{http_code}\n" https://asinu.top/      # smoke test
```

Container phải `Up X seconds (healthy)`. Smoke trả `404` từ Express là OK (chưa có route `/`, đã đến backend).

---

## 🆘 Rollback nếu fail

```bash
ssh root@36.50.176.55
cd /root/backend.asinu

git log --oneline -5              # tìm commit cũ ổn định
git checkout <commit-hash>        # vd. git checkout 091af7f
docker compose up -d --build      # rebuild lại version cũ

# Sau khi xác nhận stable, quay về branch:
git checkout main                 # (sẽ bị warning, ignore vì đã ở commit cũ)
```

Nếu chỉ vừa update mà rollback ngay (image cũ chưa bị xoá):

```bash
docker compose down
docker run -d --name asinu-backend --restart unless-stopped --network asinu_net \
  --env-file .env \
  backendasinu-asinu-api:<old-image-id>      # docker images xem id cũ
```

---

## Database operations

### Chạy migration thủ công

App tự chạy migrate qua `scripts/migrate.js` khi container start (gọi trong `npm start`). Nếu cần chạy lại:

```bash
docker compose exec asinu-backend node scripts/migrate.js
```

Migration `082_private_media_delivery.sql` thêm metadata private delivery cho
patient files. Trước khi deploy cần backup database. Các file legacy không có
`public_id`/authenticated delivery sẽ không còn được phát URL; cần upload lại
file còn cần dùng sau rollout.

### Chạy SQL ad-hoc

```bash
docker exec -it asinu_postgres psql -U asinu_user -d asinu_db
# hoặc inline:
docker exec asinu_postgres psql -U asinu_user -d asinu_db -c "SELECT count(*) FROM users;"
```

### Cleanup data test

```bash
docker exec asinu_postgres psql -U asinu_user -d asinu_db -c \
  "DELETE FROM user_connections WHERE status IN ('rejected','removed');"
```

---

## Logs & debug

```bash
docker compose logs -f                       # live tail backend
docker compose logs --tail=100               # 100 dòng cuối
docker logs -f asinu-public-proxy            # caddy logs
docker stats --no-stream                     # CPU/RAM tất cả container
```

---

## Frontend (mobile app)

Frontend là **Expo / React Native** — KHÔNG deploy lên VPS, build qua **EAS**.

```bash
cd ~/Desktop/APP/asinu

# Preview build (internal distribution, không qua App Store)
eas build --profile preview --platform android   # APK install trực tiếp
eas build --profile preview --platform ios       # TestFlight
eas build --profile preview --platform all       # cả Android + iOS

# Production build (lên store)
eas build --profile production --platform all
```

Profile `preview` đã trỏ `EXPO_PUBLIC_API_BASE_URL=https://asinu.top` → app build sẽ gọi VPS prod.

---

## Checklist trước khi deploy

- [ ] `node -c <file>.js` pass cho mọi file JS đã sửa
- [ ] `JSON.parse` pass cho mọi file i18n đã sửa
- [ ] Test local đã OK (`npm run dev`)
- [ ] Đã commit + push lên GitHub
- [ ] Backup DB nếu có schema migration nguy hiểm
- [ ] Caddy proxy còn chạy: `docker ps | grep caddy`

---

## Troubleshooting

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `git pull` báo conflict | Local edit ở VPS đè upstream | `git stash` → pull → `git stash pop` (resolve nếu cần) |
| `docker compose up` báo `network asinu_net not found` | Network bị xoá | `docker network create asinu_net` |
| Container `unhealthy` ngay sau start | Lỗi runtime / thiếu env / DB không reach | `docker compose logs --tail=50 asinu-backend` |
| `curl https://asinu.top/` connection refused | Caddy proxy chết | `docker restart asinu-public-proxy` |
| `502 Bad Gateway` từ Caddy | Backend chết hoặc khác network | Kiểm tra `docker network inspect asinu_net` — Caddy + backend phải cùng network |
| HTTP 404 từ Express path lạ | OK — backend healthy, chỉ là path không tồn tại | Test path đúng (vd. `/api/care-circle/connections`) |
| `name already in use` khi `docker compose up` | Container cũ chưa bị compose quản lý | `docker rm -f asinu-backend` rồi `docker compose up -d` |
| Compose rebuild không pickup code mới | Cache layer cũ | `docker compose build --no-cache && docker compose up -d` |

---

## Cron jobs đang chạy trong backend

Tự động trong `server.js`, không cần cron riêng:

| Cron | Schedule (VN time) | File |
|---|---|---|
| Basic notifications (reminders, checkin, ...) | mỗi phút | `basic.notification.service.js → runBasicNotifications` |
| Lifecycle segment update | 1:00 sáng | `profile/lifecycle.service.js` |
| R&D nightly cycle | 2:00 sáng | `checkin/rnd-cycle.service.js` |
| Lifecycle notifications (sub expiring/expired, profile incomplete, weekly summary) | 7:00 sáng | `lifecycle.notification.service.js` |
| Chat history cleanup | mỗi 24h | inline trong `server.js` |

Check cron có fire không:

```bash
docker compose logs --tail=200 asinu-backend | grep -E "Lifecycle|cron|R&D"
```

## Bảo vệ dữ liệu — thay đổi 15/10/2026

- API production chạy `npm run start:runtime`. Chạy migration bằng container/job riêng với tài khoản sở hữu schema; không đưa mật khẩu migration vào môi trường API.
- Provision tài khoản API bằng `scripts/provision-runtime-role.js`: `DATABASE_URL` là kết nối DBA, `RUNTIME_DATABASE_ROLE` là tên role mới, `RUNTIME_DATABASE_PASSWORD_FILE` là file riêng mode 0600. Công cụ từ chối role quản trị/role có membership, role đang sở hữu object hoặc quyền PUBLIC cho phép DDL. Chạy lại provisioning sau migration tạo bảng giới hạn như `schema_migrations`/`distillation_data`.
- Bật TLS PostgreSQL bằng CA nội bộ; SAN của chứng chỉ phải khớp hostname Docker. API dùng `DB_TLS_REQUIRE=true`, `DB_TLS_CA_FILE=/run/asinu-db-tls/ca.pem`; mount CA read-only. Không đặt `sslmode`/`sslrootcert` trong URI của Node vì có thể ghi đè cấu hình kiểm chứng chứng chỉ. Migration dùng cùng CA nhưng credential riêng. Sao lưu cấu hình PG/HBA trước khi đổi; chỉ chặn kết nối TCP không TLS sau khi mọi client đã chuyển.
- `backup-db.sh` bắt buộc `BACKUP_AGE_RECIPIENT` (khóa công khai). Dữ liệu đi thẳng qua gzip và age, không có file dump chữ thường. Có thể dùng `POSTGRES_CONTAINER` để chạy pg_dump trong container; credential đi qua môi trường, không có trong argv/log. Backup hoàn tất dùng tên `.sql.gz.age`, quyền 0600; lỗi upload không được coi là thành công. Retention chỉ áp dụng bản mã hóa, không tự xóa bản cũ chưa mã hóa.
- Khóa giải mã age và khóa ký CA giữ trên máy quản trị, ngoài Git và VPS. Cần sao chép khóa giải mã vào nơi cất giữ an toàn độc lập; mất khóa là không khôi phục được. Bản mã hóa nằm trên cùng VPS vẫn chưa phải backup ngoài máy chủ.
- `restore-db.sh` yêu cầu khóa giải mã, `DATABASE_URL` và `RESTORE_TARGET_DATABASE` khớp chính xác. Chỉ phục hồi vào DB trống, kiểm tra toàn bộ ciphertext/gzip trước transaction. `RESTORE_TMP_DIR` nên trỏ tới tmpfs riêng, vì staging SQL phục hồi là dữ liệu chữ thường có quyền 0600 và được xóa khi kết thúc.
- Thu thập distillation và dùng hội thoại người khác làm few-shot đã tắt tại code. Không bật lại bằng biến môi trường. Cần thiết kế riêng ownership, sự đồng ý cho huấn luyện, thời hạn giữ và xóa theo tài khoản trước khi mở lại.
- Mã hóa backup/TLS và tài khoản API ít quyền không thay thế mã hóa volume, mã hóa từng trường, quản lý khóa từng người dùng hoặc hồ sơ pháp lý. Không công bố hệ thống đã mã hóa đầu cuối hay đạt tuân thủ toàn bộ chỉ vì áp dụng các bước này.

Kiểm thử với dữ liệu tổng hợp trên DB local trống có tên kết thúc `_security_test`:

```bash
DATA_PROTECTION_TEST_DATABASE_URL=postgresql://localhost/asinu_data_security_test npm test -- --runTestsByPath tests/integration/data-protection.test.js
```

Test cần PostgreSQL client, Python 3 và age. Nó kiểm tra CRUD của role ít quyền, từ chối DDL/cấp quyền/ghi tập huấn luyện, backup mã hóa, phục hồi nguyên vẹn và chặn ciphertext hỏng/DB không trống/sai đích. Không chạy trên database có dữ liệu thật.
