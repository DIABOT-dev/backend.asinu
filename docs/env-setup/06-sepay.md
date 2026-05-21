# 06 · SePay (Cổng thanh toán)

**Cần lấy 3 biến:**
- `SEPAY_ACCOUNT_NUMBER`
- `SEPAY_BANK_CODE`
- `SEPAY_API_KEY`

**Vai trò:** User chuyển khoản nạp tiền vào ví → SePay detect → gọi webhook → backend cộng tiền.
**Chi phí:** Miễn phí đăng ký + phí theo giao dịch (xem sepay.vn).
**Thời gian setup:** ~30 phút (chưa kể KYC duyệt 1–3 ngày).

---

## ☑️ Checklist

- [ ] Đã đăng ký SePay với email công ty
- [ ] Đã KYC (giấy ĐKKD + CMND giám đốc + MST)
- [ ] Đã link tài khoản ngân hàng đứng tên công ty
- [ ] Đã verify số tiền 1000đ SePay gửi
- [ ] Đã lấy `SEPAY_ACCOUNT_NUMBER` + `SEPAY_BANK_CODE`
- [ ] Đã tạo API Key + IP whitelist VPS
- [ ] Đã setup webhook URL
- [ ] Đã paste 3 biến vào `.env`

---

## Bước 1 — Đăng ký SePay

1. Vào https://sepay.vn → click **Đăng ký**
2. Form:
   - **Email:** `admin@asinu.top`
   - **Số điện thoại:** SDT công ty
   - **Mật khẩu:** mạnh, lưu password manager
3. Verify email + SDT
4. Đăng nhập vào https://my.sepay.vn

> 📸 **[Screenshot 1: Trang đăng ký SePay]**

---

## Bước 2 — KYC (xác minh doanh nghiệp)

SePay yêu cầu KYC trước khi cho phép nhận tiền thật.

1. Dashboard → **Xác minh tài khoản** (góc trên bên phải)
2. Upload:
   - **Giấy đăng ký kinh doanh** (PDF/JPG, scan rõ ràng)
   - **CMND/CCCD của giám đốc** (2 mặt)
   - **Mã số thuế công ty**
   - **Hình ảnh giám đốc cầm CMND** (selfie)
3. Submit
4. Đợi SePay duyệt **1–3 ngày làm việc**

> 📸 **[Screenshot 2: Form KYC]**

⚠️ **Nếu KYC bị từ chối:** SePay sẽ gửi email lý do. Thường do scan mờ — chụp lại rõ hơn rồi resubmit.

---

## Bước 3 — Link tài khoản ngân hàng

Sau khi KYC duyệt:

1. Dashboard → sidebar **Tài khoản ngân hàng**
2. Click **+ Thêm tài khoản**
3. Form:
   - **Ngân hàng:** chọn từ danh sách (MB Bank / Vietcombank / BIDV / Techcombank / ...)
   - **Số tài khoản:** nhập số TK đứng tên công ty
   - **Tên chủ tài khoản:** Tên công ty (phải khớp chính xác với ĐKKD)
4. Click **Lưu**

> 📸 **[Screenshot 3: Form thêm tài khoản ngân hàng]**

---

## Bước 4 — Verify tài khoản

SePay sẽ chuyển 1.000đ vào tài khoản ngân hàng anh vừa thêm, kèm mã verify trong nội dung chuyển khoản.

1. Đợi 5–60 phút SePay chuyển tiền (sẽ có thông báo qua app SMS Banking)
2. Mở SMS / app ngân hàng → xem nội dung chuyển khoản có mã `SEPAYxxxxx`
3. Quay lại SePay Dashboard → trang **Tài khoản ngân hàng**
4. Click tài khoản vừa thêm → **Xác nhận** → nhập mã `SEPAYxxxxx`
5. Trạng thái sẽ chuyển sang **Đã xác minh** ✅

> 📸 **[Screenshot 4: Xác minh thành công]**

---

## Bước 5 — Lấy `SEPAY_ACCOUNT_NUMBER` + `SEPAY_BANK_CODE`

1. Dashboard → **Tài khoản ngân hàng** → click tài khoản vừa verify
2. Hiển thị thông tin:
   - **Số tài khoản:** Copy → paste vào `SEPAY_ACCOUNT_NUMBER`
   - **Mã ngân hàng:** Copy → paste vào `SEPAY_BANK_CODE`

| Mã | Ngân hàng |
|---|---|
| `MB` | MB Bank |
| `VCB` | Vietcombank |
| `TCB` | Techcombank |
| `ACB` | ACB |
| `VIB` | VIB |
| `TPB` | TPBank |
| `BIDV` | BIDV |
| `STB` | Sacombank |
| `ICB` | Vietinbank |

3. Paste vào `.env`:

```bash
SEPAY_ACCOUNT_NUMBER=1234567890
SEPAY_BANK_CODE=MB
```

> 📸 **[Screenshot 5: Trang chi tiết tài khoản]**

---

## Bước 6 — Tạo API Key

1. Dashboard → sidebar **API**
2. Click **Tạo API Key**
3. Form:
   - **Tên Key:** `Asinu Backend Prod`
   - **IP whitelist:** `36.50.176.55` (IP VPS Asinu — bảo mật quan trọng)
   - **Permissions:** chọn **Tất cả** (hoặc chỉ "Nhận thông báo giao dịch")
4. Click **Tạo**

5. Popup hiện key dạng `sepay_xxxxxxxxxxxxx` (32+ ký tự)
6. **Copy NGAY** (chỉ hiện 1 lần)
7. Paste vào `.env`:

```bash
SEPAY_API_KEY=sepay_xxxxxxxxxxxxx
```

> 📸 **[Screenshot 6: Form tạo API Key]**

---

## Bước 7 — Setup Webhook

Webhook = SePay gọi backend mỗi khi có giao dịch chuyển vào tài khoản.

1. Dashboard → sidebar **Webhook** (hoặc **Cài đặt webhook**)
2. Click **+ Thêm webhook**
3. Form:
   - **URL:** `https://asinu.top/api/payments/webhook`
   - **Phương thức:** `POST`
   - **Events:** Tick tất cả (Nhận tiền, Gửi tiền, ...)
   - **Tài khoản áp dụng:** chọn tài khoản đã verify
4. Click **Lưu**

> 📸 **[Screenshot 7: Form thêm webhook]**

---

## Bước 8 — Test webhook

1. Dashboard → Webhook vừa tạo → click **Gửi test**
2. SePay sẽ POST giả lập request lên backend
3. Verify backend nhận được:

```bash
ssh root@36.50.176.55
docker compose logs --tail=50 asinu-backend | grep payment
```

Nên thấy log:
```
[payment.webhook] received from SePay
```

**Nếu không thấy:**
- Check URL có đúng `https://asinu.top/api/payments/webhook` không
- Check IP whitelist trên SePay API Key có include IP VPS không
- Check Caddy / Docker có forward request đúng không

---

## ✅ Verify end-to-end

Test giao dịch thật nhỏ:

1. Mở app Asinu → ví → **Nạp tiền** → chọn số tiền nhỏ (vd. 10.000đ)
2. App hiện QR
3. Mở app ngân hàng → quét QR → chuyển 10.000đ
4. **Trong vòng 30s:**
   - SePay detect giao dịch
   - SePay POST webhook tới backend
   - Backend update wallet balance của user
   - User thấy ví +10.000đ

> 📸 **[Screenshot 8: App hiển thị nạp thành công]**

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| KYC bị từ chối | Scan mờ / sai thông tin | Resubmit với scan rõ hơn |
| 1.000đ verify không tới | Số TK sai / banking lag | Check SMS banking, đợi 1h, contact SePay |
| Webhook test không nhận | IP whitelist sai | Vào API Key → cập nhật IP `36.50.176.55` |
| Webhook nhận nhưng wallet không cộng | Description QR sai format | Check log: description phải có pattern `asinupay<userId>order<code>` |
| 401 Unauthorized webhook | API Key sai trong header | Check backend `payment.service.js` → `SEPAY_API_KEY` env |

---

## 📝 Note cuối

- API Key có thể tạo nhiều — cho mỗi service / mỗi env
- **Đừng dùng cùng API Key cho dev và prod** — bảo mật
- SePay có **dashboard giao dịch** real-time tại trang **Giao dịch**
- Nếu cần đối soát tháng, xuất CSV tại **Báo cáo**
