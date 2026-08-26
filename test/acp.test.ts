import { afterEach, describe, expect, it } from "vitest";

import {
  AcpClient,
  AcpProcessExited,
  type AcpClientEvent,
  type PermissionOutcome,
  type PermissionRequest,
} from "../src/acp/client.js";
import { normalizeUpdate, describeEvent } from "../src/acp/events.js";
import { fakeAgentCommand } from "../src/acp/registry.js";
import {
  sanitizeLogLine,
  sanitizeText,
  BoundedLog,
} from "../src/acp/sanitize.js";

const clients: AcpClient[] = [];

function makeClient(options: {
  requestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionOutcome>;
  env?: NodeJS.ProcessEnv;
  events?: AcpClientEvent[];
}): AcpClient {
  const command = fakeAgentCommand();
  const client = new AcpClient({
    command: command.command,
    args: command.args,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_ACP_CHUNK_DELAY_MS: "1",
      ...(options.env ?? {}),
    },
    ...(options.requestPermission === undefined
      ? {}
      : { requestPermission: options.requestPermission }),
    ...(options.events === undefined
      ? {}
      : { onEvent: (event: AcpClientEvent) => options.events?.push(event) }),
    idleTimeoutMs: 15_000,
    totalTimeoutMs: 20_000,
  });
  clients.push(client);
  client.spawnProcess();
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("ACP handshake and session", () => {
  it("initializes, negotiates capabilities, and creates a session", async () => {
    const events: AcpClientEvent[] = [];
    const client = makeClient({ events });

    const handshake = await client.initialize();
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.capabilities.loadSession).toBe(true);
    expect(await client.authenticate()).toBeNull();

    const sessionId = await client.newSession({ cwd: process.cwd() });
    expect(sessionId).toMatch(/^fake-session-/u);
    expect(client.sessionId).toBe(sessionId);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["spawned", "initialized", "session"]),
    );
  });

  it("loads a session the agent still knows, and declines one it does not", async () => {
    const client = makeClient({});
    await client.initialize();
    const sessionId = await client.newSession({ cwd: process.cwd() });

    expect(await client.loadSession({ sessionId, cwd: process.cwd() })).toBe(
      true,
    );
    expect(
      await client.loadSession({
        sessionId: "fake-session-999",
        cwd: process.cwd(),
      }),
    ).toBe(false);
  });

  it("reports loadSession as unsupported when the agent does not advertise it", async () => {
    const client = makeClient({ env: { FAKE_ACP_LOAD_SESSION: "false" } });
    const handshake = await client.initialize();
    expect(handshake.capabilities.loadSession).toBe(false);
    const sessionId = await client.newSession({ cwd: process.cwd() });
    expect(await client.loadSession({ sessionId, cwd: process.cwd() })).toBe(
      false,
    );
  });
});

describe("prompting", () => {
  it("streams chunks and returns the full response", async () => {
    const events: AcpClientEvent[] = [];
    const client = makeClient({ events });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    const result = await client.prompt(
      "The latest utterance explicitly addressed to you:\nAda: Cofounder, what do you think about retries?",
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toContain("SPEAK:");
    const chunks = events.filter(
      (event) =>
        event.kind === "update" && event.event.type === "message_chunk",
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("never surfaces the text of a thought chunk", async () => {
    const events: AcpClientEvent[] = [];
    const client = makeClient({ events });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });
    await client.prompt("Ada: Cofounder, what do you think?");

    const thoughts = events.filter(
      (event) => event.kind === "update" && event.event.type === "thought",
    );
    expect(thoughts.length).toBeGreaterThan(0);
    expect(JSON.stringify(thoughts)).not.toContain("Considering the room");
  });

  it("refuses a second concurrent turn", async () => {
    const client = makeClient({});
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });
    const first = client.prompt("Ada: Cofounder, what do you think?");
    await expect(client.prompt("Ada: and again?")).rejects.toThrow(
      /already in flight/u,
    );
    await first;
  });
});

describe("permissions", () => {
  it("routes a permission request to the delegate and proceeds when allowed", async () => {
    const seen: PermissionRequest[] = [];
    const client = makeClient({
      requestPermission: async (request) => {
        seen.push(request);
        return { outcome: "selected", optionId: "allow_once" };
      },
    });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    const result = await client.prompt(
      "The latest utterance explicitly addressed to you:\nAda: Codex, inspect the webhook retries.",
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe("Read files in the workspace");
    expect(seen[0]?.options.map((option) => option.kind)).toContain(
      "allow_once",
    );
    expect(result.text).toContain("retry path");
  });

  it("tells the agent it was denied, and the agent does no work", async () => {
    const client = makeClient({
      requestPermission: async () => ({
        outcome: "cancelled",
        reason: "denied by Ada",
      }),
    });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    const result = await client.prompt(
      "The latest utterance explicitly addressed to you:\nAda: Codex, inspect the webhook retries.",
    );
    expect(result.text).toContain("I need approval");
    expect(result.text).not.toContain("event is lost here");
  });

  it("denies by default when no approver is attached", async () => {
    const events: AcpClientEvent[] = [];
    const client = makeClient({ events });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    const result = await client.prompt(
      "The latest utterance explicitly addressed to you:\nAda: Codex, inspect the webhook retries.",
    );
    expect(result.text).toContain("I need approval");
    const resolved = events.find(
      (event) => event.kind === "permission_resolved",
    );
    expect(resolved).toMatchObject({
      outcome: expect.stringContaining("denied"),
    });
  });
});

describe("cancellation", () => {
  it("stops a turn in flight and reports it as cancelled", async () => {
    const client = makeClient({ env: { FAKE_ACP_CHUNK_DELAY_MS: "60" } });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    const turn = client.prompt(
      "Ada: Cofounder, what do you think about retries?",
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    client.cancel();

    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    expect(client.turnActive).toBe(false);
  });

  it("is a no-op before a session exists", () => {
    const client = makeClient({});
    expect(() => client.cancel()).not.toThrow();
  });
});

describe("process failure", () => {
  it("surfaces a crash mid-turn as a typed error", async () => {
    const events: AcpClientEvent[] = [];
    const client = makeClient({
      env: { FAKE_ACP_CRASH_ON_PROMPT: "1" },
      events,
    });
    await client.initialize();
    await client.newSession({ cwd: process.cwd() });

    await expect(
      client.prompt("Ada: Cofounder, thoughts?"),
    ).rejects.toBeInstanceOf(AcpProcessExited);
    expect(client.alive).toBe(false);
    expect(events.some((event) => event.kind === "exited")).toBe(true);
  });

  it("reports a command that does not exist instead of hanging", async () => {
    const events: AcpClientEvent[] = [];
    const client = new AcpClient({
      command: "/nonexistent/definitely-not-an-agent",
      args: [],
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });
    clients.push(client);
    client.spawnProcess();
    await expect(client.initialize()).rejects.toThrow();
    expect(events.some((event) => event.kind === "warning")).toBe(true);
  });
});

describe("event normalization", () => {
  it("maps every update kind this app acts on", () => {
    expect(
      normalizeUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual({ type: "message_chunk", text: "hello" });

    expect(
      normalizeUpdate({
        sessionUpdate: "agent_message_chunk",
        content: [{ text: "a" }, { text: "b" }],
      }),
    ).toEqual({ type: "message_chunk", text: "ab" });

    expect(
      normalizeUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { text: "secret" },
      }),
    ).toEqual({
      type: "thought",
    });

    expect(
      normalizeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "read file",
        kind: "read",
        status: "pending",
      }),
    ).toEqual({
      type: "tool_call",
      toolCallId: "call_1",
      title: "read file",
      kind: "read",
      status: "pending",
    });

    expect(
      normalizeUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
      }),
    ).toEqual({
      type: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: null,
    });

    expect(
      normalizeUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "step", status: "pending" }],
      }),
    ).toEqual({
      type: "plan",
      entries: [{ content: "step", status: "pending" }],
    });
  });

  it("keeps unknown update kinds visible instead of dropping them", () => {
    const event = normalizeUpdate({ sessionUpdate: "something_new" });
    expect(event).toEqual({ type: "unknown", sessionUpdate: "something_new" });
    expect(describeEvent(event!)).toContain("unrecognized update");
  });

  it("ignores malformed updates", () => {
    expect(normalizeUpdate(undefined)).toBeNull();
    expect(normalizeUpdate({})).toBeNull();
    expect(
      normalizeUpdate({ sessionUpdate: "agent_message_chunk", content: {} }),
    ).toBeNull();
  });
});

describe("sanitizing", () => {
  const ESC = String.fromCharCode(0x1b);

  it("strips ANSI colour sequences", () => {
    expect(sanitizeText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  it("strips control characters but keeps newlines and tabs", () => {
    const dirty = `a${String.fromCharCode(0x07)}b\nc\td`;
    expect(sanitizeText(dirty)).toBe("ab\nc\td");
  });

  it("collapses a log line and caps its length", () => {
    expect(sanitizeLogLine("one\ntwo\tthree")).toBe("one two three");
    expect(sanitizeText("x".repeat(50), 10)).toContain("truncated 40 chars");
  });

  it("bounds the diagnostic ring", () => {
    const log = new BoundedLog(3);
    for (const line of ["a", "b", "c", "d"]) log.push(line);
    expect(log.all().map((record) => record.line)).toEqual(["b", "c", "d"]);
  });
});
