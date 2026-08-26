import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer, type AmpServer } from "../src/server/create.js";

let server: AmpServer;
let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "amp-api-"));
  server = createServer({
    port: 0,
    host: "127.0.0.1",
    databasePath: join(workdir, "api.db"),
    logLevel: "silent",
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(workdir, { recursive: true, force: true });
});

async function createMeeting(overrides: Record<string, unknown> = {}) {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/meetings",
    payload: {
      title: "Weekly product sync",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder"],
      participants: [{ name: "Ada", kind: "human", role: "founder" }],
      ...overrides,
    },
  });
  return response;
}

describe("health and agents", () => {
  it("reports health and labels itself a prototype", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      prototype: expect.stringContaining("prototype"),
    });
  });

  it("lists agents with the exact command that would be launched", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/agents",
    });
    const body = response.json();
    const ids = body.items.map((agent: { id: string }) => agent.id);
    expect(ids).toEqual(
      expect.arrayContaining(["fake", "hermes", "codex", "openclaw", "claude"]),
    );
    const codex = body.items.find(
      (agent: { id: string }) => agent.id === "codex",
    );
    expect(codex.commandPreview).toBe("npx -y @agentclientprotocol/codex-acp");
    expect(body.genericAllowed).toBe(false);
  });

  it("checks whether an agent's executable resolves", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/agents/fake/check",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agentId: "fake", available: true });
  });

  it("404s an unknown agent with a structured error", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/agents/nope/check",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("unknown_agent");
  });
});

describe("input validation", () => {
  it("rejects a meeting with no title", async () => {
    const response = await createMeeting({ title: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });

  it("rejects an over-long utterance", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });
    const participantId = created.json().participants[0].id;

    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      payload: { participantId, text: "x".repeat(4_001) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown memory kind", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/memories`,
      payload: { kind: "wild_guess", content: "nope" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s an unknown meeting", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/meetings/mtg_missing",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("unknown_meeting");
  });

  it("refuses an utterance to a meeting that has not started", async () => {
    const created = await createMeeting();
    const body = created.json();
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${body.meeting.id}/utterances`,
      payload: { participantId: body.participants[0].id, text: "hello" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("meeting_not_live");
  });

  it("refuses an utterance from someone not in the meeting", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      payload: { participantId: "phum_stranger", text: "hello" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("unknown_participant");
  });
});

describe("meeting lifecycle", () => {
  it("creates a meeting with the agent seated, and starts it", async () => {
    const created = await createMeeting();
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.meeting.status).toBe("created");
    expect(body.participants.map((p: { name: string }) => p.name)).toEqual([
      "Ada",
      "Cofounder",
    ]);
    expect(body.participants[1].kind).toBe("agent");

    const started = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${body.meeting.id}/start`,
    });
    expect(started.json().meeting.status).toBe("live");
    expect(started.json().meeting.startedAt).not.toBeNull();
  });

  it("records utterances and chat, and exposes them after the fact", async () => {
    const created = await createMeeting();
    const body = created.json();
    const meetingId = body.meeting.id;
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });

    for (const [text, channel] of [
      ["The retries are failing.", "speech"],
      ["here is the dashboard", "chat"],
    ] as const) {
      const response = await server.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/utterances`,
        payload: { participantId: body.participants[0].id, text, channel },
      });
      expect(response.statusCode).toBe(202);
    }
    // The provider queue is drained asynchronously by the gateway.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const transcript = await server.app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/transcript`,
    });
    expect(transcript.json().items).toHaveLength(1);
    expect(transcript.json().chat).toHaveLength(1);
  });

  it("adds a participant mid-meeting", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/participants`,
      payload: { name: "Grace", kind: "human", role: "engineer" },
    });
    expect(response.statusCode).toBe(201);
    expect(
      response.json().participants.map((p: { name: string }) => p.name),
    ).toContain("Grace");
  });

  it("refuses to start an ended meeting", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/end`,
    });
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("agent control guards", () => {
  it("refuses the generic agent unless the operator enabled it", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/agent/connect`,
      payload: { agentId: "generic", command: "/bin/echo", args: ["hi"] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("generic_agent_disabled");
  });

  it("refuses to cancel when nothing is connected", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/agent/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("no_agent");
  });

  it("404s a permission response for a request nobody is waiting on", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/permissions/perm_nope/respond`,
      payload: { decision: "allow" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("memories over HTTP", () => {
  it("stores a memory linked to a transcript entry", async () => {
    const created = await createMeeting();
    const body = created.json();
    const meetingId = body.meeting.id;
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/start`,
    });
    await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      payload: {
        participantId: body.participants[0].id,
        text: "Let's cap retries at three.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const transcript = await server.app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/transcript`,
    });
    const entryId = transcript.json().items[0].id;

    const stored = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/memories`,
      payload: {
        kind: "decision",
        content: "Cap retries at three.",
        sourceTranscriptEntryId: entryId,
      },
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.json().memory).toMatchObject({
      kind: "decision",
      status: "active",
      sourceTranscriptEntryId: entryId,
      sourceParticipantId: body.participants[0].id,
    });
    expect(stored.json().memory.sourceTimestamp).toBeTypeOf("string");
  });

  it("rejects a memory whose source is not part of this meeting", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/memories`,
      payload: {
        kind: "fact",
        content: "invented provenance",
        sourceTranscriptEntryId: "utt_from_another_meeting",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_memory");
  });

  it("supersedes without deleting", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const stored = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/memories`,
      payload: { kind: "note", content: "first thought" },
    });
    const memoryId = stored.json().memory.id;
    const superseded = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/memories/${memoryId}/supersede`,
    });
    expect(superseded.json().memory.status).toBe("superseded");

    const active = await server.app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/memories?status=active`,
    });
    expect(active.json().items).toHaveLength(0);
  });
});

describe("MCP bridge authorization", () => {
  it("refuses a call with no capability", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/mcp/active",
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a call with the wrong capability", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "GET",
      url: "/api/mcp/active",
      headers: {
        "x-meeting-id": meetingId,
        "x-meeting-mcp-token": "not-the-real-capability",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts the meeting's own capability", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "GET",
      url: "/api/mcp/active",
      headers: {
        "x-meeting-id": meetingId,
        "x-meeting-mcp-token": server.gateway.mcpToken(meetingId),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meeting.id).toBe(meetingId);
  });

  it("refuses to post chat to a meeting that is not live", async () => {
    const created = await createMeeting();
    const meetingId = created.json().meeting.id;
    const response = await server.app.inject({
      method: "POST",
      url: "/api/mcp/chat",
      headers: {
        "x-meeting-id": meetingId,
        "x-meeting-mcp-token": server.gateway.mcpToken(meetingId),
      },
      payload: { text: "posting into a meeting that never started" },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("static UI", () => {
  it("serves the simulator", async () => {
    const response = await server.app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Agent Meeting Protocol");
  });

  it("does not serve files outside public/", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/../package.json",
    });
    expect(response.statusCode).toBe(404);
  });
});
