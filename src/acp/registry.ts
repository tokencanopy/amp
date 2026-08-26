/**
 * The ACP agent registry.
 *
 * One client, many agents: Codex, Claude Code, Hermes and OpenClaw differ
 * only in which executable is spawned, so they are configuration rather than
 * code. Adding an agent is adding a row here (or an entry in
 * `agents.config.json`), never a new integration.
 *
 * Command names are the fragile part of this file — adapters rename their
 * packages and binaries — so each entry records how confident we are, and
 * `/api/agents/:id/check` resolves the executable before anything is
 * launched. The two verified against npm at the time of writing are noted as
 * such; the rest are labelled unverified rather than quietly assumed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentConfidence = "verified" | "unverified" | "built-in";

export interface AgentDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  description: string;
  confidence: AgentConfidence;
  /** Set when the agent's command/args come from the request, not this file. */
  generic?: boolean;
}

const moduleDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve an in-repo entry point, preferring the compiled file and falling
 * back to running the TypeScript source through tsx. Both the fake ACP agent
 * and the meeting MCP server are spawned this way, so `npm run dev` works
 * before anything has been built.
 */
export function resolveInternalEntry(
  relativeJs: string,
  relativeTs: string,
): { command: string; args: string[] } {
  const built = resolve(moduleDir, "..", relativeJs);
  if (existsSync(built)) return { command: process.execPath, args: [built] };

  const source = resolve(moduleDir, "..", relativeTs);
  const tsxBin = resolve(moduleDir, "../../node_modules/.bin/tsx");
  if (existsSync(tsxBin) && existsSync(source)) {
    return { command: tsxBin, args: [source] };
  }
  // Nothing to fall back to; surface the path we wanted so the error names it.
  return { command: process.execPath, args: [built] };
}

export function fakeAgentCommand(): { command: string; args: string[] } {
  return resolveInternalEntry("fake-agent/bin.js", "fake-agent/bin.ts");
}

export function meetingMcpCommand(): { command: string; args: string[] } {
  return resolveInternalEntry("mcp/bin.js", "mcp/bin.ts");
}

function builtinAgents(): AgentDefinition[] {
  const fake = fakeAgentCommand();
  return [
    {
      id: "fake",
      label: "Fake ACP agent (built in)",
      command: fake.command,
      args: fake.args,
      description:
        "Deterministic in-repo ACP server. Streams chunks, calls a tool, asks for permission, and honours cancellation. Requires nothing installed.",
      confidence: "built-in",
    },
    {
      id: "hermes",
      label: "Hermes Agent",
      command: "hermes",
      args: ["acp"],
      description:
        "Hermes' native ACP mode. Requires the hermes binary on PATH.",
      confidence: "unverified",
    },
    {
      id: "codex",
      label: "Codex (codex-acp adapter)",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      description:
        "Codex through the published ACP adapter. Package @agentclientprotocol/codex-acp exists on npm (1.6.2 at time of writing); the adapter authenticates through Codex's own credentials.",
      confidence: "verified",
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      command: "openclaw",
      args: ["acp"],
      description:
        "OpenClaw's ACP mode. Command name unverified — override it in agents.config.json if your build differs.",
      confidence: "unverified",
    },
    {
      id: "claude",
      label: "Claude Code (claude-agent-acp adapter)",
      command: "claude-agent-acp",
      args: [],
      description:
        "Claude Code through an ACP adapter. @agentclientprotocol/claude-agent-acp publishes this bin (0.70.0 at time of writing); @zed-industries/claude-code-acp is an alternative that installs the `claude-code-acp` bin instead.",
      confidence: "verified",
    },
  ];
}

const GENERIC: AgentDefinition = {
  id: "generic",
  label: "Generic ACP agent",
  command: "",
  args: [],
  description:
    "Any ACP-speaking executable. Supply the command and argument array when connecting; arguments are passed as a vector, never through a shell.",
  confidence: "unverified",
  generic: true,
};

interface ConfigFileEntry {
  label?: string;
  command?: string;
  args?: string[];
  description?: string;
}

/**
 * Load overrides from `agents.config.json` beside the app root, if present.
 * Unknown ids are added; known ids are replaced. Anything malformed is
 * ignored rather than crashing the server on boot.
 */
export function loadAgentRegistry(configPath?: string): AgentDefinition[] {
  const agents = [...builtinAgents(), GENERIC];
  if (configPath === undefined || !existsSync(configPath)) return agents;

  let parsed: Record<string, ConfigFileEntry>;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      ConfigFileEntry
    >;
  } catch {
    return agents;
  }

  for (const [id, entry] of Object.entries(parsed)) {
    if (typeof entry?.command !== "string" || entry.command === "") continue;
    const definition: AgentDefinition = {
      id,
      label: entry.label ?? id,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      description: entry.description ?? "Configured in agents.config.json.",
      confidence: "unverified",
    };
    const existing = agents.findIndex((agent) => agent.id === id);
    if (existing === -1) agents.push(definition);
    else agents[existing] = definition;
  }
  return agents;
}

export interface AgentCheck {
  agentId: string;
  command: string;
  args: string[];
  available: boolean;
  resolvedPath: string | null;
  note: string;
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Find an executable the way a shell would, without invoking one. Nothing is
 * executed: this answers "would spawn find this?" and no more.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (command === "") return null;
  if (command.includes("/") || isAbsolute(command)) {
    return isExecutableFile(command) ? command : null;
  }
  const pathValue = env["PATH"] ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") continue;
    const candidate = resolve(directory, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function checkAgent(
  agent: AgentDefinition,
  env: NodeJS.ProcessEnv = process.env,
): AgentCheck {
  if (agent.generic === true) {
    return {
      agentId: agent.id,
      command: agent.command,
      args: agent.args,
      available: false,
      resolvedPath: null,
      note: "Generic agent: supply a command when connecting.",
    };
  }
  const resolved = resolveExecutable(agent.command, env);
  const available = resolved !== null;
  const note = available
    ? `Found at ${resolved}.`
    : agent.command === "npx"
      ? "npx is not on PATH; install Node.js tooling or point this agent at a local binary."
      : `${agent.command} is not on PATH. Install the adapter, or override the command in agents.config.json.`;
  return {
    agentId: agent.id,
    command: agent.command,
    args: agent.args,
    available,
    resolvedPath: resolved,
    note,
  };
}
