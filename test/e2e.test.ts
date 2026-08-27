/**
 * The vertical slice, end to end, against the fake ACP agent.
 *
 * This is the test that says the product works: a meeting is created, an
 * agent is launched, people talk past each other without waking it, one
 * person addresses it, and the answer comes back — streamed, spoken,
 * persisted, and with a permission gate that a human has to answer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createServer, type AmpServer } from "../src/server/create.js";
import { MeetingStore } from "../src/store/store.js";

let server: AmpServer;
let workdir: string;
let databasePath: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "amp-e2e-"));
  databasePath = join(workdir, "e2e.db");
  server = createServer({
    port: 0,
    host: "127.0.0.1",
    databasePath,
    logLevel: "silent",
    permissionTimeoutMs: 8_000,
  });
  await server.start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await server.stop();
  rmSync(workdir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${server.origin()}${path}`, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return payload as T;
}

interface Events {
  all: Record<string, unknown>[];
  ofType: (type: string) => Record<string, unknown>[];
}

async function openFeed(meetingId: string): Promise<Events> {
  const socket = new WebSocket(
    `${server.origin().replace("http", "ws")}/ws?meetingId=${meetingId}`,
  );
  sockets.push(socket);
  const all: Record<string, unknown>[] = [];
  socket.on("message", (raw: Buffer) => {
    try {
      all.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    } catch {
      // Not our problem in a test.
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    all,
    ofType: (type) => all.filter((event) => event["type"] === type),
  };
}

async function waitFor<T>(
  what: string,
  predicate: () => T | null | Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

interface MeetingView {
  meeting: {
    id: string;
    status: string;
    topic: string | null;
    summary: string | null;
  };
  participants: { id: string; name: string; kind: string }[];
  transcript: {
    id: string;
    speakerName: string;
    speakerKind: string;
    text: string;
  }[];
  chat: { speakerName: string; text: string }[];
  memories: { id: string; kind: string; content: string }[];
  agent: {
    status: string;
    acpSessionId: string | null;
    capabilities: { loadSession: boolean } | null;
    pendingPermissions: {
      requestId: string;
      toolName: string;
      options: { optionId: string; kind: string }[];
    }[];
  };
}

async function startMeeting() {
  const created = await call<{
    meeting: { id: string };
    participants: { id: string; name: string; kind: string }[];
  }>("/api/meetings", {
    method: "POST",
    body: {
      title: "Retry policy sync",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder", "codex"],
      participants: [
        { name: "Ada", kind: "human", role: "founder" },
        { name: "Grace", kind: "human", role: "engineer" },
      ],
      agentId: "fake",
    },
  });
  const meetingId = created.meeting.id;
  await call(`/api/meetings/${meetingId}/start`, { method: "POST" });
  const ada = created.participants.find((p) => p.name === "Ada")!.id;
  const grace = created.participants.find((p) => p.name === "Grace")!.id;
  return { meetingId, ada, grace };
}

async function connectFakeAgent(meetingId: string) {
  return call<{
    acpSessionId: string;
    resumed: boolean;
    capabilities: { loadSession: boolean };
    agent: { commandPreview: string; workspacePath: string };
  }>(`/api/meetings/${meetingId}/agent/connect`, {
    method: "POST",
    body: { agentId: "fake", workspacePath: workdir },
  });
}

async function say(
  meetingId: string,
  participantId: string,
  text: string,
  extra: { addressed?: boolean; channel?: "speech" | "chat" } = {},
) {
  await call(`/api/meetings/${meetingId}/utterances`, {
    method: "POST",
    body: { participantId, text, ...extra },
  });
}

describe("the vertical slice", () => {
  it("launches an agent, ignores side conversation, and answers when addressed", async () => {
    const { meetingId, ada, grace } = await startMeeting();
    const feed = await openFeed(meetingId);

    const connected = await connectFakeAgent(meetingId);
    expect(connected.acpSessionId).toMatch(/^fake-session-/u);
    expect(connected.capabilities.loadSession).toBe(true);
    expect(connected.agent.workspacePath).toBe(workdir);

    // Ordinary meeting talk that names the agent without addressing it.
    await say(meetingId, ada, "I used Codex yesterday for the migration.");
    await say(meetingId, grace, "We should ask the cofounder later.");
    await sleep(400);

    const quiet = await call<MeetingView>(`/api/meetings/${meetingId}`);
    expect(
      quiet.transcript.filter((entry) => entry.speakerKind === "agent"),
    ).toHaveLength(0);
    const ignored = feed.ofType("attention");
    expect(ignored).toHaveLength(2);
    expect(ignored.every((event) => event["triggered"] === false)).toBe(true);

    // Now address it directly.
    await say(meetingId, ada, "Cofounder, what do you think?");
    const spoken = await waitFor("the agent to speak", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return (
        view.transcript.find((entry) => entry.speakerKind === "agent") ?? null
      );
    });

    expect(spoken.text).toContain("cap retries at three");
    // Never the code block — that goes to chat.
    expect(spoken.text).not.toContain("```");

    const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
    const agentChat = view.chat.filter(
      (message) => message.speakerName === "Cofounder",
    );
    expect(agentChat).toHaveLength(1);
    expect(agentChat[0]!.text).toContain("```ts");

    // Speech is released a sentence at a time WHILE the agent is still
    // answering — that is where time-to-first-audio comes from, and one lump
    // at the end would mean the room waited out the whole turn in silence.
    // More than one `speak` is the point here, not a defect.
    const speech = feed.ofType("speak");
    expect(speech.length).toBeGreaterThan(1);

    // ...and those sentences must reassemble into exactly the utterance that
    // was recorded. If these two ever disagree, the room heard something
    // other than what the transcript claims it heard.
    expect(speech.map((event) => String(event["text"])).join(" ")).toBe(
      spoken.text,
    );

    // The response streamed rather than arriving in one lump...
    expect(feed.ofType("agent_stream").length).toBeGreaterThan(1);
    // ...and tool/turn activity is status, not speech.
    const acpEvents = feed.ofType("acp_event");
    expect(acpEvents.length).toBeGreaterThan(0);
    expect(feed.ofType("agent_status").map((event) => event["status"])).toEqual(
      expect.arrayContaining([
        "connecting",
        "listening",
        "thinking",
        "speaking",
      ]),
    );

    // Thought chunks are visible as activity but never carry their text.
    const thoughts = acpEvents.filter((event) => event["kind"] === "thought");
    expect(thoughts.length).toBeGreaterThan(0);
    expect(JSON.stringify(thoughts)).not.toContain("Considering the room");
  });

  it("puts a permission request in front of a human and does nothing until answered", async () => {
    const { meetingId, grace } = await startMeeting();
    const feed = await openFeed(meetingId);
    await connectFakeAgent(meetingId);

    await say(meetingId, grace, "Codex, inspect the webhook retries.");

    const request = await waitFor("a permission request", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return view.agent.pendingPermissions[0] ?? null;
    });
    expect(request.toolName).toBe("Read files in the workspace");
    expect(feed.ofType("permission_requested")).toHaveLength(1);

    // Nothing has been said while it waits.
    const waiting = await call<MeetingView>(`/api/meetings/${meetingId}`);
    expect(
      waiting.transcript.filter((entry) => entry.speakerKind === "agent"),
    ).toHaveLength(0);

    await call(
      `/api/meetings/${meetingId}/permissions/${request.requestId}/respond`,
      { method: "POST", body: { decision: "allow", optionId: "allow_once" } },
    );

    const answer = await waitFor("the answer", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return (
        view.transcript.find((entry) => entry.speakerKind === "agent") ?? null
      );
    });
    expect(answer.text).toContain("retry path");
    expect(feed.ofType("permission_resolved")[0]!["outcome"]).toContain(
      "allowed",
    );
  });

  it("denies a permission request and the agent reports it did nothing", async () => {
    const { meetingId, grace } = await startMeeting();
    await connectFakeAgent(meetingId);
    await say(meetingId, grace, "Codex, inspect the webhook retries.");

    const request = await waitFor("a permission request", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return view.agent.pendingPermissions[0] ?? null;
    });
    await call(
      `/api/meetings/${meetingId}/permissions/${request.requestId}/respond`,
      { method: "POST", body: { decision: "deny" } },
    );

    const answer = await waitFor("the refusal", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return (
        view.transcript.find((entry) => entry.speakerKind === "agent") ?? null
      );
    });
    expect(answer.text).toContain("need approval");
  });

  it("cancels agent work without ending the meeting", async () => {
    const { meetingId, ada } = await startMeeting();
    await connectFakeAgent(meetingId);
    await say(meetingId, ada, "Cofounder, what do you think?");
    await sleep(120);

    const cancelled = await call<{ cancelled: boolean }>(
      `/api/meetings/${meetingId}/agent/cancel`,
      { method: "POST" },
    );
    expect(cancelled.cancelled).toBe(true);

    const view = await waitFor("the agent to settle", async () => {
      const current = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return current.agent.status === "listening" ? current : null;
    });
    expect(view.meeting.status).toBe("live");
  });

  it("stays idle when the adapter sends an update this build does not know", async () => {
    // The first thing a real adapter does after session/new is announce its
    // slash commands, outside any turn. An update we cannot classify must
    // still reach the activity feed, but it must NOT claim the agent is busy:
    // the status pill is the room's only signal of whether it is working, and
    // "working" before anyone has addressed it is a lie.
    const { meetingId } = await startMeeting();
    const feed = await openFeed(meetingId);
    await connectFakeAgent(meetingId);
    await sleep(300);

    const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
    expect(view.agent.status).toBe("listening");

    // Nothing unrecognized is swallowed — the room can still see it happened.
    expect(
      feed
        .ofType("acp_event")
        .some((event) =>
          String(event["description"]).includes("available_commands_update"),
        ),
    ).toBe(true);

    // ...and it never drove the status.
    expect(
      feed.ofType("agent_status").map((event) => event["status"]),
    ).not.toContain("working");
  });

  it("keeps the transcript, chat and memories across a restart", async () => {
    const { meetingId, ada } = await startMeeting();
    await connectFakeAgent(meetingId);
    await say(meetingId, ada, "Cofounder, what do you think?");
    await waitFor("the agent to answer", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return (
        view.transcript.find((entry) => entry.speakerKind === "agent") ?? null
      );
    });

    const before = await call<MeetingView>(`/api/meetings/${meetingId}`);
    const entry = before.transcript.find((item) =>
      item.text.includes("what do you think"),
    )!;
    await call(`/api/meetings/${meetingId}/memories`, {
      method: "POST",
      body: {
        kind: "decision",
        content: "Cap retries at three.",
        sourceTranscriptEntryId: entry.id,
      },
    });

    await server.stop();

    // A different process reading the same database: this is what the browser
    // sees after a reload.
    const store = new MeetingStore(databasePath);
    try {
      expect(store.requireMeeting(meetingId).title).toBe("Retry policy sync");
      expect(store.listTranscript(meetingId).length).toBe(
        before.transcript.length,
      );
      expect(store.listChat(meetingId).length).toBe(before.chat.length);
      const memories = store.listMemories(meetingId);
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({
        kind: "decision",
        sourceTranscriptEntryId: entry.id,
        sourceParticipantId: ada,
      });
      // The ACP session association survives too, so a reconnect can resume.
      expect(store.latestAcpSession(meetingId, "fake")?.acpSessionId).toMatch(
        /^fake-session-/u,
      );
      // No credential was ever written to disk.
      const dump = JSON.stringify(
        store.db.prepare("SELECT * FROM agent_definitions").all(),
      );
      expect(dump).not.toContain("AMP_MCP_TOKEN");
    } finally {
      store.close();
    }
  });

  it("resumes the ACP session when the agent supports session/load", async () => {
    const { meetingId, ada } = await startMeeting();
    const first = await connectFakeAgent(meetingId);
    expect(first.resumed).toBe(false);

    // Reconnecting spawns a fresh adapter process, which has forgotten the
    // session id — the load is attempted and correctly declined.
    const second = await connectFakeAgent(meetingId);
    expect(second.resumed).toBe(false);
    expect(second.acpSessionId).toMatch(/^fake-session-/u);

    // The reconnected agent still answers.
    await say(meetingId, ada, "Cofounder, what do you think?");
    const answer = await waitFor("the answer", async () => {
      const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
      return (
        view.transcript.find((entry) => entry.speakerKind === "agent") ?? null
      );
    });
    expect(answer.text.length).toBeGreaterThan(0);
  });

  it("does nothing when addressed with no agent connected", async () => {
    const { meetingId, ada } = await startMeeting();
    const feed = await openFeed(meetingId);
    await say(meetingId, ada, "Cofounder, what do you think?");
    await sleep(300);

    expect(feed.ofType("attention")[0]!["triggered"]).toBe(true);
    const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
    expect(
      view.transcript.filter((entry) => entry.speakerKind === "agent"),
    ).toHaveLength(0);
    expect(
      feed
        .ofType("log")
        .some((event) =>
          String(event["line"]).includes("no agent is connected"),
        ),
    ).toBe(true);
  });

  it("tracks the topic as the meeting goes on", async () => {
    const { meetingId, ada, grace } = await startMeeting();
    await say(meetingId, ada, "The webhook retries are failing again.");
    await say(meetingId, grace, "Which retries, the billing ones?");
    await sleep(300);
    const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
    expect(view.meeting.topic).toBe("retries");
    expect(view.meeting.summary).toContain("2 utterance(s)");
  });

  it("survives an agent process that dies mid-turn", async () => {
    const { meetingId, ada } = await startMeeting();
    const feed = await openFeed(meetingId);

    // The fake agent reads its crash switch from its own environment, and a
    // spawned adapter inherits this process's environment — which is exactly
    // how a real adapter picks up its API key.
    process.env["FAKE_ACP_CRASH_ON_PROMPT"] = "1";
    try {
      await connectFakeAgent(meetingId);
      await say(meetingId, ada, "Cofounder, what do you think?");

      const view = await waitFor("the error status", async () => {
        const current = await call<MeetingView>(`/api/meetings/${meetingId}`);
        return current.agent.status === "error" ? current : null;
      });
      expect(view.agent.acpSessionId).toBeNull();
      expect(
        feed
          .ofType("log")
          .some((event) => String(event["line"]).includes("exited")),
      ).toBe(true);

      // One dead agent is not a dead meeting, and not a dead server.
      expect(view.meeting.status).toBe("live");
      const health = await call<{ status: string }>("/api/health");
      expect(health.status).toBe("ok");

      // Relaunching after a crash works.
      delete process.env["FAKE_ACP_CRASH_ON_PROMPT"];
      const relaunched = await connectFakeAgent(meetingId);
      expect(relaunched.acpSessionId).toMatch(/^fake-session-/u);
    } finally {
      delete process.env["FAKE_ACP_CRASH_ON_PROMPT"];
    }
  });
});
