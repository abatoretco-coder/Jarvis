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

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq
  ON conversation_messages(thread_id, seq DESC);
