/**
 * The seam for a real meeting platform, and the notes for implementing one.
 *
 * NO LONGER THE ONLY OPTION: `providers/recall/` is a working implementation
 * of this seam against Recall.ai, and it is the reference to copy. What
 * follows still describes the shape any vendor takes, which is what made that
 * integration a translation function rather than a rewrite.
 *
 * Every hosted option (Recall.ai, Meeting BaaS, Vexa) and every first-party
 * one (Meet, Zoom, Teams) reduces to the same four obligations, which is why
 * one interface covers all of them:
 *
 *   1. put something in the call — a vendor bot, or a native app/add-on;
 *   2. turn its audio into speaker-attributed transcript events;
 *   3. accept text back, as chat and as speech (TTS into the call's audio);
 *   4. report lifecycle: joined, started, ended, removed.
 *
 * What differs is only how the events arrive — a webhook, a websocket, a
 * polling API — and every one of those normalizes into `MeetingEvent`. That
 * is the entire point of the abstraction: AMP has no other
 * knowledge of meeting platforms anywhere in its code.
 *
 * Concretely, to implement this against a bot vendor:
 *   - `createMeeting` registers the meeting URL and returns the local record;
 *   - `startMeeting` dispatches the bot and waits for it to be admitted;
 *   - the vendor's transcript webhook is translated into `utterance` events
 *     and pushed onto an `AsyncQueue`, which `events()` returns;
 *   - `sendChat` posts through the vendor's in-call chat API;
 *   - `sendSpeech` sends text to the vendor's TTS/audio-injection endpoint,
 *     which is where browser `speechSynthesis` stops being the speech layer;
 *   - `endMeeting` removes the bot and closes the queue.
 *
 * Consent is a product requirement, not a technical one: a bot that joins a
 * call is a recording device, and whatever the platform requires for
 * disclosure has to happen before step 1.
 */
import type {
  CreateMeetingInput,
  Meeting,
  MeetingEvent,
  MeetingProvider,
} from "../domain.js";
import { AsyncQueue } from "./queue.js";

export class NotImplementedError extends Error {
  constructor(operation: string, provider: string) {
    super(
      `${operation} is not implemented for the "${provider}" provider. ` +
        "This is the v0 external-provider stub; use the mock provider for local development.",
    );
    this.name = "NotImplementedError";
  }
}

export interface ExternalProviderConfig {
  /** Vendor identifier, e.g. "recall", "meeting-baas", "vexa". */
  vendor: string;
  /** Base URL of the vendor API. Never a credential — those come from env. */
  apiBaseUrl?: string;
  /** The platform meeting to join. */
  meetingUrl?: string;
}

export class ExternalMeetingProvider implements MeetingProvider {
  readonly name: string;
  readonly #config: ExternalProviderConfig;
  readonly #queues = new Map<string, AsyncQueue<MeetingEvent>>();

  constructor(config: ExternalProviderConfig) {
    this.#config = config;
    this.name = `external:${config.vendor}`;
  }

  get config(): ExternalProviderConfig {
    return { ...this.#config };
  }

  /**
   * Where a vendor webhook handler would deliver a translated event. Present
   * and working so that wiring a vendor up is a translation function plus a
   * route, not a redesign.
   */
  ingest(meetingId: string, event: MeetingEvent): void {
    let queue = this.#queues.get(meetingId);
    if (queue === undefined) {
      queue = new AsyncQueue<MeetingEvent>();
      this.#queues.set(meetingId, queue);
    }
    queue.push(event);
  }

  events(meetingId: string): AsyncIterable<MeetingEvent> {
    let queue = this.#queues.get(meetingId);
    if (queue === undefined) {
      queue = new AsyncQueue<MeetingEvent>();
      this.#queues.set(meetingId, queue);
    }
    return queue;
  }

  createMeeting(_input: CreateMeetingInput): Promise<Meeting> {
    throw new NotImplementedError("createMeeting", this.name);
  }

  startMeeting(_meetingId: string): Promise<void> {
    throw new NotImplementedError("startMeeting", this.name);
  }

  endMeeting(_meetingId: string): Promise<void> {
    throw new NotImplementedError("endMeeting", this.name);
  }

  sendChat(_meetingId: string, _text: string): Promise<void> {
    throw new NotImplementedError("sendChat", this.name);
  }

  sendSpeech(_meetingId: string, _text: string): Promise<void> {
    throw new NotImplementedError("sendSpeech", this.name);
  }
}
