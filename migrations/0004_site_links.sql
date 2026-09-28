-- Short-lived, single-use links delivered to the user's Telegram chat.
CREATE TABLE web_links (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_links_user ON web_links(user_id);
