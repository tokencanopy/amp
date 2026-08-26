#!/usr/bin/env node
/**
 * Entry point for the fake ACP agent. Speaks ACP on stdio exactly as a real
 * adapter does, so the registry can spawn it with no special-casing.
 */
import { FakeAcpAgent } from "./agent.js";

const agent = new FakeAcpAgent({
  input: process.stdin,
  output: process.stdout,
  ...(process.env["FAKE_ACP_CHUNK_DELAY_MS"] === undefined
    ? {}
    : { chunkDelayMs: Number(process.env["FAKE_ACP_CHUNK_DELAY_MS"]) }),
  ...(process.env["FAKE_ACP_PERMISSION"] === undefined
    ? {}
    : {
        permissionMode: process.env["FAKE_ACP_PERMISSION"] as
          "always" | "never" | "auto",
      }),
  loadSession: process.env["FAKE_ACP_LOAD_SESSION"] !== "false",
  crashOnPrompt: process.env["FAKE_ACP_CRASH_ON_PROMPT"] === "1",
});

agent.start();

// stdin closing means the client is gone; there is nothing left to serve.
process.stdin.on("end", () => process.exit(0));
