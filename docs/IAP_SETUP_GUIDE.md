# Test IAP Asinu V2

Asinu V2 chỉ bán ba gói An Tâm qua App Store và Google Play. App dùng `expo-iap`; backend luôn xác minh giao dịch trước khi cấp quyền.

## Danh mục bắt buộc

| Gói | Tháng | Năm | Quà gói năm |
|---|---|---|---|
| An Tâm 2 | iOS: `asinu.premium.monthly`; Android: `asinu.antam2.monthly`, 149.000đ | iOS: `asinu.premium.yearly`; Android: `asinu.antam2.yearly`, 1.199.000đ | 2 lượt dr.asinu |
| An Tâm 4 | `asinu.antam4.monthly`, 199.000đ | `asinu.antam4.yearly`, 1.499.000đ | 4 lượt dr.asinu |
| An Tâm 8 | `asinu.antam8.monthly`, 249.000đ | `asinu.antam8.yearly`, 1.799.000đ | 8 lượt dr.asinu |

Hai SKU iOS `asinu.premium.*` đã duyệt được tái sử dụng và ánh xạ thành An Tâm 2; không tạo `An Tâm 1`.

## iOS Sandbox trên máy thật

1. Trong App Store Connect, tạo một subscription group và sáu auto-renewable subscription đúng Product ID ở trên.
2. Điền localization, giá, tax category và review information. Paid Applications Agreement phải ở trạng thái Active.
3. Tạo Sandbox Apple Account trong Users and Access.
4. Backend test phải dùng database riêng hoặc local:

```env
NODE_ENV=development
IAP_ENABLED=true
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_APPLE_ID=6758967197
APPLE_IAP_ENV=sandbox
APPLE_ROOT_CA_DIR=./certs/apple
```

5. Build development client, cài lên iPhone thật và bật Developer Mode:

```bash
cd /Users/ducytcg123456/Desktop/APP/app/asinu
npx eas-cli@24.8.0 build --platform ios --profile development
npx expo start --dev-client
```

6. Đăng nhập Sandbox Apple Account trong Settings, Developer, rồi mua từ màn Gói chăm sóc.

TestFlight cũng tạo giao dịch sandbox. Nếu dùng backend chạy `NODE_ENV=production`, chỉ backend staging riêng được phép đặt đồng thời:

```env
APPLE_IAP_ENV=sandbox
IAP_ALLOW_SANDBOX=true
```

Không bật `IAP_ALLOW_SANDBOX` trên `asinu.top`.

## Android Internal Testing

1. Trong Play Console, tạo và activate sáu subscription. Mỗi SKU có đúng một auto-renewing base plan tương ứng tháng hoặc năm.
2. Upload AAB package `com.asinu.lite` vào Internal testing.
3. Thêm cùng tài khoản Google vào Internal testers và Settings, License testing.
4. Cài app từ opt-in link của Play Store, không sideload bản release cần test.
5. Backend test dùng service account có quyền đọc đơn hàng và subscription.

Giao dịch test Google cũng có `testPurchase`. Backend production từ chối giao dịch này trừ khi staging riêng bật `IAP_ALLOW_SANDBOX=true`.

## Ca kiểm thử bắt buộc

- Free lên An Tâm 2 tháng.
- An Tâm 2 lên 4 và 8: tính chênh lệch ngay.
- Hạ gói hoặc đổi năm sang tháng: có hiệu lực ở kỳ tiếp theo trên Android.
- Gói tháng cấp 0 lượt dr.asinu; gói năm cấp đúng 2, 4 hoặc 8.
- Gỡ/cài lại app rồi Khôi phục giao dịch; không cấp quà hai lần.
- Gia hạn, hủy, hết hạn, refund và revoke qua Store.
- Mã ưu đãi mở sheet của App Store hoặc trang redeem của Google Play.

## Dấu hiệu thành công

Client log:

```text
[iap] init success
[iap] fetch products success
[iap] purchase updated
[iap] verify success
```

Backend log phải có `iap.activated`.

API cần kiểm tra:

- `GET /api/iap/products`: đúng sáu SKU.
- `POST /api/iap/verify`: trả `ok: true`.
- `GET /api/subscriptions/status`: đúng gói và thời hạn.
- `GET /api/subscription-household`: giới hạn đúng 2, 4 hoặc 8.
- `GET /api/subscriptions/history`: có giao dịch vừa tạo.

Không ghi log hoặc chia sẻ `raw_payload`, purchase token hay JWS.
