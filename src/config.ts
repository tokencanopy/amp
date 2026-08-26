/**
 * Configuration. Every default is the local-developer one: this is a v0
 * prototype that launches processes on the machine it runs on, so it binds to
 * loopback and stays there unless someone deliberately says otherwise.
 */
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  AMP_HOST: z.string().default("127.0.0.1"),
  AMP_PORT: z.coerce.number().int().min(1).max(65_535).default(4321),
  AMP_DB: z.string().default("./data/amp.db"),
  /** Default working directory offered to a launched agent. */
  AMP_WORKSPACE: z.string().optional(),
  AMP_AGENTS_CONFIG: z.string().default("./agents.config.json"),
  /** How long a permission request waits for a human before being denied. */
  AMP_PERMISSION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(120_000),
  AMP_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  AMP_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(1_800_000),
  /** Hand the agent the meeting MCP server at session creation. */
  AMP_ENABLE_MCP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Allow connecting an agent whose command comes from the request body.
   * Off by default: the browser must not be able to name an arbitrary
   * executable for the server to run. Turning it on is an operator decision
   * made on the machine, not in the UI.
   */
  AMP_ALLOW_GENERIC: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // --- Recall.ai meeting provider (optional; the mock simulator is default) ---
  AMP_RECALL_API_KEY: z.string().optional(),
  AMP_RECALL_REGION: z.string().default("us-west-2"),
  /** Public base URL Recall can reach — a tunnel in development. */
  AMP_RECALL_WEBHOOK_BASE_URL: z.string().optional(),
  /**
   * Shared secret required on every inbound webhook. Recall's real-time
   * webhooks are unauthenticated HTTP to a public URL, so the secret in the
   * path is what stops anyone who finds it from writing a meeting's
   * transcript.
   */
  AMP_RECALL_WEBHOOK_SECRET: z.string().optional(),
  /** Page whose audio Recall streams into the call, for agent speech. */
  AMP_RECALL_SPEAKER_URL: z.string().optional(),
  AMP_RECALL_BOT_NAME: z.string().default("AMP cofounder"),
  AMP_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  defaultWorkspace: string;
  agentsConfigPath: string;
  permissionTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  enableMcp: boolean;
  allowGenericAgent: boolean;
  recall: {
    apiKey: string | undefined;
    region: string;
    webhookBaseUrl: string | undefined;
    webhookSecret: string | undefined;
    speakerUrl: string | undefined;
    botName: string;
  };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  return {
    host: parsed.AMP_HOST,
    port: parsed.AMP_PORT,
    databasePath:
      parsed.AMP_DB === ":memory:"
        ? ":memory:"
        : resolve(process.cwd(), parsed.AMP_DB),
    defaultWorkspace: resolve(
      process.cwd(),
      parsed.AMP_WORKSPACE ?? process.cwd(),
    ),
    agentsConfigPath: resolve(process.cwd(), parsed.AMP_AGENTS_CONFIG),
    permissionTimeoutMs: parsed.AMP_PERMISSION_TIMEOUT_MS,
    idleTimeoutMs: parsed.AMP_IDLE_TIMEOUT_MS,
    totalTimeoutMs: parsed.AMP_TOTAL_TIMEOUT_MS,
    enableMcp: parsed.AMP_ENABLE_MCP,
    allowGenericAgent: parsed.AMP_ALLOW_GENERIC,
    recall: {
      apiKey: parsed.AMP_RECALL_API_KEY,
      region: parsed.AMP_RECALL_REGION,
      webhookBaseUrl: parsed.AMP_RECALL_WEBHOOK_BASE_URL,
      webhookSecret: parsed.AMP_RECALL_WEBHOOK_SECRET,
      speakerUrl: parsed.AMP_RECALL_SPEAKER_URL,
      botName: parsed.AMP_RECALL_BOT_NAME,
    },
    logLevel: parsed.AMP_LOG_LEVEL,
  };
}

/** True when the server is reachable from outside this machine. */
export function isPubliclyBound(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
}
