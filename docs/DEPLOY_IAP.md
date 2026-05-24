# Backend Asinu — Deploy bản có IAP

> Phần deploy hạ tầng (Docker, Caddy, Postgres, Redis) đã ở `DEPLOY.md`.
> File này chỉ tập trung vào bước **pull bản code mới có IAP** rồi đi vào
> production. Khoảng 15-30 phút sau khi đã có docker compose chạy.

---

## 1. Pull code

Trên VPS:

```bash
cd /root/backend.asinu
git fetch origin
git checkout main
git pull --ff-only origin main
```

Đảm bảo các file mới đã có:

```bash
ls certs/apple/                       # 3 file .cer
ls src/services/payment/iap.service.js
ls src/controllers/iap.controller.js
ls tests/unit/iap.test.js
```

## 2. Build lại Docker image (cài deps mới)

Bản này thêm `@apple/app-store-server-library`, `googleapis`, `jose`.

```bash
docker compose build asinu-api
# hoặc force pull base image trước nếu có lỗi cache:
# docker compose build --pull --no-cache asinu-api
```

## 3. Migration

Bảng `iap_receipts` đã có từ migration `072` (cũ). Kiểm tra:

```bash
docker compose exec asinu_postgres psql -U asinu_user -d asinu_db -c "\d iap_receipts"
```

Nếu báo "Did not find" → chạy migration:

```bash
docker compose exec asinu_postgres psql -U asinu_user -d asinu_db \
  -f /docker-entrypoint-initdb.d/072_iap_receipts.sql
```

(Hoặc mount migration vào container và psql trực tiếp.)

## 4. Cập nhật `.env` trên VPS

Mở `/root/backend.asinu/.env`, thêm 5 biến IAP (nếu chưa có):

```env
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_APPLE_ID=<10 chữ số từ App Store Connect>
APPLE_IAP_ENV=sandbox

GOOGLE_PLAY_PACKAGE_NAME=com.asinu.lite
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/etc/secrets/asinu-play-sa.json
```

**Upload Service Account JSON vào container:**

```bash
# Cách 1: copy vào host, mount qua volume trong docker-compose.yml
mkdir -p /root/secrets
nano /root/secrets/asinu-play-sa.json   # paste JSON
chmod 600 /root/secrets/asinu-play-sa.json

# Thêm vào docker-compose.yml dưới asinu-api.volumes:
#   - /root/secrets/asinu-play-sa.json:/etc/secrets/asinu-play-sa.json:ro
```

Chi tiết bảng env: xem [`IAP_ENV_VARS.md`](./IAP_ENV_VARS.md).

## 5. Restart container

```bash
docker compose up -d asinu-api
docker compose logs -f asinu-api --tail 50
```

Look for:
- ✅ `server.listening` — backend up
- ⚠️ `iap.apple.no_root_certs` — Apple certs không mount được (check `certs/apple/`)
- ⚠️ `iap.google.bad_credentials` — SA JSON sai format

## 6. Smoke test

```bash
curl -s https://asinu.top/api/iap/products | jq
# Phải trả: { ok: true, apple_bundle_id, google_package_name, products: [...] }
```

## 7. Paste webhook URL vào 2 console

| Store | URL | Vị trí trong console |
|---|---|---|
| App Store Connect | `https://asinu.top/api/iap/apple-notifications` | App Information → App Store Server Notifications → Production URL (chọn Version 2) |
| Google Play | `https://asinu.top/api/iap/google-notifications` | Monetization setup → Real-time developer notifications → Endpoint URL của Pub/Sub push subscription |

Test webhook bằng nút **Send Test Notification** trên cả 2 console → kiểm tra log backend.

## 8. Run tests (optional, trên CI hoặc local)

```bash
npm test -- tests/unit/iap.test.js
```

Phải pass 22/22.

## 9. Go live

Khi app đã được Apple/Google review approve:

```bash
# /root/backend.asinu/.env
APPLE_IAP_ENV=production
```

```bash
docker compose restart asinu-api
```

## 10. Rollback

```bash
cd /root/backend.asinu
git log --oneline | head -5                    # tìm commit trước IAP
git checkout <hash>
docker compose build asinu-api && docker compose up -d asinu-api
```

`iap_receipts` table không cần rollback (append-only, không phá schema cũ).

---

## Tham khảo

- [`DEPLOY.md`](./DEPLOY.md) — hạ tầng deploy chung (Docker, Caddy, DB)
- [`IAP_ENV_VARS.md`](./IAP_ENV_VARS.md) — bảng env vars chi tiết
- [`IAP_SETUP_GUIDE.md`](./IAP_SETUP_GUIDE.md) — full setup App Store / Play Console
