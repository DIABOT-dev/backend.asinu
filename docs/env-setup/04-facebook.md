# 04 · Facebook (Login bằng Facebook)

**Cần lấy 2 biến:**
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`

**Vai trò:** Cho user đăng nhập bằng Facebook.
**Chi phí:** Miễn phí.
**Thời gian setup:** ~30 phút.

---

## ☑️ Checklist

- [ ] Đã có Facebook account của giám đốc (không dùng FB cá nhân nhân viên)
- [ ] Đã tạo Business Account
- [ ] Đã tạo Facebook App
- [ ] Đã add Facebook Login product
- [ ] Đã cấu hình iOS + Android platform
- [ ] Đã lấy `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET`
- [ ] Đã paste cả 2 vào `.env`
- [ ] Đã switch App ở Live mode

---

## Bước 1 — Tạo Business Account

**Lưu ý:** Bắt buộc cho Facebook Login (không dùng cá nhân được).

1. Vào https://business.facebook.com
2. Sign in bằng Facebook account của giám đốc
3. **Create account**
4. Form:
   - **Business name:** `Asinu`
   - **Your name:** Tên giám đốc
   - **Business email:** `admin@asinu.top`
5. Verify email → done

> 📸 **[Screenshot 1: Business Manager dashboard]**

---

## Bước 2 — Tạo Facebook App

1. Vào https://developers.facebook.com/apps
2. **Create App**
3. Use case (popup hỏi đầu tiên):
   - Chọn **Authenticate and request data from users with Facebook Login**
4. Click **Next**
5. App details:
   - **App name:** `Asinu`
   - **App contact email:** `admin@asinu.top`
   - **Business account:** chọn Business vừa tạo
6. Click **Create app**

> 📸 **[Screenshot 2: Create App form]**

---

## Bước 3 — Add Facebook Login Product

1. App vừa tạo → Dashboard → cuộn xuống **Add a Product**
2. Tìm **Facebook Login** → click **Set Up**
3. Sidebar bên trái sẽ có thêm mục **Facebook Login** → **Settings**

### Cấu hình Login Settings:
1. **Client OAuth Login:** Yes
2. **Web OAuth Login:** Yes
3. **Use Strict Mode for Redirect URIs:** Yes ✅
4. **Valid OAuth Redirect URIs:** thêm 2 dòng:
   - `https://asinu.top/api/auth/facebook/callback`
   - `http://localhost:3000/api/auth/facebook/callback`
5. **Login from Devices:** No
6. **Save Changes**

> 📸 **[Screenshot 3: Login Settings]**

---

## Bước 4 — Cấu hình iOS Platform

1. Sidebar → **Settings** → **Basic**
2. Cuộn xuống cuối → **+ Add Platform** → chọn **iOS**
3. Form:
   - **Bundle ID:** `com.asinu.app`
   - **iPhone Store ID:** (để trống, điền sau khi publish App Store)
   - **iPad Store ID:** (để trống)
   - **Single Sign On:** Yes
4. Save Changes

> 📸 **[Screenshot 4: iOS Platform config]**

---

## Bước 5 — Cấu hình Android Platform

### 5.1. Lấy Key Hash từ SHA-1

Facebook cần "Key Hash" (base64 của SHA-1).

Trên macOS, chạy:

```bash
# Trường hợp debug
keytool -exportcert \
  -alias androiddebugkey \
  -keystore ~/.android/debug.keystore \
  -storepass android \
  | openssl sha1 -binary \
  | openssl base64

# Trường hợp production keystore
keytool -exportcert \
  -alias asinu-upload \
  -keystore <path-to-keystore-file> \
  | openssl sha1 -binary \
  | openssl base64
```

Output: chuỗi 28 ký tự kết thúc bằng `=`, ví dụ:
```
AbCdEfGhIjKlMnOpQrStUvWxYz12=
```

### 5.2. Add Android platform

1. **Settings** → **Basic** → cuộn xuống → **+ Add Platform** → **Android**
2. Form:
   - **Google Play Package Name:** `com.asinu.app`
   - **Class Name:** `com.asinu.app.MainActivity`
   - **Key Hashes:** paste chuỗi base64 vừa lấy
   - **Single Sign On:** Yes
3. Save Changes

> 📸 **[Screenshot 5: Android Platform config]**

⚠️ **Lưu ý:** Nếu có cả debug + release keystore, paste 2 hash riêng dòng.

---

## Bước 6 — Lấy `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET`

1. **Settings** → **Basic**
2. Trên cùng hiển thị 2 trường:
   - **App ID:** 16 chữ số, ví dụ `1234567890123456`
   - **App Secret:** click **Show** → nhập password FB của giám đốc → hiện ra chuỗi 32 hex

3. Copy cả 2 → paste vào `.env`:

```bash
FACEBOOK_APP_ID=1234567890123456
FACEBOOK_APP_SECRET=abc123def456ghi789jkl012mno345pq
```

> 📸 **[Screenshot 6: Basic Settings có App ID + App Secret]**

⚠️ **App Secret bị lộ** → vào lại → click **Reset** → tạo secret mới.

---

## Bước 7 — Cấu hình thông tin App (bắt buộc cho Live mode)

Để switch sang Live, FB yêu cầu:

1. **Settings** → **Basic**:
   - **App Domains:** `asinu.top`
   - **Privacy Policy URL:** `https://asinu.top/privacy`
   - **Terms of Service URL:** `https://asinu.top/terms`
   - **Data Deletion Instructions URL:** `https://asinu.top/data-deletion`
   - **Category:** Health & Fitness
   - **App Icon:** Upload 1024×1024 PNG
2. Save Changes

> 📸 **[Screenshot 7: App Domains + Privacy URLs]**

---

## Bước 8 — App Review (cho phép user thật login)

Default app ở mode **Development** — chỉ Developers + Testers login được.

1. Sidebar → **App Review** → **Permissions and Features**
2. Request 2 permission cơ bản:
   - `email` — luôn auto-approved
   - `public_profile` — auto-approved
3. Save

---

## Bước 9 — Switch to Live mode

1. Top bar có toggle **App Mode**: Development / Live
2. Click toggle sang **Live**

⚠️ FB sẽ check tất cả cài đặt:
- Privacy Policy URL phải reachable
- Category đã chọn
- App icon đã upload

Nếu thiếu thứ gì, FB sẽ báo. Fix xong toggle lại.

> 📸 **[Screenshot 8: Toggle Live mode]**

---

## ✅ Verify

Restart backend sau khi paste keys:

```bash
docker compose restart asinu-backend
```

Test login từ app:
- Mobile app → "Đăng nhập bằng Facebook"
- FB native app mở ra → chọn account
- Quay về Asinu → đăng nhập thành công

Backend log:
```
[auth.facebook] verified fbId=12345 name=...
```

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| "App not set up" | Mode Development + user không phải dev/tester | Thêm test users, hoặc switch Live |
| "Invalid OAuth access token" | App Secret sai | Re-copy App Secret từ Basic Settings |
| "Invalid Key Hash" (Android) | Key Hash sai | Chạy lại `openssl` lệnh, copy lại |
| Login mobile → "URL Blocked" | Redirect URI không match | Vào Login Settings → thêm URL |
| Live mode bị reject | Thiếu Privacy URL hoặc icon | Fix Basic Settings → switch lại |

---

## 📝 Note cuối

- App ID **public** (xuất hiện trong code mobile)
- App Secret **bí mật**, chỉ ở backend
- FB có dashboard usage tại **Analytics** trong app
- Nếu vi phạm policy (vd. crash nhiều), FB có thể restrict — vào **App Review** → đọc reasons
