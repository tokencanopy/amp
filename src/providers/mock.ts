/**
 * The v0 meeting provider: a simulated room.
 *
 * Deliberately first, and deliberately complete. Google Meet automation is a
 * bot-joins-a-call problem with vendor accounts, recording consent, and audio
 * pipelines attached; making it a prerequisite would mean nothing else could
 * be built or tested until it worked. Everything above this line — attention,
 * prompting, ACP, speech routing, memory — is the same whether the words came
 * from a simulator or a real call, so the simulator ships first and the real
 * providers slot in beside it.
 *
 * The simulator is not a stub: it has real participants, real speaker
 * attribution, real lifecycle, and it drives the UI in realtime.
 */
import type {
  CreateMeetingInput,
  Meeting,
  MeetingEvent,
  MeetingProvider,
} from "../domain.js";
import type { MeetingStore } from "../store/store.js";
import { AsyncQueue } from "./queue.js";

export class MockMeetingProvider implements MeetingProvider {
  readonly name = "mock";
  readonly #store: MeetingStore;
  readonly #queues = new Map<string, AsyncQueue<MeetingEvent>>();

  constructor(store: MeetingStore) {
    this.#store = store;
  }

  #queue(meetingId: string): AsyncQueue<MeetingEvent> {
    let queue = this.#queues.get(meetingId);
    if (queue === undefined || queue.closed) {
      queue = new AsyncQueue<MeetingEvent>();
      this.#queues.set(meetingId, queue);
    }
    return queue;
  }

  async createMeeting(input: CreateMeetingInput): Promise<Meeting> {
    const meeting = this.#store.createMeeting({
      title: input.title,
      provider: this.name,
      agentDisplayName: input.agentDisplayName,
      wakeNames: input.wakeNames,
      agentId: input.agentId ?? null,
      workspacePath: input.workspacePath ?? null,
    });

    for (const participant of input.participants) {
      this.#store.addParticipant({
        meetingId: meeting.id,
        name: participant.name,
        kind: participant.kind,
        role: participant.role ?? null,
      });
    }
    // The agent always has a seat, whether or not one was requested: it is a
    // participant in the room, not a feature of the transcript.
    if (this.#store.getAgentParticipant(meeting.id) === null) {
      this.#store.addParticipant({
        meetingId: meeting.id,
        name: input.agentDisplayName,
        kind: "agent",
        role: "AI cofounder",
      });
    }
    return meeting;
  }

  async startMeeting(meetingId: string): Promise<void> {
    const meeting = this.#store.requireMeeting(meetingId);
    if (meeting.status === "ended") {
      throw new Error("meeting has already ended");
    }
    this.#store.setMeetingStatus(meetingId, "live");
    this.#queue(meetingId).push({
      type: "meeting_started",
      meetingId,
      at: new Date().toISOString(),
    });
  }

  async endMeeting(meetingId: string): Promise<void> {
    this.#store.setMeetingStatus(meetingId, "ended");
    const queue = this.#queue(meetingId);
    queue.push({
      type: "meeting_ended",
      meetingId,
      at: new Date().toISOString(),
    });
    queue.close();
    this.#queues.delete(meetingId);
  }

  events(meetingId: string): AsyncIterable<MeetingEvent> {
    return this.#queue(meetingId);
  }

  /** A simulated human (or the UI) adding a participant mid-meeting. */
  async addParticipant(
    meetingId: string,
    input: { name: string; kind: "human" | "agent"; role?: string },
  ): Promise<void> {
    const participant = this.#store.addParticipant({
      meetingId,
      name: input.name,
      kind: input.kind,
      role: input.role ?? null,
    });
    this.#queue(meetingId).push({
      type: "participant_joined",
      meetingId,
      participant,
    });
  }

  /**
   * A simulated participant says something. This is the entry point the
   * meeting simulator UI drives, and the one a real provider's transcription
   * callback would drive instead.
   */
  async emitUtterance(input: {
    meetingId: string;
    participantId: string;
    text: string;
    addressed: boolean;
  }): Promise<void> {
    const participant = this.#store.getParticipant(
      input.meetingId,
      input.participantId,
    );
    if (participant === null) throw new Error("unknown participant");
    this.#queue(input.meetingId).push({
      type: "utterance",
      meetingId: input.meetingId,
      participantId: participant.id,
      speakerName: participant.name,
      speakerKind: participant.kind,
      text: input.text,
      addressed: input.addressed,
      at: new Date().toISOString(),
    });
  }

  async emitChat(input: {
    meetingId: string;
    participantId: string;
    text: string;
    addressed: boolean;
  }): Promise<void> {
    const participant = this.#store.getParticipant(
      input.meetingId,
      input.participantId,
    );
    if (participant === null) throw new Error("unknown participant");
    this.#queue(input.meetingId).push({
      type: "chat",
      meetingId: input.meetingId,
      participantId: participant.id,
      speakerName: participant.name,
      speakerKind: participant.kind,
      text: input.text,
      addressed: input.addressed,
      at: new Date().toISOString(),
    });
  }

  /** The agent posting to meeting chat. */
  async sendChat(meetingId: string, text: string): Promise<void> {
    const agent = this.#store.getAgentParticipant(meetingId);
    if (agent === null) throw new Error("meeting has no agent participant");
    this.#queue(meetingId).push({
      type: "chat",
      meetingId,
      participantId: agent.id,
      speakerName: agent.name,
      speakerKind: "agent",
      text,
      addressed: false,
      at: new Date().toISOString(),
    });
  }

  /**
   * The agent speaking. In the simulator this is an utterance in the room —
   * the browser turns it into audio through speechSynthesis. A real provider
   * would push audio into the call instead, and nothing above would change.
   */
  async sendSpeech(meetingId: string, text: string): Promise<void> {
    const agent = this.#store.getAgentParticipant(meetingId);
    if (agent === null) throw new Error("meeting has no agent participant");
    this.#queue(meetingId).push({
      type: "utterance",
      meetingId,
      participantId: agent.id,
      speakerName: agent.name,
      speakerKind: "agent",
      text,
      addressed: false,
      at: new Date().toISOString(),
    });
  }
}
