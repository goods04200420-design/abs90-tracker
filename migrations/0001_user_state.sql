CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_state_email ON user_state(email);
