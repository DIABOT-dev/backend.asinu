-- Operational events share the source transaction. No clinical text is copied.
CREATE SEQUENCE crm_operational_event_sequence;
CREATE FUNCTION crm_publish_operation(event_type TEXT, resource TEXT, subject INTEGER, properties JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE clock_row RECORD;
BEGIN
  IF subject IS NULL THEN RETURN; END IF;
  INSERT INTO crm_projection_revisions(projection,resource_id) VALUES(event_type,resource)
    ON CONFLICT(projection,resource_id) DO UPDATE SET
      revision=crm_projection_revisions.revision+1,updated_at=clock_timestamp()
    RETURNING revision,updated_at INTO clock_row;
  INSERT INTO crm_event_outbox(event_id,event_type,source,version,occurred_at,payload)
    VALUES(event_type||':operation:'||nextval('crm_operational_event_sequence'),event_type,'asinu-backend',1,
      clock_row.updated_at,properties||jsonb_build_object('user_id',subject::text,'resource_id',resource,'source_revision',clock_row.revision));
END $$;

CREATE FUNCTION crm_operational_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE subject INTEGER; notification_kind TEXT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'med_dose_events' THEN
      PERFORM crm_publish_operation('medication.updated',NEW.id::text,NEW.patient_user_id,
        jsonb_build_object('state',NEW.state,'scheduled_at',NEW.scheduled_at));
    WHEN 'coin_balances' THEN
      PERFORM crm_publish_operation('reward.updated','balance:'||NEW.user_id,NEW.user_id,
        jsonb_build_object('state','ACTIVE','kind','balance','balance',NEW.balance));
    WHEN 'reward_redemptions' THEN
      PERFORM crm_publish_operation('reward.updated',NEW.id::text,NEW.user_id,
        jsonb_build_object('state',NEW.status,'kind','redemption','reward_code',NEW.catalog_code,'delta',-NEW.cost));
    WHEN 'early_signal_assessments' THEN
      PERFORM crm_publish_operation('early_signal.updated',NEW.id::text,NEW.user_id,
        jsonb_build_object('state',UPPER(NEW.severity),'kind','assessment'));
    WHEN 'notification_push_outbox' THEN
      SELECT user_id,type INTO subject,notification_kind FROM notifications WHERE id=NEW.notification_id;
      PERFORM crm_publish_operation('notification.delivery_updated',NEW.notification_id::text,subject,
        jsonb_build_object('state',NEW.state,'channel','push','kind',notification_kind));
    WHEN 'user_onboarding_profiles' THEN
      PERFORM crm_publish_operation('onboarding.updated',NEW.user_id::text,NEW.user_id,
        jsonb_build_object('state',CASE WHEN NEW.onboarding_completed_at IS NOT NULL THEN 'COMPLETED' ELSE 'PENDING' END));
  END CASE;
  RETURN NEW;
END $$;

CREATE TRIGGER crm_medication_change AFTER INSERT OR UPDATE OF state ON med_dose_events
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
CREATE TRIGGER crm_coin_balance_change AFTER INSERT OR UPDATE OF balance ON coin_balances
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
CREATE TRIGGER crm_reward_change AFTER INSERT OR UPDATE OF status ON reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
CREATE TRIGGER crm_early_signal_change AFTER INSERT ON early_signal_assessments
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
CREATE TRIGGER crm_notification_change AFTER INSERT OR UPDATE OF state ON notification_push_outbox
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
CREATE TRIGGER crm_onboarding_change AFTER INSERT OR UPDATE OF onboarding_completed_at ON user_onboarding_profiles
  FOR EACH ROW EXECUTE FUNCTION crm_operational_change();
