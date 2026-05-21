# 03 · Zalo (Login bằng Zalo)

**Cần lấy 2 biến:**
- `ZALO_APP_ID`
- `ZALO_SECRET_KEY`

**Vai trò:** Cho user đăng nhập bằng Zalo (rất phổ biến ở VN).
**Chi phí:** Miễn phí.
**Thời gian setup:** ~20 phút (chưa kể chờ Zalo duyệt 1–7 ngày).

---

## ☑️ Checklist

- [ ] Đã có tài khoản Zalo Developer
- [ ] Đã tạo Zalo App
- [ ] Đã cấu hình OAuth callback URL
- [ ] Đã thêm Bundle ID iOS + Package Android
- [ ] Đã lấy `ZALO_APP_ID` + `ZALO_SECRET_KEY`
- [ ] Đã paste cả 2 vào `.env`
- [ ] Đã submit duyệt (đợi 1–7 ngày)

---

## Bước 1 — Đăng nhập

1. Vào https://developers.zalo.me
2. **Đăng nhập** bằng tài khoản Zalo công ty (số điện thoại công ty)
3. Lần đầu sẽ phải confirm số điện thoại

> 📸 **[Screenshot 1: Trang đăng nhập Zalo Developer]**

---

## Bước 2 — Verify Official Account (nếu chưa)

Để dùng OAuth, account Zalo phải verify Official Account (OA):

1. Vào https://oa.zalo.me
2. **Đăng ký tài khoản OA mới** (hoặc dùng OA đã có)
3. Loại: **Doanh nghiệp**
4. Upload:
   - Giấy đăng ký kinh doanh
   - Scan CMND/CCCD giám đốc
   - Logo công ty
5. Submit, đợi Zalo duyệt 1–3 ngày làm việc

> 📸 **[Screenshot 2: Form đăng ký OA]**

---

## Bước 3 — Tạo Ứng dụng

1. Quay lại https://developers.zalo.me
2. Sidebar → **Ứng dụng của tôi** → **Tạo ứng dụng**
3. Form:
   - **Tên ứng dụng:** `Asinu`
   - **Loại ứng dụng:** **Mobile App**
   - **Danh mục:** Sức khoẻ / Y tế
   - **Mô tả:** "Trợ lý sức khỏe AI cho người Việt"
   - **Logo:** Upload logo Asinu 512×512 PNG
4. Click **Tạo ứng dụng**

> 📸 **[Screenshot 3: Form tạo ứng dụng Zalo]**

---

## Bước 4 — Cấu hình Đăng nhập

1. App vừa tạo → sidebar bên trái → **Đăng nhập**
2. Tab **Cài đặt chung**:
   - **Domain bảo mật:** `asinu.top`
   - **URL callback:** thêm cả 2:
     - `https://asinu.top/api/auth/zalo/callback`
     - `http://localhost:3000/api/auth/zalo/callback` (dev)
3. Lưu

> 📸 **[Screenshot 4: Cài đặt Đăng nhập]**

---

## Bước 5 — Cấu hình Bundle ID / Package

1. Sidebar → **Cài đặt** → **URL Schemes**

### iOS
- **Bundle ID:** `com.asinu.app`
- **URL Scheme:** `zalo-<APP_ID>` (Zalo tự sinh sau khi điền App ID)

### Android
- **Package name:** `com.asinu.app`
- **SHA-1 fingerprint:** paste SHA-1 từ keystore production (xem [Bước 6.1 trong file 02-google-oauth.md](./02-google-oauth.md))

> 📸 **[Screenshot 5: URL Schemes]**

---

## Bước 6 — Xin Permissions

1. Sidebar → **Đăng nhập** → tab **Permissions**
2. Tick các quyền cần:
   - `id` — lấy Zalo User ID (luôn auto-approved)
   - `name` — lấy tên user (luôn auto-approved)
   - `picture` — lấy avatar (luôn auto-approved)
   - `email` — cần submit duyệt (Zalo verify 1–7 ngày)

3. Save

> 📸 **[Screenshot 6: Tab Permissions]**

---

## Bước 7 — Lấy keys

1. Sidebar → **Thông tin ứng dụng**
2. Hiển thị:
   - **App ID:** số 19 chữ số, ví dụ `1234567890123456789`
   - **Secret Key:** chuỗi 32 ký tự alphanumeric — click **Hiển thị** để xem

3. Copy cả 2 → paste vào `.env`:

```bash
ZALO_APP_ID=1234567890123456789
ZALO_SECRET_KEY=AbCdEf1234567890aBcDeF1234567890
```

> 📸 **[Screenshot 7: Trang Thông tin ứng dụng có App ID + Secret Key]**

⚠️ **Secret Key chỉ admin Zalo Developer xem được**. Nếu bị lộ → vào lại trang này → **Tạo lại Secret Key** (sẽ invalidate key cũ).

---

## Bước 8 — Submit duyệt App

1. Sidebar → **Submit duyệt**
2. Điền các thông tin còn lại Zalo yêu cầu (mô tả flow đăng nhập, screenshot...)
3. Click **Gửi duyệt**
4. Đợi Zalo review 1–7 ngày làm việc

**Trong thời gian chờ duyệt:**
- Chỉ tài khoản admin/dev của app dùng được (Zalo tự cho phép)
- User thường login sẽ bị lỗi "Ứng dụng chưa được duyệt"

> 📸 **[Screenshot 8: Submit duyệt button]**

---

## ✅ Verify

Sau khi paste keys + restart backend:

```bash
docker compose restart asinu-backend
```

Test login từ app:
- Mobile app → "Đăng nhập bằng Zalo"
- Zalo app mở ra → chọn account
- Quay về Asinu app → đăng nhập thành công

Backend log nên có:
```
[auth.zalo] verified zaloId=12345 name=...
```

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| "Ứng dụng chưa được duyệt" | App ở mode Testing | Submit duyệt, đợi Zalo review |
| Callback redirect lỗi | URL callback không match | Vào Cài đặt → thêm URL chính xác |
| `Invalid SHA1` (Android) | SHA-1 không đúng | Chạy lại `keytool`, verify, update |
| User Zalo không có email | User chưa cho phép share email | App phải handle case `email = null` |
| `App ID không hợp lệ` | Copy thiếu chữ số | Re-copy App ID, không có dấu cách |

---

## 📝 Note cuối

- Zalo App ID **public** (xuất hiện trong URL scheme), không cần giấu
- Zalo Secret Key **bí mật**, không bao giờ commit / share qua chat
- Mỗi App ID có giới hạn call rate, dashboard hiển thị usage real-time
