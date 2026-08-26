#!/usr/bin/env node
/**
 * Entry point for the meeting MCP server, spawned by the agent through the
 * ACP `session/new` mcpServers list. Its meeting id and capability arrive in
 * its environment; nothing is read from disk and nothing is written there.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MeetingBridge } from "./bridge.js";
import { createMeetingMcpServer } from "./server.js";

const baseUrl = process.env["AMP_MCP_BASE_URL"];
const meetingId = process.env["AMP_MCP_MEETING_ID"];
const token = process.env["AMP_MCP_TOKEN"];

if (baseUrl === undefined || meetingId === undefined || token === undefined) {
  // stderr, never stdout: stdout is the MCP transport.
  process.stderr.write(
    "amp-mcp: AMP_MCP_BASE_URL, AMP_MCP_MEETING_ID and AMP_MCP_TOKEN are required\n",
  );
  process.exit(2);
}

const bridge = new MeetingBridge({ baseUrl, meetingId, token });
const server = createMeetingMcpServer(bridge);
await server.connect(new StdioServerTransport());
