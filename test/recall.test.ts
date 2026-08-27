/**
 * The Recall.ai provider, driven by fixtures.
 *
 * No network and no credentials: `fetch` is injected, and webhooks are posted
 * as objects. That is not just convenience — the wire format in
 * `src/providers/recall/wire.ts` is the unverified part of this integration,
 * so these fixtures ARE the specification this code was written against. When
 * a real payload disagrees, the fixture changes here, the field name changes
 * there, and the suite says whether anything else moved.
 *
 * What is genuinely verified by these tests, whatever the field names turn
 * out to be: attribution, interim-vs-final handling, participant discovery,
 * the refusal to invent a speaker, bot lifecycle, and the webhook route's
 * authentication.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MeetingEvent } from "../src/domain.js";
import {
  RecallApiError,
  RecallMeetingProvider,
} from "../src/providers/recall/provider.js";
import { translateWebhook } from "../src/providers/recall/translate.js";
import { joinWords, RECALL_EVENTS } from "../src/providers/recall/wire.js";
import { MeetingStore } from "../src/store/store.js";
import { createServer, type AmpServer } from "../src/server/create.js";

// ---------------------------------------------------------------- fixtures

// These mirror the payloads published at https://docs.recall.ai (reconciled
// 2026-08-25). Three things here are load-bearing and were wrong before:
// the payload lives at `data.data` while `data.transcript` is a reference to
// the transcript RECORD; finality is the event NAME, not an `is_final` field;
// and a chat message's text sits one level deeper again, at `data.data.data`.
const transcriptEvent = (
  overrides: {
    text?: string;
    speakerId?: number | string;
    speakerName?: string;
    isFinal?: boolean;
  } = {},
) => ({
  event:
    overrides.isFinal === false
      ? RECALL_EVENTS.transcriptPartial
      : RECALL_EVENTS.transcript,
  data: {
    bot: { id: "bot_123", metadata: {} },
    // A reference to the transcript record — deliberately present, because
    // reading it instead of `data.data` is the mistake this shape invites.
    transcript: { id: "tr_123", metadata: {} },
    data: {
      language_code: "en",
      participant: {
        id: overrides.speakerId ?? 11,
        name: overrides.speakerName ?? "Ada",
      },
      words: (overrides.text ?? "cofounder what do you think")
        .split(" ")
        .map((text, index) => ({
          text,
          start_timestamp: { relative: index },
          end_timestamp: { relative: index + 1 },
        })),
    },
  },
});

const chatEvent = (text: string, sender = { id: 11, name: "Ada" }) => ({
  event: RECALL_EVENTS.chatMessage,
  data: {
    bot: { id: "bot_123", metadata: {} },
    data: {
      participant: sender,
      timestamp: { absolute: "2026-01-01T00:00:00Z", relative: 1 },
      data: { text, to: "everyone" },
    },
  },
});

const statusEvent = (event: string) => ({
  event,
  data: {
    bot: { id: "bot_123", metadata: {} },
    data: { code: event.replace(/^bot\./u, ""), sub_code: null },
  },
});

// ------------------------------------------------------------------ setup

let workdir: string;
let store: MeetingStore;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "amp-recall-"));
  store = new MeetingStore(join(workdir, "recall.db"));
});

afterEach(() => {
  store.close();
  rmSync(workdir, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function recordingFetch(
  responder: (call: Call) => { status?: number; body?: unknown } = () => ({}),
) {
  const calls: Call[] = [];
  type FetchArgs = Parameters<typeof globalThis.fetch>;
  const fetcher = (async (url: FetchArgs[0], init?: FetchArgs[1]) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const reply = responder(call);
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body ?? { id: "bot_123" }), {
      status,
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch: fetcher };
}

function makeProvider(
  options: {
    speakerUrl?: string;
    botVariant?: string;
    responder?: (call: Call) => { status?: number; body?: unknown };
  } = {},
) {
  const recorded = recordingFetch(options.responder);
  const provider = new RecallMeetingProvider({
    store,
    fetch: recorded.fetch,
    now: () => "2026-01-01T00:00:00.000Z",
    config: {
      apiKey: "test-key",
      region: "us-west-2",
      webhookBaseUrl: "https://tunnel.test",
      webhookSecret: "s3cret",
      botName: "AMP cofounder",
      ...(options.speakerUrl === undefined
        ? {}
        : { speakerUrl: options.speakerUrl }),
      ...(options.botVariant === undefined
        ? {}
        : { botVariant: options.botVariant }),
    },
  });
  return { provider, calls: recorded.calls };
}

/** The speaker-page URL out of the Create Bot call the provider made. */
function speakerUrlFrom(calls: Call[]): string {
  const body = calls[0]!.body as {
    output_media?: { camera?: { config?: { url?: string } } };
  };
  const url = body.output_media?.camera?.config?.url;
  if (url === undefined)
    throw new Error("no speaker URL in the create-bot call");
  return url;
}

async function liveMeeting(provider: RecallMeetingProvider) {
  const meeting = await provider.createMeeting({
    title: "Retry policy sync",
    agentDisplayName: "Cofounder",
    wakeNames: ["cofounder"],
    participants: [],
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  } as Parameters<typeof provider.createMeeting>[0]);
  await provider.startMeeting(meeting.id);
  return meeting;
}

/** Drain what the provider has queued, without blocking on more. */
async function drain(
  provider: RecallMeetingProvider,
  meetingId: string,
  count: number,
): Promise<MeetingEvent[]> {
  const events: MeetingEvent[] = [];
  const iterator = provider.events(meetingId)[Symbol.asyncIterator]();
  for (let index = 0; index < count; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 200),
      ),
    ]);
    if (next.done === true || next.value === undefined) break;
    events.push(next.value);
  }
  return events;
}

// ------------------------------------------------------------------- tests

describe("bot lifecycle", () => {
  it("does not dispatch a bot until the meeting is started", async () => {
    const { provider, calls } = makeProvider();
    await provider.createMeeting({
      title: "Retry policy sync",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder"],
      participants: [],
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    } as Parameters<typeof provider.createMeeting>[0]);

    // Joining somebody's call is a visible act; it waits to be asked.
    expect(calls).toHaveLength(0);
  });

  it("refuses to create a meeting with no platform URL", async () => {
    const { provider } = makeProvider();
    await expect(
      provider.createMeeting({
        title: "No URL",
        agentDisplayName: "Cofounder",
        wakeNames: [],
        participants: [],
      }),
    ).rejects.toThrow(/meeting URL/u);
  });

  it("dispatches a bot configured for transcript, chat and status", async () => {
    const { provider, calls } = makeProvider();
    const meeting = await liveMeeting(provider);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://us-west-2.recall.ai/api/v1/bot/");
    expect(call.headers["authorization"]).toBe("Token test-key");
    expect(call.body).toMatchObject({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "AMP cofounder",
      metadata: { amp_meeting_id: meeting.id },
    });

    const endpoints = (
      call.body as {
        recording_config: {
          realtime_endpoints: { url: string; events: string[] }[];
        };
      }
    ).recording_config.realtime_endpoints;
    // The whole URL, not substrings of it: the secret is a query parameter and
    // the meeting is a path segment, and a substring check happily passes a
    // URL that has them the wrong way round.
    expect(endpoints[0]!.url).toBe(
      `https://tunnel.test/api/providers/recall/${meeting.id}?secret=s3cret`,
    );
    // Partials are subscribed to so the attention engine can tell a growing
    // hypothesis from a settled one. Bot status is NOT here: it is an
    // account-level Svix webhook, and naming it would put an unknown value in
    // the events array of every Create Bot call.
    expect(endpoints[0]!.events).toEqual([
      "transcript.data",
      "transcript.partial_data",
      "participant_events.chat_message",
    ]);
    expect(store.requireMeeting(meeting.id).status).toBe("live");
    expect(provider.botId(meeting.id)).toBe("bot_123");
  });

  it("asks for output media only when a speaker page is configured", async () => {
    const without = makeProvider();
    await liveMeeting(without.provider);
    expect(without.calls[0]!.body).not.toHaveProperty("output_media");

    const withPage = makeProvider({ speakerUrl: "https://tunnel.test/speak" });
    const meeting = await liveMeeting(withPage.provider);
    const media = (
      withPage.calls[0]!.body as {
        output_media: { camera: { config: { url: string } } };
      }
    ).output_media;
    expect(media.camera.config.url).toContain("https://tunnel.test/speak");
    expect(media.camera.config.url).toContain(meeting.id);
  });

  it("hands the speaker page the secret it needs to fetch audio back", async () => {
    // The page synthesizes nothing itself — Recall's browser has no voices —
    // so it fetches WAV bytes from this host, and that route refuses it
    // without the shared secret.
    const { provider, calls } = makeProvider({
      speakerUrl: "https://tunnel.test/speaker.html",
    });
    const meeting = await liveMeeting(provider);
    const url = new URL(speakerUrlFrom(calls));
    expect(url.searchParams.get("meetingId")).toBe(meeting.id);
    expect(url.searchParams.get("secret")).toBe("s3cret");
  });

  it("does not corrupt a speaker URL that already has a query string", async () => {
    // Concatenating "?meetingId=" onto a URL with an existing query produces
    // a second "?" and a page that resolves to nothing — which would surface
    // as a silently mute bot in a live call, not as an error here.
    const { provider, calls } = makeProvider({
      speakerUrl: "https://tunnel.test/speaker.html?theme=dark",
    });
    const meeting = await liveMeeting(provider);
    const raw = speakerUrlFrom(calls);
    expect(raw.split("?")).toHaveLength(2);
    const url = new URL(raw);
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("meetingId")).toBe(meeting.id);
  });

  it("removes the bot when the meeting ends", async () => {
    const { provider, calls } = makeProvider();
    const meeting = await liveMeeting(provider);
    await provider.endMeeting(meeting.id);

    expect(calls[1]!.url).toBe(
      "https://us-west-2.recall.ai/api/v1/bot/bot_123/leave_call/",
    );
    expect(store.requireMeeting(meeting.id).status).toBe("ended");
  });

  it("can still end a meeting after the server restarted", async () => {
    // Runtimes are in memory and meetings are in the store, so a restart
    // leaves meetings this provider has never heard of. Refusing those made
    // them permanently un-endable — stuck `live` with no way back, which is
    // what happens to every live meeting every time the process restarts.
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);

    // A provider with the same store but no memory of that meeting is exactly
    // what a restart produces.
    const restarted = makeProvider().provider;
    await expect(restarted.endMeeting(meeting.id)).resolves.toBeUndefined();
    expect(store.requireMeeting(meeting.id).status).toBe("ended");
  });

  it("ends cleanly when the bot has already left on its own", async () => {
    // The vendor pulls its bot the moment a call empties and then rejects
    // further commands. Treating that as a failure left the meeting stuck
    // `live` forever — refusing to end precisely when the bot was already
    // gone, which is the normal way a meeting finishes.
    const { provider } = makeProvider({
      responder: (call) =>
        call.url.includes("leave_call")
          ? {
              status: 400,
              body: {
                code: "cannot_command_unstarted_bot",
                detail:
                  "Cannot send a command to a bot which has not been started.",
              },
            }
          : {},
    });
    const meeting = await liveMeeting(provider);

    await expect(provider.endMeeting(meeting.id)).resolves.toBeUndefined();
    expect(store.requireMeeting(meeting.id).status).toBe("ended");
  });

  it("raises rather than swallowing a failure to remove the bot", async () => {
    // A bot left in a call is a recording device nobody is watching.
    const { provider } = makeProvider({
      responder: (call) =>
        call.url.includes("leave_call")
          ? { status: 500, body: { detail: "nope" } }
          : {},
    });
    const meeting = await liveMeeting(provider);
    await expect(provider.endMeeting(meeting.id)).rejects.toBeInstanceOf(
      RecallApiError,
    );
  });

  it("surfaces a rejected bot creation", async () => {
    const { provider } = makeProvider({
      responder: () => ({ status: 402, body: { detail: "out of credit" } }),
    });
    await expect(liveMeeting(provider)).rejects.toThrow(/402/u);
  });
});

describe("webhook ingestion", () => {
  it("turns a transcript event into an attributed utterance", async () => {
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);

    const outcome = provider.ingestWebhook(meeting.id, transcriptEvent());
    expect(outcome.accepted).toBe(true);

    const events = await drain(provider, meeting.id, 2);
    // The speaker is discovered and seated, then the utterance arrives.
    expect(events[0]).toMatchObject({ type: "participant_joined" });
    expect(events[1]).toMatchObject({
      type: "utterance",
      speakerName: "Ada",
      speakerKind: "human",
      text: "cofounder what do you think",
      isFinal: true,
    });
  });

  it("reuses one seat for a speaker across utterances", async () => {
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);

    provider.ingestWebhook(meeting.id, transcriptEvent({ text: "first" }));
    provider.ingestWebhook(meeting.id, transcriptEvent({ text: "second" }));
    const events = await drain(provider, meeting.id, 4);

    const utterances = events.filter((event) => event.type === "utterance");
    expect(utterances).toHaveLength(2);
    expect(new Set(utterances.map((event) => event.participantId)).size).toBe(
      1,
    );
    // One join, not two.
    expect(
      events.filter((event) => event.type === "participant_joined"),
    ).toHaveLength(1);
    expect(
      store.listParticipants(meeting.id).filter((p) => p.kind === "human"),
    ).toHaveLength(1);
  });

  it("marks an interim result as not final", async () => {
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);
    provider.ingestWebhook(
      meeting.id,
      transcriptEvent({ text: "cofounder what", isFinal: false }),
    );
    const events = await drain(provider, meeting.id, 2);
    expect(events[1]).toMatchObject({ type: "utterance", isFinal: false });
  });

  it("carries a chat message through with its sender", async () => {
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);
    provider.ingestWebhook(meeting.id, chatEvent("here is the dashboard"));
    const events = await drain(provider, meeting.id, 2);
    expect(events[1]).toMatchObject({
      type: "chat",
      speakerName: "Ada",
      text: "here is the dashboard",
    });
  });

  it("maps bot status onto meeting lifecycle", async () => {
    const { provider } = makeProvider();
    const meeting = await liveMeeting(provider);

    expect(
      provider.ingestWebhook(meeting.id, statusEvent("bot.in_call_recording"))
        .accepted,
    ).toBe(true);
    expect(
      provider.ingestWebhook(meeting.id, statusEvent("bot.call_ended"))
        .accepted,
    ).toBe(true);
    expect(
      provider.ingestWebhook(meeting.id, statusEvent("bot.joining_call"))
        .accepted,
    ).toBe(false);

    const events = await drain(provider, meeting.id, 2);
    expect(events.map((event) => event.type)).toEqual([
      "meeting_started",
      "meeting_ended",
    ]);
  });

  it("rejects a webhook for a meeting it is not running", () => {
    const { provider } = makeProvider();
    expect(provider.ingestWebhook("mtg_nope", transcriptEvent())).toMatchObject(
      {
        accepted: false,
        reason: "unknown meeting",
      },
    );
  });
});

describe("translation refuses to guess", () => {
  const resolver = {
    find: () => null,
    create: ({ name }: { platformId: string; name: string }) => ({
      id: "phum_1",
      meetingId: "mtg_1",
      name,
      kind: "human" as const,
      role: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const context = {
    meetingId: "mtg_1",
    at: "2026-01-01T00:00:00.000Z",
    participants: resolver,
  };

  it("drops an utterance whose speaker cannot be identified", () => {
    // Mis-attribution is worse than loss: the transcript is what the agent is
    // told the room said.
    const result = translateWebhook(
      {
        event: RECALL_EVENTS.transcript,
        data: { data: { words: [{ text: "hello" }] } },
      },
      context,
    );
    expect(result.event).toBeNull();
    expect(result.skipped).toMatch(/speaker/u);
  });

  it("ignores the transcript RECORD reference and reads the payload", () => {
    // `data.transcript` is `{ id, metadata }`, not the words. Reading it
    // first silently drops every utterance, which is what this asserts
    // against: the reference is present and must not be mistaken for content.
    const result = translateWebhook(
      {
        event: RECALL_EVENTS.transcript,
        data: {
          transcript: { id: "tr_1", metadata: {} },
          data: {
            participant: { id: 11, name: "Ada" },
            words: [{ text: "cofounder" }, { text: "hello" }],
          },
        },
      },
      context,
    );
    expect(result.event).toMatchObject({
      text: "cofounder hello",
      speakerName: "Ada",
      isFinal: true,
    });
  });

  it("reports rather than throwing on payloads it cannot read", () => {
    for (const envelope of [
      {} as never,
      { event: RECALL_EVENTS.transcript },
      { event: RECALL_EVENTS.transcript, data: {} },
      {
        event: RECALL_EVENTS.transcript,
        data: { data: { participant: { id: 1 }, words: [] } },
      },
      { event: "something.new", data: {} },
    ]) {
      const result = translateWebhook(envelope, context);
      expect(result.event).toBeNull();
      expect(result.skipped).toBeTypeOf("string");
    }
  });

  it("falls back to a placeholder name rather than dropping a known speaker", () => {
    const result = translateWebhook(
      {
        event: RECALL_EVENTS.transcript,
        data: {
          data: { participant: { id: 7, name: null }, words: [{ text: "hi" }] },
        },
      },
      context,
    );
    expect(result.event).toMatchObject({ speakerName: "Unknown speaker" });
  });

  it("reads a nested transcript shape as well as a flat one", () => {
    const result = translateWebhook(
      {
        event: RECALL_EVENTS.transcript,
        data: {
          data: {
            participant: { id: 3, name: "Grace" },
            words: [{ text: "retries" }, { text: "again" }],
          },
        },
      },
      context,
    );
    expect(result.event).toMatchObject({
      type: "utterance",
      speakerName: "Grace",
      text: "retries again",
    });
  });

  it("joins words into the utterance a human would recognize", () => {
    expect(
      joinWords([{ text: "cap" }, { text: "retries" }, { text: "at three" }]),
    ).toBe("cap retries at three");
    expect(joinWords(undefined)).toBe("");
  });
});

describe("speaking", () => {
  it("posts to meeting chat through the bot", async () => {
    const { provider, calls } = makeProvider();
    const meeting = await liveMeeting(provider);
    await provider.sendChat(meeting.id, "details in the doc");

    expect(calls[1]!.url).toBe(
      "https://us-west-2.recall.ai/api/v1/bot/bot_123/send_chat_message/",
    );
    expect(calls[1]!.body).toMatchObject({ message: "details in the doc" });
  });

  it("routes speech to the speaker page as an agent utterance", async () => {
    const { provider } = makeProvider({
      speakerUrl: "https://tunnel.test/speak",
    });
    const meeting = await liveMeeting(provider);
    await provider.sendSpeech(meeting.id, "three retries then dead-letter");

    const events = await drain(provider, meeting.id, 1);
    expect(events[0]).toMatchObject({
      type: "utterance",
      speakerKind: "agent",
      text: "three retries then dead-letter",
    });
  });

  it("says it in chat rather than going mute when no speaker page exists", async () => {
    const { provider, calls } = makeProvider();
    const meeting = await liveMeeting(provider);
    await provider.sendSpeech(meeting.id, "three retries then dead-letter");

    expect(calls[1]!.url).toContain("send_chat_message");
    expect(calls[1]!.body).toMatchObject({
      message: "three retries then dead-letter",
    });
  });
});

describe("interim results reach the UI but never the transcript", () => {
  // The reason this matters: a growing hypothesis ("cofounder what" →
  // "cofounder what do you" → settled) would otherwise be persisted three
  // times AND handed to the attention engine three times, so the agent would
  // answer a question that had not finished being asked.
  it("publishes a caption, persists nothing, and wakes nobody", async () => {
    const { MeetingGateway } = await import("../src/gateway/gateway.js");
    const { AsyncQueue } = await import("../src/providers/queue.js");
    const events = new AsyncQueue<MeetingEvent>();

    const meeting = store.createMeeting({
      title: "Streaming",
      provider: "streaming",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder"],
    });
    const ada = store.addParticipant({
      meetingId: meeting.id,
      name: "Ada",
      kind: "human",
      role: null,
    });
    store.setMeetingStatus(meeting.id, "live");

    const published: { type: string; text?: string }[] = [];
    const gateway = new MeetingGateway({
      store,
      providers: {
        streaming: {
          name: "streaming",
          createMeeting: async () => meeting,
          startMeeting: async () => {},
          endMeeting: async () => {},
          events: () => events,
          sendChat: async () => {},
          sendSpeech: async () => {},
        },
      },
      publish: (_id, event) =>
        published.push(event as { type: string; text?: string }),
    });
    gateway.startConsuming(meeting.id);

    const base = {
      type: "utterance" as const,
      meetingId: meeting.id,
      participantId: ada.id,
      speakerName: "Ada",
      speakerKind: "human" as const,
      addressed: false,
      at: "2026-01-01T00:00:00.000Z",
    };
    events.push({ ...base, text: "cofounder what", isFinal: false });
    events.push({ ...base, text: "cofounder what do you", isFinal: false });
    events.push({
      ...base,
      text: "cofounder what do you think",
      isFinal: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Two captions for the two hypotheses...
    const captions = published.filter((event) => event.type === "caption");
    expect(captions.map((event) => event.text)).toEqual([
      "cofounder what",
      "cofounder what do you",
    ]);

    // ...one transcript entry for the settled text...
    const transcript = store.listTranscript(meeting.id);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.text).toBe("cofounder what do you think");

    // ...and exactly one attention decision, on the final text.
    const attention = published.filter((event) => event.type === "attention");
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      triggered: true,
      text: "cofounder what do you think",
    });
  });
});

// ------------------------------------------------------- the webhook route

describe("webhook route", () => {
  let server: AmpServer;

  beforeEach(() => {
    server = createServer(
      {
        port: 0,
        host: "127.0.0.1",
        databasePath: join(workdir, "route.db"),
        logLevel: "silent",
      },
      {
        ...process.env,
        AMP_RECALL_API_KEY: "test-key",
        AMP_RECALL_WEBHOOK_BASE_URL: "https://tunnel.test",
        AMP_RECALL_WEBHOOK_SECRET: "s3cret",
      },
    );
  });

  afterEach(async () => {
    await server.stop();
  });

  it("is mounted when Recall is configured", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/providers/recall/mtg_unknown?secret=s3cret",
      payload: transcriptEvent(),
    });
    // Authenticated, but the meeting is not one this provider runs.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: false });
  });

  it("refuses a wrong secret without confirming the meeting exists", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/providers/recall/mtg_unknown?secret=wrong",
      payload: transcriptEvent(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("refuses a missing secret", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/providers/recall/mtg_unknown",
      payload: transcriptEvent(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("is absent entirely when Recall is not configured", async () => {
    const plain = createServer(
      {
        port: 0,
        host: "127.0.0.1",
        databasePath: join(workdir, "plain.db"),
        logLevel: "silent",
      },
      { ...process.env, AMP_RECALL_API_KEY: "", AMP_RECALL_WEBHOOK_SECRET: "" },
    );
    try {
      const response = await plain.app.inject({
        method: "POST",
        url: "/api/providers/recall/mtg_x?secret=s3cret",
        payload: transcriptEvent(),
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await plain.stop();
    }
  });

  it("refuses to create a meeting for a provider that is not configured", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/meetings",
      payload: {
        title: "Zoom call",
        agentDisplayName: "Cofounder",
        provider: "zoom",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("unknown_provider");
  });
});

describe("the machine the speaker page runs on", () => {
  /**
   * These guard a field whose absence is invisible everywhere except a live
   * call. Nothing errors without it, no test goes red, the audio is correct
   * on the wire and the page is correct — the bot's browser simply does not
   * have the CPU to play speech and encode video at once, and a listener
   * hears it break up. It cost a run of live meetings to find, so it is
   * pinned here rather than left to a default.
   */
  it("asks for a machine that can actually play audio", async () => {
    const { provider, calls } = makeProvider({
      speakerUrl: "https://speaker.test",
    });
    await liveMeeting(provider);

    const body = calls[0]!.body as { variant?: Record<string, string> };
    // The vendor default is `web`: 250 millicores, a quarter of one core.
    expect(body.variant).toEqual({
      google_meet: "web_4_core",
      zoom: "web_4_core",
      microsoft_teams: "web_4_core",
    });
  });

  it("does not pay for the bigger machine when nothing is streamed", async () => {
    // A bot with no speaker page only listens, and listening is cheap. The
    // larger variant is billed per hour, so it follows output media exactly.
    const { provider, calls } = makeProvider();
    await liveMeeting(provider);

    const body = calls[0]!.body as { variant?: unknown };
    expect(body.variant).toBeUndefined();
  });

  it("lets a deployment choose a different size", async () => {
    const { provider, calls } = makeProvider({
      speakerUrl: "https://speaker.test",
      botVariant: "web_gpu",
    });
    await liveMeeting(provider);

    const body = calls[0]!.body as { variant?: Record<string, string> };
    expect(body.variant?.google_meet).toBe("web_gpu");
  });
});
