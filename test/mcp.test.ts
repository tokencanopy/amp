/**
 * The meeting MCP server, exercised the way an agent actually uses it: the
 * real binary, spawned over stdio, holding only the capability the gateway
 * would have handed it in `session/new`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { meetingMcpCommand } from "../src/acp/registry.js";
import { createServer, type AmpServer } from "../src/server/create.js";

let server: AmpServer;
let workdir: string;
let meetingId: string;
let adaId: string;
const clients: Client[] = [];

async function connectMcp(token = server.gateway.mcpToken(meetingId)) {
  const command = meetingMcpCommand();
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: command.command,
      args: command.args,
      env: {
        ...(process.env as Record<string, string>),
        AMP_MCP_BASE_URL: server.origin(),
        AMP_MCP_MEETING_ID: meetingId,
        AMP_MCP_TOKEN: token,
      },
    }),
  );
  clients.push(client);
  return client;
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "amp-mcp-"));
  server = createServer({
    port: 0,
    host: "127.0.0.1",
    databasePath: join(workdir, "mcp.db"),
    logLevel: "silent",
  });
  await server.start();

  const created = await fetch(`${server.origin()}/api/meetings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Retry policy sync",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder"],
      participants: [{ name: "Ada", kind: "human", role: "founder" }],
      agentId: "fake",
    }),
  });
  const body = (await created.json()) as {
    meeting: { id: string };
    participants: { id: string; name: string }[];
  };
  meetingId = body.meeting.id;
  adaId = body.participants.find((p) => p.name === "Ada")!.id;
  await fetch(`${server.origin()}/api/meetings/${meetingId}/start`, {
    method: "POST",
  });
  await fetch(`${server.origin()}/api/meetings/${meetingId}/utterances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: adaId,
      text: "Let's cap retries at three.",
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server.stop();
  rmSync(workdir, { recursive: true, force: true });
});

describe("meeting MCP server", () => {
  it("advertises exactly the meeting tools", async () => {
    const client = await connectMcp();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "meeting_get_active",
      "meeting_get_participants",
      "meeting_get_recent_transcript",
      "meeting_list_memories",
      "meeting_remember",
      "meeting_send_chat",
      "meeting_speak",
    ]);
  });

  it("reads the active meeting, participants and transcript", async () => {
    const client = await connectMcp();

    const active = parse(
      await client.callTool({ name: "meeting_get_active", arguments: {} }),
    );
    expect((active["meeting"] as { id: string }).id).toBe(meetingId);
    expect((active["meeting"] as { status: string }).status).toBe("live");

    const participants = parse(
      await client.callTool({
        name: "meeting_get_participants",
        arguments: {},
      }),
    );
    expect(
      (participants["items"] as { name: string }[]).map((item) => item.name),
    ).toEqual(["Ada", "Cofounder"]);

    const transcript = parse(
      await client.callTool({
        name: "meeting_get_recent_transcript",
        arguments: { limit: 5 },
      }),
    );
    const items = transcript["items"] as {
      speakerName: string;
      text: string;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      speakerName: "Ada",
      text: "Let's cap retries at three.",
    });
  });

  it("posts to meeting chat", async () => {
    const client = await connectMcp();
    const posted = parse(
      await client.callTool({
        name: "meeting_send_chat",
        arguments: { text: "Full retry table is in the doc." },
      }),
    );
    expect(posted["posted"]).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const view = (await (
      await fetch(`${server.origin()}/api/meetings/${meetingId}`)
    ).json()) as { chat: { speakerName: string; text: string }[] };
    expect(view.chat.at(-1)).toMatchObject({
      speakerName: "Cofounder",
      text: "Full retry table is in the doc.",
    });
  });

  it("speaks short text, and diverts unspeakable text to chat", async () => {
    const client = await connectMcp();
    await client.callTool({
      name: "meeting_speak",
      arguments: { text: "Three retries, then dead-letter." },
    });
    await client.callTool({
      name: "meeting_speak",
      arguments: { text: "Here is the fix:\n```ts\nconst n = 3;\n```" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const view = (await (
      await fetch(`${server.origin()}/api/meetings/${meetingId}`)
    ).json()) as {
      transcript: { speakerKind: string; text: string }[];
      chat: { text: string }[];
    };
    const spoken = view.transcript.filter(
      (entry) => entry.speakerKind === "agent",
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe("Three retries, then dead-letter.");
    // The code block was never spoken; it was posted instead.
    expect(
      view.chat.some((message) => message.text.includes("const n = 3;")),
    ).toBe(true);
  });

  it("remembers with provenance resolved from the transcript", async () => {
    const client = await connectMcp();
    const transcript = parse(
      await client.callTool({
        name: "meeting_get_recent_transcript",
        arguments: {},
      }),
    );
    const entry = (transcript["items"] as { id: string }[])[0]!;

    const stored = parse(
      await client.callTool({
        name: "meeting_remember",
        arguments: {
          kind: "decision",
          content: "Cap retries at three, then dead-letter.",
          source_transcript_entry_id: entry.id,
        },
      }),
    );
    expect(stored["memory"]).toMatchObject({
      kind: "decision",
      status: "active",
      sourceTranscriptEntryId: entry.id,
      sourceParticipantId: adaId,
    });

    const listed = parse(
      await client.callTool({
        name: "meeting_list_memories",
        arguments: { kind: "decision" },
      }),
    );
    expect((listed["items"] as unknown[]).length).toBe(1);
  });

  it("refuses to invent provenance", async () => {
    const client = await connectMcp();
    const result = await client.callTool({
      name: "meeting_remember",
      arguments: {
        kind: "fact",
        content: "Somebody definitely said this.",
        source_transcript_entry_id: "utt_never_happened",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "not part of this meeting",
    );
  });

  it("rejects a stolen or stale capability", async () => {
    const client = await connectMcp("not-the-real-capability");
    const result = await client.callTool({
      name: "meeting_get_active",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not valid");
  });

  it("refuses state changes once the meeting has ended", async () => {
    const client = await connectMcp();
    await fetch(`${server.origin()}/api/meetings/${meetingId}/end`, {
      method: "POST",
    });
    const result = await client.callTool({
      name: "meeting_send_chat",
      arguments: { text: "posting into a meeting that already ended" },
    });
    expect(result.isError).toBe(true);

    // Reads still work — history is readable after the meeting.
    const active = parse(
      await client.callTool({ name: "meeting_get_active", arguments: {} }),
    );
    expect((active["meeting"] as { status: string }).status).toBe("ended");
  });
});
