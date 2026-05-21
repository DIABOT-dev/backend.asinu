# 08 · MedGemma (Tùy chọn — Clinical AI)

**Cần lấy 3 biến:**
- `MEDGEMMA_ENDPOINT`
- `MEDGEMMA_MODEL` (default OK)
- `GOOGLE_APPLICATION_CREDENTIALS` (file JSON Service Account)

**Vai trò:** Thay OpenAI bằng MedGemma cho các luồng lâm sàng (check-in triage, symptom analyzer).
**Chi phí:** ~$0.8/giờ GPU L4 trên Vertex AI = ~$570/tháng nếu chạy 24/7 (giảm xuống ~$170/tháng nếu set Min replicas = 0).
**Thời gian setup:** ~30 phút (chưa kể chờ deploy 10–20 phút).

> ⚠️ **CÓ THỂ BỎ QUA** nếu chưa muốn dùng. Hệ thống sẽ tự fallback OpenAI và hoạt động bình thường.

---

## ☑️ Checklist

- [ ] Đã có GCP project `asinu-prod` (xem [02-google-oauth.md](./02-google-oauth.md))
- [ ] Đã enable Vertex AI API
- [ ] Đã set budget alert (KHUYẾN NGHỊ — tránh hóa đơn sốc)
- [ ] Đã deploy MedGemma model
- [ ] Đã có endpoint URL
- [ ] Đã tạo Service Account `medgemma-caller`
- [ ] Đã download JSON key
- [ ] Đã upload JSON key lên VPS
- [ ] Đã mount JSON vào container Docker
- [ ] Đã paste 3 biến + đổi 2 dòng provider vào `.env`

---

## ⚠️ Trước khi làm: Cảnh báo chi phí

MedGemma chạy trên Vertex AI **TÍNH GIỜ GPU** — kể cả khi không có traffic.

| Setting | Chi phí ước tính |
|---|---|
| Min replicas 1 (always-on) | ~$580/tháng |
| Min replicas 0 (autoscale) | ~$50–$200/tháng tùy traffic |

**Bắt buộc làm trước:**
1. Set budget alert ở $100/tháng để cảnh báo email
2. Set hard cap ở $500/tháng

---

## Bước 1 — Set budget alert

1. Vào GCP Console → top bar → **Billing**
2. Sidebar → **Budgets & alerts**
3. **+ Create budget**
4. Form:
   - **Name:** `Asinu Vertex AI Limit`
   - **Scope:** chọn project `asinu-prod`
   - **Service filter:** chọn Vertex AI
   - **Amount:** $200 (tùy ngân sách)
   - **Threshold rules:**
     - 50% → email
     - 90% → email
     - 100% → email + (tùy chọn) tắt billing
5. Save

> 📸 **[Screenshot 1: Budget alert form]**

---

## Bước 2 — Enable Vertex AI API

1. APIs & Services → **Library**
2. Tìm **Vertex AI API**
3. Click → **Enable**
4. Đợi 1–2 phút

> 📸 **[Screenshot 2: Enable Vertex AI API]**

---

## Bước 3 — Deploy MedGemma model

1. Vertex AI → sidebar → **Model Garden**
2. Search box: gõ `medgemma`
3. Chọn variant `medgemma-27b-text-it` (text-only, 27B params)
4. Click **Deploy**
5. Form deploy:
   - **Endpoint name:** `asinu-medgemma`
   - **Region:** `us-central1` (rẻ nhất; nếu cần latency thấp cho VN dùng `asia-southeast1` nhưng đắt 1.5x)
   - **Machine type:** `g2-standard-12` (12 vCPU + 1 GPU L4 — minimum chạy được)
   - **Min replica count:** **0** (autoscale, tiết kiệm chi phí — cold start 30s)
   - **Max replica count:** **1**
6. Click **Deploy**
7. **Đợi 10–20 phút** Vertex provisioning GPU

> 📸 **[Screenshot 3: Form deploy MedGemma]**

---

## Bước 4 — Lấy endpoint URL

1. Vertex AI → sidebar → **Endpoints**
2. Click endpoint vừa deploy: `asinu-medgemma`
3. Tab **SAMPLE REQUEST** → tab **REST**
4. Copy URL từ command curl, dạng:

```
https://us-central1-aiplatform.googleapis.com/v1/projects/asinu-prod/locations/us-central1/endpoints/123456789012345678:predict
```

5. Paste vào `.env`:

```bash
MEDGEMMA_ENDPOINT=https://us-central1-aiplatform.googleapis.com/v1/projects/asinu-prod/locations/us-central1/endpoints/123456789012345678:predict
MEDGEMMA_MODEL=medgemma-27b-text-it
```

> 📸 **[Screenshot 4: Sample request có URL]**

---

## Bước 5 — Tạo Service Account

Backend cần auth với Vertex AI. Cách an toàn nhất: dùng Service Account + JSON key file.

1. IAM & Admin → **Service Accounts**
2. **+ CREATE SERVICE ACCOUNT**
3. Form:
   - **Service account name:** `medgemma-caller`
   - **Service account ID:** `medgemma-caller`
   - **Description:** "Asinu backend gọi MedGemma endpoint"
4. Click **CREATE AND CONTINUE**
5. **Grant role:** chọn **Vertex AI User**
6. CONTINUE → DONE

> 📸 **[Screenshot 5: Form create Service Account]**

---

## Bước 6 — Tạo JSON key

1. Service Accounts list → click `medgemma-caller@asinu-prod.iam.gserviceaccount.com`
2. Tab **KEYS** → **ADD KEY** → **Create new key**
3. Chọn **JSON** → CREATE
4. File `medgemma-caller-abc123.json` tự download về máy

⚠️ **File này là CHÌA KHÓA gọi Vertex AI** — bảo mật như password.

> 📸 **[Screenshot 6: Download JSON key]**

---

## Bước 7 — Upload JSON lên VPS

Trên máy local:

```bash
# Đảm bảo file đã download
ls ~/Downloads/medgemma-caller-*.json

# Tạo thư mục an toàn trên VPS
ssh root@36.50.176.55 'mkdir -p /root/.gcp && chmod 700 /root/.gcp'

# Upload
scp ~/Downloads/medgemma-caller-abc123.json root@36.50.176.55:/root/.gcp/medgemma-caller.json

# Set permission an toàn (chỉ root đọc)
ssh root@36.50.176.55 'chmod 600 /root/.gcp/medgemma-caller.json'
```

---

## Bước 8 — Mount JSON vào container Docker

File `/root/.gcp/medgemma-caller.json` ở host, nhưng container không thấy → cần mount.

Edit `docker-compose.yml` trên VPS:

```bash
ssh root@36.50.176.55
cd /root/backend.asinu
nano docker-compose.yml
```

Thêm vào service `asinu-backend`:

```yaml
services:
  asinu-backend:
    # ... existing config ...
    volumes:
      - /root/.gcp:/root/.gcp:ro    # ← thêm dòng này
    environment:
      - GOOGLE_APPLICATION_CREDENTIALS=/root/.gcp/medgemma-caller.json   # ← (tự đọc từ .env cũng OK)
```

Save (Ctrl+O, Enter, Ctrl+X).

---

## Bước 9 — Update `.env`

```bash
nano /root/backend.asinu/.env
```

Tìm + uncomment / thêm:

```bash
# MedGemma
MEDGEMMA_ENDPOINT=https://us-central1-aiplatform.googleapis.com/v1/projects/asinu-prod/locations/us-central1/endpoints/.../predict
MEDGEMMA_MODEL=medgemma-27b-text-it
GOOGLE_APPLICATION_CREDENTIALS=/root/.gcp/medgemma-caller.json

# Route các luồng lâm sàng qua MedGemma
SYMPTOM_AI_PROVIDER=medgemma
AI_PROVIDER_CLINICAL=medgemma
```

⚠️ **Chatbot tự do** (`AI_PROVIDER`) vẫn để `openai` — MedGemma quá đắt cho chatbot.

---

## Bước 10 — Restart + verify

```bash
cd /root/backend.asinu
docker compose up -d   # recreate container với volume mới
docker compose logs --tail=30 asinu-backend
```

Test bằng app:
1. Mobile app → Check-in → nhập triệu chứng lạ (chưa có script cache)
2. Backend log nên có:
```
[AIAnalyzer] AI call: provider=medgemma, model=medgemma-27b-text-it, tokens=...
```

Nếu thấy `provider=openai` → fallback → check endpoint URL + JSON key path.

---

## 🆘 Trouble shooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| Backend log "MedGemma endpoint unset" | `MEDGEMMA_ENDPOINT` trống | Check `.env` → paste lại |
| `401 Unauthorized` từ Vertex | JSON key sai / Service Account chưa có role | Re-create JSON key, verify role "Vertex AI User" |
| `404 Not Found` | URL endpoint sai | Copy lại từ Sample Request Vertex |
| Response cold start chậm 30s | Min replicas = 0 | Bình thường, hoặc set Min = 1 để always-on (đắt hơn) |
| Hóa đơn cao | Min replicas = 1 hoặc không tắt sau giờ làm | Set Min = 0, hoặc tạo cron stop endpoint sau 23h |

---

## 📝 Note cuối

- **Tắt endpoint khi không dùng** để tiết kiệm: Vertex AI → Endpoints → click `...` → **Undeploy model**. Deploy lại khi cần (~10 phút).
- Theo dõi cost real-time tại **Billing** → **Reports** → filter by Vertex AI
- JSON key có thể **rotate** định kỳ: tạo key mới → update `.env` → restart → revoke key cũ
