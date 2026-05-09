# Audit hệ thống Chat AI — System Prompt + Safety Filter

**Phạm vi**: `src/services/chat/chat.service.js`, `src/services/ai/ai-safety.service.js`, `src/services/ai/providers/openai.js`, `.env`

**Tổng quan**: Có **3 BUG xác nhận** (system contradicts itself), **3 vấn đề an toàn nghiêm trọng**, và **5 cải tiến chất lượng**.

---

## Phân loại

| Mã | Loại | Số lượng |
|----|------|----------|
| 🔴 BUG | Code mâu thuẫn với chính nó, lỗi quan sát được | 3 |
| 🟠 SAFETY | Risk patient safety, không phải bug nhưng nguy hiểm | 3 |
| 🟡 QUALITY | Inconsistency, không gây bug nhưng chất lượng giảm | 5 |

---

## 🔴 BUG #1 — System prompt vs Safety filter mâu thuẫn về thuốc

**Mức độ**: 🔴🔴🔴 CRITICAL — phá vỡ output, user thấy reply bị cắt

### Hiện trạng

`chat.service.js:422` (Vi system prompt) **khuyến khích** nêu thuốc + liều:
```
Thuốc: đau bụng → men vi sinh/smecta. Đau dạ dày → antacid/omeprazole.
Đau đầu → paracetamol. Đau khớp → glucosamine/diclofenac gel.
Ho → thuốc ho thảo dược/acetylcysteine. Luôn gợi ý, không từ chối.
```

`chat.service.js:454` (Few-shot) **dạy** AI viết liều cụ thể:
```
"Đau đầu chú uống paracetamol 500mg nhé, 4-6 tiếng/lần, max 4 lần/ngày"
```

NHƯNG `ai-safety.service.js:8-15` lại **STRIP** các cụm này khỏi output:
```js
const BANNED_PHRASES = [
  'bạn bị', 'bạn mắc', 'chẩn đoán',
  'hãy uống thuốc', 'nên dùng thuốc', 'liều dùng', 'kê đơn',
  ...
];
// filtered = filtered.replace(new RegExp(phrase, 'gi'), '...');
```

`chat.service.js:728` gọi `filterChatResponse(reply)` trên mọi reply → AI tạo "uống paracetamol 500mg, **liều dùng** 4-6 tiếng/lần" → user thấy "uống paracetamol 500mg, **...** 4-6 tiếng/lần"

### Vì sao là bug

System prompt và safety filter là 2 module **đối nghịch nhau** — AI cố tuân prompt, filter phá kết quả. User nhận reply lủng củng, mất ý.

### Giải pháp

**Chọn 1 chiến lược nhất quán**:

**Phương án A — Thuốc nhẹ**: Cho phép gợi ý OTC + liều, nhưng PHẢI ép định dạng disclaimer:
1. Gỡ "liều dùng", "kê đơn", "hãy uống thuốc", "nên dùng thuốc" khỏi `BANNED_PHRASES`
2. Giữ các cụm chẩn đoán ("bạn bị", "chẩn đoán")
3. Thêm vào system prompt: mọi gợi ý thuốc PHẢI kèm "nếu kéo dài >2 ngày → đi khám"

**Phương án B — Không nêu thuốc**: AI chỉ tư vấn lifestyle, redirect mọi câu thuốc sang bác sĩ:
1. Xoá block thuốc khỏi system prompt (line 422)
2. Xoá ví dụ paracetamol khỏi few-shot
3. Giữ BANNED_PHRASES nguyên trạng

**Khuyến nghị**: **Phương án A** — user lớn tuổi VN quen tự mua thuốc OTC, từ chối hoàn toàn = trải nghiệm kém. Nhưng cần tighten:
- OTC nhẹ (paracetamol, men vi sinh, smecta, antacid): OK gợi ý
- Cần kê đơn (kháng sinh, statin, PPI dài hạn, hormone): TUYỆT ĐỐI từ chối

---

## 🔴 BUG #2 — Length instruction xung đột

**Mức độ**: 🔴🔴 HIGH — reply lúc 2 câu, lúc 12 câu, không nhất quán

### Hiện trạng

`chat.service.js:246-248` (Tiếng Anh):
```js
'ALWAYS empathize FIRST (2-3 sentences) before giving advice. Ask follow-up questions to show you care.'
'MINIMUM 10 sentences per reply. Never reply with less than 10 sentences for health questions. Be DETAILED and THOROUGH.'
'Structure: empathy (2-3 sentences) → questions (2-3) → explanation (2-3) → detailed advice (4-6) → encouragement + follow-up question (2).'
```

→ EN bắt buộc **min 10 câu**, structured 12+ câu.

`chat.service.js:255` (Tiếng Việt):
```
Độ dài: trả lời ĐỦ ĐỂ NGƯỜI DÙNG CẢM THẤY ĐƯỢC CHĂM SÓC...
Không cụt ngủn 2-3 câu rồi dừng.
```
→ VI nói chung chung, không có số.

`chat.service.js:450-463` (Few-shot VI):
- 5 example, mỗi cái chỉ **3-4 câu**.

### Vì sao là bug

- AI thấy 2 chỉ thị mâu thuẫn (min 10 câu vs ví dụ 3 câu) → behavior bipolar.
- Câu chào "Xin chào" cũng nhận reply 10 câu = phản tự nhiên.
- Câu phức tạp đôi khi lại được 3 câu vì AI bắt chước few-shot.

### Giải pháp

**Length theo intent, KHÔNG cố định**. Sửa thành rule có điều kiện:

```js
lines.push(isEn
  ? `Reply length should match question type:
     - Greeting/small talk: 1-2 sentences
     - Simple question (medication, food, exercise): 4-6 sentences
     - Complex question (explain disease, address worry): 8-12 sentences
     - Emergency: structured warning + concrete actions`
  : `Độ dài trả lời tùy câu hỏi:
     - Chào hỏi/xã giao: 1-2 câu
     - Câu hỏi đơn (thuốc, ăn, tập): 4-6 câu
     - Câu hỏi phức tạp (giải thích bệnh, lo lắng): 8-12 câu
     - Khẩn cấp: cảnh báo có cấu trúc + hành động cụ thể`);
```

Đồng bộ few-shot reflect đúng quy tắc này.

---

## 🔴 BUG #3 — Temperature 0.9 quá cao cho health advice

**Mức độ**: 🔴🔴 HIGH — output không deterministic, cùng câu hỏi → 2 reply khác nhau

### Hiện trạng

`.env`:
```
OPENAI_CHAT_TEMPERATURE=0.9
```

`openai.js:128-130` đọc từ env:
```js
const temperature = process.env.OPENAI_CHAT_TEMPERATURE
  ? parseFloat(process.env.OPENAI_CHAT_TEMPERATURE)
  : 0.75;
```

→ **Actual temp = 0.9** (env override default 0.75).

### Vì sao là bug

OpenAI khuyến nghị temperature theo use case:
- Code/JSON: 0.0 - 0.2
- Factual Q&A: 0.3 - 0.5  
- Creative writing: 0.7 - 1.0
- **Health advice = factual** → nên 0.4-0.5

Ở 0.9, gpt-4o sample tokens với độ ngẫu nhiên cao → 2 user hỏi "đường huyết 150 sau ăn có cao không?" có thể nhận 2 reply hoàn toàn khác (lúc thì OK, lúc thì cảnh báo). Mất nhất quán = mất tin tưởng.

### Giải pháp

```env
OPENAI_CHAT_TEMPERATURE=0.5
```

Hoặc nếu muốn linh hoạt: set **theo intent** (greeting=0.7, advice=0.4, emergency=0.2). Để sau implement, trước mắt chốt 0.5.

---

## 🟠 SAFETY #1 — Cấm AI nói "Tôi không biết" → buộc fabricate

**Mức độ**: 🟠🟠🟠 CRITICAL SAFETY — AI có thể bịa thông tin y tế

### Hiện trạng

`chat.service.js:419` (English):
```js
'About health: knowledgeable and frank. ... Never say "I am limited" or "beyond my capability".'
```

### Vì sao nguy hiểm

LLM có hallucination rate ~5-15% trên domain y tế. Khi AI không chắc:
- ✅ Tốt: "Tôi không chắc, hỏi bác sĩ"
- ❌ Xấu: bịa ra thông tin nghe có vẻ đúng

Cấm AI thừa nhận uncertainty → ép sang option ❌ → user đọc reply tự tin nhưng sai → tự dùng thuốc/lifestyle theo info bịa = nguy hiểm.

### Giải pháp

Đảo ngược instruction:

```js
lines.push(isEn
  ? 'When uncertain about diagnosis, dosage, or drug interactions: BE HONEST. Say "I am not sure, please ask your doctor" instead of guessing. Honesty > sounding smart.'
  : 'Khi không chắc về chẩn đoán/liều/tương tác thuốc: THÀNH THẬT nói "${selfRef} không chắc, ${honorific} hỏi bác sĩ nhé" thay vì đoán. Thật thà > thông minh.');
```

---

## 🟠 SAFETY #2 — Không có refusal pattern cho khủng hoảng tâm lý

**Mức độ**: 🟠🟠🟠 CRITICAL SAFETY — life-threatening edge case

### Hiện trạng

Tìm trong toàn `src/services/chat/`: **0 hit** cho "tự tử", "tự hại", "suicide", "hotline", "crisis".

Nếu user nhắn: *"Tôi muốn chết"* hoặc *"Tôi không thiết sống nữa"*, AI sẽ:
- Trả lời theo system prompt: empathize + advise lifestyle
- Có thể bị filter bằng `filterChatResponse` → vô tác dụng vì không có rule mental health
- KHÔNG escalate, KHÔNG đưa hotline, KHÔNG redirect

### Vì sao nguy hiểm

App sức khoẻ + user lớn tuổi → **rủi ro depression cao** (cô đơn, bệnh mạn tính, mất bạn đời). Một câu reply sai trong khủng hoảng có thể là yếu tố quyết định.

`body-location.js:98` đã detect "muốn tự tử" cho triage flow → nhưng chat flow không liên kết.

### Giải pháp

Thêm REFUSAL/ESCALATION block vào system prompt:

```js
lines.push(isEn ? `
EMERGENCY ESCALATION — when user mentions:
- Self-harm or suicide: STOP advice. Reply ONLY: "I'm worried about you. Please call 1800.599.920 (VN mental health hotline) or go to the nearest hospital now. Talk to someone close to you immediately."
- Substance abuse: redirect to addiction center
- Pregnancy + medication: refuse to suggest meds, redirect to OB-GYN
- Children <16: redirect to pediatrician
` : `
CHUYỂN TUYẾN KHẨN CẤP — khi người dùng nhắc đến:
- Tự làm hại / tự tử: DỪNG tư vấn. Chỉ trả lời: "${honorific} ơi, ${selfRef} lo lắm. ${honorific} gọi ngay 1800.599.920 (đường dây nóng tâm lý) hoặc đến bệnh viện gần nhất nha. Tìm người thân ở cạnh ${honorific} ngay."
- Lạm dụng chất: hướng tới trung tâm cai nghiện
- Mang thai + thuốc: KHÔNG gợi ý thuốc, redirect bác sĩ sản khoa
- Trẻ em <16: redirect bác sĩ nhi
`);
```

Bonus: detect các keyword này ở backend trước khi gọi AI để **bypass** system prompt và trả response cố định an toàn.

---

## 🟠 SAFETY #3 — Drug recommendation thiếu disclaimer

**Mức độ**: 🟠🟠 HIGH — liability + self-medication risk

### Hiện trạng

`chat.service.js:454` (Few-shot):
```
"Đau đầu chú uống paracetamol 500mg nhé, 4-6 tiếng/lần, max 4 lần/ngày."
```

Không có:
- "Nếu kéo dài >2 ngày → đi khám"
- "Nếu kèm sốt cao/cứng cổ → cấp cứu" (rule out viêm màng não)
- Check tương tác với bệnh nền

### Vì sao nguy hiểm

User bị đau đầu kéo dài 2 tuần, AI cứ khuyên paracetamol → user trì hoãn khám → bỏ sót u não / xuất huyết / tăng nhãn áp.

### Giải pháp

Mọi gợi ý thuốc trong few-shot và system prompt PHẢI bao gồm:
1. Liều OTC chuẩn
2. Thời gian giới hạn ("max 3-5 ngày")
3. Red flag → đi khám ngay (cụ thể từng triệu chứng)

Ví dụ rewrite:
```
"Đau đầu chú uống paracetamol 500mg, 4-6 tiếng/lần, tối đa 4 viên/ngày. 
Uống không quá 3 ngày liên tiếp. Nếu đau đầu kèm sốt >38.5°C, cứng cổ, 
nôn, hoặc kéo dài >5 ngày → đi khám ngay nhé."
```

---

## 🟡 QUALITY #1 — Personality fragmented

**Mức độ**: 🟡 MEDIUM — tone không nhất quán giữa các reply

### Hiện trạng

`chat.service.js:244-256` mô tả Asinu bằng 3 fragment:
- Line 244 EN: "close, caring health companion who truly listens"
- Line 252 VI: "như người anh/chị trong nhà biết nhiều về y tế"
- Line 252 VI: "trả lời thẳng, thực tế, có tâm"
- Line 256 VI: "Cấp cứu: ... GỌI 115 hoặc ĐẾN BỆNH VIỆN NGAY"

→ AI nhận 3 personas trộn lẫn: ấm áp / thẳng thắn / clinical. Reply lúc thiên về cảm xúc, lúc lạnh lùng cụ thể.

### Giải pháp

Viết 1 character bible cố định, ngắn, đặt đầu prompt:

```
Bạn là Asinu — người đồng hành sức khoẻ, ấm áp như người thân trong nhà.

NGUYÊN TẮC:
1. Lắng nghe trước, tư vấn sau (1 câu đồng cảm → tư vấn)
2. Cụ thể, đời thường, không đao to búa lớn
3. Không thay thế bác sĩ — biết khi nào nên redirect
4. Khi không chắc → thật thà nói không chắc
```

---

## 🟡 QUALITY #2 — Memory injection thô

**Mức độ**: 🟡 MEDIUM — lãng phí token, ít relevant

### Hiện trạng

`memory.service.js`:
- Lấy 20 memories mới nhất, không weight relevance
- Format: `- [category] content` plain text

Nếu user có 20 memories, mỗi memory ~30 từ → ~600 từ ~ 800 tokens chỉ để recall context không liên quan câu hỏi hiện tại.

### Giải pháp

**Ngắn hạn**: Top-5 memories + sort theo `updated_at DESC` (đã có).

**Dài hạn**: Bước 2 trong roadmap đề xuất — pgvector embedding + semantic retrieval, lấy top-K relevant cho query hiện tại.

---

## 🟡 QUALITY #3 — Token bloat (prompt 1500-2000 tokens mỗi reply)

**Mức độ**: 🟡 MEDIUM — cost + chất lượng giảm khi prompt overload

### Hiện trạng

Đo bằng `wc -c` trên `buildSystemPrompt()`: ~19KB code (bao gồm conditional branches).

Prompt thực tế cho user VI có profile + 5 memories + logs:
- Identity + honorific: ~200 tokens
- Profile context: ~200-400 tokens
- Health metrics + cross-refs: ~150-300 tokens
- Medical-first rule: ~150 tokens
- Memories (5 items): ~200 tokens
- Style + stop rule: ~100 tokens
- Few-shot 5 examples: ~600 tokens
- **Tổng: ~1600-2000 tokens** (chưa tính conversation history)

Cộng với 4096 max output + history = mỗi turn ~3000-5000 input tokens.

### Vì sao cản trở

- Cost: ~$0.005-0.008/turn với gpt-4o ($2.5/1M input)
- Chất lượng: GPT-4o "lost in the middle" — nội dung giữa prompt bị giảm attention
- Few-shot luôn inject = đôi khi over-prescribe

### Giải pháp

**Conditional sections** — chỉ inject nếu liên quan:
- Cross-ref BP chỉ gửi nếu user nhắn về BP/huyết áp
- Cross-ref glucose chỉ nếu user nhắn về đường huyết
- Few-shot diabetes chỉ nếu user nhắn về ăn/đường
- Medical-first rule chi tiết chỉ nếu user nhắn về thuốc/triệu chứng

Pseudocode:
```js
const intent = classifyIntent(message); // simple regex/keyword
if (intent === 'food') lines.push(diabetesFoodRule);
if (intent === 'medication') lines.push(drugRule + drugFewShot);
if (intent === 'vitals') lines.push(crossRefRule);
// always: identity + honorific + profile basics + style
```

Có thể giảm 40-60% tokens, output chất lượng + nhất quán hơn.

---

## 🟡 QUALITY #4 — EN version thiếu logic so với VI

**Mức độ**: 🟡 LOW (vì target chính là VN) — nhưng bug nếu user EN

### Hiện trạng

Compare side-by-side:

| Feature | VI | EN |
|---------|----|----|
| Honorific (cô/chú/anh) | ✅ | ❌ (không có concept) |
| Medical-first chi tiết (diabetes/HTN/heart) | ✅ 3 rule cụ thể | ⚠️ chỉ 1 dòng generic |
| Few-shot examples | ✅ 5 ví dụ | ❌ không có |
| Drug list | ✅ chi tiết | ⚠️ chung chung |
| Cấp cứu rule | ✅ "GỌI 115" | ⚠️ ngắn |

User EN nhận chất lượng thấp hơn, không có few-shot anchor.

### Giải pháp

Port toàn bộ rules sang EN với cấu trúc song song. Honorific concept không cần (English không có), nhưng các rule khác bổ sung.

---

## 🟡 QUALITY #5 — Few-shot quá prescriptive, thiếu đa dạng

**Mức độ**: 🟡 LOW — AI bắt chước pattern, mọi reply ra "kê toa"

### Hiện trạng

5 examples ở `chat.service.js:450-463` đều theo cùng template:
```
[Đồng cảm] → [Hành động hôm nay] → [Hành động ngày mai] → [Báo cáo lại]
```

Vd: "Hôm nay ăn nhẹ, đi bộ 20 phút sau bữa trưa, tối đo lại"

→ AI học pattern này → mọi reply đều ra "Hôm nay làm X, ngày mai làm Y, báo lại". User cảm thấy bị "kê toa" thay vì lắng nghe.

### Giải pháp

Đa dạng hoá few-shot — 4-5 ví dụ thay vì cùng template:
1. **Tư vấn cụ thể** (như hiện): paracetamol + dosage
2. **Đồng cảm thuần** (không advise): "Mệt mỏi quá, ${selfRef} hiểu. Kể ${selfRef} nghe thêm đi."
3. **Từ chối an toàn**: "${selfRef} không chắc về tương tác thuốc này. ${honorific} hỏi dược sĩ giúp ${selfRef} nha."
4. **Thông tin thuần** (giải thích bệnh, không advise): "Tiền tiểu đường có nghĩa là..."
5. **Escalation** (red flag): "Đau ngực kèm tê tay trái → cấp cứu ngay nhé ${honorific}, gọi 115."

---

## Tóm tắt fix theo độ ưu tiên triển khai

| # | Fix | Severity | Effort | Impact |
|---|-----|----------|--------|--------|
| 1 | BUG #1: Resolve drug filter contradiction | 🔴🔴🔴 | 30min | Restore output integrity |
| 2 | SAFETY #1: Allow uncertainty | 🟠🟠🟠 | 5min | Patient safety |
| 3 | SAFETY #2: Crisis refusal pattern | 🟠🟠🟠 | 30min | Patient safety |
| 4 | BUG #3: Lower temperature 0.9→0.5 | 🔴🔴 | 1min | Consistency |
| 5 | SAFETY #3: Drug disclaimer | 🟠🟠 | 20min | Liability |
| 6 | BUG #2: Length by intent | 🔴 | 15min | UX |
| 7 | QUALITY #1: Character bible | 🟡 | 15min | Tone |
| 8 | QUALITY #5: Diversify few-shot | 🟡 | 30min | Polish |
| 9 | QUALITY #3: Conditional sections | 🟡 | 1-2h | Cost + quality |
| 10 | QUALITY #2: Memory ranking | 🟡 | 1h | Relevance |
| 11 | QUALITY #4: EN parity | 🟡 | 1h | EN UX |

**Khuyến nghị PR #1 (critical, ~1.5h)**: #1 + #2 + #3 + #4 + #5 + #6
**PR #2 (polish, ~1h)**: #7 + #8
**PR #3 (optimization, ~2-3h)**: #9 + #10 + #11

---

## Kiểm chứng (đã verify trực tiếp từ code)

| Phát hiện | File | Line | Verified |
|-----------|------|------|----------|
| Drug filter contradiction | `ai-safety.service.js` | 8-15 | ✅ BANNED có "liều dùng" |
| System prompt list drugs | `chat.service.js` | 422 | ✅ "antacid/omeprazole..." |
| Few-shot dosage | `chat.service.js` | 454 | ✅ "paracetamol 500mg, 4-6 tiếng/lần" |
| EN min 10 sentences | `chat.service.js` | 247 | ✅ literal text |
| VI few-shot 3-4 sentences | `chat.service.js` | 450-463 | ✅ count manually |
| Temperature 0.9 in env | `.env` | line read | ✅ OPENAI_CHAT_TEMPERATURE=0.9 |
| "Never say I am limited" | `chat.service.js` | 419 | ✅ literal text |
| No mental health refusal | full grep | — | ✅ 0 hits in chat/ |
| Drug list no disclaimer | `chat.service.js` | 422, 454 | ✅ no follow-up clause |
| Personality fragments | `chat.service.js` | 244-256 | ✅ 3 different descriptions |
| EN missing few-shot | `chat.service.js` | 446 | ✅ `if (!isEn)` |
| Memory plain list | `memory.service.js` | formatMemoriesForPrompt | ✅ no ranking |
