/**
 * A deterministic ACP agent, for development and tests.
 *
 * It is a real ACP server — same JSON-RPC over stdio, same method names, same
 * update shapes — with a scripted model behind it instead of a model. That
 * makes the whole vertical slice runnable with nothing installed, and makes
 * the hard paths (a tool call, a permission request, a cancellation mid-turn,
 * a crash) reproducible instead of occasional.
 *
 * What it exercises, in one turn:
 *   1. a thought chunk, which the client must drop rather than display
 *   2. streamed message chunks
 *   3. a tool call and its completion update
 *   4. a permission request, when the question implies doing something
 *   5. a SPEAK:/CHAT: response whose CHAT half contains code
 *   6. cancellation, checked between every chunk
 *
 * Behaviour is controlled by environment variables so tests can drive it:
 *   FAKE_ACP_CHUNK_DELAY_MS   delay between chunks (default 80)
 *   FAKE_ACP_PERMISSION       always | never | auto (default auto)
 *   FAKE_ACP_LOAD_SESSION     true | false — advertise the loadSession capability
 *   FAKE_ACP_CRASH_ON_PROMPT  when "1", exit(3) mid-turn to exercise crash handling
 */
import type { Readable, Writable } from "node:stream";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface FakeAgentOptions {
  input: Readable;
  output: Writable;
  chunkDelayMs?: number;
  permissionMode?: "always" | "never" | "auto";
  loadSession?: boolean;
  crashOnPrompt?: boolean;
  exit?: (code: number) => void;
}

/** Words that make a question sound like work rather than an opinion. */
const ACTION_WORDS = [
  "inspect",
  "check",
  "run",
  "fix",
  "look at",
  "investigate",
  "audit",
  "test",
  "deploy",
  "webhook",
];

/**
 * Asking for something to CHANGE, as opposed to something to be looked at.
 *
 * The distinction decides which permission kind this agent asks for, and the
 * two are handled very differently: a read is approved without a human,
 * because a meeting has nobody who can answer, while an edit still waits for
 * one. A fake agent that only ever asked to read could not exercise the half
 * that still stops and waits.
 */
const WRITE_WORDS = ["fix", "deploy", "change", "edit", "update", "write"];

/** Asking for a recommendation, which this agent answers with a question. */
const ASK_WORDS = ["options", "advice", "recommend"];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class FakeAcpAgent {
  #buffer = "";
  #sessions = new Set<string>();
  #sessionSeq = 0;
  #cancelled = new Set<string>();
  #pendingPermissions = new Map<number, (value: unknown) => void>();
  #nextOutboundId = 1;
  readonly #options: Required<
    Omit<FakeAgentOptions, "input" | "output" | "exit">
  > & {
    exit: (code: number) => void;
  };
  readonly #input: Readable;
  readonly #output: Writable;

  constructor(options: FakeAgentOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#options = {
      chunkDelayMs: options.chunkDelayMs ?? 80,
      permissionMode: options.permissionMode ?? "auto",
      loadSession: options.loadSession ?? true,
      crashOnPrompt: options.crashOnPrompt ?? false,
      exit: options.exit ?? ((code: number) => process.exit(code)),
    };
  }

  start(): void {
    this.#input.setEncoding("utf8");
    this.#input.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line !== "") void this.#handle(line);
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  #write(message: JsonRpcMessage): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  #reply(id: unknown, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #replyError(id: unknown, code: number, message: string): void {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #update(sessionId: string, update: Record<string, unknown>): void {
    this.#write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  async #handle(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    // A response to a permission request we sent.
    if (message.method === undefined && message.id !== undefined) {
      const resolver = this.#pendingPermissions.get(Number(message.id));
      if (resolver !== undefined) {
        this.#pendingPermissions.delete(Number(message.id));
        resolver(message.result);
      }
      return;
    }

    switch (message.method) {
      case "initialize":
        this.#reply(message.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: this.#options.loadSession,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: true,
            },
          },
          authMethods: [],
        });
        return;

      case "authenticate":
        this.#reply(message.id, {});
        return;

      case "session/new": {
        this.#sessionSeq += 1;
        const sessionId = `fake-session-${this.#sessionSeq}`;
        this.#sessions.add(sessionId);
        this.#reply(message.id, { sessionId });
        // Real adapters announce their slash commands the moment a session
        // exists, outside any turn. claude-agent-acp sends exactly this, and
        // it is the first thing AMP ever sees from a real agent, so the fake
        // sends it too: an update this build does not recognize, arriving
        // while the agent is idle.
        this.#update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [],
        });
        return;
      }

      case "session/load": {
        const sessionId = String(message.params?.["sessionId"] ?? "");
        if (!this.#options.loadSession) {
          this.#replyError(message.id, -32601, "session/load not supported");
          return;
        }
        // A previously-issued id resumes; anything else is unknown, which is
        // what a restarted adapter would say about a stale id.
        if (this.#sessions.has(sessionId)) this.#reply(message.id, {});
        else
          this.#replyError(message.id, -32602, `unknown session ${sessionId}`);
        return;
      }

      case "session/cancel": {
        const sessionId = String(message.params?.["sessionId"] ?? "");
        this.#cancelled.add(sessionId);
        return;
      }

      case "session/prompt":
        await this.#runTurn(message);
        return;

      default:
        if (message.id !== undefined) {
          this.#replyError(
            message.id,
            -32601,
            `method not found: ${String(message.method)}`,
          );
        }
    }
  }

  async #runTurn(message: JsonRpcMessage): Promise<void> {
    const sessionId = String(message.params?.["sessionId"] ?? "");
    if (!this.#sessions.has(sessionId)) {
      this.#replyError(message.id, -32602, `unknown session ${sessionId}`);
      return;
    }
    this.#cancelled.delete(sessionId);

    const promptText = extractPromptText(message.params?.["prompt"]);
    const question = extractQuestion(promptText);
    const needsWork = ACTION_WORDS.some((word) =>
      question.toLowerCase().includes(word),
    );

    // Reasoning first, which the client is required to drop on the floor.
    this.#update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Considering the room's last few turns." },
    });

    if (this.#options.crashOnPrompt) {
      // No reply to the outstanding request: this is what a dying adapter
      // looks like from the client's side.
      this.#options.exit(3);
      return;
    }

    if (needsWork) {
      this.#update(sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the relevant code", status: "in_progress" },
          { content: "Report back to the meeting", status: "pending" },
        ],
      });

      const granted = await this.#askPermission(sessionId, question);
      if (this.#isCancelled(sessionId)) {
        this.#reply(message.id, { stopReason: "cancelled" });
        return;
      }
      if (!granted) {
        const refusal =
          "SPEAK:\nI need approval before I can look at that, so I have not run anything yet.\nCHAT:\nPermission was declined for the requested tool call. Nothing was executed.";
        await this.#stream(sessionId, refusal);
        this.#reply(message.id, { stopReason: "end_turn" });
        return;
      }

      this.#update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "read src/webhooks/retry.ts",
        kind: "read",
        status: "in_progress",
      });
      await sleep(this.#options.chunkDelayMs);
      this.#update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
      });
    }

    if (this.#isCancelled(sessionId)) {
      this.#reply(message.id, { stopReason: "cancelled" });
      return;
    }

    const response = ASK_WORDS.some((word) =>
      question.toLowerCase().includes(word),
    )
      ? askResponse(question)
      : needsWork
        ? workResponse(question)
        : opinionResponse(question);
    const finished = await this.#stream(sessionId, response);
    this.#reply(message.id, {
      stopReason: finished ? "end_turn" : "cancelled",
    });
  }

  /** Stream a response in chunks, checking for cancellation between each. */
  async #stream(sessionId: string, text: string): Promise<boolean> {
    const chunks = splitForStreaming(text);
    for (const chunk of chunks) {
      if (this.#isCancelled(sessionId)) return false;
      this.#update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
      await sleep(this.#options.chunkDelayMs);
    }
    return !this.#isCancelled(sessionId);
  }

  #isCancelled(sessionId: string): boolean {
    return this.#cancelled.has(sessionId);
  }

  /** Ask the client for permission and wait for the human's answer. */
  async #askPermission(sessionId: string, question: string): Promise<boolean> {
    if (this.#options.permissionMode === "never") return true;

    const id = this.#nextOutboundId++;
    const answer = new Promise<unknown>((resolve) => {
      this.#pendingPermissions.set(id, resolve);
    });
    this.#write({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "call_1",
          ...(WRITE_WORDS.some((word) => question.toLowerCase().includes(word))
            ? { title: "Edit files in the workspace", kind: "edit" }
            : { title: "Read files in the workspace", kind: "read" }),
          rawInput: {
            path: "src/webhooks/retry.ts",
            reason: question.slice(0, 120),
          },
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          {
            optionId: "allow_always",
            name: "Always allow",
            kind: "allow_always",
          },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
      },
    });

    const result = (await answer) as
      { outcome?: { outcome?: string; optionId?: string } } | undefined;
    const outcome = result?.outcome;
    return (
      outcome?.outcome === "selected" &&
      typeof outcome.optionId === "string" &&
      outcome.optionId.startsWith("allow")
    );
  }
}

/** ACP prompts are content blocks; the fake agent only reads text ones. */
function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      const record = (block ?? {}) as Record<string, unknown>;
      return typeof record["text"] === "string" ? record["text"] : "";
    })
    .join("\n");
}

/** Pull the addressed utterance back out of the gateway's prompt. */
export function extractQuestion(prompt: string): string {
  const marker = "The latest utterance explicitly addressed to you:";
  const index = prompt.indexOf(marker);
  if (index === -1) return prompt.slice(-200).trim();
  const tail = prompt.slice(index + marker.length).trim();
  const firstLine = tail.split("\n")[0] ?? "";
  const colon = firstLine.indexOf(":");
  return colon === -1 ? firstLine.trim() : firstLine.slice(colon + 1).trim();
}

/**
 * A turn that ends by handing the conversation back.
 *
 * The other two responses finish on a statement, so neither can exercise what
 * happens after the agent asks something — which is where a real reply
 * arrives with no name attached to it, because people answering a question
 * say "yes", not "Cofounder, yes".
 */
function askResponse(question: string): string {
  return [
    "SPEAK:",
    `On "${trim(question)}" — there are two paths, and they differ in blast radius. Want me to look at the inbound one first?`,
  ].join("\n");
}

function opinionResponse(question: string): string {
  return [
    "SPEAK:",
    `On "${trim(question)}" — my read is that we should cap retries at three with exponential backoff, and treat anything beyond that as a dead letter rather than a retry.`,
    "CHAT:",
    "Reasoning in more detail: unbounded retries hide the failure instead of surfacing it, and a dead-letter queue gives us a place to look. Suggested shape:",
    "```ts",
    "const RETRY_LIMIT = 3;",
    "const backoffMs = (attempt: number) => 2 ** attempt * 500;",
    "```",
  ].join("\n");
}

function workResponse(question: string): string {
  return [
    "SPEAK:",
    `I looked at that. Short version: the retry path gives up after the third attempt and drops the event instead of dead-lettering it. Details are in the chat.`,
    "CHAT:",
    `Investigated: ${trim(question)}`,
    "- src/webhooks/retry.ts caps attempts at 3",
    "- the failure branch logs and returns, with no dead-letter write",
    "```ts",
    "if (attempt >= RETRY_LIMIT) return; // <- event is lost here",
    "```",
  ].join("\n");
}

function trim(text: string, limit = 120): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** Chunk on word boundaries, the way a streaming model actually arrives. */
export function splitForStreaming(text: string, size = 40): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/(\s+)/u)) {
    current += word;
    if (current.length >= size) {
      chunks.push(current);
      current = "";
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}
