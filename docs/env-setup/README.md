# 🔑 Hướng dẫn lấy biến môi trường — Asinu Backend

Tài liệu này giúp anh/chị **lấy giá trị thật của từng biến trong file `.env`** từ dashboard các dịch vụ bên thứ 3.

> ⚠️ **An toàn:** Các API key trong tài liệu này là **bí mật**. KHÔNG share file `.env` qua chat / email không mã hoá. Lưu backup vào password manager (1Password / Bitwarden).

---

## 📑 Mục lục

Mỗi dịch vụ tách thành 1 file riêng để dễ in/đọc:

| # | Dịch vụ | File | Biến môi trường lấy được |
|---|---|---|---|
| 1 | **OpenAI** | [`01-openai.md`](./01-openai.md) | `OPENAI_API_KEY` |
| 2 | **Google OAuth** | [`02-google-oauth.md`](./02-google-oauth.md) | `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID` |
| 3 | **Zalo** | [`03-zalo.md`](./03-zalo.md) | `ZALO_APP_ID`, `ZALO_SECRET_KEY` |
| 4 | **Facebook** | [`04-facebook.md`](./04-facebook.md) | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| 5 | **Expo Push** | [`05-expo-push.md`](./05-expo-push.md) | `EXPO_ACCESS_TOKEN` |
| 6 | **SePay** | [`06-sepay.md`](./06-sepay.md) | `SEPAY_ACCOUNT_NUMBER`, `SEPAY_BANK_CODE`, `SEPAY_API_KEY` |
| 7 | **Tự tạo (JWT, CRON)** | [`07-self-generated.md`](./07-self-generated.md) | `JWT_SECRET`, `CRON_SECRET` |
| 8 | **MedGemma** (optional) | [`08-medgemma.md`](./08-medgemma.md) | `MEDGEMMA_ENDPOINT`, `MEDGEMMA_MODEL`, `GOOGLE_APPLICATION_CREDENTIALS` |
| 9 | **Sentry** (optional) | [`09-sentry.md`](./09-sentry.md) | `SENTRY_DSN` |
| 10 | **Triển khai** | [`10-deploy.md`](./10-deploy.md) | Upload `.env` + restart |

---

## ✅ Checklist tiến độ

Đánh dấu khi hoàn thành mỗi mục:

### Bắt buộc
- [ ] **01-OpenAI** — đã có `OPENAI_API_KEY` (`sk-proj-...`)
- [ ] **02-Google OAuth Web** — đã có 2 biến `GOOGLE_WEB_CLIENT_*`
- [ ] **02-Google OAuth iOS** — đã có `GOOGLE_IOS_CLIENT_ID`
- [ ] **02-Google OAuth Android** — đã có `GOOGLE_ANDROID_CLIENT_ID`
- [ ] **03-Zalo** — đã có `ZALO_APP_ID` + `ZALO_SECRET_KEY`
- [ ] **04-Facebook** — đã có `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET`
- [ ] **05-Expo Push** — đã có `EXPO_ACCESS_TOKEN`
- [ ] **06-SePay** — đã có `SEPAY_ACCOUNT_NUMBER` + `SEPAY_BANK_CODE` + `SEPAY_API_KEY`
- [ ] **07-Self-generated** — đã tạo `JWT_SECRET` + `CRON_SECRET` bằng `openssl rand`

### Tùy chọn
- [ ] **08-MedGemma** — đã deploy endpoint + tạo Service Account (chỉ làm khi cần)
- [ ] **09-Sentry** — đã có `SENTRY_DSN` (chỉ làm khi cần error tracking)

### Triển khai
- [ ] **10-Deploy** — `.env` đã upload lên VPS + container đã restart
- [ ] **10-Deploy** — Smoke test: `curl https://asinu.top/api/healthz` trả `{"status":"ok"}`

---

## 📦 Biến nội bộ — copy nguyên xi (không cần đăng ký gì)

Các biến sau lấy default, dán y nguyên vào `.env`:

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://asinu_user:asinu_secure_password_2026@asinu_postgres:5432/asinu_db
REDIS_URL=redis://asinu_redis:6379
BACKEND_PUBLIC_URL=https://asinu.top
SUBSCRIPTION_PRICE=199000
AI_PROVIDER=openai
AI_PROVIDER_CLINICAL=openai
SYMPTOM_AI_PROVIDER=openai
SYMPTOM_AI_MODEL=gpt-4o-mini
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.7
TESTING_MODE=false

# MVP audit flags (đã có default an toàn)
CHATBOT_ENABLED=true
CHATBOT_PREMIUM_ONLY=false
CHATBOT_DAILY_LIMIT_FREE=0
CHATBOT_DAILY_LIMIT_PREMIUM=20
CHATBOT_MONTHLY_TOKEN_LIMIT_FREE=0
CHATBOT_MONTHLY_TOKEN_LIMIT_PREMIUM=200000
PHONE_SEARCH_DAILY_LIMIT=20
SCRIPT_REGEN_LIMIT_FREE=2
SCRIPT_REGEN_LIMIT_PREMIUM=10
CARE_CIRCLE_ENABLED=true
CARE_CIRCLE_FREE_LIMIT=1
CARE_CIRCLE_PREMIUM_LIMIT=3
CAREGIVER_ALERT_ENABLED=true
CAREGIVER_VIEW_LOGS_ENABLED=true
CAREGIVER_HISTORY_DAYS_FREE=30
CAREGIVER_HISTORY_DAYS_PREMIUM=365
CAREGIVER_ACK_ENABLED=true
CHECKIN_MODE=ai
CHAT_RETENTION_DAYS_FREE=30
CHAT_RETENTION_DAYS_PREMIUM=365
CHAT_HISTORY_LIMIT_FREE=50
CHAT_HISTORY_LIMIT_PREMIUM=300
```

---

## 🧭 Quy trình khuyến nghị

Đi theo thứ tự để không phụ thuộc nhau:

1. **07-Self-generated** trước — `JWT_SECRET` cần ngay, không lệ thuộc dịch vụ ngoài
2. **01-OpenAI** — quan trọng nhất, đại trà
3. **02-Google OAuth** — cần thiết cho login Google
4. **05-Expo Push** — cần cho mobile notification
5. **06-SePay** — cần cho thanh toán
6. **03-Zalo**, **04-Facebook** — cần cho login Zalo/FB
7. **08-MedGemma** (skip nếu chưa muốn dùng)
8. **09-Sentry** (skip nếu chưa cần error tracking)
9. **10-Deploy** — cuối cùng, sau khi `.env` đầy đủ
