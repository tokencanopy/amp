#!/usr/bin/env node
/**
 * AMP — Agent Meeting Protocol: the Meeting Channel for Agents.
 *
 * A LOCAL DEVELOPER PROTOTYPE (v0). It launches processes on the machine it
 * runs on and has no authentication of its own, which is why it binds to
 * loopback by default and says so on startup. Do not deploy it.
 */
import { createServer } from "./server/create.js";
import { isPubliclyBound } from "./config.js";

const server = createServer();

async function shutdown(signal: string): Promise<void> {
  server.app.log.info({ signal }, "shutting down");
  try {
    // Child agent processes are terminated here; a stranded ACP adapter is a
    // model session nobody is watching.
    await server.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const address = await server.start();
server.app.log.info(
  {
    address,
    mcp: server.config.enableMcp,
    workspace: server.config.defaultWorkspace,
    agents: server.agents.map((agent) => agent.id),
  },
  "amp ready (local v0 developer prototype)",
);

if (isPubliclyBound(server.config.host)) {
  server.app.log.warn(
    `Bound to ${server.config.host}, which is reachable from other machines. ` +
      "This prototype has no authentication and can launch local processes. Bind to 127.0.0.1 unless you know why you are not.",
  );
}
