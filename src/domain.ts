/**
 * The vocabulary every layer of the prototype shares.
 *
 * Deliberately provider-neutral: nothing here knows whether an utterance came
 * from the mock simulator, a Recall.ai bot, or a Meet caption stream, and
 * nothing here knows which ACP agent is attached. The gateway is the only
 * place those two worlds meet.
 */

export type ParticipantKind = "human" | "agent";

export interface Participant {
  id: string;
  meetingId: string;
  name: string;
  kind: ParticipantKind;
  /** Free-form label shown in the UI ("founder", "engineer", "AI cofounder"). */
  role: string | null;
  createdAt: string;
}

export type MeetingStatus = "created" | "live" | "ended";

export interface Meeting {
  id: string;
  title: string;
  provider: string;
  status: MeetingStatus;
  /** The name the agent answers to in the room, e.g. "Cofounder". */
  agentDisplayName: string;
  /** Every name that may address the agent, lowercased. */
  wakeNames: string[];
  agentId: string | null;
  workspacePath: string | null;
  topic: string | null;
  summary: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** One attributed thing said out loud. */
export interface TranscriptEntry {
  id: string;
  meetingId: string;
  participantId: string;
  speakerName: string;
  speakerKind: ParticipantKind;
  text: string;
  /** The speaker explicitly marked this as addressed to the agent. */
  addressed: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  meetingId: string;
  participantId: string;
  speakerName: string;
  speakerKind: ParticipantKind;
  text: string;
  addressed: boolean;
  createdAt: string;
}

export type MemoryKind = "decision" | "action_item" | "fact" | "note";
export type MemoryStatus = "active" | "superseded";

export interface MeetingMemory {
  id: string;
  meetingId: string;
  kind: MemoryKind;
  content: string;
  sourceParticipantId?: string;
  sourceTranscriptEntryId?: string;
  sourceTimestamp?: string;
  status: MemoryStatus;
  createdAt: string;
}

/**
 * What a meeting provider emits. The mock provider synthesises these from the
 * simulator UI; a real provider translates a vendor's webhook or socket feed
 * into exactly this shape and nothing downstream changes.
 */
export type MeetingEvent =
  | { type: "meeting_started"; meetingId: string; at: string }
  | { type: "meeting_ended"; meetingId: string; at: string }
  | { type: "participant_joined"; meetingId: string; participant: Participant }
  | {
      type: "participant_left";
      meetingId: string;
      participantId: string;
      at: string;
    }
  | {
      type: "utterance";
      meetingId: string;
      participantId: string;
      speakerName: string;
      speakerKind: ParticipantKind;
      text: string;
      addressed: boolean;
      at: string;
      /**
       * False while speech recognition is still revising this utterance.
       *
       * Live transcription emits a growing hypothesis — "cofounder what",
       * "cofounder what do you", then the settled text — and only the last of
       * those is worth acting on. An interim result is shown as a live
       * caption and nothing more: it is not persisted, and it never reaches
       * the attention engine, because deciding to interrupt a meeting on
       * text that has not finished arriving is how an agent answers a
       * question nobody asked. Absent means final, which keeps every
       * non-streaming provider correct by default.
       */
      isFinal?: boolean;
    }
  | {
      type: "chat";
      meetingId: string;
      participantId: string;
      speakerName: string;
      speakerKind: ParticipantKind;
      text: string;
      addressed: boolean;
      at: string;
    };

export interface CreateMeetingInput {
  title: string;
  agentDisplayName: string;
  wakeNames: string[];
  participants: { name: string; kind: ParticipantKind; role?: string }[];
  workspacePath?: string;
  agentId?: string;
}

/**
 * The seam every meeting platform plugs into.
 *
 * `events()` is an async iterable rather than a callback registry so that
 * consumer backpressure is real: the gateway can be slow (an agent turn takes
 * minutes) without the provider having to buffer on its behalf.
 */
export interface MeetingProvider {
  readonly name: string;
  createMeeting(input: CreateMeetingInput): Promise<Meeting>;
  startMeeting(meetingId: string): Promise<void>;
  endMeeting(meetingId: string): Promise<void>;
  events(meetingId: string): AsyncIterable<MeetingEvent>;
  sendChat(meetingId: string, text: string): Promise<void>;
  sendSpeech(meetingId: string, text: string): Promise<void>;
}

/** Speech is a browser capability in v0; this is the seam a server-side TTS
 *  provider would implement later without the gateway noticing. */
export interface SpeechOutput {
  speak(text: string): Promise<void>;
  cancel(): void;
  isSpeaking(): boolean;
}

export type AgentStatus =
  | "disconnected"
  | "connecting"
  | "listening"
  | "thinking"
  | "working"
  | "speaking"
  | "error";
