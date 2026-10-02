# IAP

Backend xác minh subscription Apple/Google cho ba gói An Tâm 2, 4 và 8. Mobile dùng `expo-iap`, không dùng `react-native-iap`.

Nguồn cấu hình hiện hành:

- [Danh sách biến môi trường](../IAP_ENV_VARS.md)
- [Hướng dẫn tạo và test sản phẩm](../IAP_SETUP_GUIDE.md)
- [Hướng dẫn deploy](../DEPLOY_IAP.md)

Checklist tối thiểu:

- Sáu SKU đúng tên và giá đã được tạo/activate trên Store.
- App package/bundle là `com.asinu.lite`.
- Apple Root CA tồn tại trong container.
- Google service account có quyền đọc đơn hàng và subscription.
- Sandbox chỉ trỏ backend/database staging hoặc local.
- Production đặt `APPLE_IAP_ENV=production` và `IAP_ALLOW_SANDBOX=false`.
