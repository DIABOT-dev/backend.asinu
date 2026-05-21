# 02 · Google OAuth (Login bằng Google)

**Cần lấy 4 biến:**
- `GOOGLE_WEB_CLIENT_ID`
- `GOOGLE_WEB_CLIENT_SECRET`
- `GOOGLE_IOS_CLIENT_ID`
- `GOOGLE_ANDROID_CLIENT_ID`

**Vai trò:** Cho user đăng nhập bằng tài khoản Google.
**Chi phí:** Miễn phí.
**Thời gian setup:** ~30 phút.

---

## ☑️ Checklist

- [ ] Đã tạo project GCP `asinu-prod`
- [ ] Đã enable People API
- [ ] Đã cấu hình OAuth Consent Screen
- [ ] Đã tạo Web Client ID → có `GOOGLE_WEB_CLIENT_ID` + `GOOGLE_WEB_CLIENT_SECRET`
- [ ] Đã tạo iOS Client ID → có `GOOGLE_IOS_CLIENT_ID`
- [ ] Đã tạo Android Client ID → có `GOOGLE_ANDROID_CLIENT_ID`
- [ ] Đã paste cả 4 biến vào `.env`

---

## Bước 1 — Tạo GCP Project

1. Vào https://console.cloud.google.com
2. Đăng nhập bằng `admin@asinu.top`
3. Top bar có dropdown "Select a project" → Click → **NEW PROJECT**
4. Form:
   - **Project name:** `asinu-prod`
   - **Organization:** No organization (nếu chưa setup org)
5. Click **Create**, đợi 30s

> 📸 **[Screenshot 1: Trang New Project]**

---

## Bước 2 — Enable People API

OAuth login cần People API để đọc thông tin user (tên, email, ảnh).

1. Top bar — chọn project `asinu-prod` vừa tạo
2. Sidebar trái → **APIs & Services** → **Library**
3. Tìm **People API**
4. Click → **Enable**

> 📸 **[Screenshot 2: People API Library]**

---

## Bước 3 — Cấu hình OAuth Consent Screen

Đây là màn hình user thấy khi click "Đăng nhập bằng Google" (logo + tên app).

1. Sidebar → **APIs & Services** → **OAuth consent screen**
2. **User Type:** Chọn **External** → Create
3. Form OAuth consent screen:

| Trường | Giá trị |
|---|---|
| App name | `Asinu` |
| User support email | `admin@asinu.top` |
| App logo | Upload logo Asinu 120×120 PNG (optional) |
| App home page | `https://asinu.top` |
| Privacy policy | `https://asinu.top/privacy` (cần có sẵn page này) |
| Terms of service | `https://asinu.top/terms` (cần có sẵn page này) |
| Authorized domains | `asinu.top` |
| Developer contact | `admin@asinu.top` |

4. Save and continue

5. Trang **Scopes** → Click **Add or remove scopes** → tích:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`

6. Save and continue

7. Trang **Test users** → Add email của anh + dev team (để test trước khi Publish public)

8. Save

> 📸 **[Screenshot 3: OAuth consent screen form]**

---

## Bước 4 — Tạo Web Client ID

1. Sidebar → **APIs & Services** → **Credentials**
2. Top → **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Form:
   - **Application type:** **Web application**
   - **Name:** `Asinu Backend`
   - **Authorized JavaScript origins:** (để trống)
   - **Authorized redirect URIs:** thêm 2 dòng:
     - `https://asinu.top/api/auth/google/callback`
     - `http://localhost:3000/api/auth/google/callback`
4. Click **CREATE**

5. Popup hiện ra:
   - **Client ID:** dạng `123456789-abc123.apps.googleusercontent.com`
   - **Client Secret:** dạng `GOCSPX-...`

**Copy NGAY cả 2 giá trị** → paste vào `.env`:

```bash
GOOGLE_WEB_CLIENT_ID=123456789-abc123.apps.googleusercontent.com
GOOGLE_WEB_CLIENT_SECRET=GOCSPX-AbCdEf123...
```

> 📸 **[Screenshot 4: Popup OAuth client created với Web]**

---

## Bước 5 — Tạo iOS Client ID

1. **Credentials** → **+ CREATE CREDENTIALS** → **OAuth client ID**
2. Form:
   - **Application type:** **iOS**
   - **Name:** `Asinu iOS`
   - **Bundle ID:** `com.asinu.app`
     - ⚠️ Phải khớp với `ios.bundleIdentifier` trong file `app.json` của project mobile
3. Click **CREATE**

4. Popup hiện **Client ID** → Copy → paste vào `.env`:

```bash
GOOGLE_IOS_CLIENT_ID=123456789-xyz.apps.googleusercontent.com
```

> 📸 **[Screenshot 5: iOS Client ID created]**

---

## Bước 6 — Tạo Android Client ID

**Bước này cần SHA-1 fingerprint của keystore Android.**

### 6.1. Lấy SHA-1

Có 2 trường hợp:

#### Trường hợp A — Test với debug keystore (dev)
Trên máy mac chạy:
```bash
keytool -list -v \
  -alias androiddebugkey \
  -keystore ~/.android/debug.keystore \
  -storepass android \
  -keypass android
```

Nếu chưa có file: chạy app Android một lần (`npm run android`) Expo sẽ tự tạo debug keystore.

#### Trường hợp B — Production keystore (đã tạo cho Play Store)
```bash
keytool -list -v \
  -alias asinu-upload \
  -keystore <đường-dẫn-tới-file-keystore-production>.keystore
```

Hỏi password — gõ password đã đặt khi tạo keystore.

### 6.2. Copy SHA-1

Output có dòng:
```
SHA1: AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:11:22:33:44
```

Copy giá trị sau `SHA1:` (cả dấu `:` luôn).

### 6.3. Tạo Client

1. **Credentials** → **+ CREATE CREDENTIALS** → **OAuth client ID**
2. Form:
   - **Application type:** **Android**
   - **Name:** `Asinu Android`
   - **Package name:** `com.asinu.app`
   - **SHA-1 certificate fingerprint:** paste vào (cả `:`)
3. Click **CREATE**

4. Popup hiện **Client ID** → Copy → paste vào `.env`:

```bash
GOOGLE_ANDROID_CLIENT_ID=123456789-abc.apps.googleusercontent.com
```

> 📸 **[Screenshot 6: Android Client ID created]**

**Lưu ý:** Nếu có **CẢ debug + release keystore**, tạo 2 Android Client riêng cho mỗi keystore. Trong `.env` chỉ paste ID của release (production).

---

## Bước 7 — Publish App (khi sẵn sàng public)

Trước khi user thật dùng được, OAuth consent screen phải Publish:

1. **OAuth consent screen** → click **PUBLISH APP**
2. Google sẽ verify (mất 1–4 tuần nếu app xin scope nhạy cảm)
3. Trước khi verified: chỉ test users trong list dùng được

---

## ✅ Verify

Sau khi paste 4 biến vào `.env`, restart backend:

```bash
docker compose restart asinu-backend
```

Test login từ app:
- Mobile app → "Đăng nhập bằng Google" → chọn account
- Backend log nên có `[auth.google] verified user@gmail.com`

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| "Error 400: redirect_uri_mismatch" | URI redirect không match | Vào Web Client → thêm URL chính xác |
| "Error 403: access_denied" | App ở mode Testing + user không trong test list | Add user vào test list, hoặc Publish app |
| Android không nhận client | SHA-1 không match | Chạy lại keytool, verify SHA-1, update Android Client |
| iOS login mở Safari rồi trắng | Bundle ID không match | Check `app.json` `ios.bundleIdentifier` |
