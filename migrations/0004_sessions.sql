-- Apply before deploying D1 sessions. Stateless tokens require sign-in again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_email ON users (org_id, email);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (org_id, user_email) REFERENCES users (org_id, email) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (org_id, user_email);
