-- Founder update 2026-10-17: planned prize is iPhone 18, but the draw is paused.
-- Do not modify already-applied gift migrations or create a fictitious period.
-- Fortune content remains available; coupon issuance is separately disabled.
ALTER TABLE gift_config ALTER COLUMN loc_weight SET DEFAULT 90;
ALTER TABLE gift_config ALTER COLUMN ticket_weight SET DEFAULT 0;
UPDATE gift_config
SET loc_weight = loc_weight + ticket_weight,
    ticket_weight = 0,
    lucky_draw_enabled = FALSE,
    updated_at = NOW()
WHERE id = 1;
