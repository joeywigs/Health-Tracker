-- Schema for the "soccer" D1 database (id 252f3743-20d9-41e9-b56f-fd332d7c0f7c),
-- exported from the live database via sqlite_master on 2026-08-28.
-- The live DB also contains two empty leftover scratch tables
-- (ui_assets, ui_assets_original) and D1's internal _cf_KV table,
-- which are intentionally not part of this schema.

CREATE TABLE teams (
  id               TEXT PRIMARY KEY,      -- 'grey' | 'sloane'
  label            TEXT NOT NULL,         -- "Grey"
  club_name        TEXT,                  -- "Riverside FC U10"
  half_length_min  INTEGER NOT NULL DEFAULT 25,
  color            TEXT,                  -- accent hex for the UI
  updated_at       INTEGER NOT NULL
);

CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  number      INTEGER,
  name        TEXT NOT NULL,
  position    TEXT,
  active      INTEGER NOT NULL DEFAULT 1,  -- 0 = left the team / archived
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE games (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES teams(id),
  opponent         TEXT,
  location         TEXT,
  home_away        TEXT,                  -- 'home' | 'away' | 'neutral'
  kind             TEXT,                  -- 'league' | 'tournament' | 'friendly' | 'scrimmage'
  half_length_min  INTEGER,
  kickoff_at       INTEGER,               -- epoch ms
  local_date       TEXT,                  -- YYYY-MM-DD in the phone's timezone;
                                          -- kickoff_at alone would export an
                                          -- evening game as the following day
  status           TEXT NOT NULL,         -- 'setup' | 'live' | 'final'
  period           INTEGER NOT NULL DEFAULT 1,
  h1_ms            INTEGER,               -- length of the first half, once split
  h2_ms            INTEGER,
  us_score         INTEGER NOT NULL DEFAULT 0,
  them_score       INTEGER NOT NULL DEFAULT 0,
  starters         TEXT,                  -- json array of player ids
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE events (
  id             TEXT PRIMARY KEY,        -- client-generated uuid
  game_id        TEXT NOT NULL REFERENCES games(id),
  side           TEXT NOT NULL,           -- 'us' | 'them'
  type           TEXT NOT NULL,           -- see EVENT_TYPES in public/app.js
  player_id      TEXT,                    -- our roster (side = 'us')
  player_number  INTEGER,                 -- free-entry jersey number (side = 'them')
  assist_id      TEXT,                    -- our roster, goals only
  sub_out_id     TEXT,
  sub_in_id      TEXT,
  period         INTEGER NOT NULL,        -- 1 | 2
  clock_ms       INTEGER NOT NULL,        -- game clock within that period
  wall_at        INTEGER NOT NULL,        -- epoch ms, for ordering ties
  note           TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  group_id       TEXT,
  assist_number  INTEGER
);

CREATE INDEX idx_events_game  ON events(game_id, period, clock_ms);
CREATE INDEX idx_games_team   ON games(team_id, kickoff_at DESC);
CREATE INDEX idx_players_team ON players(team_id, active);
