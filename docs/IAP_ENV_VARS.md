# Asinu IAP — Bảng biến môi trường & nguồn lấy

Phần code đã setup xong. Việc còn lại là điền 8 biến này. Bảng dưới chỉ rõ
mỗi biến lấy ở đâu, dán vào file nào, có format gì.

> **Quy ước:** mọi đường dẫn dưới đây tính từ thư mục dự án `APP/`.
> Mobile client → `asinu/.env`. Backend → `backend.asinu/.env`.

---

## A. CLIENT — `asinu/.env`

| Biến | Giá trị | Bắt buộc | Nguồn |
|---|---|---|---|
| `EXPO_PUBLIC_PAYMENT_METHOD` | `iap` | ✅ | Đổi từ `hidden` thành `iap` khi sẵn sàng bật tính năng. |
| `EXPO_PUBLIC_IAP_PRODUCT_MONTHLY` | `asinu.premium.monthly` | ✅ | **Trùng product ID bạn tạo trên App Store Connect + Play Console**. |
| `EXPO_PUBLIC_IAP_PRODUCT_YEARLY` | `asinu.premium.yearly` | ✅ | Trùng product ID bạn tạo. |

```env
EXPO_PUBLIC_PAYMENT_METHOD=iap
EXPO_PUBLIC_IAP_PRODUCT_MONTHLY=asinu.premium.monthly
EXPO_PUBLIC_IAP_PRODUCT_YEARLY=asinu.premium.yearly
```

> Sau khi sửa, **rebuild dev-client** (không dùng Expo Go):
> ```
> cd asinu && npx expo prebuild --clean && npx expo run:ios
> ```

---

## B. BACKEND — `backend.asinu/.env`

### B.1 Apple

| Biến | Bắt buộc | Lấy ở đâu |
|---|---|---|
| `APPLE_BUNDLE_ID` | ✅ | `com.asinu.lite` — đã match `app.json`. **Không đổi** trừ khi bạn rename app. |
| `APPLE_APP_APPLE_ID` | ⚠️ ở production | App Store Connect → chọn app **Asinu** → **App Information** → **General Information** → trường **Apple ID** (chuỗi số ~10 chữ số, vd `6478123456`). |
| `APPLE_IAP_ENV` | ✅ | `sandbox` khi đang test (Sandbox Tester). Đổi sang `production` ngay khi app go live trên App Store. |
| `APPLE_ROOT_CA_DIR` | optional | Mặc định `./certs/apple`. Đã tạo sẵn dir; chỉ cần **drop file .cer vào** (xem mục C bên dưới). |

```env
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_APPLE_ID=6478123456
APPLE_IAP_ENV=sandbox
APPLE_ROOT_CA_DIR=/app/certs/apple   # absolute path nếu chạy trong Docker
```

### B.2 Google

| Biến | Bắt buộc | Lấy ở đâu |
|---|---|---|
| `GOOGLE_PLAY_PACKAGE_NAME` | ✅ | `com.asinu.lite` — đã match `app.json`. **Không đổi**. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | ✅ | File JSON tải về khi tạo Service Account (xem D.3). Có thể: ⓐ paste đường dẫn file, hoặc ⓑ paste cả nội dung JSON inline trên 1 dòng. |

```env
GOOGLE_PLAY_PACKAGE_NAME=com.asinu.lite

# Option A — đường dẫn file (khuyên dùng):
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/etc/secrets/asinu-play-sa.json

# Option B — inline (chỉ khi không thể mount file, vd Vercel):
# GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",...}
```

> **Quan trọng cho option B:** trong JSON, các `\n` trong `private_key` phải được escape thành `\\n`, hoặc paste nguyên xuống cả `private_key` rồi quote bằng `'...'`. Test bằng `node -e "console.log(JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).client_email)"`.

### B.3 Product IDs

| Biến | Giá trị |
|---|---|
| `IAP_PRODUCT_MONTHLY` | `asinu.premium.monthly` |
| `IAP_PRODUCT_YEARLY` | `asinu.premium.yearly` |

### B.4 Observability (optional)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `SENTRY_DSN` | optional | Khi set, mọi lỗi IAP gửi lên Sentry với tags `{component, platform, code, productId, notificationType}`. Bỏ trống → no-op, không phá vỡ flow. |

> **Rate-limit đã bật sẵn:** `POST /api/iap/verify` giới hạn **20 req/phút/user**.
> Bình thường user không bao giờ chạm trần (mua + restore vài lần). Webhook
> Apple/Google không bị limit.

---

## C. Apple Root CA — drop file vào server

Một lần, tải 3 file rồi đặt vào `backend.asinu/certs/apple/`:

```bash
cd backend.asinu/certs/apple
curl -O https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
curl -O https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
curl -O https://www.apple.com/appleca/AppleIncRootCertificate.cer
```

Khi deploy lên VPS / Docker, **copy nguyên thư mục** này lên (đã có trong repo, không cần build lại).

---

## D. Setup trên Console (cần làm 1 lần, không phải code)

### D.1 App Store Connect — tạo Subscription

1. https://appstoreconnect.apple.com → chọn app **Asinu**.
2. Sidebar **Monetization → Subscriptions → + Create Subscription Group** → đặt tên `Asinu Premium`.
3. Trong group:
   - **+ Create Subscription** → Product ID `asinu.premium.monthly`, Duration 1 Month, Price 199.000₫.
   - **+ Create Subscription** → Product ID `asinu.premium.yearly`, Duration 1 Year, Price 1.999.000₫.
4. Mỗi product cần có **Localization** (tiếng Việt + tiếng Anh) + **Review screenshot** + **Description** trước khi status chuyển từ `Missing Metadata` → `Ready to Submit`.

### D.2 App Store Server Notifications

1. App Store Connect → **App Information** → **App Store Server Notifications**.
2. **Production Server URL:** `https://asinu.top/api/iap/apple-notifications`
3. **Sandbox Server URL:** dán cùng URL (Apple sẽ tự gửi sandbox events).
4. **Version:** chọn **Version 2** (V1 đã deprecated).
5. **Apple ID:** lưu lại để điền vào `APPLE_APP_APPLE_ID`.

### D.3 Google Play Console — đăng ký + tạo product + Service Account

1. **Đăng ký Play Console** (phí $25 1 lần): https://play.google.com/console
2. **Create app** → tên `Asinu`, package `com.asinu.lite`.
3. Upload AAB lên Internal Testing track (build bằng `cd asinu/android && ./gradlew bundleRelease`).
4. **Monetize → Subscriptions → Create subscription:**
   - Product ID `asinu.premium.monthly`, Base plan: Auto-renewing, 1 month, 199.000₫. **Activate**.
   - Product ID `asinu.premium.yearly`, Base plan: Auto-renewing, 1 year, 1.999.000₫. **Activate**.
5. **Setup → API access**:
   - Click **Create new service account** → mở Cloud Console.
   - Cloud Console → **IAM & Admin → Service Accounts → Create**: tên `asinu-iap-verifier`, skip role.
   - Tab **Keys → Add key → JSON** → tải file `.json` về. **Đây là `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`**.
   - Quay lại Play Console → **API access** → **Grant access** cho service account: permissions **View financial data** + **Manage orders and subscriptions**.
6. **Real-time developer notifications:**
   - Tạo Pub/Sub topic trong Google Cloud (`asinu-rtdn`).
   - Tạo Push subscription cho topic → endpoint URL: `https://asinu.top/api/iap/google-notifications`.
   - Play Console → **Monetize → Monetization setup → Real-time developer notifications**: paste topic name `projects/<GCP_PROJECT>/topics/asinu-rtdn`.
   - Cấp role `Pub/Sub Publisher` cho `google-play-developer-notifications@system.gserviceaccount.com` trên topic đó.

### D.4 Tester Sandbox / License

- **iOS:** App Store Connect → **Users and Access → Sandbox → Testers** → tạo email mới (chưa từng dùng làm Apple ID). Đăng nhập tester ở `Settings → App Store → Sandbox Account` trên iPhone test.
- **Android:** Play Console → **Setup → License testing** → thêm email Gmail dev của bạn. Mở Play Store trên thiết bị test với email đó.

---

## E. Endpoint webhook đã sẵn

| Webhook | Đường dẫn | Khi nào dùng |
|---|---|---|
| Apple Server Notifications v2 | `POST /api/iap/apple-notifications` | Apple POST tự động khi user renew/cancel/refund. |
| Google RTDN (Pub/Sub) | `POST /api/iap/google-notifications` | Google đẩy qua Pub/Sub push subscription. |

Mỗi webhook tự verify chữ ký (Apple) hoặc payload (Google). Không cần auth token.

---

## F. Checklist before submit

- [ ] `EXPO_PUBLIC_PAYMENT_METHOD=iap` trong `.env` của client.
- [ ] 8 biến mục B đã có giá trị.
- [ ] 3 file `.cer` đã có trong `backend.asinu/certs/apple/`.
- [ ] 2 products đã `Ready to Submit` trên App Store Connect.
- [ ] 2 subscriptions đã `Active` trên Play Console (base plan publish).
- [ ] Webhook URL đã paste vào App Store Connect + Play Console.
- [ ] Đã test mua thật bằng Sandbox Tester / License Tester.
- [ ] Khi go live, đổi `APPLE_IAP_ENV=production`.

---

## G. Lệnh test nhanh sau khi điền env

```bash
# Backend healthcheck — load env, init verifiers
cd backend.asinu && node -e "
  require('dotenv').config();
  const s = require('./src/services/payment/iap.service');
  console.log('Apple bundle:', process.env.APPLE_BUNDLE_ID);
  console.log('Google package:', process.env.GOOGLE_PLAY_PACKAGE_NAME);
"

# Gọi endpoint products (public)
curl http://localhost:3000/api/iap/products | jq

# Mua thử trên thiết bị → backend log sẽ hiện 'iap.apple_verify' hoặc 'iap.google_verify'.
```

Có lỗi nào trong quá trình điền, gửi mình log để debug.
