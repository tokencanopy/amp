/**
 * The MCP server's client for the meeting gateway.
 *
 * The MCP server is spawned by the AGENT, not by this app's server, so it
 * cannot reach meeting state in-process. It calls back over loopback HTTP
 * carrying a per-meeting capability that was handed to it through its
 * environment. Three consequences worth being explicit about:
 *
 *   - the capability scopes every call to one meeting, so a tool call cannot
 *     touch a meeting the agent was not invited to;
 *   - it is minted per connection and held only in memory, so it is not in
 *     the database, in a config file, or in the transcript;
 *   - the gateway re-validates the meeting on every call, so a tool call
 *     against an ended meeting fails rather than mutating history.
 */
export interface BridgeConfig {
  baseUrl: string;
  meetingId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export class MeetingBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MeetingBridgeError";
  }
}

export class MeetingBridge {
  readonly #config: BridgeConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: BridgeConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async #call<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(path, this.#config.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.#fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "x-meeting-id": this.#config.meetingId,
        "x-meeting-mcp-token": this.#config.token,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new MeetingBridgeError(
        response.status,
        payload.error?.code ?? "request_failed",
        payload.error?.message ??
          `Meeting gateway returned ${response.status}.`,
      );
    }
    return payload as T;
  }

  getActive() {
    return this.#call<{ meeting: Record<string, unknown> }>("/api/mcp/active");
  }

  getParticipants() {
    return this.#call<{ items: Record<string, unknown>[] }>(
      "/api/mcp/participants",
    );
  }

  getRecentTranscript(limit: number) {
    return this.#call<{ items: Record<string, unknown>[] }>(
      "/api/mcp/transcript",
      { query: { limit: String(limit) } },
    );
  }

  sendChat(text: string) {
    return this.#call<{ posted: boolean }>("/api/mcp/chat", {
      method: "POST",
      body: { text },
    });
  }

  speak(text: string) {
    return this.#call<{ spoken: boolean }>("/api/mcp/speak", {
      method: "POST",
      body: { text },
    });
  }

  remember(input: {
    kind: string;
    content: string;
    sourceParticipantId?: string;
    sourceTranscriptEntryId?: string;
  }) {
    return this.#call<{ memory: Record<string, unknown> }>(
      "/api/mcp/memories",
      {
        method: "POST",
        body: input,
      },
    );
  }

  listMemories(filter: { kind?: string; status?: string }) {
    const query: Record<string, string> = {};
    if (filter.kind !== undefined) query["kind"] = filter.kind;
    if (filter.status !== undefined) query["status"] = filter.status;
    return this.#call<{ items: Record<string, unknown>[] }>(
      "/api/mcp/memories",
      { query },
    );
  }
}
