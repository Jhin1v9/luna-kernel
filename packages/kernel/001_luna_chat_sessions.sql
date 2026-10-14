CREATE TABLE IF NOT EXISTS luna_chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT,
  mode TEXT,
  persona TEXT,
  provider TEXT,
  messages JSONB DEFAULT '[]'::jsonb,
  event_ledger JSONB DEFAULT '[]'::jsonb,
  last_acked_event_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
