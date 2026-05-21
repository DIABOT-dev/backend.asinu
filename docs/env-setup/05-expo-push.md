# 05 · Expo Push Notification

**Cần lấy:** `EXPO_ACCESS_TOKEN`
**Vai trò:** Backend gọi Expo Push Service để gửi thông báo cho mobile app.
**Chi phí:** Miễn phí 15 builds/tháng (đủ cho MVP).
**Thời gian setup:** ~10 phút.

---

## ☑️ Checklist

- [ ] Đã tạo Expo account với email công ty
- [ ] Đã link project Asinu vào account
- [ ] Đã tạo Access Token tên `asinu-backend-push`
- [ ] Đã paste `EXPO_ACCESS_TOKEN` vào `.env`

---

## Bước 1 — Tạo Expo Account

1. Vào https://expo.dev/signup
2. Form đăng ký:
   - **Email:** `dev@asinu.top` (hoặc admin)
   - **Username:** `asinu` (sẽ thành namespace project, ví dụ `@asinu/asinu-mobile`)
   - **Password:** mạnh + lưu password manager
3. Verify email

> 📸 **[Screenshot 1: Trang signup Expo]**

---

## Bước 2 — Bật 2FA (khuyến nghị mạnh)

1. Đăng nhập https://expo.dev
2. Click avatar góc phải → **Settings**
3. Sidebar → **Two-Factor Authentication** → **Enable**
4. Scan QR bằng app Google Authenticator / Authy
5. Lưu backup codes vào password manager

---

## Bước 3 — Tạo Organization (nếu sau này có team)

1. Settings → **Organizations** → **Create**
2. Form:
   - **Name:** `asinu`
   - **Plan:** **Free** (đủ cho MVP — 15 builds/tháng)
3. Create

Sau khi có org, có thể transfer project về org để team chung quản lý.

> 📸 **[Screenshot 2: Create Organization]**

---

## Bước 4 — Link project Asinu

Trên máy có code mobile app:

```bash
cd ~/Desktop/APP/asinu
npx eas login
# Nhập email + password vừa tạo

npx eas init
# Sẽ hỏi:
# - Project name? → asinu
# - Slug? → asinu-app
# - Owner? → asinu (org vừa tạo, hoặc user account)
```

Sau khi xong, file `app.json` sẽ có field:
```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "abcd1234-..."
      }
    }
  }
}
```

Commit changes lên git để team đồng bộ.

---

## Bước 5 — Tạo Access Token

1. Vào https://expo.dev → đăng nhập
2. Click avatar góc phải → **Settings**
3. Sidebar → **Access Tokens**
4. Click **+ Create Access Token**
5. Form:
   - **Name:** `asinu-backend-push`
   - **Note:** "Backend gửi push notification qua Expo Push Service"
6. Click **Create**

> 📸 **[Screenshot 3: Form Create Access Token]**

---

## Bước 6 — Copy Token

⚠️ **Token chỉ hiện 1 LẦN.** Đóng tab mà chưa copy → phải tạo lại.

1. Popup hiện token dạng `expo_AbCdEf1234567890...` (40+ ký tự)
2. Click icon **Copy**
3. Paste vào:
   - File `.env` dòng `EXPO_ACCESS_TOKEN=`
   - Password manager backup

```bash
EXPO_ACCESS_TOKEN=expo_AbCdEf1234567890...
```

> 📸 **[Screenshot 4: Popup hiện token]**

---

## ✅ Verify

Sau khi paste + restart backend:

```bash
docker compose restart asinu-backend
```

Test gửi push từ backend (nếu có user với valid push_token trong DB):

```bash
# Trên VPS
ssh root@36.50.176.55
docker compose exec asinu-backend node -e "
const { sendPushNotification } = require('./src/services/notification/push.notification.service');
sendPushNotification(
  ['ExponentPushToken[xxx-real-token-from-DB-xxx]'],
  'Test',
  'Hello from backend',
  { test: true }
).then(console.log);
"
```

**Kết quả:**
- ✅ Trả về `{ok: true, data: ...}` → push gửi thành công
- ❌ Trả về `{ok: false, error: ...}` → check error message

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| "Unauthorized" | Token sai hoặc đã revoked | Tạo token mới, update `.env` |
| Push không tới device | Device chưa register token vào DB | Mobile app phải gọi `/api/profile/push-token` lúc login |
| Push tới Android nhưng không iOS | Chưa setup APNs certificate trên Expo | Vào `eas credentials` → iOS → upload .p8 từ Apple Developer |
| Push delay vài phút | Expo có queue khi traffic cao | Không phải lỗi, đợi 1–2 phút |

---

## 📝 Note cuối

- Token có thể tạo nhiều — backup, staging, prod
- Mỗi token có thể revoke độc lập từ trang Access Tokens
- Expo có usage dashboard hiển thị số push gửi tại **Settings** → **Usage**
- Bản FREE Expo cho 15 builds/tháng (EAS Build) và push không giới hạn
