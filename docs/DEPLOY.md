# Deploy Backend lên VPS

## Tổng quan kiến trúc

| Thành phần | Container | Port | Note |
|---|---|---|---|
| Backend Node.js | `asinu-backend` | 3000 (internal) | Image `backendasinu-asinu-api:latest` |
| Reverse proxy | `asinu-public-proxy` | 80 / 443 | Caddy, auto SSL Let's Encrypt |
| PostgreSQL | `asinu_postgres` | 5432 (internal) | Persistent data |
| Redis | `asinu_redis` | 6379 (internal) | Cache + queue |

- **Domain:** `asinu.top` → VPS `36.50.176.55`
- **Caddy upstream:** `asinu-backend:3000` (qua Docker network `asinu_net`)
- **Repo backend:** `https://github.com/DIABOT-dev/backend.asinu` (branch `main`)
- **Source path trên VPS:** `/root/backend.asinu`

## Quy trình deploy chuẩn (zero-downtime rollback-safe)

### Bước 1 — Push code lên GitHub (làm ở máy local)

```bash
cd ~/Desktop/APP/backend.asinu
git status                          # xem changes
git add <files>                     # KHÔNG dùng git add -A để tránh commit secrets
git commit -m "feat/fix: mô tả ngắn"
git push origin main
```

### Bước 2 — SSH vào VPS

```bash
sshpass -p '!Diabot2025' ssh root@36.50.176.55
# hoặc nếu đã setup ssh key:
# ssh root@36.50.176.55
```

### Bước 3 — Pull code mới

```bash
cd /root/backend.asinu

# (Nếu có local edit chưa commit ở VPS) stash để tránh conflict:
git stash push -m "vps-local-mods" -- docker-compose.yml

# Pull
git pull --ff-only origin main
git log --oneline -3                # xác nhận HEAD đúng commit vừa push

# Khôi phục local mods nếu đã stash:
git stash pop                       # (chỉ chạy nếu đã stash)
```

> **Lưu ý:** VPS có thể có local-modified file `docker-compose.yml` (Coolify
> labels cũ). Đó không phải file đang được dùng — container hiện chạy bằng
> `docker run` trực tiếp (xem Bước 5). Cứ stash qua nó.

### Bước 4 — Build image mới

```bash
cd /root/backend.asinu
docker build -t backendasinu-asinu-api:latest .
```

Mất 1–3 phút tuỳ thay đổi. Kết thúc thấy `naming to docker.io/library/backendasinu-asinu-api:latest done`.

### Bước 5 — Recreate container (zero-downtime + rollback)

**Quan trọng:** Container hiện tại **không** dùng compose. Phải recreate bằng `docker run` thủ công với env đầy đủ.

```bash
# 1. Backup container cũ (rename để rollback nếu fail)
docker stop asinu-backend
docker rename asinu-backend asinu-backend-old

# 2. Run container mới với image vừa build
docker run -d --name asinu-backend --restart unless-stopped --network asinu_net \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL="postgres://asinu_user:asinu_secure_password_2026@asinu_postgres:5432/asinu_db" \
  -e REDIS_URL=redis://asinu_redis:6379 \
  -e JWT_SECRET=asinu_prod_secret_change_later \
  -e AI_PROVIDER=openai \
  -e OPENAI_API_KEY="sk-proj-..." \
  -e BACKEND_PUBLIC_URL=https://asinu.top \
  backendasinu-asinu-api:latest

# 3. Đợi healthy
until docker inspect asinu-backend --format '{{.State.Health.Status}}' | grep -q healthy; do
  sleep 2; printf "."
done; echo " ready!"

# 4. Smoke test
curl -sS -o /dev/null -w "HTTPS %{http_code}\n" https://asinu.top/

# 5. Nếu OK → xoá container backup
docker rm asinu-backend-old
```

> Nếu smoke fail → rollback ở Bước 7.

### Bước 6 — Verify code mới đã vào container

```bash
docker exec asinu-backend grep -c "<chuỗi cần verify>" src/services/<file>
docker logs --tail 30 asinu-backend
```

### Bước 7 — Rollback (nếu container mới fail)

```bash
docker stop asinu-backend
docker rm asinu-backend
docker rename asinu-backend-old asinu-backend
docker start asinu-backend
```

## One-liner deploy từ máy local (advanced)

Sau khi đã push commit lên GitHub:

```bash
sshpass -p '!Diabot2025' ssh -o StrictHostKeyChecking=no root@36.50.176.55 \
  'cd /root/backend.asinu && \
   git stash push -m "vps-mods" -- docker-compose.yml 2>/dev/null; \
   git pull --ff-only origin main && \
   docker build -t backendasinu-asinu-api:latest . && \
   docker stop asinu-backend && docker rename asinu-backend asinu-backend-old && \
   docker run -d --name asinu-backend --restart unless-stopped --network asinu_net \
     -e NODE_ENV=production -e PORT=3000 \
     -e DATABASE_URL="postgres://asinu_user:asinu_secure_password_2026@asinu_postgres:5432/asinu_db" \
     -e REDIS_URL=redis://asinu_redis:6379 \
     -e JWT_SECRET=asinu_prod_secret_change_later \
     -e AI_PROVIDER=openai \
     -e OPENAI_API_KEY="sk-proj-..." \
     -e BACKEND_PUBLIC_URL=https://asinu.top \
     backendasinu-asinu-api:latest && \
   sleep 8 && \
   docker rm asinu-backend-old'
```

## Database — chạy migration mới

Migrations nằm ở `db/migrations/*.sql`. App tự chạy migrate qua `scripts/migrate.js` (gọi trong `npm start`). Nếu cần chạy thủ công:

```bash
docker exec -it asinu-backend node scripts/migrate.js
```

Để chạy SQL ad-hoc trên DB:

```bash
docker exec -it asinu_postgres psql -U asinu_user -d asinu_db -c "SELECT ...;"
```

Cleanup dữ liệu test (vd. orphan rows):

```bash
docker exec asinu_postgres psql -U asinu_user -d asinu_db -c \
  "DELETE FROM user_connections WHERE status IN ('rejected','removed');"
```

## Logs & debug

```bash
# Live tail
docker logs -f asinu-backend

# Last 100 lines
docker logs --tail 100 asinu-backend

# Caddy proxy logs
docker logs --tail 50 asinu-public-proxy

# Resource usage
docker stats --no-stream
```

## Frontend (mobile app)

Frontend là **Expo / React Native** — không deploy lên VPS, build qua **EAS**.

```bash
cd ~/Desktop/APP/asinu

# Preview build (internal distribution)
eas build --profile preview --platform android   # APK
eas build --profile preview --platform ios       # TestFlight
eas build --profile preview --platform all       # cả hai

# Production build
eas build --profile production --platform all
```

Profile `preview` đã trỏ `EXPO_PUBLIC_API_BASE_URL=https://asinu.top` → app
build sẽ gọi VPS prod luôn.

## Checklist trước khi deploy

- [ ] `node -c <file>.js` pass cho mọi file backend đã sửa
- [ ] `JSON.parse` pass cho mọi file i18n đã sửa
- [ ] Test local đã OK (`npm run dev`)
- [ ] Đã commit + push lên GitHub
- [ ] Backup DB nếu có schema migration nguy hiểm
- [ ] Check Caddy proxy còn chạy (`docker ps | grep caddy`)

## Troubleshooting

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `git pull` báo conflict | Local edit ở VPS đè upstream | `git stash` → pull → `git stash pop` |
| Container `unhealthy` | Lỗi runtime hoặc thiếu env | `docker logs asinu-backend` xem stack |
| `curl https://asinu.top/` connection refused | Caddy proxy chết | `docker restart asinu-public-proxy` |
| `502 Bad Gateway` từ Caddy | Backend chết hoặc khác network | Kiểm tra `docker network inspect asinu_net` — backend + caddy phải cùng network |
| HTTP 404 từ Express path lạ | OK — backend healthy, chỉ là path không tồn tại | Test path đúng (vd. `/api/care-circle/connections`) |
| `name already in use` khi `docker run` | Container cũ chưa rename/rm | `docker rename asinu-backend asinu-backend-old` trước |

## Cron jobs đang chạy trong backend

Tự động trong `server.js`, không cần cron riêng:

| Cron | Schedule (VN time) | File |
|---|---|---|
| Basic notifications (reminders, checkin, ...) | mỗi phút | `basic.notification.service.js → runBasicNotifications` |
| Lifecycle segment update | 1:00 sáng | `profile/lifecycle.service.js` |
| R&D nightly cycle | 2:00 sáng | `checkin/rnd-cycle.service.js` |
| Lifecycle notifications (sub expiring/expired, profile incomplete, weekly summary) | 7:00 sáng | `lifecycle.notification.service.js` |
| Chat history cleanup | mỗi 24h | inline trong `server.js` |
