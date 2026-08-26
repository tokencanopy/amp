/**
 * `MeetingProvider` backed by a Recall.ai meeting bot.
 *
 * The bot is a participant in a real call. It hears the room (transcript
 * webhooks), can post to the meeting's chat, and — through Output Media —
 * speaks by having its camera render a webpage whose audio is streamed into
 * the call.
 *
 * Three things about that speech path are worth knowing before wiring it up,
 * because they are vendor constraints rather than choices:
 *
 *   1. Output Media always carries VIDEO. There is no audio-only mode and the
 *      camera cannot be turned off, so the agent is a visible tile. Arguably
 *      right — a participant that can speak should be visible — but forced.
 *   2. The page is the speech engine. `AMP_RECALL_SPEAKER_URL` points at a
 *      page that must turn text into audible audio on its own; the meeting
 *      simulator's browser `speechSynthesis` may not have voices installed in
 *      a server-side browser, so a real TTS probably belongs there.
 *   3. Because the page is what speaks, `sendSpeech` here hands text to that
 *      page rather than to Recall. When no speaker URL is configured, speech
 *      degrades to a chat post rather than being silently dropped — a
 *      cofounder that says nothing and does not say why is a bug report.
 *
 * `fetch` is injected so every path here is testable without a network, which
 * matters more than usual: this file's wire format is unverified (see
 * `wire.ts`) and the tests are what pin its behaviour while that is true.
 */
import type {
  CreateMeetingInput,
  Meeting,
  MeetingEvent,
  MeetingProvider,
  Participant,
} from "../../domain.js";
import type { MeetingStore } from "../../store/store.js";
import { AsyncQueue } from "../queue.js";
import { translateWebhook, type ParticipantResolver } from "./translate.js";
import {
  authorizationHeader,
  RECALL_CHAT_EVERYONE,
  RECALL_EVENTS,
  RECALL_HOST_TEMPLATE,
  RECALL_PATHS,
  type CreateBotRequest,
  type CreateBotResponse,
  type RecallWebhookEnvelope,
} from "./wire.js";

export interface RecallConfig {
  apiKey: string;
  /** e.g. "us-west-2". */
  region: string;
  /** Public base URL Recall can reach for webhooks, e.g. https://x.ngrok.app */
  webhookBaseUrl: string;
  /** Shared secret appended to the webhook URL; see the route in server/app.ts. */
  webhookSecret?: string;
  /** Page whose audio Recall streams into the call, if speech is wanted. */
  speakerUrl?: string;
  /** A `say` voice for that page to request. Unknown names fall back. */
  speakerVoice?: string;
  botName?: string;
}

export interface RecallDeps {
  store: MeetingStore;
  config: RecallConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  log?: (line: string) => void;
}

export class RecallApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Recall API returned ${status}: ${body.slice(0, 300)}`);
    this.name = "RecallApiError";
  }
}

interface MeetingRuntime {
  botId: string | null;
  meetingUrl: string;
  queue: AsyncQueue<MeetingEvent>;
  /** Platform participant id → the seat we gave them in this meeting. */
  seats: Map<string, Participant>;
}

export class RecallMeetingProvider implements MeetingProvider {
  readonly name = "recall";
  readonly #store: MeetingStore;
  readonly #config: RecallConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;
  readonly #log: (line: string) => void;
  readonly #runtimes = new Map<string, MeetingRuntime>();

  constructor(deps: RecallDeps) {
    this.#store = deps.store;
    this.#config = deps.config;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#log = deps.log ?? (() => {});
  }

  #origin(): string {
    return RECALL_HOST_TEMPLATE.replace("{region}", this.#config.region);
  }

  async #call<T>(
    path: string,
    init: { method: string; body?: unknown } = { method: "GET" },
  ): Promise<T> {
    const response = await this.#fetch(`${this.#origin()}${path}`, {
      method: init.method,
      headers: {
        authorization: authorizationHeader(this.#config.apiKey),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw new RecallApiError(
        response.status,
        await response.text().catch(() => ""),
      );
    }
    // Several of these endpoints answer 200 with an empty body.
    const text = await response.text().catch(() => "");
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  /**
   * The public URL for one meeting's webhooks.
   *
   * Built with `URL` rather than string concatenation: the secret is a query
   * parameter and the meeting is a path segment, and getting that order wrong
   * silently produces a URL that looks right in a substring check and 404s in
   * production.
   */
  /**
   * The page Recall streams into the call as the bot's camera and audio.
   *
   * Built through `URL` rather than concatenated, for the same reason the
   * webhook URL is: a configured speaker URL that already carries a query
   * string — a CDN token, a cache buster — would otherwise get a second `?`
   * and become a URL that resolves to nothing, and the failure would show up
   * as a silent bot in a live meeting rather than as an error here.
   *
   * It carries the shared secret because the page fetches synthesized audio
   * back from this host, and that route is refused without it.
   */
  #speakerPageUrl(meetingId: string, speakerUrl: string): string {
    const url = new URL(speakerUrl);
    url.searchParams.set("meetingId", meetingId);
    if (this.#config.webhookSecret !== undefined) {
      url.searchParams.set("secret", this.#config.webhookSecret);
    }
    if (this.#config.speakerVoice !== undefined) {
      url.searchParams.set("voice", this.#config.speakerVoice);
    }
    return url.toString();
  }

  #webhookUrl(meetingId: string): string {
    const url = new URL(
      `/api/providers/recall/${encodeURIComponent(meetingId)}`,
      this.#config.webhookBaseUrl,
    );
    if (this.#config.webhookSecret !== undefined) {
      url.searchParams.set("secret", this.#config.webhookSecret);
    }
    return url.toString();
  }

  #runtime(meetingId: string): MeetingRuntime {
    const runtime = this.#runtimes.get(meetingId);
    if (runtime === undefined) {
      throw new Error(`meeting ${meetingId} is not a Recall meeting`);
    }
    return runtime;
  }

  /**
   * Record the meeting locally. The bot is NOT dispatched here — joining a
   * call is a visible act in someone else's meeting, so it waits for an
   * explicit `startMeeting`.
   */
  async createMeeting(
    input: CreateMeetingInput & { meetingUrl?: string },
  ): Promise<Meeting> {
    const meetingUrl = input.meetingUrl;
    if (meetingUrl === undefined || meetingUrl === "") {
      throw new Error("a Recall meeting needs the platform meeting URL");
    }

    const meeting = this.#store.createMeeting({
      title: input.title,
      provider: this.name,
      agentDisplayName: input.agentDisplayName,
      wakeNames: input.wakeNames,
      agentId: input.agentId ?? null,
      workspacePath: input.workspacePath ?? null,
    });

    // Humans are not pre-registered: they are discovered from the transcript
    // as they speak, because a real call's roster is not knowable up front.
    this.#store.addParticipant({
      meetingId: meeting.id,
      name: input.agentDisplayName,
      kind: "agent",
      role: "AI cofounder",
    });

    this.#runtimes.set(meeting.id, {
      botId: null,
      meetingUrl,
      queue: new AsyncQueue<MeetingEvent>(),
      seats: new Map(),
    });
    return meeting;
  }

  /** Dispatch the bot into the call. */
  async startMeeting(meetingId: string): Promise<void> {
    const runtime = this.#runtime(meetingId);
    const request: CreateBotRequest = {
      meeting_url: runtime.meetingUrl,
      bot_name: this.#config.botName ?? "AMP cofounder",
      recording_config: {
        transcript: { provider: { recallai_streaming: {} } },
        realtime_endpoints: [
          {
            type: "webhook",
            // Scoped per meeting so a webhook cannot be replayed into a
            // different one, and so the route needs no lookup table.
            url: this.#webhookUrl(meetingId),
            events: [
              RECALL_EVENTS.transcript,
              // Partials arrive as their own event, and the attention engine
              // needs them marked as such so it never answers a question
              // that has not finished being asked.
              RECALL_EVENTS.transcriptPartial,
              RECALL_EVENTS.chatMessage,
            ],
          },
        ],
      },
      metadata: { amp_meeting_id: meetingId },
      ...(this.#config.speakerUrl === undefined
        ? {}
        : {
            output_media: {
              camera: {
                kind: "webpage",
                config: {
                  url: this.#speakerPageUrl(meetingId, this.#config.speakerUrl),
                },
              },
            },
          }),
    };

    const bot = await this.#call<CreateBotResponse>(RECALL_PATHS.createBot, {
      method: "POST",
      body: request,
    });
    runtime.botId = bot.id;
    this.#store.setMeetingStatus(meetingId, "live");
    this.#log(`recall bot ${bot.id} dispatched to ${runtime.meetingUrl}`);
  }

  async endMeeting(meetingId: string): Promise<void> {
    const runtime = this.#runtime(meetingId);
    if (runtime.botId !== null) {
      // A bot left running is a recording device nobody is watching, so a
      // failure to leave is logged loudly rather than swallowed.
      try {
        await this.#call(
          RECALL_PATHS.leaveCall.replace("{id}", runtime.botId),
          { method: "POST" },
        );
      } catch (error) {
        this.#log(
          `FAILED to remove bot ${runtime.botId} from the call: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        throw error;
      }
    }
    this.#store.setMeetingStatus(meetingId, "ended");
    runtime.queue.push({ type: "meeting_ended", meetingId, at: this.#now() });
    runtime.queue.close();
    this.#runtimes.delete(meetingId);
  }

  events(meetingId: string): AsyncIterable<MeetingEvent> {
    return this.#runtime(meetingId).queue;
  }

  async sendChat(meetingId: string, text: string): Promise<void> {
    const runtime = this.#runtime(meetingId);
    if (runtime.botId === null) throw new Error("no bot is in the call");
    await this.#call(
      RECALL_PATHS.sendChatMessage.replace("{id}", runtime.botId),
      { method: "POST", body: { to: RECALL_CHAT_EVERYONE, message: text } },
    );
  }

  /**
   * Speak into the call.
   *
   * The text goes to the speaker page, which is what actually produces audio;
   * this provider only decides that it should be said. With no speaker page
   * configured the agent is mute, and saying so in chat is better than
   * appearing to have ignored the room.
   */
  async sendSpeech(meetingId: string, text: string): Promise<void> {
    if (this.#config.speakerUrl === undefined) {
      this.#log("no speaker page configured; speaking through chat instead");
      await this.sendChat(meetingId, text);
      return;
    }
    // The speaker page subscribes to this meeting's realtime feed, so the
    // spoken text reaches it the same way it reaches the browser UI.
    this.#runtime(meetingId).queue.push({
      type: "utterance",
      meetingId,
      participantId: this.#agentSeat(meetingId).id,
      speakerName: this.#agentSeat(meetingId).name,
      speakerKind: "agent",
      text,
      addressed: false,
      at: this.#now(),
    });
  }

  #agentSeat(meetingId: string): Participant {
    const agent = this.#store.getAgentParticipant(meetingId);
    if (agent === null) throw new Error("meeting has no agent participant");
    return agent;
  }

  /**
   * Where a Recall webhook lands. Returns what it did, so the route can
   * answer usefully and diagnostics can show events that were skipped rather
   * than silently discarding them.
   */
  ingestWebhook(
    meetingId: string,
    envelope: RecallWebhookEnvelope,
  ): { accepted: boolean; reason?: string } {
    const runtime = this.#runtimes.get(meetingId);
    if (runtime === undefined) {
      return { accepted: false, reason: "unknown meeting" };
    }

    const resolver: ParticipantResolver = {
      find: (platform) => runtime.seats.get(platform) ?? null,
      create: ({ platformId, name }) => {
        const participant = this.#store.addParticipant({
          meetingId,
          name,
          kind: "human",
          role: null,
        });
        runtime.seats.set(platformId, participant);
        runtime.queue.push({
          type: "participant_joined",
          meetingId,
          participant,
        });
        return participant;
      },
    };

    const result = translateWebhook(envelope, {
      meetingId,
      at: this.#now(),
      participants: resolver,
    });
    if (result.event === null) {
      return {
        accepted: false,
        ...(result.skipped === undefined ? {} : { reason: result.skipped }),
      };
    }
    runtime.queue.push(result.event);
    return { accepted: true };
  }

  /** Bot id for a meeting, for diagnostics. */
  botId(meetingId: string): string | null {
    return this.#runtimes.get(meetingId)?.botId ?? null;
  }
}
