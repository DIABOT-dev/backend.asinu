-- V2 gifts are independent of billing. Trial columns reserve the next phase;
-- this migration does not activate trials or change existing entitlements.
ALTER TABLE subscription_households
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plan_source TEXT NOT NULL DEFAULT 'free';

CREATE TABLE IF NOT EXISTS gift_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  loc_weight INTEGER NOT NULL DEFAULT 60 CHECK (loc_weight >= 0),
  ticket_weight INTEGER NOT NULL DEFAULT 30 CHECK (ticket_weight >= 0),
  coupon_weight INTEGER NOT NULL DEFAULT 10 CHECK (coupon_weight >= 0),
  lucky_draw_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  coupon_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (coupon_enabled = FALSE),
  coupon_max_vnd INTEGER NOT NULL DEFAULT 100000 CHECK (coupon_max_vnd BETWEEN 0 AND 100000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (loc_weight + ticket_weight + coupon_weight = 100)
);
INSERT INTO gift_config (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS loc_items (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('wish', 'proverb', 'health_tip')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  text_en TEXT,
  conditions TEXT[] NOT NULL DEFAULT '{}',
  serif BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (type <> 'health_tip' OR NOT active OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gift_draw_periods (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  prize_name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  draw_at TIMESTAMPTZ NOT NULL,
  rules JSONB NOT NULL,
  registration_reference TEXT NOT NULL CHECK (length(trim(registration_reference)) > 0),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMPTZ,
  CHECK (starts_at < closes_at AND closes_at < draw_at),
  CHECK (rules ? 'vi' AND rules ? 'en')
);

CREATE TABLE IF NOT EXISTS gift_events (
  id UUID PRIMARY KEY,
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id BIGINT REFERENCES health_checkins(id) ON DELETE SET NULL,
  call_episode_id UUID REFERENCES checkin_call_episodes(id) ON DELETE SET NULL,
  date_vn DATE NOT NULL,
  loc_id BIGINT NOT NULL REFERENCES loc_items(id),
  loc_snapshot JSONB NOT NULL,
  extra TEXT NOT NULL CHECK (extra IN ('none', 'ticket', 'coupon')),
  answer TEXT NOT NULL CHECK (answer IN ('fine', 'tired', 'very_tired', 'specific_concern')),
  random_value INTEGER NOT NULL CHECK (random_value BETWEEN 0 AND 999999),
  config_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  selected_box INTEGER CHECK (selected_box BETWEEN 0 AND 5),
  UNIQUE (household_id, date_vn),
  UNIQUE (user_id, date_vn)
);
CREATE INDEX IF NOT EXISTS idx_gift_fortune_history ON gift_events(household_id, date_vn DESC, loc_id);

CREATE SEQUENCE IF NOT EXISTS gift_ticket_numbers;
CREATE TABLE IF NOT EXISTS draw_tickets (
  ticket_no TEXT PRIMARY KEY DEFAULT ('A' || nextval('gift_ticket_numbers')::text),
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  draw_period BIGINT NOT NULL REFERENCES gift_draw_periods(id),
  gift_event_id UUID NOT NULL UNIQUE REFERENCES gift_events(id) ON DELETE CASCADE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reserved schema only. Coupon issuance and store redemption remain disabled
-- until the offer-code inventory and store offer implementation are ready.
CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY,
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('schedule_n12', 'schedule_n25', 'gift_box')),
  value_vnd INTEGER NOT NULL CHECK (value_vnd BETWEEN 1 AND 199000),
  first_year_price_vnd INTEGER NOT NULL CHECK (first_year_price_vnd >= 1000000),
  renewal_price_vnd INTEGER NOT NULL DEFAULT 1199000 CHECK (renewal_price_vnd >= 1000000),
  store_code TEXT,
  offer_id TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired')),
  reminded_at TIMESTAMPTZ,
  gift_event_id UUID UNIQUE REFERENCES gift_events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_household_coupon ON coupons(household_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS gift_family_outbox (
  gift_event_id UUID NOT NULL REFERENCES gift_events(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  PRIMARY KEY (gift_event_id, recipient_id)
);

-- Seed original, non-medical wishes. P3 can replace/edit these through the
-- management command; health tips require a recorded professional review.
INSERT INTO loc_items (code, type, text, text_en)
SELECT 'welcome_' || lpad(n::text, 2, '0'), 'wish',
  (ARRAY[
    'Chúc bạn một ngày bình yên.', 'Mong hôm nay có một điều làm bạn mỉm cười.',
    'Chúc mái nhà luôn đầy tiếng cười.', 'Mong niềm vui ghé thăm bạn hôm nay.',
    'Chúc bạn có một buổi sáng thật nhẹ nhàng.', 'Mong những điều nhỏ bé mang lại niềm vui.',
    'Chúc gia đình mình luôn gần nhau trong yêu thương.', 'Mong hôm nay là một ngày ấm áp.',
    'Chúc bạn có thời gian cho những điều mình thích.', 'Mong bạn luôn được lắng nghe.'
  ])[((n - 1) % 10) + 1] || ' ' ||
  (ARRAY[
    'Cả nhà luôn nhớ đến bạn.', 'Một lời hỏi thăm cũng làm ngày thêm ấm.',
    'Bình yên bắt đầu từ những điều giản dị.', 'Yêu thương không ngại khoảng cách.',
    'Mỗi lần gặp nhau là một niềm vui.', 'Bạn xứng đáng với những điều dịu dàng.'
  ])[((n - 1) / 10) + 1],
  (ARRAY[
    'Wishing you a peaceful day.', 'May something make you smile today.',
    'May your home be full of laughter.', 'May a little joy find you today.',
    'Wishing you a gentle morning.', 'May small moments bring you joy.',
    'May your family stay close in love.', 'Wishing you warmth today.',
    'May you find time for what you enjoy.', 'May you always feel heard.'
  ])[((n - 1) % 10) + 1] || ' ' ||
  (ARRAY[
    'Your family is thinking of you.', 'A kind hello can brighten a day.',
    'Peace can be found in simple things.', 'Love travels across distances.',
    'Every reunion is a joy.', 'You deserve gentle moments.'
  ])[((n - 1) / 10) + 1]
FROM generate_series(1, 60) n ON CONFLICT (code) DO NOTHING;
