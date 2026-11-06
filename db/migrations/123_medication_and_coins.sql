-- V2.1 is opt-in on the server. No default medication schedule or live call.
CREATE TABLE v21_config (
 id INTEGER PRIMARY KEY CHECK(id=1), medication_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 coins_enabled BOOLEAN NOT NULL DEFAULT FALSE, scan_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 native_call_enabled BOOLEAN NOT NULL DEFAULT FALSE, rollout_user_ids INTEGER[] NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO v21_config(id) VALUES(1);
CREATE FUNCTION v21_allowed(subject INTEGER, feature TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT COALESCE((SELECT CASE feature WHEN 'coins' THEN coins_enabled
 WHEN 'medication' THEN medication_enabled WHEN 'scan' THEN medication_enabled AND scan_enabled
 WHEN 'native' THEN medication_enabled AND native_call_enabled ELSE FALSE END
 AND (cardinality(rollout_user_ids)=0 OR subject=ANY(rollout_user_ids)) FROM v21_config WHERE id=1),FALSE)
$$;

CREATE TABLE med_media (
 id UUID PRIMARY KEY, patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL, mime_type TEXT NOT NULL,
 payload TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 12 AND 10485760),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE med_items (
 id UUID PRIMARY KEY, patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL, printed_name TEXT, kind TEXT NOT NULL CHECK(kind IN ('MEDICINE','SUPPLEMENT')),
 photo_media_id UUID REFERENCES med_media(id) ON DELETE SET NULL,
 source TEXT NOT NULL CHECK(source IN ('PHOTO_AI','CHIP','VOICE')), active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE user_meal_times (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 breakfast TIME NOT NULL DEFAULT '06:30', lunch TIME NOT NULL DEFAULT '11:30',
 dinner TIME NOT NULL DEFAULT '18:00', bedtime TIME NOT NULL DEFAULT '21:30',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE med_schedules (
 id UUID PRIMARY KEY, patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 time_local TIME NOT NULL, meal_anchor TEXT, note TEXT,
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 consent_state TEXT NOT NULL CHECK(consent_state IN ('PENDING','ACTIVE','DECLINED')),
 consented_at TIMESTAMPTZ, declined_at TIMESTAMPTZ, consent_reminded_at TIMESTAMPTZ,
 active BOOLEAN NOT NULL DEFAULT TRUE, revision INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX med_schedules_patient ON med_schedules(patient_user_id) WHERE active;
CREATE UNIQUE INDEX med_schedules_time ON med_schedules(patient_user_id,time_local)
 WHERE active AND consent_state<>'DECLINED';
CREATE TABLE med_schedule_items (
 schedule_id UUID NOT NULL REFERENCES med_schedules(id) ON DELETE CASCADE,
 item_id UUID NOT NULL REFERENCES med_items(id) ON DELETE CASCADE, PRIMARY KEY(schedule_id,item_id)
);
CREATE TABLE med_scan_jobs (
 id UUID PRIMARY KEY, uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 media_id UUID REFERENCES med_media(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('PROCESSING','DONE','UNREADABLE','FAILED')),
 result_json TEXT, model TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE med_dose_events (
 id UUID PRIMARY KEY, schedule_id UUID NOT NULL REFERENCES med_schedules(id) ON DELETE CASCADE,
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 local_date DATE NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL, next_attempt_at TIMESTAMPTZ NOT NULL,
 timezone TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'SCHEDULED'
 CHECK(state IN ('SCHEDULED','CALLING','TAKEN','SKIPPED','OUT_OF_MEDS','UNCONFIRMED','SKIPPED_NO_DEVICE','CANCELLED')),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
 answered_at TIMESTAMPTZ, button INTEGER CHECK(button IN(1,2,3)),
 checkin_id BIGINT REFERENCES health_checkins(id) ON DELETE SET NULL,
 checkin_pending BOOLEAN NOT NULL DEFAULT FALSE, checkin_status TEXT,
 has_medicine BOOLEAN NOT NULL DEFAULT FALSE, taken_after_retry BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(schedule_id,local_date)
);
CREATE INDEX med_doses_due ON med_dose_events(next_attempt_at) WHERE state='SCHEDULED';
CREATE TABLE med_dose_items (
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 dose_event_id UUID REFERENCES med_dose_events(id) ON DELETE CASCADE,
 item_id UUID REFERENCES med_items(id) ON DELETE SET NULL,
 display_name TEXT NOT NULL, kind TEXT NOT NULL, photo_media_id UUID REFERENCES med_media(id) ON DELETE SET NULL,
 id BIGSERIAL PRIMARY KEY
);
CREATE TABLE med_call_attempts (
 id UUID PRIMARY KEY, dose_event_id UUID NOT NULL REFERENCES med_dose_events(id) ON DELETE CASCADE,
 group_id UUID NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 2),
 channel TEXT NOT NULL CHECK(channel IN ('native_call','push')),
 state TEXT NOT NULL CHECK(state IN ('QUEUED','SENDING','DELIVERED','ANSWERED','ENDED','FAILED')),
 button INTEGER, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ,
 deadline TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, lease_until TIMESTAMPTZ, end_reason TEXT,
 notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
 UNIQUE(dose_event_id,attempt_no)
);
CREATE INDEX med_call_group ON med_call_attempts(group_id);
CREATE TABLE med_answer_receipts (
 request_id UUID NOT NULL, patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 dose_event_id UUID NOT NULL REFERENCES med_dose_events(id) ON DELETE CASCADE,
 button INTEGER NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(patient_user_id,request_id)
);
CREATE TABLE med_schedule_audit (
 id BIGSERIAL PRIMARY KEY, schedule_id UUID REFERENCES med_schedules(id) ON DELETE CASCADE,
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE med_setup_receipts (
 actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id UUID NOT NULL, patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE med_devices (
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, platform TEXT CHECK(platform IN('ios','android')),
 token_hash TEXT NOT NULL, supported BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,platform)
);
CREATE TABLE med_family_preferences (
 caregiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 patient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, problems_only BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY(caregiver_id,patient_user_id)
);
CREATE TABLE med_consent_calls (
 id UUID PRIMARY KEY, schedule_id UUID NOT NULL UNIQUE REFERENCES med_schedules(id) ON DELETE CASCADE,
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN('QUEUED','SENDING','DELIVERED','ENDED')),
 channel TEXT NOT NULL DEFAULT 'push', next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 deadline TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE v21_message_outbox (
 id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
 subject_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
 notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
 completed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE coin_rules (
 task_code TEXT PRIMARY KEY CHECK(task_code IN('CHECKIN','MED_ANSWER','VITAL','GIFT_OPEN','WEEKLY')),
 coins INTEGER NOT NULL CHECK(coins BETWEEN 1 AND 100), daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 0 AND 4),
 weekly_limit INTEGER NOT NULL DEFAULT 0 CHECK(weekly_limit BETWEEN 0 AND 1), active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO coin_rules(task_code,coins,daily_limit,weekly_limit) VALUES
 ('CHECKIN',10,1,0),('MED_ANSWER',5,4,0),('VITAL',5,2,0),('GIFT_OPEN',2,1,0),('WEEKLY',20,0,1);
CREATE TABLE coin_balances (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE coin_ledger (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 delta INTEGER NOT NULL CHECK(delta<>0),
 reason TEXT NOT NULL CHECK(reason IN('CHECKIN','MED_ANSWER','VITAL','GIFT_OPEN','WEEKLY','REDEEM','EXPIRE','REFUND')),
 ref_id TEXT NOT NULL, local_date DATE NOT NULL, expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,reason,ref_id),
 CHECK(delta<0 OR expires_at IS NOT NULL)
);
CREATE INDEX coin_ledger_history ON coin_ledger(user_id,id DESC);
CREATE FUNCTION coin_ledger_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'coin ledger is append only'; END $$;
CREATE TRIGGER coin_ledger_immutable BEFORE UPDATE ON coin_ledger FOR EACH ROW EXECUTE FUNCTION coin_ledger_no_update();
CREATE TABLE coin_lots (
 ledger_id BIGINT PRIMARY KEY REFERENCES coin_ledger(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 remaining INTEGER NOT NULL CHECK(remaining>=0), expires_at TIMESTAMPTZ NOT NULL,
 reminded_at TIMESTAMPTZ
);
CREATE TABLE coin_event_outbox (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL, ref_id TEXT NOT NULL, local_date DATE NOT NULL,
 completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,reason,ref_id)
);
CREATE TABLE reward_catalog (
 code TEXT PRIMARY KEY, name TEXT NOT NULL, name_en TEXT NOT NULL,
 cost INTEGER NOT NULL CHECK(cost>0), monthly_limit INTEGER NOT NULL DEFAULT 0,
 daily_limit INTEGER NOT NULL DEFAULT 0, requires TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
 approved_at TIMESTAMPTZ
);
INSERT INTO reward_catalog(code,name,name_en,cost,daily_limit,monthly_limit,requires) VALUES
 ('GREETING_CARD','Thiệp gửi người thân','A card for your family',50,1,0,'care_circle'),
 ('DRAW_TICKET','Phiếu bốc thăm kỳ này','A ticket for this draw',300,0,3,'lucky_draw_open');
-- Fixed non-health messages; P3 can approve/activate templates through the ops API.
CREATE TABLE greeting_templates (
 code TEXT PRIMARY KEY, title TEXT NOT NULL, title_en TEXT NOT NULL,
 body TEXT NOT NULL, body_en TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT FALSE,
 approved_by TEXT, approved_at TIMESTAMPTZ,
 CHECK(NOT active OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
INSERT INTO greeting_templates(code,title,title_en,body,body_en) VALUES
 ('MISS_YOU','Nhớ con','Thinking of you','Hôm nay bố mẹ nhớ con. Mong cả nhà mình sớm có dịp gặp nhau.','Thinking of you today. Hope we can spend time together soon.'),
 ('BIRTHDAY','Chúc mừng sinh nhật','Happy birthday','Chúc con một tuổi mới bình an, nhiều sức khỏe và niềm vui.','Wishing you health, peace and joy on your birthday.'),
 ('NEW_YEAR','Chúc mừng năm mới','Happy new year','Chúc gia đình mình năm mới bình an, mạnh khỏe và luôn gần nhau.','Wishing our family health, peace and many moments together this year.');
CREATE TABLE reward_redemptions (
 id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 catalog_code TEXT NOT NULL REFERENCES reward_catalog(code), cost INTEGER NOT NULL,
 request_id UUID NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
 status TEXT NOT NULL CHECK(status IN('PENDING','DELIVERED','REFUNDED')),
 ledger_id BIGINT REFERENCES coin_ledger(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ,
 UNIQUE(user_id,request_id)
);
CREATE TABLE coin_redemption_allocations (
 redemption_id UUID REFERENCES reward_redemptions(id) ON DELETE CASCADE,
 lot_id BIGINT REFERENCES coin_lots(ledger_id) ON DELETE CASCADE,
 amount INTEGER NOT NULL CHECK(amount>0), PRIMARY KEY(redemption_id,lot_id)
);
ALTER TABLE draw_tickets ALTER COLUMN gift_event_id DROP NOT NULL;
ALTER TABLE draw_tickets ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE draw_tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'gift_box' CHECK(source IN('gift_box','coin'));
ALTER TABLE draw_tickets ADD COLUMN redemption_id UUID UNIQUE REFERENCES reward_redemptions(id) ON DELETE SET NULL;

-- Domain writes enqueue only. Exceptions are isolated in the trigger's
-- subtransaction, so a coin failure cannot roll back check-in, logs or gifts.
CREATE FUNCTION enqueue_v21_coin_event() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE subject INTEGER; why TEXT; reference TEXT; local_day DATE;
 BEGIN
  IF TG_TABLE_NAME='health_checkins' THEN
   subject:=NEW.user_id; why:='CHECKIN'; reference:=NEW.session_date::text;
   local_day:=NEW.session_date;
   IF NEW.initial_status IS NULL OR local_day<>(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='logs_common' THEN
   IF NEW.log_type NOT IN('glucose','bp','blood_pressure','weight') THEN RETURN NEW; END IF;
   subject:=NEW.user_id; why:='VITAL'; reference:=NEW.id::text;
   local_day:=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  ELSIF TG_TABLE_NAME='gift_events' THEN
   IF NEW.opened_at IS NULL OR (TG_OP='UPDATE' AND OLD.opened_at IS NOT NULL) THEN RETURN NEW; END IF;
   subject:=NEW.user_id; why:='GIFT_OPEN'; reference:=NEW.id::text;
   local_day:=(NEW.opened_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  ELSE
   IF NEW.answered_at IS NULL OR (TG_OP='UPDATE' AND OLD.answered_at IS NOT NULL) THEN RETURN NEW; END IF;
   subject:=NEW.patient_user_id; why:='MED_ANSWER'; reference:=NEW.id::text;
   local_day:=(NEW.answered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  END IF;
  IF v21_allowed(subject,'coins') THEN
   INSERT INTO coin_event_outbox(user_id,reason,ref_id,local_date)
   VALUES(subject,why,reference,local_day) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'coin event enqueue unavailable'; RETURN NEW;
 END $$;
CREATE TRIGGER v21_checkin_event AFTER INSERT OR UPDATE ON health_checkins
 FOR EACH ROW EXECUTE FUNCTION enqueue_v21_coin_event();
CREATE TRIGGER v21_vital_event AFTER INSERT ON logs_common
 FOR EACH ROW EXECUTE FUNCTION enqueue_v21_coin_event();
CREATE TRIGGER v21_gift_event AFTER INSERT OR UPDATE OF opened_at ON gift_events
 FOR EACH ROW EXECUTE FUNCTION enqueue_v21_coin_event();
CREATE TRIGGER v21_med_answer AFTER UPDATE OF answered_at ON med_dose_events
 FOR EACH ROW EXECUTE FUNCTION enqueue_v21_coin_event();
