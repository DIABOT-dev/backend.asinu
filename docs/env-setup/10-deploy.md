# 10 · Triển khai `.env` lên VPS

**Mục tiêu:** Sau khi đã có đủ giá trị thật từ các bước 01–09, upload file `.env` lên VPS production và restart backend.

**Thời gian:** ~5 phút.

---

## ☑️ Checklist trước khi deploy

- [ ] File `.env` local đã đủ tất cả keys (xem [README.md](./README.md) phần "Checklist tiến độ")
- [ ] Đã backup `.env` cũ trên VPS (đề phòng rollback)
- [ ] Đã backup database (đề phòng migration mới fail)
- [ ] Đã thông báo user / khách hàng về downtime ngắn (~30s)

---

## Bước 1 — Verify `.env` local

Mở terminal trên máy mac, đếm số dòng:

```bash
cd ~/Desktop/APP/backend.asinu
grep -v "^#" .env | grep "=" | wc -l
```

Số nên ra ~30 (nếu chưa setup MedGemma + Sentry) hoặc ~33 (nếu setup đủ).

Verify không có key nào trống:

```bash
grep -v "^#" .env | grep -E "=\s*$" || echo "OK — không có key nào trống"
```

Nếu hiện ra dòng nào — đó là key đang để trống, cần fill.

---

## Bước 2 — Backup `.env` cũ trên VPS

```bash
ssh root@36.50.176.55 'cp /root/backend.asinu/.env /root/backend.asinu/.env.bak-$(date +%Y%m%d-%H%M%S)'
```

Verify backup tạo thành công:

```bash
ssh root@36.50.176.55 'ls -la /root/backend.asinu/.env.bak*'
```

---

## Bước 3 — Backup database (đề phòng)

```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && ./scripts/backup-db.sh'
```

Script này dump Postgres ra `/var/backups/asinu/asinu-<timestamp>.sql.gz`.

Verify:
```bash
ssh root@36.50.176.55 'ls -la /var/backups/asinu/ | tail -3'
```

---

## Bước 4 — Upload `.env` lên VPS

```bash
scp ~/Desktop/APP/backend.asinu/.env root@36.50.176.55:/root/backend.asinu/.env
```

Verify upload:

```bash
ssh root@36.50.176.55 'wc -l /root/backend.asinu/.env'
```

Số dòng phải khớp với local.

---

## Bước 5 — Restart container

```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && docker compose restart asinu-backend'
```

Đợi 10–15 giây cho container restart + migrate.

---

## Bước 6 — Verify logs

```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && docker compose logs --tail=40 asinu-backend'
```

Logs nên có:

```
asinu-backend  | > backend.asinu@1.0.0 start
asinu-backend  | > node scripts/migrate.js && node server.js
asinu-backend  | [dotenv@17.2.3] injecting env (0) from .env
asinu-backend  | (migrations đã apply trước → không có dòng "applied" mới)
asinu-backend  | {"level":"info","msg":"server.listening","port":"3000"}
asinu-backend  | [Redis] Connected
```

Nếu Sentry đã setup:
```
asinu-backend  | {"level":"info","msg":"sentry.enabled","environment":"production"}
```

**Nếu có error:**
- `JWT_SECRET is not set` → check `.env` line `JWT_SECRET=`
- `Database connection refused` → check `DATABASE_URL` không bị đổi
- `Error: connect ECONNREFUSED redis` → check `REDIS_URL`

---

## Bước 7 — Smoke test API

```bash
# Health check
curl -sS https://asinu.top/api/healthz
# → {"status":"ok"}

# Check container env loaded
ssh root@36.50.176.55 'docker exec asinu-backend printenv | grep -E "^(OPENAI|GOOGLE|ZALO|FACEBOOK|SEPAY|EXPO|JWT|SENTRY|MEDGEMMA)_" | sed "s/=.*/=<set>/"'
```

Output sẽ hiển thị tất cả keys đang set giá trị (giấu giá trị thật):

```
OPENAI_API_KEY=<set>
OPENAI_MODEL=<set>
GOOGLE_WEB_CLIENT_ID=<set>
GOOGLE_WEB_CLIENT_SECRET=<set>
GOOGLE_IOS_CLIENT_ID=<set>
GOOGLE_ANDROID_CLIENT_ID=<set>
ZALO_APP_ID=<set>
ZALO_SECRET_KEY=<set>
FACEBOOK_APP_ID=<set>
FACEBOOK_APP_SECRET=<set>
SEPAY_ACCOUNT_NUMBER=<set>
SEPAY_BANK_CODE=<set>
SEPAY_API_KEY=<set>
EXPO_ACCESS_TOKEN=<set>
JWT_SECRET=<set>
SENTRY_DSN=<set>
```

Đếm số dòng → khớp với số keys anh đã setup ✅

---

## Bước 8 — Test end-to-end các flow

| Flow | Cách test | Verify |
|---|---|---|
| Login Google | App → Đăng nhập Google → chọn account | Backend log: `[auth.google] verified` |
| Login Zalo | App → Đăng nhập Zalo | Backend log: `[auth.zalo] verified` |
| Login Facebook | App → Đăng nhập Facebook | Backend log: `[auth.facebook] verified` |
| Chat AI | App → Chat → gửi "xin chào" | Backend gọi OpenAI, trả lời |
| Push notification | Send từ admin → device | Device nhận push |
| Thanh toán | App → Nạp ví → quét QR → chuyển khoản | Webhook SePay → wallet cộng tiền |

---

## 🆘 Trouble shooting tổng quát

### Container không start
```bash
ssh root@36.50.176.55 'docker compose logs --tail=50 asinu-backend'
```
Tìm error đầu tiên — thường là env var thiếu.

### Container start nhưng API trả lỗi
```bash
# Test trực tiếp container
ssh root@36.50.176.55 'docker exec asinu-backend curl -sS http://localhost:3000/api/healthz'
# Nếu OK → vấn đề ở Caddy proxy hoặc DNS

# Test qua Caddy
ssh root@36.50.176.55 'curl -sS https://asinu.top/api/healthz'
```

### Cần rollback `.env`
```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && \
  cp .env.bak-<timestamp> .env && \
  docker compose restart asinu-backend'
```

### Cần rollback toàn bộ deploy
```bash
ssh root@36.50.176.55 'cd /root/backend.asinu && \
  git log --oneline -5'
# Xem commit cũ → checkout
ssh root@36.50.176.55 'cd /root/backend.asinu && \
  git checkout <commit-hash> && \
  docker compose up -d --build'
```

---

## 📝 Note sau khi deploy

1. **Theo dõi log 30 phút đầu** sau deploy — nhiều bug chỉ lộ khi user thật dùng
2. **Check Sentry dashboard** mỗi sáng — xem có errors mới không
3. **Backup `.env` ra Bitwarden / 1Password** — backup duy nhất bị mất là thảm họa
4. **Đừng commit `.env`** vào git (đã có `.gitignore` rồi nhưng verify lại)

---

## ✅ KẾT THÚC

Sau khi pass tất cả smoke test → backend đã sẵn sàng production. Quay lại [README.md](./README.md) tick các checkbox đã hoàn thành.
