import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildRollingSummary, deriveTopic } from "../src/gateway/context.js";
import { MeetingStore } from "../src/store/store.js";
import type { TranscriptEntry } from "../src/domain.js";

const dirs: string[] = [];

function newStore(): { store: MeetingStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "amp-store-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  return { store: new MeetingStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function seed(store: MeetingStore) {
  const meeting = store.createMeeting({
    title: "Retry policy sync",
    provider: "mock",
    agentDisplayName: "Cofounder",
    wakeNames: ["cofounder", "codex"],
  });
  const ada = store.addParticipant({
    meetingId: meeting.id,
    name: "Ada",
    kind: "human",
    role: "founder",
  });
  const agent = store.addParticipant({
    meetingId: meeting.id,
    name: "Cofounder",
    kind: "agent",
    role: "AI cofounder",
  });
  return { meeting, ada, agent };
}

describe("meeting persistence", () => {
  it("round-trips a meeting, its participants, transcript and chat", () => {
    const { store, path } = newStore();
    const { meeting, ada } = seed(store);
    const entry = store.appendTranscript({
      meetingId: meeting.id,
      participantId: ada.id,
      speakerName: "Ada",
      speakerKind: "human",
      text: "Cofounder, what do you think?",
      addressed: true,
    });
    store.appendChat({
      meetingId: meeting.id,
      participantId: ada.id,
      speakerName: "Ada",
      speakerKind: "human",
      text: "link in the doc",
      addressed: false,
    });
    store.setMeetingStatus(meeting.id, "live");
    store.close();

    // Reopening is what "the transcript survives a reload" actually means.
    const reopened = new MeetingStore(path);
    const restored = reopened.requireMeeting(meeting.id);
    expect(restored.title).toBe("Retry policy sync");
    expect(restored.status).toBe("live");
    expect(restored.wakeNames).toEqual(["cofounder", "codex"]);
    expect(restored.startedAt).not.toBeNull();
    expect(reopened.listParticipants(meeting.id).map((p) => p.name)).toEqual([
      "Ada",
      "Cofounder",
    ]);
    const transcript = reopened.listTranscript(meeting.id);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ id: entry.id, addressed: true });
    expect(reopened.listChat(meeting.id)).toHaveLength(1);
    reopened.close();
  });

  it("returns recent transcript oldest-first and bounded", () => {
    const { store } = newStore();
    const { meeting, ada } = seed(store);
    for (let index = 0; index < 20; index += 1) {
      store.appendTranscript({
        meetingId: meeting.id,
        participantId: ada.id,
        speakerName: "Ada",
        speakerKind: "human",
        text: `line ${index}`,
        addressed: false,
      });
    }
    const recent = store.recentTranscript(meeting.id, 5);
    expect(recent).toHaveLength(5);
    expect(recent.map((entry) => entry.text)).toEqual([
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
    ]);
  });

  it("finds the live meeting and the agent's own seat", () => {
    const { store } = newStore();
    const { meeting } = seed(store);
    expect(store.getActiveMeeting()).toBeNull();
    store.setMeetingStatus(meeting.id, "live");
    expect(store.getActiveMeeting()?.id).toBe(meeting.id);
    expect(store.getAgentParticipant(meeting.id)?.name).toBe("Cofounder");
  });

  it("records ACP sessions and can resume the latest", () => {
    const { store } = newStore();
    const { meeting } = seed(store);
    store.recordAcpSession({
      meetingId: meeting.id,
      agentId: "fake",
      acpSessionId: "fake-session-1",
      workspacePath: "/tmp/work",
    });
    store.recordAcpSession({
      meetingId: meeting.id,
      agentId: "fake",
      acpSessionId: "fake-session-2",
      workspacePath: "/tmp/work",
    });
    expect(store.latestAcpSession(meeting.id, "fake")?.acpSessionId).toBe(
      "fake-session-2",
    );
    expect(store.latestAcpSession(meeting.id, "codex")).toBeNull();
    store.closeAcpSessions(meeting.id);
    expect(store.latestAcpSession(meeting.id, "fake")?.status).toBe("closed");
  });

  it("stores agent definitions without secrets and keeps an audit trail", () => {
    const { store } = newStore();
    const { meeting } = seed(store);
    store.upsertAgentDefinition({
      id: "fake",
      label: "Fake",
      command: "node",
      args: ["bin.js"],
    });
    store.upsertAgentDefinition({
      id: "fake",
      label: "Fake ACP agent",
      command: "node",
      args: ["bin.js"],
    });
    const rows = store.db
      .prepare("SELECT id, label, args FROM agent_definitions")
      .all() as { id: string; label: string; args: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Fake ACP agent");

    store.recordAgentEvent(meeting.id, "turn_started", "triggered by Ada");
    store.recordAgentEvent(meeting.id, "turn_finished", "stop=end_turn");
    expect(
      store.listAgentEvents(meeting.id).map((event) => event.kind),
    ).toEqual(["turn_started", "turn_finished"]);
  });
});

describe("memory", () => {
  it("keeps provenance and supersedes without deleting", () => {
    const { store } = newStore();
    const { meeting, ada } = seed(store);
    const entry = store.appendTranscript({
      meetingId: meeting.id,
      participantId: ada.id,
      speakerName: "Ada",
      speakerKind: "human",
      text: "Let's cap retries at three.",
      addressed: false,
    });

    const memory = store.addMemory({
      meetingId: meeting.id,
      kind: "decision",
      content: "Cap retries at three.",
      sourceParticipantId: ada.id,
      sourceTranscriptEntryId: entry.id,
      sourceTimestamp: entry.createdAt,
    });
    expect(memory).toMatchObject({
      kind: "decision",
      status: "active",
      sourceParticipantId: ada.id,
      sourceTranscriptEntryId: entry.id,
      sourceTimestamp: entry.createdAt,
    });

    const superseded = store.supersedeMemory(meeting.id, memory.id);
    expect(superseded.status).toBe("superseded");
    expect(store.listMemories(meeting.id, { status: "active" })).toHaveLength(
      0,
    );
    expect(store.listMemories(meeting.id)).toHaveLength(1);
  });

  it("omits provenance fields entirely when there is none", () => {
    const { store } = newStore();
    const { meeting } = seed(store);
    const memory = store.addMemory({
      meetingId: meeting.id,
      kind: "note",
      content: "Nobody said where this came from.",
    });
    expect(memory.sourceTranscriptEntryId).toBeUndefined();
    expect(memory.sourceParticipantId).toBeUndefined();
  });

  it("filters by kind", () => {
    const { store } = newStore();
    const { meeting } = seed(store);
    store.addMemory({ meetingId: meeting.id, kind: "decision", content: "A" });
    store.addMemory({
      meetingId: meeting.id,
      kind: "action_item",
      content: "B",
    });
    expect(
      store
        .listMemories(meeting.id, { kind: "action_item" })
        .map((m) => m.content),
    ).toEqual(["B"]);
  });
});

describe("meeting context", () => {
  const entry = (text: string, index: number): TranscriptEntry => ({
    id: `utt_${index}`,
    meetingId: "mtg_1",
    participantId: "p_1",
    speakerName: index % 2 === 0 ? "Ada" : "Grace",
    speakerKind: "human",
    text,
    addressed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("derives the topic from repeated significant terms", () => {
    const entries = [
      "The webhook retries are failing again.",
      "Which retries, the billing ones?",
      "Yes, the retries on billing webhooks.",
    ].map(entry);
    expect(deriveTopic(entries)).toBe("retries");
  });

  it("returns no topic when nothing repeats", () => {
    expect(deriveTopic([entry("Morning everyone.", 0)])).toBeNull();
    expect(deriveTopic([])).toBeNull();
  });

  it("summarizes speakers, decisions and action items only", () => {
    const summary = buildRollingSummary(
      [entry("One", 0), entry("Two", 1)],
      [
        {
          id: "mem_1",
          meetingId: "mtg_1",
          kind: "decision",
          content: "Cap retries at three.",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "mem_2",
          meetingId: "mtg_1",
          kind: "action_item",
          content: "Grace writes the dead-letter path.",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "mem_3",
          meetingId: "mtg_1",
          kind: "note",
          content: "Superseded thought.",
          status: "superseded",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    expect(summary).toContain(
      "2 utterance(s) so far from 2 speaker(s): Ada, Grace.",
    );
    expect(summary).toContain("- Cap retries at three.");
    expect(summary).toContain("- Grace writes the dead-letter path.");
    expect(summary).not.toContain("Superseded thought.");
  });

  it("is empty with nothing to summarize", () => {
    expect(buildRollingSummary([], [])).toBe("");
  });
});
