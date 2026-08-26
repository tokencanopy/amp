/**
 * One ACP client, driving any ACP-speaking coding agent over stdio.
 *
 * ACP inverts MCP. Under MCP the agent is the client and reaches out to tool
 * servers; under ACP the agent is the *server* and something else drives it.
 * That something is normally an editor — here it is the meeting gateway,
 * which is what lets a turn-driven agent (Claude Code, Codex, Hermes,
 * OpenClaw) behave like a meeting participant without changing anything about
 * its model, workspace, instructions, skills, tools, session, or memory.
 *
 * Differences from a one-shot ACP client, which this is modelled on and
 * which solves a narrower problem:
 *
 *   - updates are STREAMED to a listener as they arrive, because a meeting
 *     shows work in progress rather than only a final answer;
 *   - permission requests are NEVER auto-approved. They are handed to a
 *     delegate that puts them in front of a human. An agent participating in
 *     a meeting is being watched by the whole room; approving on its behalf
 *     would be inventing consent nobody gave;
 *   - cancellation is a first-class public operation, not an internal
 *     timeout detail, because "stop working on that" is a thing people say
 *     out loud in meetings;
 *   - a process that dies is a reported state, not an exception nobody
 *     catches.
 *
 * Never `shell: true`, and never a command string: the executable and its
 * arguments are separate values from here down to `spawn`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  describeEvent,
  normalizeUpdate,
  type NormalizedAcpEvent,
} from "./events.js";
import { sanitizeLogLine, sanitizeText } from "./sanitize.js";

export const ACP_PROTOCOL_VERSION = 1;

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  /** Stable id for this request within the client, used by the UI to answer. */
  requestId: string;
  toolName: string;
  toolKind: string;
  options: PermissionOption[];
  /** Sanitized, bounded description of what the agent wants to do. */
  detail: string;
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled"; reason: string };

export type AcpClientEvent =
  | { kind: "spawned"; command: string; args: readonly string[]; cwd: string }
  | {
      kind: "initialized";
      protocolVersion: number;
      capabilities: AgentCapabilities;
    }
  | { kind: "authenticated"; methodId: string }
  | { kind: "session"; sessionId: string; loaded: boolean }
  | { kind: "update"; event: NormalizedAcpEvent; description: string }
  | { kind: "turn_started" }
  | { kind: "turn_finished"; stopReason: string; chars: number }
  | { kind: "turn_failed"; message: string }
  | { kind: "permission_requested"; request: PermissionRequest }
  | { kind: "permission_resolved"; requestId: string; outcome: string }
  | { kind: "cancelled" }
  | { kind: "stderr"; line: string }
  | {
      kind: "exited";
      code: number | null;
      signal: string | null;
      expected: boolean;
    }
  | { kind: "warning"; message: string };

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface AcpClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: AcpClientEvent) => void;
  /**
   * Asked whenever the agent requests permission. There is no default and no
   * auto-approval: a caller that does not supply this refuses everything.
   */
  requestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionOutcome>;
  /** Silence before a turn is abandoned. Resets on any agent output. */
  idleTimeoutMs?: number;
  /** Absolute wall-clock cap on one turn. */
  totalTimeoutMs?: number;
}

export interface PromptResult {
  text: string;
  stopReason: string;
}

export class AcpProcessExited extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: string | null,
  ) {
    super(
      `agent process exited (code ${code ?? "none"}, signal ${signal ?? "none"})`,
    );
    this.name = "AcpProcessExited";
  }
}

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_TOTAL_MS = 1_800_000;
const TIMEOUT_POLL_MS = 500;
const CANCEL_GRACE_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
/** codex advertises several auth methods and the first is not the working one. */
const DEFAULT_AUTH_PREFERENCE = ["chat-gpt"] as const;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class AcpClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #permissionSeq = 0;
  #buffer = "";
  #sessionId: string | null = null;
  #chunks: string[] = [];
  #lastActivity = Date.now();
  #exited: { code: number | null; signal: string | null } | null = null;
  /** Set the moment stdin is closed, which is before the process exits. */
  #writable = false;
  /** True once close() has been called, so an exit is expected rather than a
   *  crash. A killed process can report its exit well after close() returns —
   *  the SIGKILL path does not wait — so without this a clean shutdown shows
   *  up in the UI as an agent that died. */
  #closing = false;
  #capabilities: AgentCapabilities = {
    loadSession: false,
    promptCapabilities: {},
    raw: {},
  };
  #authMethods: { id: string; name?: string }[] = [];
  #turnActive = false;
  #cancelRequested = false;
  readonly #options: AcpClientOptions;
  readonly #emit: (event: AcpClientEvent) => void;

  constructor(options: AcpClientOptions) {
    this.#options = options;
    this.#emit = options.onEvent ?? (() => {});
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get capabilities(): AgentCapabilities {
    return this.#capabilities;
  }

  get authMethods(): readonly { id: string; name?: string }[] {
    return [...this.#authMethods];
  }

  get alive(): boolean {
    return this.#child !== null && this.#exited === null;
  }

  get turnActive(): boolean {
    return this.#turnActive;
  }

  /** True once a shutdown has been asked for, so callers can tell an
   *  interrupted turn apart from a failed one. */
  get closing(): boolean {
    return this.#closing;
  }

  /** Spawn the adapter. Argument vector only — no shell, ever. */
  spawnProcess(): void {
    if (this.#child !== null) throw new Error("already spawned");
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    this.#writable = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") {
          this.#emit({ kind: "stderr", line: sanitizeLogLine(line) });
        }
      }
    });
    child.on("error", (error: Error) => {
      // A command that does not exist fails here, not at spawn() — this is
      // where "hermes: not found" becomes a message the UI can show.
      this.#emit({ kind: "warning", message: sanitizeLogLine(error.message) });
      this.#failAll(new Error(`agent process error: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      this.#exited = { code, signal };
      this.#writable = false;
      this.#turnActive = false;
      this.#emit({ kind: "exited", code, signal, expected: this.#closing });
      this.#failAll(new AcpProcessExited(code, signal));
    });

    this.#emit({
      kind: "spawned",
      command: this.#options.command,
      args: [...this.#options.args],
      cwd: this.#options.cwd,
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #onStdout(chunk: string): void {
    this.#lastActivity = Date.now();
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#onMessage(line);
      newline = this.#buffer.indexOf("\n");
    }
    // A wildly long line with no newline is a broken adapter, not a message.
    if (this.#buffer.length > 8_000_000) this.#buffer = "";
  }

  #onMessage(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Adapters print human-readable banners to stdout. Not fatal, but worth
      // showing in diagnostics.
      this.#emit({ kind: "stderr", line: sanitizeLogLine(line) });
      return;
    }

    if (parsed["method"] === "session/update") {
      const params = parsed["params"] as Record<string, unknown> | undefined;
      const update = normalizeUpdate(
        params?.["update"] as Record<string, unknown> | undefined,
      );
      if (update !== null) {
        if (update.type === "message_chunk") this.#chunks.push(update.text);
        this.#emit({
          kind: "update",
          event: update,
          description: describeEvent(update),
        });
      }
      return;
    }

    if (parsed["method"] === "session/request_permission") {
      void this.#onPermission(parsed);
      return;
    }

    const id = parsed["id"];
    if (typeof id === "number" && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (pending === undefined) return;
      if (parsed["error"] !== undefined) {
        const error = parsed["error"] as { message?: string };
        pending.reject(new Error(sanitizeText(error.message ?? "agent error")));
      } else {
        pending.resolve(parsed["result"]);
      }
      return;
    }

    // An unhandled REQUEST carries both a method and an id, so the agent is
    // blocked waiting for a reply. Silence presents as a hung model, so
    // answer "method not found" — the only thing that stays correct as
    // adapters add methods this build has never heard of.
    if (parsed["method"] !== undefined && id !== undefined) {
      const method = sanitizeText(String(parsed["method"]));
      this.#emit({ kind: "warning", message: `unsupported method: ${method}` });
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    }
  }

  /**
   * Route a permission request to a human and answer with their decision.
   *
   * Note what is NOT here: any path that selects an option on its own. When
   * no delegate is configured, or the delegate throws, the request is
   * cancelled — refusing is always the safe answer, and the agent handles
   * refusal as an ordinary outcome.
   */
  async #onPermission(message: Record<string, unknown>): Promise<void> {
    const params = (message["params"] ?? {}) as Record<string, unknown>;
    const toolCall = (params["toolCall"] ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(params["options"])
      ? params["options"]
      : [];
    const options: PermissionOption[] = rawOptions
      .map((option) => (option ?? {}) as Record<string, unknown>)
      .filter((option) => typeof option["optionId"] === "string")
      .map((option) => ({
        optionId: String(option["optionId"]),
        name: sanitizeText(String(option["name"] ?? option["optionId"]), 200),
        kind: sanitizeText(String(option["kind"] ?? "unknown"), 64),
      }));

    this.#permissionSeq += 1;
    const request: PermissionRequest = {
      requestId: `perm_${this.#permissionSeq}`,
      toolName: sanitizeText(String(toolCall["title"] ?? "unknown tool"), 200),
      toolKind: sanitizeText(String(toolCall["kind"] ?? "other"), 64),
      options,
      detail: sanitizeText(
        typeof toolCall["rawInput"] === "object" &&
          toolCall["rawInput"] !== null
          ? JSON.stringify(toolCall["rawInput"])
          : String(toolCall["title"] ?? ""),
        1_000,
      ),
    };

    this.#emit({ kind: "permission_requested", request });

    let outcome: PermissionOutcome = {
      outcome: "cancelled",
      reason: "no approver is attached",
    };
    if (this.#options.requestPermission !== undefined) {
      try {
        outcome = await this.#options.requestPermission(request);
      } catch (error) {
        outcome = {
          outcome: "cancelled",
          reason: error instanceof Error ? error.message : "approval failed",
        };
      }
    }

    this.#emit({
      kind: "permission_resolved",
      requestId: request.requestId,
      outcome:
        outcome.outcome === "selected"
          ? `allowed (${outcome.optionId})`
          : `denied (${outcome.reason})`,
    });

    this.#send({
      jsonrpc: "2.0",
      id: message["id"],
      result:
        outcome.outcome === "selected"
          ? { outcome: { outcome: "selected", optionId: outcome.optionId } }
          : { outcome: { outcome: "cancelled" } },
    });
  }

  /**
   * Write one JSON-RPC message, or drop it.
   *
   * Dropping is correct here and the guard is load-bearing: shutdown ends
   * stdin, then resolves any permission request still outstanding, and the
   * resolution tries to answer an agent that is already going away. Writing
   * to a closed stdin raises ERR_STREAM_WRITE_AFTER_END on the socket, which
   * is an unhandled 'error' event that takes the whole server down.
   */
  #send(message: unknown): void {
    if (this.#child === null || this.#exited !== null || !this.#writable)
      return;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The pipe went away between the check and the write.
      this.#writable = false;
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#child === null) return Promise.reject(new Error("not spawned"));
    if (this.#exited !== null) {
      return Promise.reject(
        new AcpProcessExited(this.#exited.code, this.#exited.signal),
      );
    }
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** Handshake and capability negotiation. */
  async initialize(): Promise<{
    protocolVersion: number;
    capabilities: AgentCapabilities;
    authMethods: readonly { id: string; name?: string }[];
  }> {
    const result = (await this.#request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })) as {
      protocolVersion?: number;
      agentCapabilities?: Record<string, unknown>;
      authMethods?: { id: string; name?: string }[];
    };

    const agentCapabilities = result?.agentCapabilities ?? {};
    this.#capabilities = {
      loadSession: agentCapabilities["loadSession"] === true,
      promptCapabilities:
        (agentCapabilities["promptCapabilities"] as Record<string, unknown>) ??
        {},
      raw: agentCapabilities,
    };
    this.#authMethods = Array.isArray(result?.authMethods)
      ? result.authMethods
      : [];
    const protocolVersion = result?.protocolVersion ?? ACP_PROTOCOL_VERSION;
    this.#emit({
      kind: "initialized",
      protocolVersion,
      capabilities: this.#capabilities,
    });
    return {
      protocolVersion,
      capabilities: this.#capabilities,
      authMethods: this.authMethods,
    };
  }

  /**
   * Authenticate, if the agent asked to be. Returns the method used, or null
   * when none was advertised — the ordinary case for an adapter reading a
   * key from its own environment. Safe to call unconditionally.
   */
  async authenticate(
    preferred: readonly string[] = DEFAULT_AUTH_PREFERENCE,
  ): Promise<string | null> {
    if (this.#authMethods.length === 0) return null;
    const advertised = this.#authMethods.map((method) => method.id);
    const chosen =
      preferred.find((id) => advertised.includes(id)) ?? advertised[0];
    if (chosen === undefined) return null;
    await this.#request("authenticate", { methodId: chosen });
    this.#emit({ kind: "authenticated", methodId: chosen });
    return chosen;
  }

  /** Start a session. `mcpServers` is how the agent is handed meeting tools. */
  async newSession(options: {
    cwd: string;
    mcpServers?: readonly McpServerConfig[];
  }): Promise<string> {
    const result = (await this.#request("session/new", {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    })) as { sessionId?: string };
    if (typeof result?.sessionId !== "string") {
      throw new Error("session/new returned no sessionId");
    }
    this.#sessionId = result.sessionId;
    this.#emit({ kind: "session", sessionId: result.sessionId, loaded: false });
    return result.sessionId;
  }

  /**
   * Resume a session recorded on a previous connection.
   *
   * Only attempted when the agent advertised `loadSession`; returns false
   * otherwise so the caller can fall back to a new session. A failed load is
   * also false rather than a throw — a stale session id from a previous run
   * of the adapter is expected, not exceptional.
   */
  async loadSession(options: {
    sessionId: string;
    cwd: string;
    mcpServers?: readonly McpServerConfig[];
  }): Promise<boolean> {
    if (!this.#capabilities.loadSession) return false;
    try {
      await this.#request("session/load", {
        sessionId: options.sessionId,
        cwd: options.cwd,
        mcpServers: options.mcpServers ?? [],
      });
    } catch (error) {
      this.#emit({
        kind: "warning",
        message: `session/load failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
      return false;
    }
    this.#sessionId = options.sessionId;
    this.#emit({ kind: "session", sessionId: options.sessionId, loaded: true });
    return true;
  }

  /**
   * One turn. Resolves with everything the agent said and why it stopped.
   *
   * A cancelled turn is a normal result, not an error: the text produced
   * before the cancel is still what the agent said, and the room saw it
   * stream in.
   */
  async prompt(text: string): Promise<PromptResult> {
    if (this.#sessionId === null) throw new Error("no ACP session");
    if (this.#turnActive) throw new Error("a turn is already in flight");

    this.#chunks = [];
    this.#cancelRequested = false;
    this.#turnActive = true;
    this.#lastActivity = Date.now();
    this.#emit({ kind: "turn_started" });

    const started = Date.now();
    const turn = this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    }) as Promise<{ stopReason?: string }>;

    try {
      const expiry = await this.#watch(turn, started);
      if (expiry !== null) {
        // Detecting a stuck turn is only half the job: without a cancel the
        // subprocess keeps running, still holding the session, and the next
        // question is handed to an agent already busy with the last one.
        this.cancel();
        await Promise.race([
          turn.then(
            () => true,
            () => true,
          ),
          new Promise((resolve) =>
            setTimeout(resolve, CANCEL_GRACE_MS).unref?.(),
          ),
        ]);
        const message = `agent ${expiry.which} timeout after ${expiry.ms}ms`;
        this.#emit({ kind: "turn_failed", message });
        return { text: this.#chunks.join(""), stopReason: "timeout" };
      }

      const result = await turn;
      const stopReason =
        result?.stopReason ?? (this.#cancelRequested ? "cancelled" : "unknown");
      const body = this.#chunks.join("");
      this.#emit({ kind: "turn_finished", stopReason, chars: body.length });
      return { text: body, stopReason };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "agent turn failed";
      this.#emit({ kind: "turn_failed", message });
      if (error instanceof AcpProcessExited) throw error;
      throw new Error(message);
    } finally {
      this.#turnActive = false;
    }
  }

  /** Resolve with the expiry that fired, or null if the turn finished first. */
  #watch(
    turn: Promise<unknown>,
    started: number,
  ): Promise<{ which: "idle" | "total"; ms: number } | null> {
    const idleLimit = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    const totalLimit = this.#options.totalTimeoutMs ?? DEFAULT_TOTAL_MS;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const idle = Date.now() - this.#lastActivity;
        const total = Date.now() - started;
        if (idle > idleLimit) {
          clearInterval(timer);
          resolve({ which: "idle", ms: idle });
        } else if (total > totalLimit) {
          clearInterval(timer);
          resolve({ which: "total", ms: total });
        }
      }, TIMEOUT_POLL_MS);
      timer.unref?.();
      void turn.then(
        () => {
          clearInterval(timer);
          resolve(null);
        },
        () => {
          clearInterval(timer);
          resolve(null);
        },
      );
    });
  }

  /**
   * Ask the agent to stop the current turn. `session/cancel` is a
   * NOTIFICATION: there is no reply to await, and the turn settles through
   * the outstanding `session/prompt` with `stopReason: "cancelled"`.
   *
   * Cancelling agent work is deliberately independent of stopping speech —
   * the browser silences itself locally, which must never imply the agent
   * should abandon what it is doing.
   */
  cancel(): void {
    if (this.#sessionId === null || !this.alive) return;
    this.#cancelRequested = true;
    this.#send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.#sessionId },
    });
    this.#emit({ kind: "cancelled" });
  }

  /**
   * Graceful shutdown: close stdin, ask politely, then insist. A child left
   * running after the server stops is an orphaned model session nobody is
   * watching.
   */
  async close(): Promise<void> {
    const child = this.#child;
    if (child === null || this.#exited !== null) return;
    this.#closing = true;
    this.cancel();
    this.#writable = false;
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed; the kill below is what matters.
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#exited === null) child.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_GRACE_MS);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
