/**
 * Persistence for the prototype.
 *
 * SQLite through Node's built-in `node:sqlite` — no native compile step, no
 * database service to run, and nothing added to the repository's dependency
 * surface. The repo's own convention is Postgres + Drizzle (`apps/chat`,
 * `apps/hub`); this app is a local developer prototype that must run from a
 * clone with `npm install && npm run dev`, so it takes the v0 escape hatch
 * the brief allows. The schema is written plainly enough to port.
 *
 * Note: `node:sqlite` is flagged experimental on Node 22 and prints one
 * warning on first import. That is expected.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  provider           TEXT NOT NULL,
  status             TEXT NOT NULL,
  agent_display_name TEXT NOT NULL,
  wake_names         TEXT NOT NULL,
  agent_id           TEXT,
  workspace_path     TEXT,
  topic              TEXT,
  summary            TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  ended_at           TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id         TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  role       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS participants_meeting ON participants(meeting_id);

-- Reads order by rowid, not by id or created_at: several rows land inside one
-- millisecond routinely, and rowid is the only column that records the order
-- they were actually written in. Indexes are on meeting_id alone — an index
-- cannot name rowid, and within one meeting_id key the index already yields
-- rows in rowid order.
CREATE TABLE IF NOT EXISTS transcript_entries (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  speaker_name   TEXT NOT NULL,
  speaker_kind   TEXT NOT NULL,
  text           TEXT NOT NULL,
  addressed      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_meeting ON transcript_entries(meeting_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  speaker_name   TEXT NOT NULL,
  speaker_kind   TEXT NOT NULL,
  text           TEXT NOT NULL,
  addressed      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_meeting ON chat_messages(meeting_id);

-- Agent definitions as configured, never their credentials: the command and
-- argument vector only, so the UI can show what was launched after a reload.
CREATE TABLE IF NOT EXISTS agent_definitions (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  command     TEXT NOT NULL,
  args        TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acp_sessions (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS acp_sessions_meeting ON acp_sessions(meeting_id);

-- Sanitized audit of what the agent did. Never raw process output.
CREATE TABLE IF NOT EXISTS agent_events (
  id         TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_events_meeting ON agent_events(meeting_id);

CREATE TABLE IF NOT EXISTS memories (
  id                        TEXT PRIMARY KEY,
  meeting_id                TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind                      TEXT NOT NULL,
  content                   TEXT NOT NULL,
  source_participant_id     TEXT,
  source_transcript_entry_id TEXT,
  source_timestamp          TEXT,
  status                    TEXT NOT NULL,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_meeting ON memories(meeting_id);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export type Database = DatabaseSync;
