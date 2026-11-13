-- Health monitoring sessions reset at 05:00 Vietnam time. Coin tasks reset at
-- midnight: use the accepted response timestamp, never the session's old day.
-- Keep the existing outbox key (user, CHECKIN, calendar date) shared with med_call.
CREATE OR REPLACE FUNCTION enqueue_v21_coin_event() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE subject INTEGER; why TEXT; reference TEXT; local_day DATE;
 BEGIN
  IF TG_TABLE_NAME='health_checkins' THEN
   IF NEW.initial_status IS NULL OR NEW.last_response_at IS NULL THEN RETURN NEW; END IF;
   IF TG_OP='UPDATE' AND NEW.last_response_at IS NOT DISTINCT FROM OLD.last_response_at THEN RETURN NEW; END IF;
   subject:=NEW.user_id; why:='CHECKIN';
   local_day:=(NEW.last_response_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
   IF local_day<>(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN RETURN NEW; END IF;
   reference:=local_day::text;
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
