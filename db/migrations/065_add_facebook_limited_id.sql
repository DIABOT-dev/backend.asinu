-- 065: Tách Facebook ID theo loại login (Standard vs iOS Limited Login)
--
-- Vấn đề: iOS Limited Login (yêu cầu bởi App Tracking Transparency của Apple)
-- trả về `id_token.sub` KHÁC HOÀN TOÀN với Facebook user_id từ Graph API.
-- Standard FB ID = "2404121363361233" (16 chữ số). Limited sub = "MGoP7q..." (40+ ký tự, per-app).
--
-- Trước fix: cùng 1 user FB login iOS vs Android → 2 record → tạo trùng account.
-- Sau fix: lookup theo facebook_id (Standard) HOẶC facebook_limited_id (iOS).
-- Email match (đã có sẵn trong service.loginByProvider) sẽ tự link cross-platform.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS facebook_limited_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_facebook_limited_id
  ON users (facebook_limited_id)
  WHERE facebook_limited_id IS NOT NULL;

COMMENT ON COLUMN users.facebook_id IS
  'Standard Facebook user_id từ Graph API (Android, web flow)';

COMMENT ON COLUMN users.facebook_limited_id IS
  'iOS Limited Login sub từ id_token JWT — KHÁC facebook_id, per-app stable';

COMMIT;
