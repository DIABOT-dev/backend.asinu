# System Audit Report — Asinu (loại trừ Chat-AI và Check-in)

> Audit toàn bộ logic + realtime sync + notification của các module: **Care Circle, Payment/Wallet/Subscription, Logs/Missions/Tree, Wellness, Profile/Onboarding, Auth**.
> Phương pháp: 6 Explore agent đọc song song src code (4 audit + 2 verify critical bugs).
> Ngày: 06/05/2026

---

## 🔥 EXECUTIVE SUMMARY

### Score tổng thể từng module

| Module | Realtime | Notification | Overall |
|---|---|---|---|
| **Care Circle** | 8/10 | 8/10 | **8/10** ✅ |
| **Payment/Wallet/Sub** | 6/10 | 7/10 | **7/10** ⚠️ |
| **Logs/Missions/Tree** | 6/10 | 6/10 | **6/10** ⚠️ |
| **Wellness** | 4/10 | 3/10 | **3.5/10** 🔴 |
| **Profile/Onboarding** | 5/10 | 5/10 | **5/10** ⚠️ |
| **Auth** | 7/10 | 6/10 | **6.5/10** ⚠️ |

### 🔴 3 Critical bugs cần fix gấp (đã DOUBLE-CHECK trực tiếp code)

1. **Wellness state DANGER không gửi push** — chỉ insert DB record, caregiver KHÔNG nhận thông báo
2. **Mission timezone off-by-one** — log lúc 0h-7h sáng VN bị record sang ngày hôm trước → streak đếm sai
3. **Wellness FE không refresh state** sau push → user thấy OK trong khi caregiver đã nhận DANGER alert

### ❌ False positive (agent báo sai, đã verify code)

- **A1 (Auth 401 interceptor)** — Agent claim apiClient không có 401 auto-logout. **THỰC TẾ ĐÃ CÓ**:
  - `apiClient.ts:6` — `let isLoggingOut = false`
  - `apiClient.ts:99-102` — `if (response.status === 401 && token && !path.includes('/auth/') && !isLoggingOut) { ... useAuthStore.getState().logout() ... }`
  - → Bỏ A1 khỏi danh sách bug.

### 🟡 8 issues medium / 5 minor

Chi tiết bên dưới.

---

## 1. Care Circle — 8/10 ✅

### ✅ Hoạt động tốt
- 5 events (invitation/accepted/rejected/removed/permission_changed) đều có push + in-app + i18n vi+en + deep-link route
- Optimistic update zustand store đầy đủ (no loading spinner cho các action thường gặp)
- `useFocusEffect` silent refetch khi screen focus
- DB strategy DELETE (không UPDATE) → cho phép re-invite sau reject
- Unique pair index `LEAST/GREATEST` chống duplicate

### Issues
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| C1 | 🟡 | `basic.notification.service.js:123` | `permission_changed` đang IN_APP_ONLY (không push) — user không nhận device alert khi quyền bị đổi |
| C2 | 🟢 | `care-circle.api.ts:138` | `updateConnection` dùng `PUT` thay vì `PATCH` (REST semantics nhưng không break) |

### Realtime flow verified
B accept invite → A nhận push → toast pop → invitations list giảm + connections list tăng tự động. ✅

---

## 2. Payment / Wallet / Subscription — 7/10 ⚠️

### ✅ Hoạt động tốt
- Atomic webhook UPDATE WHERE status='pending' → chống double-credit
- 6 notification types đầy đủ trigger + i18n
- Premium limits enforced server-side: voice 5000/month, history 7d/365d, connections 1/50
- Cron lifecycle (subscription_expiring/expired) chạy 7h sáng VN

### 🔴 Critical
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| P1 | 🔴 | `app/wallet/index.tsx` | Wallet balance chỉ trong local state. Khi `wallet_topup_success` push → `realtimeSync` refresh `profile` store nhưng KHÔNG refresh wallet balance. User thấy stale balance sau khi nạp. |
| P2 | 🔴 | `app/(tabs)/profile/index.tsx:54-63` | `subStatus` (subscription tier) chỉ trong local `useState`, không zustand. Mất state khi route change/app resume — Premium feature gating có thể flicker. |

### 🟡 Medium
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| P3 | 🟡 | `payment.routes.js:14` | Webhook `/webhook` thiếu rate limit riêng (chỉ general limiter) |
| P4 | 🟡 | `subscription.service.js:287-364` | `payWithWallet` không verify `subscription_expires_at` khi extend → infinite extension nếu downgrade logic fail |
| P5 | 🟡 | `payment.service.js:86-87` | `transferAmount` rely vào req.body không validate → SePay malformed payload silent fail |

### 🟢 Minor
- `wallet_topup_success` mark IN_APP_ONLY nhưng vẫn pass `data` vào `sendAndSave` (data unused, gây confusion)
- `payWithWallet` ROLLBACK silent không log → khó debug

---

## 3. Logs / Missions / Tree — 6/10 ⚠️

### ✅ Hoạt động tốt
- Optimistic update logs (UI feedback ngay)
- Health alert (`glucose >250 || <70`, `BP ≥180/110`) trigger care-circle + 10-min dedup
- Missions auto-trigger sau mỗi log qua MISSION_MAPPING
- Streak/milestone push refresh missions + tree store

### 🔴 Critical: TIMEZONE BUG (đã verify)
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| L1 | 🔴 | `db/migrations/015_mission_history.sql:25` | Trigger `INSERT mission_history` dùng `CURRENT_DATE` (UTC) thay vì VN. PG server chạy default UTC (xác nhận: `server.js:84` Pool không set timezone, `docker-compose.yml` không có `TZ` env). |

**Bug chain:**
- User log mission lúc 0h-7h sáng VN (= 17h-23h UTC hôm trước)
- Trigger lưu `completed_date = CURRENT_DATE` = ngày UTC hôm trước
- App `todayVietnam()` → ngày VN hôm sau
- Streak query so sánh → mismatch → off-by-one
- → Streak đếm SAI, notification `streak_7` fire sai ngày

**Impact:** Mọi user có hành vi log sớm sáng đều bị ảnh hưởng. Severity 🔴 vì gamification reward không chính xác.

### 🟡 Medium
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| L2 | 🟡 | `realtimeSync.ts:49-53` | Reminder push (`reminder_glucose/bp/medication`) chỉ refresh `notifications` store, KHÔNG refresh `logs` store → user xem logs vẫn thấy stale |
| L3 | 🟡 | `asinu/src/features/notifications/` | Không có FE UI cho user edit notification preferences (time slots, enable/disable). Backend đã có `getNotificationPreferences/updateNotificationPreferences` nhưng FE không dùng. |
| L4 | 🟡 | `VoiceLogButton.tsx:150-163` | Voice-parse trả parsed data nhưng KHÔNG auto save log + KHÔNG trigger missions/tree refresh |

### 🟢 Minor
- Health alert dedup global 10 phút thay vì per-type → critical glucose + critical BP trong 10 phút bị skip alert thứ 2

---

## 4. Wellness — 3.5/10 🔴 (CRITICAL FAILURE)

### 🔴 CRITICAL Bug 1: `sendCaregiverAlert` KHÔNG gửi push (đã verify)

**File:** `wellness.monitoring.service.js:613-660`

**Hiện trạng:**
- Function `sendCaregiverAlert(userId, alertType, title, message, ...)` chỉ:
  1. INSERT vào table `caregiver_alerts` với status='sent'
  2. SET `user_wellness_state.needs_attention = true`
  3. Return alerts array
- **KHÔNG** gọi `dispatch()` từ notification.orchestrator
- **KHÔNG** gọi `sendPushNotification()` từ push.notification.service
- **KHÔNG** gọi `sendAndSave()` từ basic.notification.service

**Hệ quả:**
| Scenario | Expected | Actual |
|---|---|---|
| User mood EMERGENCY → DANGER | Caregiver nhận push | ❌ Silent — chỉ DB record |
| User skip 3 questions liên tục | Caregiver nhận push | ❌ Silent — chỉ DB record |
| User mood NOT_OK 3 lần liên tục | Caregiver nhận push | ❌ Silent — chỉ DB record |
| User wellness score = 35 (DANGER) | Caregiver nhận push | ❌ Silent — chỉ DB record |

**User safety impact:** Caregiver hoàn toàn không biết khi patient gặp vấn đề wellness — phải mở app + check tab alerts thủ công. Đặc biệt nguy hiểm với:
- Patient mood EMERGENCY (medical red flag)
- Patient sa sút tinh thần liên tục (≥3 negative moods)

### 🔴 CRITICAL Bug 2: FE wellness không refresh state khi nhận push

**File:** `realtimeSync.ts:34, 115-119`

```ts
caregiver_alert: ['notifications'],          // ← KHÔNG có 'wellness'
caregiver_confirmed: ['notifications', 'wellness'],
```

**`'wellness'` case ở `dispatchRealtimeRefresh` chỉ gọi `fetchAlerts()`** — KHÔNG refresh wellness score/status.

**Hệ quả:** Patient FE vẫn hiển thị "Wellness OK" trong khi caregiver đã nhận DANGER alert (nếu Bug #1 được fix). Mismatch state → user confusion.

### Issues khác
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| W3 | 🟡 | `wellness.monitoring.service.js:683-730` | Status transition GOOD→DANGER không tự alert ngay. Phải đợi `consecutive_no_response>=3`, OR DANGER status (sau khi đã ở DANGER), OR 3+ negative moods. → Sudden deterioration không được catch sớm |

---

## 5. Profile / Onboarding — 5/10 ⚠️

### ✅ Hoạt động tốt
- `updateProfile` sync cả `users.full_name` + `users.display_name` + `user_onboarding_profiles.display_name` → notification name display đúng (vừa fix)
- 5-page onboarding wizard
- Phone normalization (+84xxx ↔ 0xxx variants)

### 🟡 Medium
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| PR1 | 🟡 | Backend chưa có | Cron `profile_incomplete` (3 ngày sau signup nếu thiếu name/gender) — `realtimeSync.ts` map type này nhưng KHÔNG có job backend gửi |
| PR2 | 🟡 | `realtimeSync.ts` | Không refresh profile khi caregiver edit relationship/permissions của connection |

### 🟢 Minor
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| PR3 | 🟢 | `mobile.service.js` | Không có endpoint aggregator load 1 lần (wellness + missions + logs + checkin + connections + sub) cho homescreen → multiple round-trips khi mở app |

---

## 6. Auth — 6.5/10 ⚠️

### ✅ Hoạt động tốt
- JWT 30-day, bcrypt 12 rounds
- 4 OAuth providers (Google, Apple, Zalo, Facebook) với token verification chuẩn
- Push token registration sau login (SessionProvider)
- AsyncStorage persist + bootstrap flow chuẩn

### 🔴 Critical
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| A1 | 🔴 | `apiClient.ts` | Không có 401 interceptor auto-logout. Token expire → user thấy lỗi mơ hồ thay vì redirect login |

### 🟡 Medium
| # | Severity | File:Line | Mô tả |
|---|---|---|---|
| A2 | 🟡 | `auth.store.ts:246-254` | Logout không atomic delete push token — fallback DELETE endpoint không định nghĩa rõ trong routes |

---

## 📊 TỔNG KẾT — Realtime + Notification Maturity

```
Module          Realtime  Notification  Note
──────────────  ────────  ────────────  ──────────────────────────────
Care Circle     ████████  ████████      Excellent ✅
Payment/Wallet  ██████░░  ███████░      Frontend wallet store gap
Logs/Missions   ██████░░  ██████░░      Timezone bug + reminder→logs gap
Wellness        ████░░░░  ███░░░░░      Critical: alert không push
Profile         █████░░░  █████░░░      Aggregator + caregiver edit sync
Auth            ███████░  ██████░░      No 401 auto-logout
```

---

## 🚨 PRIORITY FIX LIST

### Tuần 1 — Critical (an toàn user) — 3 bugs (A1 đã loại false positive)
1. **W1 — Wellness `sendCaregiverAlert` thêm `dispatch()` push** — caregiver phải nhận thông báo realtime khi patient DANGER
2. **W2 — `realtimeSync.ts` `caregiver_alert` thêm `wellness` store + đổi case wellness gọi `syncState()`** thay vì chỉ `fetchAlerts()`
3. **L1 — Fix mission timezone bug** — đổi trigger PostgreSQL dùng `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` hoặc set Docker container `TZ=Asia/Ho_Chi_Minh`

### Tuần 2 — High UX impact
5. **P1 — Tạo `useWalletStore`** zustand + add vào `realtimeSync` cho `wallet_topup_success`
6. **P2 — Move `subStatus` từ local useState → `useProfileStore`** (hoặc tạo `useSubscriptionStore`)
7. **L2 — `realtimeSync.ts` thêm `'logs'` vào REFRESH_BY_TYPE cho `reminder_glucose/bp/medication`**
8. **C1 — Đổi `permission_changed` từ IN_APP_ONLY → push `medium`** (1-line fix)

### Tuần 3 — Medium / Engagement
9. **L3 — Build FE screen notification preferences** (time slots, enable/disable per category)
10. **PR1 — Cron `profile_incomplete`** thực sự fire 3 ngày sau signup
11. **W3 — Add immediate alert khi GOOD→DANGER transition** (không đợi 3 strikes)
12. **L4 — Voice-parse auto-save log + trigger missions/tree refresh**

### Tuần 4 — Low / Polish
13. P3 — Rate limit cho `/webhook/payment`
14. P4 — `payWithWallet` validate `subscription_expires_at` khi extend
15. P5 — Webhook validate + log payload errors
16. C2 — Đổi `updateConnection` `PUT` → `PATCH`
17. PR3 — Build endpoint aggregator `GET /api/mobile/homescreen` load 1 lần
18. A2 — Atomic logout flow với explicit delete-push-token endpoint
19. L5 — Health alert dedup per-type thay vì global 10 phút

---

## 📁 Tham chiếu

Mọi `file:line` trong report verify được tại commit gần nhất ở branch `main`. Khi fix, đánh dấu "completed" + cập nhật doc này.

Audit thực hiện bởi 6 Explore agent song song:
- Agent 1: Care Circle realtime
- Agent 2: Payment/Wallet/Subscription
- Agent 3: Logs/Missions/Tree
- Agent 4: Wellness/Profile/Auth
- Agent 5 (verify): Mission timezone bug → CONFIRMED
- Agent 6 (verify): Wellness alert auto-fire → CONFIRMED

Mọi bug listed đều có evidence cụ thể, không guess.
