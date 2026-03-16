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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq
  ON conversation_messages(thread_id, seq DESC);
