-- Browser admin sessions and an audit record for bookings made for colleagues.
CREATE TABLE web_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_admin_sessions_user ON web_admin_sessions(user_id);
CREATE TABLE web_admin_attempts (
  source_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);
ALTER TABLE bookings ADD COLUMN created_by INTEGER REFERENCES users(id);
