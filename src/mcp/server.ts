/**
 * The meeting MCP server: the agent's hands in the meeting.
 *
 * The split with ACP is the point of the architecture and is worth stating
 * plainly, because the two protocols look symmetrical and are not:
 *
 *   ACP  — the gateway drives the agent. Prompt it, watch it, cancel it.
 *   MCP  — the agent drives the meeting. Read context, chat, speak, remember.
 *
 * One is control, the other is capability, and the direction of each is
 * fixed. An agent cannot prompt itself through ACP, and the gateway does not
 * call MCP tools on the agent's behalf.
 *
 * Every state-changing tool goes through the gateway bridge, which validates
 * that the meeting is live and that the caller holds this meeting's
 * capability. A tool call is not trusted because the agent made it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MeetingBridge, MeetingBridgeError } from "./bridge.js";

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failed(error: unknown) {
  const message =
    error instanceof MeetingBridgeError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Meeting operation failed";
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code: "meeting_error", message } }),
      },
    ],
  };
}

function guarded<T extends Record<string, unknown>>(handler: () => Promise<T>) {
  return handler().then(result, failed);
}

export function createMeetingMcpServer(bridge: MeetingBridge): McpServer {
  const server = new McpServer({
    name: "tokencanopy-amp",
    version: "0.0.1",
  });

  server.registerTool(
    "meeting_get_active",
    {
      description:
        "Get the meeting you are currently participating in: title, status, current topic, and the rolling summary.",
      inputSchema: {},
    },
    () => guarded(() => bridge.getActive()),
  );

  server.registerTool(
    "meeting_get_participants",
    {
      description:
        "List everyone in the meeting, with their id, display name, kind (human or agent), and role.",
      inputSchema: {},
    },
    () => guarded(() => bridge.getParticipants()),
  );

  server.registerTool(
    "meeting_get_recent_transcript",
    {
      description:
        "Read the most recent speaker-attributed transcript entries, oldest first. Use this to catch up before answering.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many entries to return (default 20)."),
      },
    },
    (args) => guarded(() => bridge.getRecentTranscript(args.limit ?? 20)),
  );

  server.registerTool(
    "meeting_send_chat",
    {
      description:
        "Post a message to the meeting chat as yourself. Use this for anything long, technical, or containing code — chat is read, not spoken.",
      inputSchema: {
        text: z.string().min(1).max(8_000).describe("The message to post."),
      },
    },
    (args) => guarded(() => bridge.sendChat(args.text)),
  );

  server.registerTool(
    "meeting_speak",
    {
      description:
        "Say something out loud in the meeting. Keep it short and conversational; code, URLs, and long lists are posted to chat instead of being read aloud.",
      inputSchema: {
        text: z.string().min(1).max(4_000).describe("What to say."),
      },
    },
    (args) => guarded(() => bridge.speak(args.text)),
  );

  server.registerTool(
    "meeting_remember",
    {
      description:
        "Record a decision, action item, fact, or note from this meeting. Link it to the transcript entry it came from so it can be traced back.",
      inputSchema: {
        kind: z
          .enum(["decision", "action_item", "fact", "note"])
          .describe("What kind of memory this is."),
        content: z.string().min(1).max(2_000).describe("What to remember."),
        source_transcript_entry_id: z
          .string()
          .optional()
          .describe(
            "The transcript entry this came from, from meeting_get_recent_transcript.",
          ),
        source_participant_id: z
          .string()
          .optional()
          .describe("The participant who said it."),
      },
    },
    (args) =>
      guarded(() =>
        bridge.remember({
          kind: args.kind,
          content: args.content,
          ...(args.source_transcript_entry_id === undefined
            ? {}
            : { sourceTranscriptEntryId: args.source_transcript_entry_id }),
          ...(args.source_participant_id === undefined
            ? {}
            : { sourceParticipantId: args.source_participant_id }),
        }),
      ),
  );

  server.registerTool(
    "meeting_list_memories",
    {
      description:
        "List what has been remembered in this meeting: decisions, action items, facts, and notes.",
      inputSchema: {
        kind: z.enum(["decision", "action_item", "fact", "note"]).optional(),
        status: z.enum(["active", "superseded"]).optional(),
      },
    },
    (args) =>
      guarded(() =>
        bridge.listMemories({
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(args.status === undefined ? {} : { status: args.status }),
        }),
      ),
  );

  return server;
}
