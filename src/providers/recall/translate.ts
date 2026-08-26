/**
 * Recall's webhook payloads → `MeetingEvent`.
 *
 * This is the whole of what a real meeting provider adds: one translation
 * function. Everything above it — attention, prompting, ACP, speech routing,
 * memory — already works and does not know a vendor exists.
 *
 * Written defensively on purpose. Every field is optional in the types
 * because the payloads are unverified (see `wire.ts`), so a missing or
 * renamed field produces `null` — an event that is skipped and logged —
 * rather than a crash or, worse, an utterance attributed to the wrong person.
 * Mis-attribution is the one failure mode worth being paranoid about: the
 * transcript is what the agent is told the room said.
 */
import type { MeetingEvent, Participant } from "../../domain.js";
import { sanitizeText } from "../../acp/sanitize.js";
import {
  joinWords,
  RECALL_BOT_STATUS_EVENTS,
  RECALL_EVENTS,
  type RecallParticipant,
  type RecallWebhookEnvelope,
} from "./wire.js";

/** Resolves a Recall participant to one seated in this meeting. */
export interface ParticipantResolver {
  /** An existing seat for this platform participant, or null to create one. */
  find(platformId: string): Participant | null;
  create(input: { platformId: string; name: string }): Participant;
}

export interface TranslateResult {
  event: MeetingEvent | null;
  /** Why nothing was produced — surfaced in diagnostics, never silent. */
  skipped?: string;
}

function platformId(participant: RecallParticipant | undefined): string | null {
  if (participant === undefined) return null;
  const id = participant.id;
  if (typeof id === "number") return String(id);
  if (typeof id === "string" && id !== "") return id;
  return null;
}

function displayName(participant: RecallParticipant | undefined): string {
  const name = participant?.name;
  return typeof name === "string" && name.trim() !== ""
    ? sanitizeText(name.trim(), 64)
    : "Unknown speaker";
}

/**
 * Translate one webhook envelope.
 *
 * `at` is passed in rather than read from the clock so translation is a pure
 * function and its tests do not depend on time.
 */
export function translateWebhook(
  envelope: RecallWebhookEnvelope,
  context: { meetingId: string; at: string; participants: ParticipantResolver },
): TranslateResult {
  const { event, data } = envelope;
  if (typeof event !== "string" || data === undefined) {
    return { event: null, skipped: "envelope had no event" };
  }

  switch (event) {
    case RECALL_EVENTS.transcript:
    case RECALL_EVENTS.transcriptPartial: {
      // The payload is at `data.data`. The sibling `data.transcript` is a
      // reference to the transcript RECORD (`{ id, metadata }`), so reading
      // that instead finds no words and drops the utterance silently.
      const transcript = data.data;
      if (transcript === undefined) {
        return {
          event: null,
          skipped: "transcript event carried no transcript",
        };
      }
      const text = sanitizeText(joinWords(transcript.words), 4_000);
      if (text === "") return { event: null, skipped: "transcript was empty" };

      const speaker: RecallParticipant | undefined = transcript.participant;
      const id = platformId(speaker);
      if (id === null) {
        // Better to drop an utterance than to attribute it to the wrong
        // person: the transcript is evidence, and the agent is told it is.
        return { event: null, skipped: "speaker could not be identified" };
      }

      const participant =
        context.participants.find(id) ??
        context.participants.create({
          platformId: id,
          name: displayName(speaker),
        });

      return {
        event: {
          type: "utterance",
          meetingId: context.meetingId,
          participantId: participant.id,
          speakerName: participant.name,
          speakerKind: participant.kind,
          text,
          addressed: false,
          at: context.at,
          // Finality is the event NAME, not a field: Recall sends
          // `transcript.partial_data` for a growing hypothesis and
          // `transcript.data` once the segment settles. There is no
          // `is_final` in the payload. Anything that is not explicitly a
          // partial is final, which keeps every non-streaming provider
          // correct by default.
          isFinal: event !== RECALL_EVENTS.transcriptPartial,
        },
      };
    }

    case RECALL_EVENTS.chatMessage: {
      // `data.data` is the participant-event payload; the message text sits
      // one level deeper again, at `data.data.data`.
      const payload = data.data;
      const text = sanitizeText(
        String(payload?.data?.text ?? "").trim(),
        4_000,
      );
      if (text === "")
        return { event: null, skipped: "chat message was empty" };

      const sender = payload?.participant;
      const id = platformId(sender);
      if (id === null) {
        return { event: null, skipped: "chat sender could not be identified" };
      }
      const participant =
        context.participants.find(id) ??
        context.participants.create({
          platformId: id,
          name: displayName(sender),
        });

      return {
        event: {
          type: "chat",
          meetingId: context.meetingId,
          participantId: participant.id,
          speakerName: participant.name,
          speakerKind: participant.kind,
          text,
          addressed: false,
          at: context.at,
        },
      };
    }

    // Bot status is an account-level Svix webhook, not a real-time endpoint
    // event, and every status is its own event name — there is no single
    // `bot.status_change`. These are handled if an operator points their
    // dashboard webhook at this route, and ignored otherwise.
    case RECALL_BOT_STATUS_EVENTS.inCallRecording:
    case RECALL_BOT_STATUS_EVENTS.inCallNotRecording:
      return {
        event: {
          type: "meeting_started",
          meetingId: context.meetingId,
          at: context.at,
        },
      };

    case RECALL_BOT_STATUS_EVENTS.callEnded:
    case RECALL_BOT_STATUS_EVENTS.done:
    case RECALL_BOT_STATUS_EVENTS.fatal:
      return {
        event: {
          type: "meeting_ended",
          meetingId: context.meetingId,
          at: context.at,
        },
      };

    default:
      return { event: null, skipped: `unhandled event ${event}` };
  }
}
