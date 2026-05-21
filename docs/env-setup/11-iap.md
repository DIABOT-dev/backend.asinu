# 11 · IAP — Apple App Store + Google Play Billing

**Cần lấy:**
- `APPLE_BUNDLE_ID` + `APPLE_APP_STORE_SHARED_SECRET` **HOẶC** `APPLE_APP_STORE_{KEY_ID, ISSUER_ID, PRIVATE_KEY_PATH}`
- `GOOGLE_PLAY_PACKAGE_NAME` + `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (file)

**Vai trò:** Backend verify receipt từ Apple App Store / Google Play sau khi user mua Premium trong mobile app. **Bắt buộc** để tuân thủ chính sách store.

**Chi phí:**
- Apple Developer Program: $99/năm
- Google Play Console: $25 một lần
- Phí commission Apple/Google: 15-30% mỗi giao dịch

**Thời gian setup:** ~1 ngày (chưa kể Apple Review).

---

## ☑️ Checklist

### Apple
- [ ] Apple Developer Program đã enrolled ($99/năm)
- [ ] Bundle ID `com.asinu.lite` đã đăng ký
- [ ] Tạo subscription product trên App Store Connect (monthly + yearly)
- [ ] Tạo App-Specific Shared Secret (Cách A)
- [ ] HOẶC tạo App Store Server API key (Cách B — recommend)
- [ ] Paste env vào `.env`

### Google
- [ ] Google Play Console đã đăng ký ($25)
- [ ] Package name `com.asinu.lite` đã đăng ký
- [ ] Tạo subscription product trên Play Console (monthly + yearly)
- [ ] Tạo Service Account + JSON key
- [ ] Grant role "Service Account User" + "Pub/Sub Subscriber"
- [ ] Liên kết với Play Console (Settings → API access)
- [ ] Upload JSON lên VPS + paste path vào `.env`

### Mobile (FE)
- [ ] `npm install react-native-iap` + native config
- [ ] Wire `initializeIap()` vào `app/_layout.tsx`
- [ ] Replace NOT_IMPLEMENTED trong `src/features/iap/iap.service.ts`
- [ ] Set `EXPO_PUBLIC_PAYMENT_METHOD=iap` trong `.env` mobile

---

## 🍎 Apple — Bước 1: Tạo subscription product

1. Vào https://appstoreconnect.apple.com
2. **My Apps** → chọn `Asinu`
3. Sidebar → **Monetization** → **In-App Purchases** → click **+**
4. Chọn **Auto-Renewable Subscription**
5. Reference Name: `Premium Monthly`, Product ID: `asinu.premium.monthly`
6. Tạo Subscription Group (vd. `asinu_premium`)
7. Form chi tiết:
   - **Duration:** 1 Month
   - **Price:** chọn tier gần 199K nhất ($8.99 ≈ 215K, hoặc dùng custom pricing nếu có)
   - **Display Name** (Vietnamese): `Premium 1 tháng`
   - **Description**: 1-2 câu mô tả quyền lợi
8. Save → Submit for review
9. Lặp lại với `asinu.premium.yearly` (Duration: 1 Year, Price tier $39.99 ≈ 990K)

> 📸 **[Screenshot 1: App Store Connect Subscription form]**

⚠️ **Subscription product cần Apple review riêng** — submit cùng app build. Review 1-3 ngày.

---

## 🍎 Apple — Bước 2A: Lấy Shared Secret (legacy, đơn giản)

1. App Store Connect → **My Apps** → Asinu → **App Information**
2. Cuộn xuống **App-Specific Shared Secret** → click **Manage**
3. Click **Generate** → 32 ký tự hex hiện ra
4. Copy → paste vào `.env`:
```bash
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_STORE_SHARED_SECRET=abcd1234ef567890...
```

> 📸 **[Screenshot 2: Shared Secret]**

---

## 🍎 Apple — Bước 2B: App Store Server API key (recommend cho prod)

App Store Server API mới hơn, không phụ thuộc deprecated `/verifyReceipt`. Phải có cho subscription auto-renew tracking dài hạn.

1. App Store Connect → **Users and Access** → **Integrations** → **App Store Server API**
2. Click **+ Generate API Key**
3. Form:
   - Name: `Asinu Backend Prod`
   - Access: **In-App Purchase** (hoặc cao hơn nếu cần)
4. Download file `.p8` (chỉ 1 lần download được)
5. Lưu **Key ID** (10 chars) + **Issuer ID** (UUID)

Upload file `.p8` lên VPS:
```bash
mkdir -p /root/.apple
scp AuthKey_ABC123XYZ4.p8 root@36.50.176.55:/root/.apple/
chmod 600 /root/.apple/AuthKey_ABC123XYZ4.p8
```

Paste vào `.env`:
```bash
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_STORE_KEY_ID=ABC123XYZ4
APPLE_APP_STORE_ISSUER_ID=12345678-1234-1234-1234-123456789012
APPLE_APP_STORE_PRIVATE_KEY_PATH=/root/.apple/AuthKey_ABC123XYZ4.p8
```

---

## 🤖 Google — Bước 1: Tạo subscription product

1. Vào https://play.google.com/console
2. Chọn app **Asinu**
3. Sidebar → **Monetize** → **Products** → **Subscriptions**
4. Click **Create subscription**
5. Form:
   - **Product ID:** `asinu.premium.monthly`
   - **Name:** `Premium 1 tháng`
   - **Description:** mô tả ngắn
   - **Base plan:** tạo base plan tên `monthly`
   - **Billing period:** 1 Month
   - **Price:** 199.000 VND (Google cho custom pricing tự do hơn Apple)
6. Save → Activate
7. Lặp lại với `asinu.premium.yearly` (billing period 1 Year, price 999.000 VND)

> 📸 **[Screenshot 3: Play Console Subscription create]**

---

## 🤖 Google — Bước 2: Service Account + JSON key

1. Vào https://console.cloud.google.com — chọn project liên kết với Play Console
2. **IAM & Admin** → **Service Accounts** → **+ CREATE**
3. Form:
   - Name: `play-publisher`
   - Role: **Service Account User**
4. Created → click **Keys** → **ADD KEY** → JSON → download file
5. Mở https://play.google.com/console → **Settings** → **API access** → Link GCP project
6. Trong section **Service accounts**, tìm `play-publisher@<project>.iam.gserviceaccount.com`
7. Click **Grant access** → chọn permissions:
   - View financial data
   - Manage orders and subscriptions
8. Save

Upload JSON lên VPS:
```bash
mkdir -p /root/.gcp
scp play-publisher-abc123.json root@36.50.176.55:/root/.gcp/play-publisher.json
chmod 600 /root/.gcp/play-publisher.json
```

Paste vào `.env`:
```bash
GOOGLE_PLAY_PACKAGE_NAME=com.asinu.lite
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/root/.gcp/play-publisher.json
```

Mount JSON vào container:
```yaml
# docker-compose.yml
asinu-backend:
  volumes:
    - /root/.gcp:/root/.gcp:ro
    - /root/.apple:/root/.apple:ro
```

---

## 📱 Mobile FE — Bước 3: Cài react-native-iap

Trên máy dev (sau khi anh đã có Apple Developer + Play Console product):

```bash
cd ~/Desktop/APP/asinu
npm install react-native-iap
npx pod-install   # iOS
```

Update `app.json`:
```json
{
  "expo": {
    "plugins": [
      ["react-native-iap"]
    ]
  }
}
```

Wire vào app entry (`app/_layout.tsx`):
```tsx
import { initializeIap } from '../src/features/iap/iap.service';

useEffect(() => {
  initializeIap();
}, []);
```

Mở `src/features/iap/iap.service.ts` → uncomment các block `// const RNIap = require('react-native-iap');` và sửa code đầy đủ (xem comment trong file).

Cuối cùng, đổi `.env` mobile:
```bash
EXPO_PUBLIC_PAYMENT_METHOD=iap
EXPO_PUBLIC_IAP_PRODUCT_MONTHLY=asinu.premium.monthly
EXPO_PUBLIC_IAP_PRODUCT_YEARLY=asinu.premium.yearly
```

---

## ✅ Verify

### Test trên iOS Sandbox
1. Tạo Sandbox tester trên App Store Connect (Users → Sandbox Testers)
2. Đăng nhập sandbox account trên iPhone test (Settings → App Store → Sandbox Account)
3. Build TestFlight + cài app
4. Mua subscription → Apple sẽ hỏi sandbox account → OK
5. App nhận receipt → gửi backend → backend log:
```
{"level":"info","msg":"iap.activated","platform":"apple","userId":...}
```

### Test trên Android Internal Track
1. Upload APK lên Play Console → Internal Testing Track
2. Add Google account vào tester list
3. Cài app từ Internal Track URL trên Android
4. Mua subscription → Google hiện popup test → "Hoàn tất giao dịch test"
5. Backend log:
```
{"level":"info","msg":"iap.activated","platform":"google","userId":...}
```

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| `APPLE_VERIFIER_NOT_IMPLEMENTED` | Stub chưa được wire thật | Cài `node-apple-receipt-verify` hoặc gọi App Store Server API thủ công |
| `GOOGLE_VERIFIER_NOT_IMPLEMENTED` | Tương tự | Dùng `googleapis` package |
| Apple reject app | Subscription chưa "Ready to Submit" | Tạo + submit product cùng app build |
| Sandbox purchase failed | Account trùng giữa sandbox và prod | Sign out tất cả, signin chỉ với sandbox |
| Android: Item already owned | Test purchase chưa được consume | RNIap `consumePurchase` hoặc finishTransaction |

---

## 📝 Note cuối

- Apple ăn **30% năm đầu, 15% năm thứ 2+** cho subscription
- Google ăn **15%** cho subscription dài hạn (1+ năm subscribe)
- Webhook để track renewals: Apple Server Notifications v2 + Google Pub/Sub (cần setup riêng)
- Test sandbox **chậm hơn prod** — renewal 5 phút thay vì 1 tháng để dễ test
