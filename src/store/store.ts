/**
 * Repository over the SQLite schema.
 *
 * Rows in, domain objects out — the rest of the app never sees a snake_case
 * column or a 0/1 boolean. Every read is scoped by `meetingId` so a caller
 * cannot accidentally reach across meetings.
 */
import type {
  ChatMessage,
  Meeting,
  MeetingMemory,
  MemoryKind,
  MemoryStatus,
  Participant,
  ParticipantKind,
  TranscriptEntry,
} from "../domain.js";
import { newId } from "../ids.js";
import { openDatabase, type Database } from "./db.js";

type Row = Record<string, unknown>;

const str = (value: unknown): string => (value === null ? "" : String(value));
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const bool = (value: unknown): boolean => Number(value) === 1;

function toMeeting(row: Row): Meeting {
  return {
    id: str(row["id"]),
    title: str(row["title"]),
    provider: str(row["provider"]),
    status: str(row["status"]) as Meeting["status"],
    agentDisplayName: str(row["agent_display_name"]),
    wakeNames: JSON.parse(str(row["wake_names"])) as string[],
    agentId: nullable(row["agent_id"]),
    workspacePath: nullable(row["workspace_path"]),
    topic: nullable(row["topic"]),
    summary: nullable(row["summary"]),
    createdAt: str(row["created_at"]),
    startedAt: nullable(row["started_at"]),
    endedAt: nullable(row["ended_at"]),
  };
}

function toParticipant(row: Row): Participant {
  return {
    id: str(row["id"]),
    meetingId: str(row["meeting_id"]),
    name: str(row["name"]),
    kind: str(row["kind"]) as ParticipantKind,
    role: nullable(row["role"]),
    createdAt: str(row["created_at"]),
  };
}

function toTranscriptEntry(row: Row): TranscriptEntry {
  return {
    id: str(row["id"]),
    meetingId: str(row["meeting_id"]),
    participantId: str(row["participant_id"]),
    speakerName: str(row["speaker_name"]),
    speakerKind: str(row["speaker_kind"]) as ParticipantKind,
    text: str(row["text"]),
    addressed: bool(row["addressed"]),
    createdAt: str(row["created_at"]),
  };
}

function toChatMessage(row: Row): ChatMessage {
  return toTranscriptEntry(row) as ChatMessage;
}

function toMemory(row: Row): MeetingMemory {
  const sourceParticipantId = nullable(row["source_participant_id"]);
  const sourceEntryId = nullable(row["source_transcript_entry_id"]);
  const sourceTimestamp = nullable(row["source_timestamp"]);
  return {
    id: str(row["id"]),
    meetingId: str(row["meeting_id"]),
    kind: str(row["kind"]) as MemoryKind,
    content: str(row["content"]),
    ...(sourceParticipantId === null ? {} : { sourceParticipantId }),
    ...(sourceEntryId === null
      ? {}
      : { sourceTranscriptEntryId: sourceEntryId }),
    ...(sourceTimestamp === null ? {} : { sourceTimestamp }),
    status: str(row["status"]) as MemoryStatus,
    createdAt: str(row["created_at"]),
  };
}

export interface AgentEvent {
  id: string;
  meetingId: string;
  kind: string;
  detail: string;
  createdAt: string;
}

export interface AcpSessionRecord {
  id: string;
  meetingId: string;
  agentId: string;
  acpSessionId: string;
  workspacePath: string;
  status: "active" | "closed";
  createdAt: string;
  closedAt: string | null;
}

export class MeetingStore {
  readonly db: Database;
  #closed = false;

  constructor(pathOrDb: string | Database) {
    this.db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  }

  /** Idempotent: shutdown paths overlap (an explicit stop, then a test's
   *  cleanup, then a signal handler) and closing twice throws. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  // ---- meetings ---------------------------------------------------------

  createMeeting(input: {
    title: string;
    provider: string;
    agentDisplayName: string;
    wakeNames: string[];
    agentId?: string | null;
    workspacePath?: string | null;
  }): Meeting {
    const now = new Date().toISOString();
    const id = newId("mtg");
    this.db
      .prepare(
        `INSERT INTO meetings
           (id, title, provider, status, agent_display_name, wake_names,
            agent_id, workspace_path, topic, summary, created_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.title,
        input.provider,
        input.agentDisplayName,
        JSON.stringify(input.wakeNames),
        input.agentId ?? null,
        input.workspacePath ?? null,
        now,
      );
    return this.requireMeeting(id);
  }

  getMeeting(id: string): Meeting | null {
    const row = this.db
      .prepare("SELECT * FROM meetings WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? null : toMeeting(row);
  }

  requireMeeting(id: string): Meeting {
    const meeting = this.getMeeting(id);
    if (meeting === null) throw new Error(`unknown meeting ${id}`);
    return meeting;
  }

  listMeetings(): Meeting[] {
    const rows = this.db
      .prepare("SELECT * FROM meetings ORDER BY created_at DESC")
      .all() as Row[];
    return rows.map(toMeeting);
  }

  /** The most recent meeting still live, which is what the MCP tools mean by
   *  "the active meeting" when the agent does not name one. */
  getActiveMeeting(): Meeting | null {
    const row = this.db
      .prepare(
        "SELECT * FROM meetings WHERE status = 'live' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as Row | undefined;
    return row === undefined ? null : toMeeting(row);
  }

  /**
   * Remember what the provider put in the call.
   *
   * Provider runtimes are in memory; meetings are not. Without this a restart
   * loses the only handle on a live bot, and nothing can remove it.
   */
  setProviderBotId(id: string, botId: string | null): void {
    this.db
      .prepare("UPDATE meetings SET provider_bot_id = ? WHERE id = ?")
      .run(botId, id);
  }

  /** The provider's handle on this meeting's bot, if one was recorded. */
  providerBotId(id: string): string | null {
    const row = this.db
      .prepare("SELECT provider_bot_id FROM meetings WHERE id = ?")
      .get(id) as { provider_bot_id?: string | null } | undefined;
    const value = row?.provider_bot_id;
    return typeof value === "string" && value !== "" ? value : null;
  }

  setMeetingStatus(id: string, status: Meeting["status"]): Meeting {
    const now = new Date().toISOString();
    if (status === "live") {
      this.db
        .prepare(
          "UPDATE meetings SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
        )
        .run(status, now, id);
    } else if (status === "ended") {
      this.db
        .prepare("UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?")
        .run(status, now, id);
    } else {
      this.db
        .prepare("UPDATE meetings SET status = ? WHERE id = ?")
        .run(status, id);
    }
    return this.requireMeeting(id);
  }

  updateMeetingContext(
    id: string,
    patch: { topic?: string | null; summary?: string | null },
  ): Meeting {
    if (patch.topic !== undefined) {
      this.db
        .prepare("UPDATE meetings SET topic = ? WHERE id = ?")
        .run(patch.topic, id);
    }
    if (patch.summary !== undefined) {
      this.db
        .prepare("UPDATE meetings SET summary = ? WHERE id = ?")
        .run(patch.summary, id);
    }
    return this.requireMeeting(id);
  }

  setMeetingAgent(
    id: string,
    agentId: string | null,
    workspacePath: string | null,
  ): Meeting {
    this.db
      .prepare(
        "UPDATE meetings SET agent_id = ?, workspace_path = ? WHERE id = ?",
      )
      .run(agentId, workspacePath, id);
    return this.requireMeeting(id);
  }

  // ---- participants -----------------------------------------------------

  addParticipant(input: {
    meetingId: string;
    name: string;
    kind: ParticipantKind;
    role?: string | null;
  }): Participant {
    const id = newId(input.kind === "agent" ? "pagt" : "phum");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO participants (id, meeting_id, name, kind, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.name,
        input.kind,
        input.role ?? null,
        now,
      );
    return {
      id,
      meetingId: input.meetingId,
      name: input.name,
      kind: input.kind,
      role: input.role ?? null,
      createdAt: now,
    };
  }

  listParticipants(meetingId: string): Participant[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM participants WHERE meeting_id = ? ORDER BY rowid ASC",
      )
      .all(meetingId) as Row[];
    return rows.map(toParticipant);
  }

  getParticipant(meetingId: string, participantId: string): Participant | null {
    const row = this.db
      .prepare("SELECT * FROM participants WHERE meeting_id = ? AND id = ?")
      .get(meetingId, participantId) as Row | undefined;
    return row === undefined ? null : toParticipant(row);
  }

  /** The agent's own seat in the room, created when the meeting was created. */
  getAgentParticipant(meetingId: string): Participant | null {
    const row = this.db
      .prepare(
        "SELECT * FROM participants WHERE meeting_id = ? AND kind = 'agent' ORDER BY rowid ASC LIMIT 1",
      )
      .get(meetingId) as Row | undefined;
    return row === undefined ? null : toParticipant(row);
  }

  // ---- transcript & chat ------------------------------------------------

  appendTranscript(input: {
    meetingId: string;
    participantId: string;
    speakerName: string;
    speakerKind: ParticipantKind;
    text: string;
    addressed: boolean;
    createdAt?: string;
  }): TranscriptEntry {
    const id = newId("utt");
    const now = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO transcript_entries
           (id, meeting_id, participant_id, speaker_name, speaker_kind, text, addressed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.participantId,
        input.speakerName,
        input.speakerKind,
        input.text,
        input.addressed ? 1 : 0,
        now,
      );
    return { id, ...input, addressed: input.addressed, createdAt: now };
  }

  listTranscript(meetingId: string, limit = 200): TranscriptEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM transcript_entries WHERE meeting_id = ? ORDER BY rowid ASC LIMIT ?",
      )
      .all(meetingId, limit) as Row[];
    return rows.map(toTranscriptEntry);
  }

  /** The last `limit` entries, oldest first — the shape a prompt wants. */
  recentTranscript(meetingId: string, limit = 12): TranscriptEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM transcript_entries WHERE meeting_id = ? ORDER BY rowid DESC LIMIT ?",
      )
      .all(meetingId, limit) as Row[];
    return rows.map(toTranscriptEntry).reverse();
  }

  appendChat(input: {
    meetingId: string;
    participantId: string;
    speakerName: string;
    speakerKind: ParticipantKind;
    text: string;
    addressed: boolean;
    createdAt?: string;
  }): ChatMessage {
    const id = newId("cht");
    const now = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO chat_messages
           (id, meeting_id, participant_id, speaker_name, speaker_kind, text, addressed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.participantId,
        input.speakerName,
        input.speakerKind,
        input.text,
        input.addressed ? 1 : 0,
        now,
      );
    return { id, ...input, createdAt: now };
  }

  listChat(meetingId: string, limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY rowid ASC LIMIT ?",
      )
      .all(meetingId, limit) as Row[];
    return rows.map(toChatMessage);
  }

  // ---- agents, sessions, audit -----------------------------------------

  upsertAgentDefinition(input: {
    id: string;
    label: string;
    command: string;
    args: readonly string[];
    description?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_definitions (id, label, command, args, description, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           command = excluded.command,
           args = excluded.args,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.label,
        input.command,
        JSON.stringify([...input.args]),
        input.description ?? null,
        new Date().toISOString(),
      );
  }

  recordAcpSession(input: {
    meetingId: string;
    agentId: string;
    acpSessionId: string;
    workspacePath: string;
  }): AcpSessionRecord {
    const id = newId("acps");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO acp_sessions
           (id, meeting_id, agent_id, acp_session_id, workspace_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.agentId,
        input.acpSessionId,
        input.workspacePath,
        now,
      );
    return { id, ...input, status: "active", createdAt: now, closedAt: null };
  }

  closeAcpSessions(meetingId: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET status = 'closed', closed_at = ? WHERE meeting_id = ? AND status = 'active'",
      )
      .run(new Date().toISOString(), meetingId);
  }

  /** The session to resume on reconnect, if the adapter supports `session/load`. */
  latestAcpSession(
    meetingId: string,
    agentId: string,
  ): AcpSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM acp_sessions
         WHERE meeting_id = ? AND agent_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(meetingId, agentId) as Row | undefined;
    if (row === undefined) return null;
    return {
      id: str(row["id"]),
      meetingId: str(row["meeting_id"]),
      agentId: str(row["agent_id"]),
      acpSessionId: str(row["acp_session_id"]),
      workspacePath: str(row["workspace_path"]),
      status: str(row["status"]) as "active" | "closed",
      createdAt: str(row["created_at"]),
      closedAt: nullable(row["closed_at"]),
    };
  }

  recordAgentEvent(
    meetingId: string,
    kind: string,
    detail: string,
  ): AgentEvent {
    const id = newId("aev");
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO agent_events (id, meeting_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, meetingId, kind, detail, now);
    return { id, meetingId, kind, detail, createdAt: now };
  }

  listAgentEvents(meetingId: string, limit = 200): AgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_events WHERE meeting_id = ? ORDER BY rowid DESC LIMIT ?",
      )
      .all(meetingId, limit) as Row[];
    return rows
      .map((row) => ({
        id: str(row["id"]),
        meetingId: str(row["meeting_id"]),
        kind: str(row["kind"]),
        detail: str(row["detail"]),
        createdAt: str(row["created_at"]),
      }))
      .reverse();
  }

  // ---- memory -----------------------------------------------------------

  addMemory(input: {
    meetingId: string;
    kind: MemoryKind;
    content: string;
    sourceParticipantId?: string | null;
    sourceTranscriptEntryId?: string | null;
    sourceTimestamp?: string | null;
  }): MeetingMemory {
    const id = newId("mem");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memories
           (id, meeting_id, kind, content, source_participant_id,
            source_transcript_entry_id, source_timestamp, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.kind,
        input.content,
        input.sourceParticipantId ?? null,
        input.sourceTranscriptEntryId ?? null,
        input.sourceTimestamp ?? null,
        now,
      );
    return this.requireMemory(input.meetingId, id);
  }

  requireMemory(meetingId: string, id: string): MeetingMemory {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE meeting_id = ? AND id = ?")
      .get(meetingId, id) as Row | undefined;
    if (row === undefined) throw new Error(`unknown memory ${id}`);
    return toMemory(row);
  }

  listMemories(
    meetingId: string,
    filter: { kind?: MemoryKind; status?: MemoryStatus } = {},
  ): MeetingMemory[] {
    const clauses = ["meeting_id = ?"];
    const params: unknown[] = [meetingId];
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY rowid ASC`,
      )
      .all(...(params as string[])) as Row[];
    return rows.map(toMemory);
  }

  supersedeMemory(meetingId: string, id: string): MeetingMemory {
    this.db
      .prepare(
        "UPDATE memories SET status = 'superseded' WHERE meeting_id = ? AND id = ?",
      )
      .run(meetingId, id);
    return this.requireMemory(meetingId, id);
  }
}
