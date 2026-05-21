# 01 · OpenAI API Key

**Cần lấy:** `OPENAI_API_KEY`
**Vai trò:** Backend gọi OpenAI để chạy chatbot + phân tích triệu chứng.
**Chi phí:** Pay-as-you-go (theo token). Khoảng 500k–5tr VND/tháng tùy traffic.
**Thời gian setup:** ~10 phút.

---

## ☑️ Checklist

- [ ] Đã tạo OpenAI account với email công ty
- [ ] Đã thêm card thanh toán
- [ ] Đã set spending limit (recommended: $100–200/tháng)
- [ ] Đã tạo Secret Key + copy lưu password manager
- [ ] Đã paste vào `.env`

---

## Bước 1 — Tạo account

1. Vào https://platform.openai.com/signup
2. Sign up bằng **email công ty** (`admin@asinu.top`)
3. Verify email + số điện thoại
4. Đăng nhập

> 📸 **[Screenshot 1: Trang đăng ký OpenAI]**
> _(chèn ảnh chụp trang signup khi anh làm xong để document hoàn chỉnh)_

---

## Bước 2 — Thêm thanh toán

1. Click avatar góc phải trên cùng → **Settings**
2. Sidebar trái → **Billing** → **Payment methods**
3. Click **Add payment method**
4. Nhập thông tin thẻ Visa/Mastercard
5. Save

> 📸 **[Screenshot 2: Trang Billing → Payment methods]**

---

## Bước 3 — Set spending limit (QUAN TRỌNG)

Để tránh hóa đơn sốc nếu code bị bug gọi AI vô tận:

1. Settings → **Limits**
2. **Usage limits** → Edit
3. Điền:
   - **Hard limit:** `$200` (cảnh báo dừng tự động khi đạt mốc)
   - **Soft limit:** `$100` (cảnh báo email)
4. Save

> 📸 **[Screenshot 3: Trang Limits]**

---

## Bước 4 — Tạo API Key

1. Sidebar trái → **API Keys**
2. Click **+ Create new secret key**
3. Form điền:
   - **Name:** `Asinu Backend Prod`
   - **Project:** Default
   - **Permissions:** **All**
4. Click **Create secret key**

> 📸 **[Screenshot 4: Form tạo API Key]**

---

## Bước 5 — Copy key NGAY

⚠️ **Key chỉ hiện 1 LẦN.** Nếu đóng popup mà chưa copy → phải tạo key mới.

1. Popup hiện ra key dạng `sk-proj-AbCdEf123...`
2. Click icon **Copy** bên cạnh
3. **Paste ngay vào:**
   - File `.env` dòng `OPENAI_API_KEY=sk-proj-...`
   - Password manager (1Password / Bitwarden) — note: "Asinu OpenAI Prod"

> 📸 **[Screenshot 5: Popup hiện secret key]**

---

## Bước 6 — Paste vào `.env`

Mở file `.env` (local hoặc trên VPS), tìm dòng `OPENAI_API_KEY=` rồi điền:

```bash
OPENAI_API_KEY=sk-proj-AbCdEf123456789...
```

**Lưu ý:**
- Không có dấu cách trước/sau dấu `=`
- Không có dấu nháy bao quanh key
- Toàn bộ key trên 1 dòng (không xuống dòng giữa chừng)

---

## ✅ Verify

Sau khi paste, test xem key có hoạt động không. Mở terminal:

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-proj-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

**Kết quả:**
- ✅ Trả về JSON có field `choices` → key OK
- ❌ Trả về `{"error":{"message":"Incorrect API key"}}` → key bị sai, kiểm tra lại

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| Không thấy "Create new secret key" | Account chưa verify | Verify email + SDT |
| Tạo key xong dùng bị 401 | Copy thiếu ký tự | Tạo key mới, copy lại |
| Key dùng 1 ngày tự ngừng | Hết quota free trial | Add card + set spending limit |
| Hết tháng bị fail | Spending limit hard | Vào Limits tăng lên hoặc đợi sang tháng |

---

## 📝 Note cuối

- Có thể tạo nhiều key cho nhiều environment (dev / staging / prod)
- Mỗi key có thể revoke độc lập từ trang API Keys (không ảnh hưởng key khác)
- OpenAI có usage dashboard real-time tại **Usage** trong Settings
