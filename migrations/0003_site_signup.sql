-- Website registration requires both the employee code and proof of Telegram ownership.
CREATE TABLE web_signups (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  department TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_signups_user ON web_signups(user_id);
CREATE TABLE web_code_requests (
  source_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);
