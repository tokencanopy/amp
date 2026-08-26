/**
 * The Meeting Gateway: the only place the meeting and the agent meet.
 *
 *   meeting platform → provider → GATEWAY → ACP client → coding agent
 *                                    ↑                        │
 *                                    └──── meeting MCP tools ──┘
 *
 * The agent stays the agent of record. Its model, workspace, instructions,
 * skills, tools, session, and memory are its own; this gateway adds a
 * communication channel and nothing else. It decides *when* the agent is
 * addressed, hands it the room's context, streams what it does back to the
 * room, and routes anything sensitive to a human. It never speaks for the
 * agent and never approves on its behalf.
 */
import { randomUUID } from "node:crypto";

import {
  AcpClient,
  AcpProcessExited,
  type AcpClientEvent,
  type AgentCapabilities,
  type McpServerConfig,
  type PermissionOutcome,
  type PermissionRequest,
} from "../acp/client.js";
import { BoundedLog } from "../acp/sanitize.js";
import type { AgentDefinition } from "../acp/registry.js";
import type {
  AgentStatus,
  ChatMessage,
  MeetingEvent,
  MeetingProvider,
  MeetingMemory,
  MemoryKind,
  Participant,
  TranscriptEntry,
} from "../domain.js";

import type { MeetingStore } from "../store/store.js";
import { decideAttention, type AttentionDecision } from "./attention.js";
import { buildRollingSummary, deriveTopic } from "./context.js";
import { buildAgentPrompt, planSpeech } from "./prompt.js";

export interface PendingPermission {
  requestId: string;
  meetingId: string;
  toolName: string;
  toolKind: string;
  detail: string;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
}

export type GatewayEvent =
  | { type: "transcript"; entry: TranscriptEntry }
  | { type: "chat"; message: ChatMessage }
  | { type: "participant"; participant: Participant }
  | { type: "meeting_status"; status: string; topic: string | null }
  | { type: "agent_status"; status: AgentStatus; detail: string }
  | {
      type: "attention";
      triggered: boolean;
      reason: string;
      detail: string;
      text: string;
      speaker: string;
    }
  | { type: "acp_event"; kind: string; description: string; at: string }
  | { type: "caption"; speakerName: string; text: string }
  | { type: "agent_stream"; text: string }
  | { type: "permission_requested"; request: PendingPermission }
  | { type: "permission_resolved"; requestId: string; outcome: string }
  | { type: "speak"; text: string; source: string }
  | { type: "memory"; memory: MeetingMemory }
  | { type: "log"; line: string; at: string }
  | {
      type: "session";
      acpSessionId: string | null;
      capabilities: AgentCapabilities | null;
      agentId: string | null;
      command: string | null;
    };

export type GatewayPublisher = (meetingId: string, event: GatewayEvent) => void;

export interface GatewayOptions {
  store: MeetingStore;
  /**
   * Providers by name, matching the `provider` recorded on each meeting. A
   * map rather than one provider because a simulated meeting and a real one
   * can be live at the same time on the same build — which is how the two get
   * compared without a redeploy.
   */
  providers: Record<string, MeetingProvider>;
  publish: GatewayPublisher;
  /** How long a permission request waits for a human before it is denied. */
  permissionTimeoutMs?: number;
  /** Built per meeting so the agent's MCP tools are scoped to that meeting. */
  mcpServers?: (context: {
    meetingId: string;
    mcpToken: string;
  }) => McpServerConfig[];
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

interface MeetingRuntime {
  meetingId: string;
  client: AcpClient | null;
  agent: AgentDefinition | null;
  status: AgentStatus;
  capabilities: AgentCapabilities | null;
  acpSessionId: string | null;
  log: BoundedLog;
  pending: Map<
    string,
    {
      request: PendingPermission;
      resolve: (outcome: PermissionOutcome) => void;
      timer: NodeJS.Timeout;
    }
  >;
  /**
   * The MCP capability for this meeting. Held in memory only: it is an
   * authentication token, and the brief is explicit that those are not
   * persisted.
   */
  mcpToken: string;
  consuming: boolean;
  /** Set while a turn is in flight, so a second question queues rather than
   *  racing the first. */
  turn: Promise<void> | null;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export class MeetingGateway {
  readonly #store: MeetingStore;
  readonly #providers: Record<string, MeetingProvider>;
  readonly #publish: GatewayPublisher;
  readonly #options: GatewayOptions;
  readonly #runtimes = new Map<string, MeetingRuntime>();

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#publish = options.publish;
    this.#options = options;
  }

  get store(): MeetingStore {
    return this.#store;
  }

  /** The provider driving one meeting, resolved from what it was created as. */
  providerFor(meetingId: string): MeetingProvider {
    const name = this.#store.requireMeeting(meetingId).provider;
    const provider = this.#providers[name];
    if (provider === undefined) {
      throw new Error(
        `meeting ${meetingId} was created with the "${name}" provider, which is not configured`,
      );
    }
    return provider;
  }

  /** A provider by name, for routes that must create a meeting before one exists. */
  providerNamed(name: string): MeetingProvider | undefined {
    return this.#providers[name];
  }

  #runtime(meetingId: string): MeetingRuntime {
    let runtime = this.#runtimes.get(meetingId);
    if (runtime === undefined) {
      runtime = {
        meetingId,
        client: null,
        agent: null,
        status: "disconnected",
        capabilities: null,
        acpSessionId: null,
        log: new BoundedLog(),
        pending: new Map(),
        mcpToken: randomUUID(),
        consuming: false,
        turn: null,
      };
      this.#runtimes.set(meetingId, runtime);
    }
    return runtime;
  }

  /** Read-only view for the API. */
  snapshot(meetingId: string): {
    status: AgentStatus;
    acpSessionId: string | null;
    capabilities: AgentCapabilities | null;
    agent: {
      id: string;
      label: string;
      command: string;
      args: string[];
    } | null;
    pendingPermissions: PendingPermission[];
    log: readonly { at: string; line: string }[];
  } {
    const runtime = this.#runtime(meetingId);
    return {
      status: runtime.status,
      acpSessionId: runtime.acpSessionId,
      capabilities: runtime.capabilities,
      agent:
        runtime.agent === null
          ? null
          : {
              id: runtime.agent.id,
              label: runtime.agent.label,
              command: runtime.agent.command,
              args: runtime.agent.args,
            },
      pendingPermissions: [...runtime.pending.values()].map(
        (entry) => entry.request,
      ),
      log: runtime.log.all(),
    };
  }

  /** The MCP capability for a meeting — checked by the MCP bridge routes. */
  verifyMcpToken(meetingId: string, token: string): boolean {
    const runtime = this.#runtimes.get(meetingId);
    return runtime !== undefined && runtime.mcpToken === token;
  }

  mcpToken(meetingId: string): string {
    return this.#runtime(meetingId).mcpToken;
  }

  #setStatus(meetingId: string, status: AgentStatus, detail = ""): void {
    const runtime = this.#runtime(meetingId);
    runtime.status = status;
    this.#publish(meetingId, { type: "agent_status", status, detail });
  }

  #logLine(meetingId: string, line: string): void {
    const record = this.#runtime(meetingId).log.push(line);
    this.#publish(meetingId, {
      type: "log",
      line: record.line,
      at: record.at,
    });
  }

  // ---- meeting lifecycle -------------------------------------------------

  /**
   * Begin consuming provider events for a meeting. Idempotent: starting a
   * meeting twice must not produce two consumers racing the same queue.
   */
  startConsuming(meetingId: string): void {
    const runtime = this.#runtime(meetingId);
    if (runtime.consuming) return;
    runtime.consuming = true;
    void this.#consume(meetingId).finally(() => {
      runtime.consuming = false;
    });
  }

  async #consume(meetingId: string): Promise<void> {
    for await (const event of this.providerFor(meetingId).events(meetingId)) {
      try {
        await this.#onMeetingEvent(event);
      } catch (error) {
        this.#logLine(
          meetingId,
          `event handling failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
  }

  async #onMeetingEvent(event: MeetingEvent): Promise<void> {
    const meetingId = event.meetingId;
    switch (event.type) {
      case "meeting_started":
        this.#publish(meetingId, {
          type: "meeting_status",
          status: "live",
          topic: this.#store.requireMeeting(meetingId).topic,
        });
        this.#setStatus(
          meetingId,
          this.#runtime(meetingId).client === null
            ? "disconnected"
            : "listening",
        );
        return;

      case "meeting_ended":
        this.#publish(meetingId, {
          type: "meeting_status",
          status: "ended",
          topic: this.#store.requireMeeting(meetingId).topic,
        });
        return;

      case "participant_joined":
        this.#publish(meetingId, {
          type: "participant",
          participant: event.participant,
        });
        return;

      case "participant_left":
        return;

      case "utterance": {
        // An unsettled hypothesis is a caption, not a transcript entry. It is
        // shown live and then forgotten; only the final text is recorded and
        // only the final text can wake the agent.
        if (event.isFinal === false) {
          this.#publish(meetingId, {
            type: "caption",
            speakerName: event.speakerName,
            text: event.text,
          });
          return;
        }
        const entry = this.#store.appendTranscript({
          meetingId,
          participantId: event.participantId,
          speakerName: event.speakerName,
          speakerKind: event.speakerKind,
          text: event.text,
          addressed: event.addressed,
          createdAt: event.at,
        });
        this.#publish(meetingId, { type: "transcript", entry });
        this.#refreshContext(meetingId);
        await this.#considerAttention(meetingId, {
          text: event.text,
          speakerName: event.speakerName,
          speakerKind: event.speakerKind,
          addressed: event.addressed,
          channel: "speech",
          entryId: entry.id,
          participantId: event.participantId,
        });
        return;
      }

      case "chat": {
        const message = this.#store.appendChat({
          meetingId,
          participantId: event.participantId,
          speakerName: event.speakerName,
          speakerKind: event.speakerKind,
          text: event.text,
          addressed: event.addressed,
          createdAt: event.at,
        });
        this.#publish(meetingId, { type: "chat", message });
        await this.#considerAttention(meetingId, {
          text: event.text,
          speakerName: event.speakerName,
          speakerKind: event.speakerKind,
          addressed: event.addressed,
          channel: "chat",
          entryId: message.id,
          participantId: event.participantId,
        });
        return;
      }
    }
  }

  /** Recompute topic and rolling summary from what has been said. */
  #refreshContext(meetingId: string): void {
    const entries = this.#store.listTranscript(meetingId, 500);
    const memories = this.#store.listMemories(meetingId, { status: "active" });
    const topic = deriveTopic(entries);
    const summary = buildRollingSummary(entries, memories);
    this.#store.updateMeetingContext(meetingId, { topic, summary });
  }

  // ---- attention ---------------------------------------------------------

  async #considerAttention(
    meetingId: string,
    input: {
      text: string;
      speakerName: string;
      speakerKind: Participant["kind"];
      addressed: boolean;
      channel: "speech" | "chat";
      entryId: string;
      participantId: string;
    },
  ): Promise<void> {
    const meeting = this.#store.requireMeeting(meetingId);
    const decision: AttentionDecision = decideAttention({
      text: input.text,
      channel: input.channel,
      addressed: input.addressed,
      speakerKind: input.speakerKind,
      wakeNames: [meeting.agentDisplayName, ...meeting.wakeNames],
    });

    this.#publish(meetingId, {
      type: "attention",
      triggered: decision.triggered,
      reason: decision.reason,
      detail: decision.detail,
      text: input.text,
      speaker: input.speakerName,
    });

    if (!decision.triggered) return;

    const runtime = this.#runtime(meetingId);
    if (runtime.client === null || runtime.acpSessionId === null) {
      this.#logLine(
        meetingId,
        "addressed, but no agent is connected — nothing was sent",
      );
      return;
    }

    // A new direct question while a turn is running is a barge-in: stop
    // speaking immediately (the browser handles that on receipt), but do NOT
    // cancel the agent's work — silencing a voice and abandoning work are
    // different intentions, and only a person gets to choose the second.
    if (runtime.turn !== null) {
      this.#publish(meetingId, { type: "speak", text: "", source: "barge_in" });
      this.#logLine(meetingId, "queued: a turn is already in flight");
      await runtime.turn.catch(() => {});
    }

    const turn = this.#runTurn(meetingId, {
      speakerName: input.speakerName,
      text: input.text,
    });
    runtime.turn = turn;
    await turn.finally(() => {
      if (runtime.turn === turn) runtime.turn = null;
    });
  }

  // ---- the agent turn ----------------------------------------------------

  async #runTurn(
    meetingId: string,
    trigger: { speakerName: string; text: string },
  ): Promise<void> {
    const runtime = this.#runtime(meetingId);
    const client = runtime.client;
    if (client === null) return;

    const meeting = this.#store.requireMeeting(meetingId);
    const prompt = buildAgentPrompt({
      meetingTitle: meeting.title,
      agentName: meeting.agentDisplayName,
      participants: this.#store.listParticipants(meetingId),
      topic: meeting.topic,
      summary: meeting.summary,
      recentTranscript: this.#store.recentTranscript(meetingId, 12),
      trigger,
      memories: this.#store.listMemories(meetingId, { status: "active" }),
    });

    this.#setStatus(meetingId, "thinking", `answering ${trigger.speakerName}`);
    this.#store.recordAgentEvent(
      meetingId,
      "turn_started",
      `triggered by ${trigger.speakerName}`,
    );

    try {
      const result = await client.prompt(prompt);
      if (result.stopReason === "cancelled") {
        this.#setStatus(meetingId, "listening", "turn cancelled");
        this.#store.recordAgentEvent(meetingId, "turn_cancelled", "cancelled");
        return;
      }

      const plan = planSpeech(result.text);
      this.#store.recordAgentEvent(
        meetingId,
        "turn_finished",
        `stop=${result.stopReason} speech=${plan.decision}`,
      );

      // Chat first: the details should be readable before the spoken summary
      // finishes, not after.
      if (plan.chat !== null && plan.chat.trim() !== "") {
        await this.providerFor(meetingId).sendChat(meetingId, plan.chat);
      }
      if (plan.speak !== null) {
        this.#setStatus(meetingId, "speaking", "");
        await this.providerFor(meetingId).sendSpeech(meetingId, plan.speak);
        this.#publish(meetingId, {
          type: "speak",
          text: plan.speak,
          source: plan.decision,
        });
      } else {
        this.#logLine(
          meetingId,
          `response not spoken (${plan.decision}); posted to meeting chat instead`,
        );
      }
      this.#setStatus(meetingId, "listening", "");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "agent turn failed";
      // A turn cut short because an operator shut the agent down is not a
      // failure of the turn. Only an unasked-for death is.
      const interrupted = error instanceof AcpProcessExited && client.closing;
      this.#store.recordAgentEvent(
        meetingId,
        interrupted ? "turn_interrupted" : "turn_failed",
        message,
      );
      this.#logLine(
        meetingId,
        interrupted
          ? `turn interrupted by shutdown`
          : `turn failed: ${message}`,
      );
      this.#setStatus(
        meetingId,
        client.alive ? "listening" : interrupted ? "disconnected" : "error",
        interrupted ? "" : message,
      );
      if (!client.alive) {
        runtime.client = null;
        runtime.acpSessionId = null;
        this.#publish(meetingId, {
          type: "session",
          acpSessionId: null,
          capabilities: runtime.capabilities,
          agentId: runtime.agent?.id ?? null,
          command: runtime.agent?.command ?? null,
        });
      }
    }
  }

  // ---- connecting an agent ----------------------------------------------

  /**
   * Launch an agent and give it a session for this meeting.
   *
   * Launching is always an explicit, human-initiated action: nothing here
   * runs on a timer or in response to something said in the room. The caller
   * has already been shown the command, arguments, and working directory.
   */
  async connectAgent(
    meetingId: string,
    agent: AgentDefinition,
    options: { workspacePath: string; resume?: boolean },
  ): Promise<{
    acpSessionId: string;
    capabilities: AgentCapabilities;
    resumed: boolean;
  }> {
    const runtime = this.#runtime(meetingId);
    if (runtime.client !== null) {
      await this.disconnectAgent(meetingId);
    }

    this.#setStatus(meetingId, "connecting", agent.label);
    const client = new AcpClient({
      command: agent.command,
      args: agent.args,
      cwd: options.workspacePath,
      onEvent: (event) => this.#onAcpEvent(meetingId, event),
      requestPermission: (request) => this.#onPermission(meetingId, request),
      ...(this.#options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.#options.idleTimeoutMs }),
      ...(this.#options.totalTimeoutMs === undefined
        ? {}
        : { totalTimeoutMs: this.#options.totalTimeoutMs }),
    });

    runtime.client = client;
    runtime.agent = agent;

    try {
      client.spawnProcess();
      const handshake = await client.initialize();
      await client.authenticate();
      runtime.capabilities = handshake.capabilities;

      const mcpServers =
        this.#options.mcpServers?.({
          meetingId,
          mcpToken: runtime.mcpToken,
        }) ?? [];

      // Resume the meeting's previous session when the adapter supports it,
      // so an agent reconnecting to a meeting in progress keeps its own
      // memory of it rather than starting over.
      let resumed = false;
      const previous = this.#store.latestAcpSession(meetingId, agent.id);
      if (
        options.resume !== false &&
        previous !== null &&
        handshake.capabilities.loadSession
      ) {
        resumed = await client.loadSession({
          sessionId: previous.acpSessionId,
          cwd: options.workspacePath,
          mcpServers,
        });
      }

      const acpSessionId = resumed
        ? (client.sessionId as string)
        : await client.newSession({
            cwd: options.workspacePath,
            mcpServers,
          });

      if (!resumed) {
        this.#store.recordAcpSession({
          meetingId,
          agentId: agent.id,
          acpSessionId,
          workspacePath: options.workspacePath,
        });
      }
      this.#store.upsertAgentDefinition({
        id: agent.id,
        label: agent.label,
        command: agent.command,
        args: agent.args,
        description: agent.description,
      });
      this.#store.setMeetingAgent(meetingId, agent.id, options.workspacePath);

      runtime.acpSessionId = acpSessionId;
      this.#setStatus(meetingId, "listening", agent.label);
      this.#publish(meetingId, {
        type: "session",
        acpSessionId,
        capabilities: handshake.capabilities,
        agentId: agent.id,
        command: [agent.command, ...agent.args].join(" "),
      });
      this.#store.recordAgentEvent(
        meetingId,
        "agent_connected",
        `${agent.id} session=${acpSessionId} resumed=${resumed}`,
      );

      return { acpSessionId, capabilities: handshake.capabilities, resumed };
    } catch (error) {
      runtime.client = null;
      runtime.acpSessionId = null;
      await client.close();
      const message =
        error instanceof Error ? error.message : "failed to launch agent";
      this.#setStatus(meetingId, "error", message);
      this.#store.recordAgentEvent(meetingId, "agent_connect_failed", message);
      throw new Error(message);
    }
  }

  async disconnectAgent(meetingId: string): Promise<void> {
    const runtime = this.#runtime(meetingId);
    for (const entry of runtime.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ outcome: "cancelled", reason: "agent disconnected" });
    }
    runtime.pending.clear();

    if (runtime.client !== null) {
      await runtime.client.close();
      this.#store.recordAgentEvent(meetingId, "agent_disconnected", "closed");
    }
    runtime.client = null;
    runtime.acpSessionId = null;
    this.#store.closeAcpSessions(meetingId);
    this.#setStatus(meetingId, "disconnected", "");
  }

  /** Cancel the agent's current work. Never touches speech. */
  cancelAgentWork(meetingId: string): boolean {
    const runtime = this.#runtime(meetingId);
    if (runtime.client === null) return false;
    runtime.client.cancel();
    this.#store.recordAgentEvent(meetingId, "cancel_requested", "operator");
    this.#logLine(meetingId, "cancel requested by an operator");
    return true;
  }

  #onAcpEvent(meetingId: string, event: AcpClientEvent): void {
    switch (event.kind) {
      case "update":
        if (event.event.type === "message_chunk") {
          this.#publish(meetingId, {
            type: "agent_stream",
            text: event.event.text,
          });
        } else if (event.event.type !== "unknown") {
          // Tool activity is status, not speech — the room sees that work is
          // happening without anyone reading tool output aloud.
          //
          // An update this build cannot classify is deliberately NOT status.
          // Adapters emit them while idle — claude-agent-acp announces its
          // slash commands the moment a session exists — so treating unknown
          // as work makes the room believe the agent is busy before anyone
          // has addressed it. It is still published to the activity log
          // below, which is where something unrecognized belongs.
          this.#setStatus(meetingId, "working", event.description);
        }
        this.#publish(meetingId, {
          type: "acp_event",
          kind: event.event.type,
          description: event.description,
          at: new Date().toISOString(),
        });
        return;

      case "stderr":
        this.#logLine(meetingId, `agent: ${event.line}`);
        return;

      case "warning":
        this.#logLine(meetingId, `warning: ${event.message}`);
        return;

      case "exited":
        this.#logLine(
          meetingId,
          `agent process exited (code ${event.code ?? "none"}, signal ${event.signal ?? "none"})${
            event.expected ? " as asked" : " unexpectedly"
          }`,
        );
        this.#store.recordAgentEvent(
          meetingId,
          "agent_exited",
          `code=${event.code ?? "none"} signal=${event.signal ?? "none"} expected=${event.expected}`,
        );
        // A process we asked to stop is not a fault. Only an exit nobody
        // asked for puts the agent into an error state.
        if (!event.expected) {
          this.#setStatus(meetingId, "error", "agent process exited");
        }
        return;

      default:
        this.#publish(meetingId, {
          type: "acp_event",
          kind: event.kind,
          description: describeClientEvent(event),
          at: new Date().toISOString(),
        });
    }
  }

  // ---- permissions -------------------------------------------------------

  /**
   * Put a permission request in front of a human and wait.
   *
   * There is no auto-approve path, and the timeout denies rather than
   * allows. An unanswered request is not consent.
   */
  #onPermission(
    meetingId: string,
    request: PermissionRequest,
  ): Promise<PermissionOutcome> {
    const runtime = this.#runtime(meetingId);
    const pending: PendingPermission = {
      requestId: `${request.requestId}_${randomUUID().slice(0, 8)}`,
      meetingId,
      toolName: request.toolName,
      toolKind: request.toolKind,
      detail: request.detail,
      options: request.options,
      requestedAt: new Date().toISOString(),
    };

    this.#store.recordAgentEvent(
      meetingId,
      "permission_requested",
      `${pending.toolName} (${pending.toolKind})`,
    );
    this.#setStatus(
      meetingId,
      "working",
      `waiting for approval: ${pending.toolName}`,
    );

    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(pending.requestId);
        this.#publish(meetingId, {
          type: "permission_resolved",
          requestId: pending.requestId,
          outcome: "denied (no answer)",
        });
        this.#store.recordAgentEvent(
          meetingId,
          "permission_denied",
          `${pending.toolName}: timed out`,
        );
        resolve({ outcome: "cancelled", reason: "nobody answered in time" });
      }, this.#options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
      timer.unref?.();

      runtime.pending.set(pending.requestId, {
        request: pending,
        resolve,
        timer,
      });
      this.#publish(meetingId, {
        type: "permission_requested",
        request: pending,
      });
    });
  }

  /** Answer a pending request. `optionId` null means deny. */
  respondToPermission(
    meetingId: string,
    requestId: string,
    optionId: string | null,
  ): boolean {
    const runtime = this.#runtime(meetingId);
    const entry = runtime.pending.get(requestId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    runtime.pending.delete(requestId);

    const allowed =
      optionId !== null &&
      entry.request.options.some((option) => option.optionId === optionId);

    entry.resolve(
      allowed
        ? { outcome: "selected", optionId: optionId as string }
        : { outcome: "cancelled", reason: "denied by a meeting participant" },
    );
    this.#store.recordAgentEvent(
      meetingId,
      allowed ? "permission_allowed" : "permission_denied",
      `${entry.request.toolName}${allowed ? ` via ${optionId}` : ""}`,
    );
    this.#publish(meetingId, {
      type: "permission_resolved",
      requestId,
      outcome: allowed ? `allowed (${optionId})` : "denied",
    });
    return true;
  }

  // ---- operations the MCP tools call ------------------------------------

  async agentSendChat(meetingId: string, text: string): Promise<void> {
    this.#requireLiveMeeting(meetingId);
    await this.providerFor(meetingId).sendChat(meetingId, text);
  }

  async agentSpeak(meetingId: string, text: string): Promise<void> {
    this.#requireLiveMeeting(meetingId);
    const plan = planSpeech(text);
    const spoken = plan.speak ?? null;
    if (spoken === null) {
      // The agent asked to say something unspeakable. Post it instead of
      // reading a code block to the room.
      await this.providerFor(meetingId).sendChat(meetingId, text);
      this.#logLine(
        meetingId,
        `meeting_speak fell back to chat (${plan.decision})`,
      );
      return;
    }
    await this.providerFor(meetingId).sendSpeech(meetingId, spoken);
    this.#publish(meetingId, { type: "speak", text: spoken, source: "mcp" });
  }

  remember(
    meetingId: string,
    input: {
      kind: MemoryKind;
      content: string;
      sourceParticipantId?: string;
      sourceTranscriptEntryId?: string;
    },
  ): MeetingMemory {
    this.#store.requireMeeting(meetingId);
    // Provenance is resolved from the transcript rather than trusted from the
    // caller: a memory whose source cannot be pointed at is an assertion.
    let sourceTimestamp: string | undefined;
    let participantId = input.sourceParticipantId;
    if (input.sourceTranscriptEntryId !== undefined) {
      const entry = this.#store
        .listTranscript(meetingId, 1_000)
        .find((candidate) => candidate.id === input.sourceTranscriptEntryId);
      if (entry === undefined) {
        throw new Error(
          `transcript entry ${input.sourceTranscriptEntryId} is not part of this meeting`,
        );
      }
      sourceTimestamp = entry.createdAt;
      participantId = participantId ?? entry.participantId;
    }

    const memory = this.#store.addMemory({
      meetingId,
      kind: input.kind,
      content: input.content,
      sourceParticipantId: participantId ?? null,
      sourceTranscriptEntryId: input.sourceTranscriptEntryId ?? null,
      sourceTimestamp: sourceTimestamp ?? null,
    });
    this.#publish(meetingId, { type: "memory", memory });
    this.#refreshContext(meetingId);
    return memory;
  }

  supersedeMemory(meetingId: string, memoryId: string): MeetingMemory {
    const memory = this.#store.supersedeMemory(meetingId, memoryId);
    this.#publish(meetingId, { type: "memory", memory });
    this.#refreshContext(meetingId);
    return memory;
  }

  #requireLiveMeeting(meetingId: string): void {
    const meeting = this.#store.requireMeeting(meetingId);
    if (meeting.status !== "live") {
      throw new Error(`meeting ${meetingId} is not live`);
    }
  }

  /** Terminate every child process. Called on server shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#runtimes.keys()].map((meetingId) =>
        this.disconnectAgent(meetingId).catch(() => {}),
      ),
    );
  }
}

function describeClientEvent(event: AcpClientEvent): string {
  switch (event.kind) {
    case "spawned":
      return `launched ${event.command} ${event.args.join(" ")} in ${event.cwd}`;
    case "initialized":
      return `initialized (ACP v${event.protocolVersion}, loadSession=${event.capabilities.loadSession})`;
    case "authenticated":
      return `authenticated with ${event.methodId}`;
    case "session":
      return `${event.loaded ? "resumed" : "created"} session ${event.sessionId}`;
    case "turn_started":
      return "turn started";
    case "turn_finished":
      return `turn finished (${event.stopReason}, ${event.chars} chars)`;
    case "turn_failed":
      return `turn failed: ${event.message}`;
    case "permission_requested":
      return `permission requested: ${event.request.toolName}`;
    case "permission_resolved":
      return `permission ${event.outcome}`;
    case "cancelled":
      return "cancellation sent";
    default:
      return event.kind;
  }
}
