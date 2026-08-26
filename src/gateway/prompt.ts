/**
 * Turning a meeting into a prompt, and a response back into something safe to
 * say out loud.
 *
 * Two rules shape this file. First, everything the agent reads here is text
 * other people said in a shared room, so it is fenced and labelled with
 * provenance rather than concatenated into the instruction — the same
 * discipline `packages/tc-acp` applies to channel messages. Second, a meeting
 * is an audio medium: a response that is correct but unspeakable (a code
 * block, a URL, forty seconds of list) is a failure. The agent is asked to
 * split its own answer with SPEAK:/CHAT:, and `planSpeech` enforces the split
 * whether or not it complied.
 */
import type { MeetingMemory, Participant, TranscriptEntry } from "../domain.js";

export interface PromptInput {
  meetingTitle: string;
  agentName: string;
  participants: readonly Participant[];
  topic: string | null;
  summary: string | null;
  recentTranscript: readonly TranscriptEntry[];
  trigger: { speakerName: string; text: string };
  memories?: readonly MeetingMemory[];
}

const BEHAVIOR = [
  "Meeting behavior:",
  "- Respond conversationally and concisely.",
  "- Keep the spoken portion below approximately 80 words.",
  "- Do not read code, raw URLs, or long lists aloud.",
  "- Put lengthy technical details in a section beginning with CHAT:.",
  "- If substantial work is required, acknowledge it briefly before working.",
  "- Do not claim work is complete unless tool results confirm it.",
  "- Distinguish brainstorming from confirmed decisions.",
].join("\n");

const FORMAT = [
  "Use this output format when appropriate:",
  "SPEAK:",
  "Concise response for the meeting.",
  "CHAT:",
  "Optional detailed content for meeting chat.",
].join("\n");

export function buildAgentPrompt(input: PromptInput): string {
  const participants =
    input.participants.length === 0
      ? "(none recorded)"
      : input.participants
          .map(
            (participant) =>
              `- ${participant.name} (${participant.kind}${
                participant.role === null ? "" : `, ${participant.role}`
              })`,
          )
          .join("\n");

  const transcript =
    input.recentTranscript.length === 0
      ? "(no prior utterances)"
      : input.recentTranscript
          .map((entry) => `${entry.speakerName}: ${entry.text}`)
          .join("\n");

  const lines = [
    "You are participating as an AI cofounder in a live multiparty meeting.",
    `Meeting: ${input.meetingTitle}`,
    `Your meeting name: ${input.agentName}`,
    "Participants:",
    participants,
    "Current topic:",
    input.topic ?? "(not set)",
  ];

  if (input.summary !== null && input.summary.trim() !== "") {
    lines.push("Meeting so far:", input.summary);
  }

  const activeMemories = (input.memories ?? []).filter(
    (memory) => memory.status === "active",
  );
  if (activeMemories.length > 0) {
    lines.push(
      "Decisions and action items recorded so far:",
      ...activeMemories.map((memory) => `- [${memory.kind}] ${memory.content}`),
    );
  }

  lines.push(
    // The transcript is other people's words. Fencing it is a boundary, not
    // formatting: without the markers there is nothing distinguishing what
    // the room said from what this harness instructs.
    "Recent attributed transcript:",
    "--- BEGIN TRANSCRIPT ---",
    transcript,
    "--- END TRANSCRIPT ---",
    "The latest utterance explicitly addressed to you:",
    `${input.trigger.speakerName}: ${input.trigger.text}`,
    "",
    BEHAVIOR,
    "",
    FORMAT,
  );

  return lines.join("\n");
}

export interface ParsedAgentResponse {
  speak: string | null;
  chat: string | null;
  /** True when the agent actually used the SPEAK:/CHAT: format. */
  structured: boolean;
}

const SPEAK_MARKER = /^\s*SPEAK\s*:\s*$/imu;
const CHAT_MARKER = /^\s*CHAT\s*:\s*$/imu;
const INLINE_SPEAK = /^\s*SPEAK\s*:\s*/iu;
const INLINE_CHAT = /^\s*CHAT\s*:\s*/iu;

/**
 * Split a response on SPEAK:/CHAT:.
 *
 * Both the "marker on its own line" form the prompt asks for and the
 * "SPEAK: text on the same line" form models actually produce are accepted.
 * Anything before a SPEAK: marker is treated as preamble and dropped from
 * speech but kept for chat, because that is where a model puts its throat
 * clearing.
 */
export function parseAgentResponse(raw: string): ParsedAgentResponse {
  const text = raw.replace(/\r\n/gu, "\n").trim();
  if (text === "") return { speak: null, chat: null, structured: false };

  const speakAt = findMarker(text, SPEAK_MARKER, INLINE_SPEAK);
  const chatAt = findMarker(text, CHAT_MARKER, INLINE_CHAT);

  if (speakAt === null && chatAt === null) {
    return { speak: null, chat: null, structured: false };
  }

  const sections: { start: number; end: number; kind: "speak" | "chat" }[] = [];
  if (speakAt !== null) {
    sections.push({
      start: speakAt.bodyStart,
      end:
        chatAt !== null && chatAt.start > speakAt.start
          ? chatAt.start
          : text.length,
      kind: "speak",
    });
  }
  if (chatAt !== null) {
    sections.push({
      start: chatAt.bodyStart,
      end:
        speakAt !== null && speakAt.start > chatAt.start
          ? speakAt.start
          : text.length,
      kind: "chat",
    });
  }

  let speak: string | null = null;
  let chat: string | null = null;
  for (const section of sections) {
    const body = text.slice(section.start, section.end).trim();
    if (body === "") continue;
    if (section.kind === "speak") speak = body;
    else chat = body;
  }
  return { speak, chat, structured: true };
}

function findMarker(
  text: string,
  block: RegExp,
  inline: RegExp,
): { start: number; bodyStart: number } | null {
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (block.test(line)) {
      return { start: offset, bodyStart: offset + line.length + 1 };
    }
    const inlineMatch = inline.exec(line);
    if (inlineMatch !== null) {
      return { start: offset, bodyStart: offset + inlineMatch[0].length };
    }
    offset += line.length + 1;
  }
  return null;
}

export type SpeechDecision =
  | "speak_section"
  | "short_response"
  | "too_long"
  | "contains_code"
  | "looks_like_tool_output"
  | "empty";

export interface SpeechPlan {
  /** What the browser should say, or null for silence. */
  speak: string | null;
  /** What belongs in meeting chat, or null when nothing needs posting. */
  chat: string | null;
  decision: SpeechDecision;
  truncated: boolean;
}

/** Above this, an unstructured response is chat, not speech. */
const MAX_UNSTRUCTURED_WORDS = 60;
/** Hard cap on anything spoken, structured or not. */
const MAX_SPOKEN_WORDS = 110;

const CODE_FENCE = /```[\s\S]*?(```|$)/gu;
const URL = /\bhttps?:\/\/\S+/giu;
const TOOL_OUTPUT_HINT =
  /^(\s*[$>#]\s|\s*\{|\s*\[|\s*at\s+\S+:\d+|\s*(?:Traceback|ERROR|WARN|INFO)\b)/mu;

export function containsCode(text: string): boolean {
  if (/```/u.test(text)) return true;
  // An indented block of four spaces or a tab is markdown's other code form.
  if (/^(?: {4}|\t)\S/mu.test(text)) return true;
  return false;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Strip everything unspeakable: code, URLs, markdown furniture, list bullets.
 * What survives is prose.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(CODE_FENCE, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(URL, "a link in the chat")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*#{1,6}\s+/gmu, "")
    .replace(/\*\*|__/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateWords(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  const words = text.split(/\s+/u);
  if (words.length <= limit) return { text, truncated: false };
  const head = words.slice(0, limit).join(" ");
  // Prefer a sentence boundary so the cut does not land mid-clause.
  const lastStop = Math.max(
    head.lastIndexOf("."),
    head.lastIndexOf("?"),
    head.lastIndexOf("!"),
  );
  const cut = lastStop > head.length * 0.5 ? head.slice(0, lastStop + 1) : head;
  return { text: `${cut} The rest is in the meeting chat.`, truncated: true };
}

/**
 * Decide what is said aloud and what is posted, from a raw agent response.
 *
 * The fallbacks matter more than the happy path: an agent that ignores the
 * format still must not read a stack trace to a room of people.
 */
export function planSpeech(raw: string): SpeechPlan {
  const parsed = parseAgentResponse(raw);
  const text = raw.trim();
  if (text === "") {
    return { speak: null, chat: null, decision: "empty", truncated: false };
  }

  if (parsed.structured) {
    const spoken = parsed.speak === null ? "" : sanitizeForSpeech(parsed.speak);
    const capped = truncateWords(spoken, MAX_SPOKEN_WORDS);
    return {
      speak: capped.text.trim() === "" ? null : capped.text,
      chat: parsed.chat,
      decision: "speak_section",
      truncated: capped.truncated,
    };
  }

  if (containsCode(text)) {
    return {
      speak: null,
      chat: text,
      decision: "contains_code",
      truncated: false,
    };
  }
  if (TOOL_OUTPUT_HINT.test(text)) {
    return {
      speak: null,
      chat: text,
      decision: "looks_like_tool_output",
      truncated: false,
    };
  }
  if (countWords(text) > MAX_UNSTRUCTURED_WORDS) {
    return { speak: null, chat: text, decision: "too_long", truncated: false };
  }

  const spoken = sanitizeForSpeech(text);
  if (spoken === "") {
    return { speak: null, chat: text, decision: "empty", truncated: false };
  }
  return {
    speak: spoken,
    chat: null,
    decision: "short_response",
    truncated: false,
  };
}
