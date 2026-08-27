/**
 * Speaking while the agent is still answering.
 *
 * `planSpeech` decides what to say from a COMPLETE response, which is correct
 * and costs the whole turn in silence: an answer that takes eight seconds to
 * generate is eight seconds of a room staring at a muted tile. Measured on a
 * real call, time-to-first-audio was ten to fifteen seconds, and almost all of
 * it was this wait.
 *
 * So this consumes the same response incrementally and releases it a sentence
 * at a time, while the rest is still being written. The safety property that
 * matters — never read code, tool output or a URL aloud — is preserved by
 * applying it per sentence rather than per response.
 *
 * The conservative rule that makes that sound: **nothing is spoken until the
 * agent has declared a `SPEAK:` section.** Before that marker, this build
 * cannot know whether it is looking at prose or the first line of a stack
 * trace, so it says nothing and lets the turn end in `planSpeech`'s hands.
 * An agent that ignores the format therefore behaves exactly as it does
 * today; one that follows it gets heard immediately. That asymmetry is the
 * point — compliance is rewarded, non-compliance is not punished with a
 * mistake.
 */
import { splitSentences } from "./attention.js";
import {
  containsCode,
  planSpeech,
  sanitizeForSpeech,
  type SpeechPlan,
} from "./prompt.js";

/** Matches `planSpeech`'s cap, applied cumulatively across the stream. */
const MAX_SPOKEN_WORDS = 110;

const SPEAK_MARKER = /(^|\n)\s*SPEAK\s*:/iu;
const CHAT_MARKER = /(^|\n)\s*CHAT\s*:/iu;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * A sentence is releasable only once its terminator has arrived. Without this
 * the stream would speak half a clause and then the other half as a separate
 * utterance, which sounds worse than waiting.
 */
function settledSpan(body: string): { settled: string; rest: string } {
  const match = /[.!?]["')\]]?(\s|$)/gu;
  let lastEnd = -1;
  let found: RegExpExecArray | null;
  while ((found = match.exec(body)) !== null) {
    lastEnd = found.index + found[0].trimEnd().length;
  }
  if (lastEnd < 0) return { settled: "", rest: body };
  return { settled: body.slice(0, lastEnd), rest: body.slice(lastEnd) };
}

/**
 * Remove fenced blocks BEFORE splitting into sentences.
 *
 * A fence carries no sentence terminator, so it glues itself to whatever
 * prose follows and the pair is then rejected as one unspeakable sentence —
 * silently swallowing a legitimate line. Dropping the fence first keeps the
 * prose around it sayable, and the `containsCode` check below still stands as
 * the backstop for anything a fence did not delimit.
 */
function withoutFences(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/gu, " ");
}

export class SpeechStreamer {
  #raw = "";
  #releasedChars = 0;
  #spokenWords = 0;
  #streamed = false;
  #capped = false;

  /**
   * Feed one streamed chunk. Returns whatever is now safe to say aloud, in
   * order — usually nothing, occasionally one sentence, rarely several.
   */
  push(chunk: string): string[] {
    this.#raw += chunk;
    if (this.#capped) return [];

    const speakBody = this.#speakBody();
    if (speakBody === null) return [];

    const pending = speakBody.slice(this.#releasedChars);
    const { settled, rest } = settledSpan(pending);
    if (settled === "") return [];
    // Advance over the RAW span consumed; sentences come from a fence-stripped
    // copy of it, so the two never disagree about how much was read.
    this.#releasedChars = speakBody.length - rest.length;
    const ready = splitSentences(withoutFences(settled));

    const out: string[] = [];
    for (const sentence of ready) {
      // Per sentence, for the same reason planSpeech does it per response: a
      // model that fenced a snippet inside its SPEAK section must not have it
      // read out, and finding that at the end would be finding it too late.
      if (containsCode(sentence)) continue;
      const spoken = sanitizeForSpeech(sentence).trim();
      if (spoken === "") continue;
      // Stop before the sentence that would breach the cap rather than after
      // it: `planSpeech` truncates at a sentence boundary INSIDE the cap, and
      // the streamed path must not be looser than the one it replaces.
      if (this.#spokenWords + countWords(spoken) > MAX_SPOKEN_WORDS) {
        this.#capped = true;
        break;
      }
      this.#spokenWords += countWords(spoken);
      this.#streamed = true;
      out.push(spoken);
    }
    return out;
  }

  /** Anything already released, so the caller need not track it. */
  get streamed(): boolean {
    return this.#streamed;
  }

  /**
   * Close the turn.
   *
   * When nothing was streamed this defers entirely to `planSpeech`, so a
   * non-complying agent, an empty answer, or a response that turned out to be
   * tool output all behave exactly as before.
   */
  finish(): { plan: SpeechPlan; tail: string[] } {
    const speakBody = this.#speakBody();
    if (!this.#streamed || speakBody === null) {
      return { plan: planSpeech(this.#raw), tail: [] };
    }

    // Whatever never reached a sentence terminator — a final clause the model
    // ended without punctuation.
    const tail: string[] = [];
    const remainder = speakBody.slice(this.#releasedChars).trim();
    if (remainder !== "" && !this.#capped && !containsCode(remainder)) {
      const spoken = sanitizeForSpeech(remainder).trim();
      if (spoken !== "" && this.#spokenWords < MAX_SPOKEN_WORDS) {
        this.#spokenWords += countWords(spoken);
        tail.push(spoken);
      }
    }

    const parsed = planSpeech(this.#raw);
    return {
      plan: {
        // Already said aloud, sentence by sentence. Handing it back would
        // speak the whole answer a second time.
        speak: null,
        chat: parsed.chat,
        decision: "speak_section",
        truncated: this.#capped,
      },
      tail,
    };
  }

  /** The body of the SPEAK section so far, or null if it has not opened. */
  #speakBody(): string | null {
    const text = this.#raw.replace(/\r\n/gu, "\n");
    const speak = SPEAK_MARKER.exec(text);
    if (speak === null) return null;
    const start = speak.index + speak[0].length;
    const after = text.slice(start);
    const chat = CHAT_MARKER.exec(after);
    return chat === null ? after : after.slice(0, chat.index);
  }
}
