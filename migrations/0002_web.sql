-- One-time website codes and persistent browser sessions. No change to existing bookings.
CREATE TABLE web_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_codes_user ON web_codes(user_id);
CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_user ON web_sessions(user_id);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
CREATE TABLE web_login_attempts (
  source_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);
