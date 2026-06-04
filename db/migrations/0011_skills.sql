CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  focus_prompt TEXT NOT NULL,
  prefer_tier TEXT NOT NULL DEFAULT 'sonnet',
  default_effort TEXT NOT NULL DEFAULT 'medium',
  default_count INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  built_in INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_active ON skills (archived_at, name);
