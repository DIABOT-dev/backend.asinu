# 09 · Sentry (Tùy chọn — Error Tracking)

**Cần lấy:** `SENTRY_DSN`
**Vai trò:** Backend tự gửi crash + error lên Sentry; anh nhận email cảnh báo khi có lỗi.
**Chi phí:** Free tier — 5.000 errors/tháng (đủ cho MVP).
**Thời gian setup:** ~10 phút.

> 💡 **NÊN làm** sớm để biết user gặp lỗi gì ở production. Free tier đủ dùng tới khi DAU vài nghìn.

---

## ☑️ Checklist

- [ ] Đã tạo Sentry account với email công ty
- [ ] Đã tạo project `asinu-backend` platform Node.js
- [ ] Đã copy DSN
- [ ] Đã setup alert rule (email khi > 10 errors/giờ)
- [ ] Đã paste `SENTRY_DSN` vào `.env`

---

## Bước 1 — Đăng ký

1. Vào https://sentry.io/signup
2. Sign up với email công ty `admin@asinu.top`
3. Form:
   - **Organization name:** `Asinu`
   - **Plan:** **Developer (Free)** — 5k errors/month
4. Click **Continue**

> 📸 **[Screenshot 1: Signup page]**

---

## Bước 2 — Tạo Project

Wizard sẽ hỏi luôn:

1. **Choose a platform:** chọn **Node.js**
2. **Project name:** `asinu-backend`
3. **Team:** Default
4. Click **Create Project**

> 📸 **[Screenshot 2: Create Project form]**

---

## Bước 3 — Lấy DSN

Sentry sẽ hiện onboarding với code snippet — có DSN sẵn.

Hoặc lấy thủ công sau:

1. Sidebar → **Settings** (góc trái dưới)
2. **Projects** → click `asinu-backend`
3. Sidebar → **Client Keys (DSN)**
4. Hiển thị DSN dạng:

```
https://abc123def456@o789012.ingest.us.sentry.io/345678
```

5. Click icon **Copy**
6. Paste vào `.env`:

```bash
SENTRY_DSN=https://abc123def456@o789012.ingest.us.sentry.io/345678
SENTRY_RELEASE=2026.05
SENTRY_TRACES_SAMPLE_RATE=0.1
```

(`SENTRY_RELEASE` = version đang deploy; `SENTRY_TRACES_SAMPLE_RATE` = % request có performance trace, 0.1 = 10%)

> 📸 **[Screenshot 3: Client Keys (DSN)]**

---

## Bước 4 — Setup Alert Rule

Default Sentry không tự gửi email. Phải setup rule:

1. Sidebar → **Alerts** → **+ Create Alert**
2. Choose alert type: **Issues**
3. Form:
   - **Project:** `asinu-backend`
   - **When:** A new issue is created
   - **And:** The issue is unresolved
   - **Filter:** event count > 10 in 1 hour
   - **Then:** Send notification to **email** → `admin@asinu.top`
4. Save

> 📸 **[Screenshot 4: Alert Rule form]**

---

## Bước 5 — Verify

Restart backend sau khi paste DSN:

```bash
docker compose restart asinu-backend
docker compose logs --tail=20 asinu-backend
```

Backend log nên có:
```
{"level":"info","msg":"sentry.enabled","environment":"production"}
```

Nếu thấy `sentry.disabled` → DSN chưa được đọc.

---

## Bước 6 — Test bằng cách trigger 1 error giả

```bash
# Trigger error giả qua admin endpoint (nếu code đã có)
# Hoặc: bypass — gọi API với data invalid
curl https://asinu.top/api/mobile/chat \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"invalid": "payload"}'
```

Trong 30s, Sentry dashboard sẽ hiện issue mới.

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| Sentry không nhận event | DSN sai / network block | Test lại DSN, check VPS có ra internet không |
| Spam quá nhiều issue | Set traces sample rate 1.0 | Giảm xuống 0.1 (10%) |
| Hết quota 5k/tháng | Bug spam errors | Fix root cause + tăng plan |

---

## 📝 Note cuối

- Sentry tự dedup similar errors → không bị spam
- Free tier reset hàng tháng
- Có thể tích hợp với Slack / Discord — Sentry → Settings → Integrations
- Nếu muốn tracking performance (slow API), uncomment `SENTRY_TRACES_SAMPLE_RATE`
