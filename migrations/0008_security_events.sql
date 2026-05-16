CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_events_key_type_created ON security_events(event_key, event_type, created_at);
