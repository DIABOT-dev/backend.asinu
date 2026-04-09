-- ============================================================================
-- BACKUP: Dead Tables and Dead Fields
-- Created: 2026-04-04
-- Purpose: Full CREATE TABLE statements for 10 dead tables and
--          ALTER TABLE ADD COLUMN statements for 14 dead fields,
--          so they can be restored if needed.
-- ============================================================================

-- ############################################################################
-- PART 1: DEAD TABLES (full CREATE TABLE + indexes + constraints)
-- ############################################################################

-- ============================================================================
-- 1. triage_outcomes
-- ============================================================================

CREATE TABLE public.triage_outcomes (
    id bigint NOT NULL,
    checkin_id bigint NOT NULL,
    user_id integer NOT NULL,
    ai_severity text,
    ai_recommendation text,
    actual_outcome text,
    recommendation_helpful boolean,
    user_note text,
    outcome_date date,
    created_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE public.triage_outcomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.triage_outcomes_id_seq OWNED BY public.triage_outcomes.id;

ALTER TABLE ONLY public.triage_outcomes ALTER COLUMN id SET DEFAULT nextval('public.triage_outcomes_id_seq'::regclass);

ALTER TABLE ONLY public.triage_outcomes
    ADD CONSTRAINT triage_outcomes_pkey PRIMARY KEY (id);

CREATE INDEX idx_triage_outcomes_user ON public.triage_outcomes USING btree (user_id, created_at DESC);

ALTER TABLE ONLY public.triage_outcomes
    ADD CONSTRAINT triage_outcomes_checkin_id_fkey FOREIGN KEY (checkin_id) REFERENCES public.health_checkins(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.triage_outcomes
    ADD CONSTRAINT triage_outcomes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 2. health_logs
-- ============================================================================

CREATE TABLE public.health_logs (
    id integer NOT NULL,
    user_id integer,
    log_type character varying(32),
    payload jsonb,
    created_at timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.health_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.health_logs_id_seq OWNED BY public.health_logs.id;

ALTER TABLE ONLY public.health_logs ALTER COLUMN id SET DEFAULT nextval('public.health_logs_id_seq'::regclass);

ALTER TABLE ONLY public.health_logs
    ADD CONSTRAINT health_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.health_logs
    ADD CONSTRAINT health_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

-- ============================================================================
-- 3. alert_decision_audit
-- ============================================================================

CREATE TABLE public.alert_decision_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    run_at timestamp with time zone DEFAULT now(),
    engine_version text NOT NULL,
    config_version text,
    shadow_mode boolean DEFAULT false NOT NULL,
    input_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    computation jsonb DEFAULT '{}'::jsonb NOT NULL,
    output jsonb DEFAULT '{}'::jsonb NOT NULL,
    explainability_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    notification_sent boolean DEFAULT false NOT NULL,
    channel text
);

COMMENT ON TABLE public.alert_decision_audit IS 'Audit trail for risk engine B decisions';

ALTER TABLE ONLY public.alert_decision_audit
    ADD CONSTRAINT alert_decision_audit_pkey PRIMARY KEY (id);

CREATE INDEX idx_alert_decision_audit_config ON public.alert_decision_audit USING btree (config_version, run_at DESC);

CREATE INDEX idx_alert_decision_audit_user ON public.alert_decision_audit USING btree (user_id, run_at DESC);

ALTER TABLE ONLY public.alert_decision_audit
    ADD CONSTRAINT alert_decision_audit_config_version_fkey FOREIGN KEY (config_version) REFERENCES public.risk_config_versions(config_version);

ALTER TABLE ONLY public.alert_decision_audit
    ADD CONSTRAINT alert_decision_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 4. risk_config_params
-- ============================================================================

CREATE TABLE public.risk_config_params (
    id bigint NOT NULL,
    config_version text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.risk_config_params IS 'Risk engine B config parameters';

CREATE SEQUENCE public.risk_config_params_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.risk_config_params_id_seq OWNED BY public.risk_config_params.id;

ALTER TABLE ONLY public.risk_config_params ALTER COLUMN id SET DEFAULT nextval('public.risk_config_params_id_seq'::regclass);

ALTER TABLE ONLY public.risk_config_params
    ADD CONSTRAINT risk_config_params_config_version_key_key UNIQUE (config_version, key);

ALTER TABLE ONLY public.risk_config_params
    ADD CONSTRAINT risk_config_params_pkey PRIMARY KEY (id);

CREATE INDEX idx_risk_config_params_version ON public.risk_config_params USING btree (config_version, key);

ALTER TABLE ONLY public.risk_config_params
    ADD CONSTRAINT risk_config_params_config_version_fkey FOREIGN KEY (config_version) REFERENCES public.risk_config_versions(config_version) ON DELETE CASCADE;

-- ============================================================================
-- 5. risk_config_versions
-- ============================================================================

CREATE TABLE public.risk_config_versions (
    config_version text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT false NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.risk_config_versions IS 'Risk engine B config versions';

ALTER TABLE ONLY public.risk_config_versions
    ADD CONSTRAINT risk_config_versions_pkey PRIMARY KEY (config_version);

CREATE INDEX idx_risk_config_versions_active ON public.risk_config_versions USING btree (is_active, created_at DESC);

-- ============================================================================
-- 6. risk_persistence
-- ============================================================================

CREATE TABLE public.risk_persistence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    risk_score integer DEFAULT 0 NOT NULL,
    risk_tier text DEFAULT 'LOW'::text NOT NULL,
    last_updated_at timestamp with time zone,
    streak_ok_days integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT risk_persistence_score_check CHECK (((risk_score >= 0) AND (risk_score <= 100))),
    CONSTRAINT risk_persistence_tier_check CHECK ((risk_tier = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text])))
);

COMMENT ON TABLE public.risk_persistence IS 'Asinu risk persistence with decay (plugin extension)';

ALTER TABLE ONLY public.risk_persistence
    ADD CONSTRAINT risk_persistence_pkey PRIMARY KEY (id);

CREATE INDEX idx_risk_persistence_last_updated ON public.risk_persistence USING btree (user_id, last_updated_at);

CREATE INDEX idx_risk_persistence_user_id ON public.risk_persistence USING btree (user_id);

CREATE UNIQUE INDEX idx_risk_persistence_user_unique ON public.risk_persistence USING btree (user_id);

ALTER TABLE ONLY public.risk_persistence
    ADD CONSTRAINT risk_persistence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 7. asinu_brain_events
-- ============================================================================

CREATE TABLE public.asinu_brain_events (
    id bigint NOT NULL,
    session_id text NOT NULL,
    user_id integer NOT NULL,
    event_type character varying(20) NOT NULL,
    question_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.asinu_brain_events IS 'Asinu Brain question/answer events (plugin extension)';

CREATE SEQUENCE public.asinu_brain_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.asinu_brain_events_id_seq OWNED BY public.asinu_brain_events.id;

ALTER TABLE ONLY public.asinu_brain_events ALTER COLUMN id SET DEFAULT nextval('public.asinu_brain_events_id_seq'::regclass);

ALTER TABLE ONLY public.asinu_brain_events
    ADD CONSTRAINT asinu_brain_events_pkey PRIMARY KEY (id);

CREATE INDEX idx_asinu_brain_events_session_time ON public.asinu_brain_events USING btree (session_id, created_at DESC);

CREATE INDEX idx_asinu_brain_events_user_time ON public.asinu_brain_events USING btree (user_id, created_at DESC);

ALTER TABLE ONLY public.asinu_brain_events
    ADD CONSTRAINT asinu_brain_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.asinu_brain_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asinu_brain_events
    ADD CONSTRAINT asinu_brain_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 8. asinu_brain_outcomes
-- ============================================================================

CREATE TABLE public.asinu_brain_outcomes (
    id bigint NOT NULL,
    session_id text NOT NULL,
    user_id integer NOT NULL,
    risk_level character varying(30) NOT NULL,
    notify_caregiver boolean DEFAULT false NOT NULL,
    recommended_action text,
    outcome_text text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.asinu_brain_outcomes IS 'Asinu Brain outcomes and risk decisions (plugin extension)';

CREATE SEQUENCE public.asinu_brain_outcomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.asinu_brain_outcomes_id_seq OWNED BY public.asinu_brain_outcomes.id;

ALTER TABLE ONLY public.asinu_brain_outcomes ALTER COLUMN id SET DEFAULT nextval('public.asinu_brain_outcomes_id_seq'::regclass);

ALTER TABLE ONLY public.asinu_brain_outcomes
    ADD CONSTRAINT asinu_brain_outcomes_pkey PRIMARY KEY (id);

CREATE INDEX idx_asinu_brain_outcomes_user_time ON public.asinu_brain_outcomes USING btree (user_id, created_at DESC);

ALTER TABLE ONLY public.asinu_brain_outcomes
    ADD CONSTRAINT asinu_brain_outcomes_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.asinu_brain_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asinu_brain_outcomes
    ADD CONSTRAINT asinu_brain_outcomes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 9. asinu_brain_context_snapshots
-- ============================================================================

CREATE TABLE public.asinu_brain_context_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text NOT NULL,
    user_id integer NOT NULL,
    snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.asinu_brain_context_snapshots IS 'Context snapshot for brain sessions (plugin extension)';

ALTER TABLE ONLY public.asinu_brain_context_snapshots
    ADD CONSTRAINT asinu_brain_context_snapshots_pkey PRIMARY KEY (id);

CREATE INDEX idx_asinu_brain_context_session ON public.asinu_brain_context_snapshots USING btree (session_id, created_at DESC);

ALTER TABLE ONLY public.asinu_brain_context_snapshots
    ADD CONSTRAINT asinu_brain_context_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.asinu_brain_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asinu_brain_context_snapshots
    ADD CONSTRAINT asinu_brain_context_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 10. asinu_trackers
-- ============================================================================

CREATE TABLE public.asinu_trackers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    current_path text DEFAULT 'GREEN'::text NOT NULL,
    phase_in_day text,
    locked_session_id text,
    next_due_at timestamp with time zone,
    cooldown_until timestamp with time zone,
    dismissed_until timestamp with time zone,
    last_prompt_at timestamp with time zone,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT asinu_trackers_path_check CHECK ((current_path = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text, 'EMERGENCY'::text]))),
    CONSTRAINT asinu_trackers_phase_check CHECK (((phase_in_day IS NULL) OR (phase_in_day = ANY (ARRAY['MORNING'::text, 'NOON'::text, 'AFTERNOON'::text, 'NIGHT'::text])))),
    CONSTRAINT asinu_trackers_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'CLOSED'::text])))
);

COMMENT ON TABLE public.asinu_trackers IS 'Asinu risk pathway tracker (plugin extension)';

ALTER TABLE ONLY public.asinu_trackers
    ADD CONSTRAINT asinu_trackers_pkey PRIMARY KEY (id);

CREATE INDEX idx_asinu_trackers_user_id ON public.asinu_trackers USING btree (user_id);

CREATE INDEX idx_asinu_trackers_user_next_due ON public.asinu_trackers USING btree (user_id, next_due_at);

CREATE INDEX idx_asinu_trackers_user_path ON public.asinu_trackers USING btree (user_id, current_path);

CREATE INDEX idx_asinu_trackers_user_status ON public.asinu_trackers USING btree (user_id, status);

ALTER TABLE ONLY public.asinu_trackers
    ADD CONSTRAINT asinu_trackers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


-- ############################################################################
-- PART 2: DEAD FIELDS (ALTER TABLE ADD COLUMN to restore)
-- ############################################################################

-- 1. user_connections.blocked_at
ALTER TABLE public.user_connections ADD COLUMN blocked_at timestamp with time zone;

-- 2. chat_feedback.note_text
ALTER TABLE public.chat_feedback ADD COLUMN note_text text;

-- 3. medication_adherence.taken_at
ALTER TABLE public.medication_adherence ADD COLUMN taken_at timestamp with time zone;

-- 4. medication_adherence.notes
ALTER TABLE public.medication_adherence ADD COLUMN notes text;

-- 5. prompt_history.response_status
ALTER TABLE public.prompt_history ADD COLUMN response_status text DEFAULT 'pending'::text;

-- 6. prompt_history.response_data
ALTER TABLE public.prompt_history ADD COLUMN response_data jsonb;

-- 7. prompt_history.responded_at
ALTER TABLE public.prompt_history ADD COLUMN responded_at timestamp with time zone;

-- 8. user_health_scores.valid_until
ALTER TABLE public.user_health_scores ADD COLUMN valid_until timestamp with time zone;

-- 9. asinu_brain_sessions.started_at
ALTER TABLE public.asinu_brain_sessions ADD COLUMN started_at timestamp with time zone DEFAULT now();

-- 10. asinu_brain_sessions.ended_at
ALTER TABLE public.asinu_brain_sessions ADD COLUMN ended_at timestamp with time zone;

-- 11. asinu_brain_sessions.last_question_id
ALTER TABLE public.asinu_brain_sessions ADD COLUMN last_question_id text;

-- 12. asinu_brain_sessions.last_answered_at
ALTER TABLE public.asinu_brain_sessions ADD COLUMN last_answered_at timestamp with time zone;

-- 13. triage_scripts.expires_at
ALTER TABLE public.triage_scripts ADD COLUMN expires_at timestamp with time zone;

-- 14. rnd_cycle_logs.details
ALTER TABLE public.rnd_cycle_logs ADD COLUMN details jsonb DEFAULT '{}'::jsonb;
