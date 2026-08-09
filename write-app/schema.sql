-- The Drawer — schema for write.hminv.com
-- Applied with: wrangler d1 execute drawer --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS snippets (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snippets_created_at ON snippets (created_at DESC);

-- Tags known to the app, whether or not any snippet currently uses them.
CREATE TABLE IF NOT EXISTS tags (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snippet_tags (
  snippet_id  TEXT NOT NULL REFERENCES snippets (id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (snippet_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_snippet_tags_tag ON snippet_tags (tag);

-- Distinct timestamps so the drawers keep this order, not alphabetical order.
INSERT OR IGNORE INTO tags (name, created_at) VALUES
  ('Family',         '1970-01-01T00:00:00.001Z'),
  ('Private Equity', '1970-01-01T00:00:00.002Z'),
  ('Life',           '1970-01-01T00:00:00.003Z');
