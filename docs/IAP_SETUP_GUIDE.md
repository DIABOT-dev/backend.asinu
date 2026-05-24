# Hướng dẫn cấu hình IAP cho Asinu (App Store + Google Play)

Phần code đã sẵn sàng. Tài liệu này hướng dẫn bạn **bật IAP thật** trên cả 2 store.

---

## 0. Bật chế độ IAP trong app

Trong `.env` (hoặc `.env.local`) của Expo client:

```
EXPO_PUBLIC_PAYMENT_METHOD=iap
EXPO_PUBLIC_IAP_PRODUCT_MONTHLY=asinu.premium.monthly
EXPO_PUBLIC_IAP_PRODUCT_YEARLY=asinu.premium.yearly
```

Sau đó rebuild client (KHÔNG expo-go — phải dev-client hoặc EAS build):

```bash
cd asinu
npx expo prebuild --clean
npx expo run:ios       # iOS
npx expo run:android   # Android
```

---

## 1. App Store Connect (iOS)

### 1.1 Tạo Subscription Group + Products

1. Vào https://appstoreconnect.apple.com → chọn app `Asinu`.
2. Sidebar → **Monetization** → **Subscriptions** → **+ Create Subscription Group** → đặt tên `Asinu Premium`.
3. Trong group đó, **+ Create Subscription**:
   - **Product ID:** `asinu.premium.monthly` *(phải khớp env `IAP_PRODUCT_MONTHLY`)*
   - **Reference Name:** `Premium Monthly`
   - **Subscription Duration:** 1 Month
   - **Price:** 199.000₫ (Vietnam) — Apple tự convert sang các quốc gia khác.
   - Thêm **Localizations** (vi, en).
   - **Review Information:** ảnh chụp UI subscription + 1 câu mô tả.
4. Lặp lại cho `asinu.premium.yearly`:
   - Duration: 1 Year
   - Price: 1.999.000₫ (~999.000 × 2 với 17% discount; tùy bạn)
5. Status mỗi product phải là **Ready to Submit** trước khi submit app review.

### 1.2 Lấy In-App Purchase Key (Apple Server Notifications)

1. **Users and Access** → **Integrations** → **In-App Purchase** → **Generate API Key**.
2. Tải file `.p8` về. Lưu lại **Key ID** + **Issuer ID** (chỉ hiện 1 lần!).
3. Đây là API key để backend gọi App Store Server API (nếu bạn muốn poll status sau này). KHÔNG bắt buộc cho luồng verify JWS đơn giản — code hiện tại chỉ cần Root CAs.

### 1.3 Tải Apple Root CA về backend

```bash
cd backend.asinu/certs/apple
curl -O https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
curl -O https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
curl -O https://www.apple.com/appleca/AppleIncRootCertificate.cer
```

### 1.4 Tạo Sandbox Tester

1. **Users and Access** → **Sandbox** → **Testers** → **+**.
2. Đặt email *chưa từng* dùng làm Apple ID (vd `tester+asinu@gmail.com`).
3. Trên thiết bị test: **Settings → App Store → Sandbox Account** → đăng nhập bằng tester.
4. Build app dev-client → mua → giao dịch sẽ chạy ở môi trường sandbox (miễn phí, gia hạn 5 phút).

---

## 2. Google Play Console — đăng ký + cấu hình

### 2.1 Đăng ký tài khoản

1. Vào https://play.google.com/console → **Get started**.
2. Chọn **Organization** (nếu bạn có pháp nhân) hoặc **Personal** (cá nhân).
3. Phí: **$25 (1 lần, vĩnh viễn)** — thanh toán bằng thẻ visa/master.
4. Xác minh danh tính (CMND/CCCD nếu cá nhân, GP kinh doanh nếu org).
5. Sau khi approve (vài giờ → 2 ngày), bạn có Play Console.

### 2.2 Tạo app + Subscription products

1. **Create app** → tên `Asinu`, ngôn ngữ mặc định `Tiếng Việt`, package name = `com.asinu.lite` (phải khớp `app.json`).
2. Upload **internal testing** AAB (build ra bằng `cd asinu/android && ./gradlew bundleRelease`) → mục đích để Play biết package tồn tại.
3. **Monetize** → **Subscriptions** → **Create subscription**:
   - **Product ID:** `asinu.premium.monthly`
   - **Name:** Premium Monthly
   - **Base plan:** Auto-renewing, billing period 1 month, price 199.000₫.
   - Activate base plan.
4. Lặp lại cho `asinu.premium.yearly` (billing period 1 year).
5. **Quan trọng:** subscription phải có ít nhất 1 *base plan* đang ACTIVE — nếu không, Play Billing trả `offerToken` null và code IAP sẽ báo "Missing offerToken".

### 2.3 Tạo Service Account (để backend verify)

1. **Setup → API access** → **Create new service account** → mở Google Cloud Console.
2. Trong Cloud Console: **Service Accounts → Create**.
   - Tên: `asinu-iap-verifier`.
   - Skip role (sẽ grant trong Play Console).
   - Tab **Keys → Add Key → JSON** → tải file JSON về.
3. Quay lại Play Console → **API access** → **Grant access** cho service account này:
   - Permissions: **View financial data**, **Manage orders and subscriptions**.
4. Đặt file JSON ở backend, ví dụ `/etc/secrets/asinu-play-sa.json`.

### 2.4 Tạo License Tester (mua test không tốn tiền)

1. **Setup → License testing** → thêm email Gmail của bạn.
2. Trên Android dev: đăng nhập Play Store bằng email đó → mua subscription qua app sẽ ở chế độ test (refund tự động).

---

## 3. Env vars backend

Thêm vào `backend.asinu/.env`:

```bash
# Apple
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_APPLE_ID=                # ID số của app trên App Store (có sau khi tạo app, optional)
APPLE_IAP_ENV=sandbox              # 'sandbox' khi test, 'production' khi live
APPLE_ROOT_CA_DIR=/abs/path/backend.asinu/certs/apple

# Google
GOOGLE_PLAY_PACKAGE_NAME=com.asinu.lite
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/etc/secrets/asinu-play-sa.json
# Hoặc inline:
# GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# Optional — đồng bộ ID với client
IAP_PRODUCT_MONTHLY=asinu.premium.monthly
IAP_PRODUCT_YEARLY=asinu.premium.yearly
```

Restart backend sau khi đổi env.

---

## 4. Test flow

### 4.1 Sandbox iOS
1. Build `npx expo run:ios` → mở app trên iPhone đã login Sandbox Tester.
2. Vào màn `/subscription` → chọn gói → bấm **Nâng cấp ngay**.
3. Apple sheet hiện → confirm → app gọi `/api/iap/verify` → backend verify JWS → trả `{ ok: true, expiresAt, planMonths }`.
4. UI hiển thị Alert "Kích hoạt thành công", premium status refresh.

### 4.2 Sandbox Android
1. App phải được upload Internal Testing track (Play yêu cầu app đã ở 1 track mới mở Billing).
2. Tài khoản test phải là License Tester.
3. Build dev-client cho Android → mua → backend verify với `subscriptionsv2.get`.

### 4.3 Restore
- Đăng xuất → đăng nhập lại → vào `/subscription` → bấm **Khôi phục mua hàng** → backend nhận lại transaction id cũ, trả `alreadyProcessed: true` → premium được giữ.

---

## 5. Webhook gia hạn (TODO sau khi live)

Khi user gia hạn / hủy / refund, store sẽ thông báo cho backend:

- **Apple:** App Store Server Notifications v2 → URL nhận: `POST /api/iap/apple-notifications` (CHƯA implement — tôi có thể thêm).
- **Google:** Real-Time Developer Notifications qua Pub/Sub → URL nhận: `POST /api/iap/google-notifications` (CHƯA implement).

Không bắt buộc cho lần submit đầu, nhưng PHẢI có trước khi scale lớn (nếu không, expiry của bạn lệch khỏi Apple/Google).

---

## 6. Checklist trước khi submit

- [ ] Product IDs trên Apple/Google trùng `asinu.premium.monthly` + `asinu.premium.yearly`
- [ ] App Privacy → khai báo "User pays for subscription"
- [ ] App Review note: kèm Sandbox Tester credentials
- [ ] `EXPO_PUBLIC_PAYMENT_METHOD=iap` ở build production
- [ ] `APPLE_IAP_ENV=production` ở backend prod
- [ ] Test full flow: mua → verify → premium active → restore → cancel (in iOS Settings)
- [ ] Test sandbox flow trên thiết bị thật (simulator không có StoreKit thật)
- [ ] Apple Root CA G3 đã có trong `backend.asinu/certs/apple/`
