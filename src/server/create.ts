/**
 * Composition root. Everything is wired here and nowhere else, which is what
 * lets a test build the identical stack against an in-memory database on an
 * ephemeral port.
 */
import type { FastifyInstance } from "fastify";

import {
  meetingMcpCommand,
  loadAgentRegistry,
  type AgentDefinition,
} from "../acp/registry.js";
import { loadConfig, isPubliclyBound, type AppConfig } from "../config.js";
import { MeetingGateway } from "../gateway/gateway.js";
import { MockMeetingProvider } from "../providers/mock.js";
import { RecallMeetingProvider } from "../providers/recall/provider.js";
import { MeetingStore } from "../store/store.js";
import { buildApp } from "./app.js";
import { RealtimeHub } from "./hub.js";

export interface AmpServer {
  app: FastifyInstance;
  config: AppConfig;
  store: MeetingStore;
  gateway: MeetingGateway;
  hub: RealtimeHub;
  agents: AgentDefinition[];
  /** The Recall provider, when configured. */
  recall: RecallMeetingProvider | undefined;
  /** Resolved after listen(); the MCP subprocess needs the real port. */
  origin: () => string;
  start: () => Promise<string>;
  stop: () => Promise<void>;
}

export interface CreateServerOptions {
  /**
   * The HTTP client the Recall provider dispatches bots with.
   *
   * Exists so a test can drive the real webhook ingress — translation,
   * attention, prompting, the spawned agent — without a network or a
   * credential. Nothing else has any business replacing it.
   */
  fetch?: typeof globalThis.fetch;
}

export function createServer(
  overrides: Partial<AppConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
  options: CreateServerOptions = {},
): AmpServer {
  const config: AppConfig = { ...loadConfig(env), ...overrides };
  const store = new MeetingStore(config.databasePath);
  const hub = new RealtimeHub();

  // The simulator always exists — it is how the prototype is developed and
  // demonstrated. Recall is added ALONGSIDE it when configured, rather than
  // replacing it, so a real meeting and a simulated one can be compared on
  // the same build without a redeploy.
  const simulator = new MockMeetingProvider(store);
  const recallReady =
    config.recall.apiKey !== undefined &&
    config.recall.webhookBaseUrl !== undefined &&
    config.recall.webhookSecret !== undefined;
  const recall = recallReady
    ? new RecallMeetingProvider({
        store,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        config: {
          apiKey: config.recall.apiKey as string,
          region: config.recall.region,
          webhookBaseUrl: config.recall.webhookBaseUrl as string,
          webhookSecret: config.recall.webhookSecret as string,
          ...(config.recall.speakerUrl === undefined
            ? {}
            : { speakerUrl: config.recall.speakerUrl }),
          ...(config.recall.speakerVoice === undefined
            ? {}
            : { speakerVoice: config.recall.speakerVoice }),
          ...(config.recall.transcriptLanguage === undefined
            ? {}
            : { transcriptLanguage: config.recall.transcriptLanguage }),
          botName: config.recall.botName,
        },
      })
    : undefined;
  const agents = loadAgentRegistry(config.agentsConfigPath);

  let resolvedPort = config.port;
  const origin = (): string => {
    // 0.0.0.0 is not an address a child process can dial; loopback is.
    const host = isPubliclyBound(config.host) ? "127.0.0.1" : config.host;
    return `http://${host === "::1" ? "[::1]" : host}:${resolvedPort}`;
  };

  const mcp = meetingMcpCommand();
  const gateway = new MeetingGateway({
    store,
    providers: {
      mock: simulator,
      ...(recall === undefined ? {} : { recall }),
    },
    publish: (meetingId, event) => hub.publish(meetingId, event),
    permissionTimeoutMs: config.permissionTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    mcpServers: ({ meetingId, mcpToken }) =>
      config.enableMcp
        ? [
            {
              name: "meeting",
              command: mcp.command,
              args: mcp.args,
              env: [
                { name: "AMP_MCP_BASE_URL", value: origin() },
                { name: "AMP_MCP_MEETING_ID", value: meetingId },
                { name: "AMP_MCP_TOKEN", value: mcpToken },
              ],
            },
          ]
        : [],
  });

  const app = buildApp({
    config,
    gateway,
    hub,
    agents,
    simulator,
    ...(recall === undefined ? {} : { recall }),
  });

  return {
    app,
    config,
    store,
    gateway,
    hub,
    agents,
    recall,
    origin,
    start: async () => {
      const address = await app.listen({
        host: config.host,
        port: config.port,
      });
      const port = (app.server.address() as { port?: number } | null)?.port;
      if (typeof port === "number") resolvedPort = port;
      return address;
    },
    stop: async () => {
      await gateway.shutdown();
      hub.closeAll();
      await app.close();
      store.close();
    },
  };
}
