/**
 * The Recall.ai wire format — every field this app sends or reads, in one
 * file.
 *
 * Reconciled against https://docs.recall.ai on 2026-08-25. It was originally
 * written without access to the API or its docs, and the corrections are
 * recorded below where they change behaviour, because the shapes that were
 * guessed wrong are the ones a future reader will be tempted to guess the
 * same way again.
 *
 * Everything here is now sourced from the published schema. What is still
 * unverified is the live behaviour: no bot has been dispatched from this code
 * against a real call. Marked [VERIFIED] where the docs state it outright and
 * [UNTESTED-LIVE] where the shape is documented but has never round-tripped.
 *
 * The quarantine still holds: `provider.ts` names no Recall field, and the
 * translation is driven by fixtures in `test/recall.test.ts`. Correct a name
 * here, update its fixture, and the suite says what else moved.
 */

/** [VERIFIED] Regional host, e.g. `us-west-2.recall.ai`. */
export const RECALL_HOST_TEMPLATE = "https://{region}.recall.ai";

/** [VERIFIED] Bot lifecycle paths. */
export const RECALL_PATHS = {
  createBot: "/api/v1/bot/",
  leaveCall: "/api/v1/bot/{id}/leave_call/",
  sendChatMessage: "/api/v1/bot/{id}/send_chat_message/",
  outputAudio: "/api/v1/bot/{id}/output_audio/",
} as const;

/** [VERIFIED] Recall uses a static API key under the `Token` scheme. */
export function authorizationHeader(apiKey: string): string {
  return `Token ${apiKey}`;
}

/**
 * [VERIFIED] Create Bot request.
 *
 * `recording_config.transcript.provider` is a single-key object naming the
 * provider (`recallai_streaming: {}`), and `realtime_endpoints` lives inside
 * `recording_config`, not beside it.
 */
export interface CreateBotRequest {
  meeting_url: string;
  bot_name?: string;
  recording_config?: {
    transcript?: {
      /**
       * A single-key object naming the provider, whose value is that
       * provider's own options — `recallai_streaming` takes a `mode` of
       * `prioritize_low_latency` or `prioritize_accuracy` (the default, which
       * uses async non-real-time models).
       */
      provider?: Record<string, Record<string, string>>;
    };
    realtime_endpoints?: {
      type: "webhook";
      url: string;
      events: string[];
    }[];
  };
  /**
   * [VERIFIED] Streams a webpage into the call — how the agent speaks.
   *
   * There is no audio-only mode: the docs are explicit that output media
   * always carries the webpage as the bot's video, so the agent is a visible
   * tile. A speaker page that wants to be unobtrusive draws a still frame.
   */
  output_media?: {
    camera?: {
      kind: "webpage";
      config: { url: string };
    };
  };
  metadata?: Record<string, string>;
}

/** [VERIFIED] 201 response; `id` is the bot UUID. */
export interface CreateBotResponse {
  id: string;
  status_changes?: { code?: string; created_at?: string }[];
}

/** [VERIFIED] Body of `send_chat_message`. `to` names the recipient. */
export interface SendChatMessageRequest {
  to: string;
  message: string;
}

/** [VERIFIED] Broadcast recipient for `send_chat_message`. */
export const RECALL_CHAT_EVERYONE = "everyone";

/**
 * [VERIFIED] Real-time endpoint events — the ones deliverable to a webhook
 * configured under `recording_config.realtime_endpoints`.
 *
 * CORRECTION: finality is carried by the EVENT NAME, not by a field. Recall
 * emits `transcript.partial_data` for a growing hypothesis and
 * `transcript.data` once the segment settles. There is no `is_final` anywhere
 * in the payload; the earlier guess that there was is why this note exists.
 *
 * CORRECTION: `bot.status_change` is NOT one of these. Bot status is an
 * account-level Svix webhook (see `RECALL_BOT_STATUS_EVENTS`), delivered to
 * the endpoints configured in Recall's dashboard, and naming it here would
 * put an unknown value in the `events` array of every Create Bot call.
 */
export const RECALL_EVENTS = {
  transcript: "transcript.data",
  transcriptPartial: "transcript.partial_data",
  chatMessage: "participant_events.chat_message",
} as const;

/**
 * [VERIFIED] Account-level Svix webhook events for bot status.
 *
 * These do not arrive on the per-meeting real-time URL unless the operator
 * points their dashboard webhook at it. Each status is its own event name —
 * there is no single `bot.status_change` event — and the code lives at
 * `data.data.code`.
 */
export const RECALL_BOT_STATUS_EVENTS = {
  joiningCall: "bot.joining_call",
  inCallRecording: "bot.in_call_recording",
  inCallNotRecording: "bot.in_call_not_recording",
  callEnded: "bot.call_ended",
  done: "bot.done",
  fatal: "bot.fatal",
} as const;

/**
 * [VERIFIED] The real-time webhook envelope.
 *
 * CORRECTION, and the one that would have broken every transcript: the event
 * payload is at `data.data`. The sibling `data.transcript` is a RESOURCE
 * REFERENCE (`{ id, metadata }`) for the transcript record, not the words —
 * so code that reads `data.transcript` first finds an object with no `words`
 * and silently drops every utterance. Same for `data.recording` and
 * `data.bot`: references, not content.
 */
export interface RecallWebhookEnvelope {
  event: string;
  data?: {
    /** The event payload proper. */
    data?: RecallTranscriptPayload & RecallChatPayload & RecallBotStatusPayload;
    /** Resource references, not content. */
    bot?: RecallResourceRef;
    recording?: RecallResourceRef;
    transcript?: RecallResourceRef;
    participant_events?: RecallResourceRef;
    realtime_endpoint?: RecallResourceRef;
  };
}

export interface RecallResourceRef {
  id?: string;
  metadata?: Record<string, string>;
}

/** [VERIFIED] Word timings are nested objects, not bare numbers. */
export interface RecallWord {
  text?: string;
  start_timestamp?: { relative?: number };
  end_timestamp?: { relative?: number } | null;
}

/** [VERIFIED] The speaker. There are no flat `speaker`/`speaker_id` fields. */
export interface RecallParticipant {
  id?: number | string;
  name?: string | null;
  is_host?: boolean | null;
  platform?: string | null;
  extra_data?: Record<string, unknown> | null;
  email?: string | null;
}

/** [VERIFIED] Payload of `transcript.data` and `transcript.partial_data`. */
export interface RecallTranscriptPayload {
  words?: RecallWord[];
  language_code?: string;
  participant?: RecallParticipant;
}

/** [VERIFIED] Payload of `participant_events.chat_message`. */
export interface RecallChatPayload {
  participant?: RecallParticipant;
  timestamp?: { absolute?: string; relative?: number };
  /** The message itself sits one level deeper again. */
  data?: { text?: string; to?: string };
}

/** [VERIFIED] Payload of the bot status Svix webhooks. */
export interface RecallBotStatusPayload {
  code?: string;
  sub_code?: string | null;
  updated_at?: string;
}

/** Join the words of a transcript into the utterance a human would recognize. */
export function joinWords(words: readonly RecallWord[] | undefined): string {
  if (words === undefined) return "";
  return words
    .map((word) => (typeof word.text === "string" ? word.text : ""))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}
