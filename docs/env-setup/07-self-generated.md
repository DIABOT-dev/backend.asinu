# 07 · Tự tạo trên máy (JWT, CRON)

**Cần lấy 2 biến:**
- `JWT_SECRET`
- `CRON_SECRET`

**Vai trò:**
- `JWT_SECRET`: ký token đăng nhập user (tất cả request có Bearer token đều verify bằng key này)
- `CRON_SECRET`: bảo vệ cron endpoint nội bộ khỏi bị gọi từ ngoài

**Chi phí:** 0đ. Không cần đăng ký dịch vụ nào.
**Thời gian setup:** 1 phút.

---

## ☑️ Checklist

- [ ] Đã chạy `openssl rand -hex 32` lấy `JWT_SECRET`
- [ ] Đã chạy `openssl rand -hex 24` lấy `CRON_SECRET`
- [ ] Đã paste cả 2 vào `.env`
- [ ] Đã lưu backup vào password manager

---

## Bước 1 — Tạo `JWT_SECRET`

`JWT_SECRET` là chuỗi bí mật dùng để ký + verify JSON Web Token mà backend cấp cho user khi đăng nhập.

Mở Terminal trên máy mac, chạy:

```bash
openssl rand -hex 32
```

**Output ví dụ:**
```
a3f9b2c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2
```

(64 ký tự hex — đủ entropy 256 bit, an toàn cho prod)

> 📸 **[Screenshot 1: Terminal chạy lệnh openssl]**

---

## Bước 2 — Tạo `CRON_SECRET`

`CRON_SECRET` ngắn hơn được — dùng cho endpoint cron internal:

```bash
openssl rand -hex 24
```

**Output:**
```
9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e
```

(48 ký tự hex — 192 bit)

---

## Bước 3 — Paste vào `.env`

```bash
JWT_SECRET=a3f9b2c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2b5c8e1d4f7a2
CRON_SECRET=9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e
```

⚠️ **Quan trọng:**
- KHÔNG có dấu cách trước/sau dấu `=`
- KHÔNG bao quanh bằng dấu nháy
- Toàn bộ giá trị trên 1 dòng

---

## Bước 4 — Lưu backup

Lưu 2 secret vào password manager:

| Field | Value |
|---|---|
| Service | `Asinu Backend Prod` |
| Note | "JWT signing key — DO NOT change after launch" |
| `JWT_SECRET` | (paste) |
| `CRON_SECRET` | (paste) |

---

## ⚠️ Cảnh báo cực kỳ quan trọng

### Đổi `JWT_SECRET` SAU KHI ĐÃ LAUNCH = LOGOUT TOÀN BỘ USER

JWT chứa info user, ký bằng `JWT_SECRET`. Khi user gửi request, backend dùng cùng `JWT_SECRET` để verify chữ ký.

Nếu anh đổi `JWT_SECRET`:
- Tất cả JWT đã cấp trước đó → bị từ chối (chữ ký không khớp)
- Tất cả user đang đăng nhập → bị logout + phải login lại
- App sẽ trả lỗi "Phiên đăng nhập đã hết hạn" hàng loạt

**Khi nào CẦN đổi `JWT_SECRET`:**
- Khi bị leak (nhân viên cũ biết, hoặc bị hack)
- Khi setup môi trường mới (dev / staging / prod đều có secret riêng)

**Khi nào KHÔNG đổi:**
- Restart container
- Update code
- Deploy version mới
- Add env var mới

---

## ✅ Verify

Sau khi paste + restart backend:

```bash
docker compose restart asinu-backend
docker compose logs --tail=20 asinu-backend
```

Nên thấy log:
```
{"level":"info","msg":"server.listening","port":"3000"}
```

Không có error `JWT_SECRET is not set`.

Test thêm:

```bash
# Tạo 1 JWT test
docker exec asinu-backend node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({test: 'ok'}, process.env.JWT_SECRET, {expiresIn: '1h'});
console.log('Token:', token);
console.log('Verify:', jwt.verify(token, process.env.JWT_SECRET));
"
```

Nên in ra JWT + `{test: 'ok', iat:..., exp:...}` → JWT_SECRET hoạt động đúng.

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| Backend không start | `JWT_SECRET` chưa set hoặc rỗng | Check `.env`, paste lại |
| User login xong vẫn fail mọi API | JWT trên FE generate ở env khác | Sync `JWT_SECRET` giữa dev / prod nếu test cross-env |
| Login OK nhưng token decode fail | Secret có ký tự đặc biệt bị escape | Tạo lại bằng `openssl rand -hex 32` (chỉ hex, không có ký tự đặc biệt) |

---

## 📝 Note cuối

- Có thể dùng `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` thay thế nếu không có `openssl`
- KHÔNG dùng password đơn giản như "asinu2025" — dễ bị brute-force
- KHÔNG share `JWT_SECRET` qua chat / email — chỉ password manager
