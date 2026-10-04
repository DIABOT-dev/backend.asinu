# Biến môi trường IAP Asinu V2

## Mobile

```env
EXPO_PUBLIC_PAYMENT_METHOD=iap
EXPO_PUBLIC_API_BASE_URL=https://<backend-phù-hợp>
```

Product ID được lấy từ `GET /api/iap/products?platform=apple|google`. iOS dùng hai Product ID `asinu.premium.*` đã duyệt cho An Tâm 2; Android dùng `asinu.antam2.*`.

## Backend dùng chung

```env
IAP_ENABLED=true
APPLE_BUNDLE_ID=com.asinu.lite
APPLE_APP_APPLE_ID=6758967197
APPLE_ROOT_CA_DIR=./certs/apple
GOOGLE_PLAY_PACKAGE_NAME=com.asinu.lite
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/run/secrets/google-play.json

IAP_PRODUCT_ANTAM2_MONTHLY=asinu.antam2.monthly
IAP_PRODUCT_ANTAM2_YEARLY=asinu.antam2.yearly
IAP_PRODUCT_ANTAM4_MONTHLY=asinu.antam4.monthly
IAP_PRODUCT_ANTAM4_YEARLY=asinu.antam4.yearly
IAP_PRODUCT_ANTAM8_MONTHLY=asinu.antam8.monthly
IAP_PRODUCT_ANTAM8_YEARLY=asinu.antam8.yearly
```

Hai biến `IAP_PRODUCT_ANTAM2_*` áp dụng cho Google Play. Product ID An Tâm 2 trên iOS là `asinu.premium.monthly` và `asinu.premium.yearly`.

## Production

```env
NODE_ENV=production
APPLE_IAP_ENV=production
IAP_ALLOW_SANDBOX=false
```

Backend sẽ dừng khởi động nếu thiếu Apple App ID, bundle/package, Google service account hoặc cấu hình Apple production.

## Staging/Sandbox riêng

```env
NODE_ENV=production
APPLE_IAP_ENV=sandbox
IAP_ALLOW_SANDBOX=true
```

Chỉ dùng cấu hình này với database staging. Local development có thể để `NODE_ENV=development`, khi đó receipt sandbox được chấp nhận mà không cần cờ bổ sung.

Apple Root CA là chứng thư công khai và được đưa vào Docker image từ `certs/apple`. File `.p8`, service-account JSON và private key vẫn bị loại khỏi Docker context và phải được mount dưới dạng secret.
