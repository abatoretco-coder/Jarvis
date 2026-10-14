CREATE TABLE IF NOT EXISTS conversation_threads (
  thread_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  summary_version INTEGER NOT NULL DEFAULT 0,
  summary_candidate TEXT,
  summary_candidate_upto_seq INTEGER,
  summary_status TEXT NOT NULL DEFAULT 'idle' CHECK (summary_status IN ('idle','running','ready','failed')),
  summary_last_error TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  thread_id TEXT NOT NULL REFERENCES conversation_threads(thread_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  spoken_content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, seq)
);

CREATE TABLE IF NOT EXISTS mutation_idempotency_results (
  identity TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','completed')),
  status_code INTEGER,
  content_type TEXT,
  payload BYTEA,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  PRIMARY KEY(identity,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_expiry
  ON mutation_idempotency_results(expires_at_ms);

CREATE TABLE IF NOT EXISTS voice_artifacts (
  voice_turn_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('input','output')),
  thread_id TEXT REFERENCES conversation_threads(thread_id) ON DELETE CASCADE,
  owner_user_id TEXT,
  owner_service_id TEXT,
  transcript TEXT,
  engine_id TEXT,
  source_content_type TEXT NOT NULL,
  source_byte_length INTEGER NOT NULL CHECK (source_byte_length > 0),
  mp3_audio BYTEA NOT NULL,
  mp3_byte_length INTEGER NOT NULL CHECK (mp3_byte_length > 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (voice_turn_id, direction),
  CHECK (owner_user_id IS NULL OR owner_service_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_voice_artifacts_thread_created
  ON voice_artifacts(thread_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_voice_artifacts_created
  ON voice_artifacts(created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq
  ON conversation_messages(thread_id, seq DESC);

CREATE TABLE IF NOT EXISTS home_telemetry_entities (
  home_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  role TEXT NOT NULL,
  unit_of_measurement TEXT,
  device_class TEXT,
  state_class TEXT,
  first_seen_at_ms BIGINT NOT NULL,
  last_seen_at_ms BIGINT NOT NULL,
  PRIMARY KEY (home_id, entity_id),
  CHECK (first_seen_at_ms >= 0),
  CHECK (last_seen_at_ms >= first_seen_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_home_telemetry_entities_device
  ON home_telemetry_entities(home_id, device_id);
CREATE INDEX IF NOT EXISTS idx_home_telemetry_entities_room
  ON home_telemetry_entities(home_id, room_id);

CREATE TABLE IF NOT EXISTS home_telemetry_samples (
  home_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  state TEXT NOT NULL,
  numeric_value DOUBLE PRECISION,
  attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('home_assistant_history','home_assistant_snapshot')),
  captured_at_ms BIGINT NOT NULL,
  PRIMARY KEY (home_id, entity_id, observed_at_ms),
  FOREIGN KEY (home_id, entity_id)
    REFERENCES home_telemetry_entities(home_id, entity_id)
    ON DELETE CASCADE,
  CHECK (observed_at_ms >= 0),
  CHECK (captured_at_ms >= observed_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_home_telemetry_samples_home_time
  ON home_telemetry_samples(home_id, observed_at_ms DESC);

CREATE TABLE IF NOT EXISTS home_telemetry_sync_state (
  home_id TEXT PRIMARY KEY,
  history_cursor_at_ms BIGINT,
  last_attempt_at_ms BIGINT,
  last_success_at_ms BIGINT,
  last_error_code TEXT,
  CHECK (history_cursor_at_ms IS NULL OR history_cursor_at_ms >= 0),
  CHECK (last_attempt_at_ms IS NULL OR last_attempt_at_ms >= 0),
  CHECK (last_success_at_ms IS NULL OR last_success_at_ms >= 0)
);
