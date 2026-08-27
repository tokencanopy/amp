/**
 * What a real speech-to-text vendor actually did to real speech.
 *
 * `asr.test.ts` models one dialect — no capitals, no punctuation — which is
 * what Whisper-style engines emit. Recall's streaming transcription does
 * something different and, for this engine, more dangerous: it DOES punctuate,
 * and it punctuates by where the speaker paused.
 *
 * Every transform below was observed in a live Google Meet call on 2026-08-26,
 * and each one is annotated with the shape that motivated it. The content here
 * is synthetic — the real utterances were a person's actual meeting and do not
 * belong in a repository — but the damage is copied faithfully, because it is
 * the damage that breaks things.
 *
 * The one that matters most is `pausePeriod`. A speaker naturally pauses after
 * saying someone's name, the vendor renders that pause as a full stop, and the
 * sentence splitter then separates the name from the question it introduced:
 * one half has an address with nothing asked, the other asks something of
 * nobody. Both halves are correctly ignored, and the agent goes deaf to the
 * single most natural way of addressing it.
 */

/**
 * Whole phrases arrive with the spaces gone.
 *
 * Observed: an English question inside otherwise Chinese speech came back as
 * one unbroken token. Auto language detection appears to segment against the
 * wrong language and then not re-segment the rest.
 */
export function runTogether(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * A compound wake name is split into two words.
 *
 * Observed: "cofounder" transcribed as "Co founder". The engine matches wake
 * names as tokens, so the name simply stops existing.
 */
export function splitCompound(
  text: string,
  compound: string,
  /** Where the vendor broke it — "cofounder" split after "co". */
  after: string,
): string {
  const rest = compound.slice(after.length);
  return text.replace(new RegExp(compound, "giu"), (match) => {
    const split = `${after} ${rest}`;
    return match.charAt(0) === match.charAt(0).toUpperCase()
      ? split.charAt(0).toUpperCase() + split.slice(1)
      : split;
  });
}

/**
 * The pause after a vocative becomes a full stop rather than a comma.
 *
 * Observed: "Cofounder, what do you think about the retry budget?" arrived as
 * "Co founder. What do you think about the retry budget?" — and that period is
 * a sentence boundary, which is why the address and the question stop being
 * the same utterance.
 */
export function pausePeriod(text: string): string {
  // A full stop starts a sentence, so the vendor capitalizes what follows —
  // which is exactly what makes the two halves look like separate thoughts.
  return text.replace(
    /,\s+(\p{L})/u,
    (_match, next: string) => `. ${next.toUpperCase()}`,
  );
}

/** Terminal punctuation is dropped when the speaker trails off. */
export function trailOff(text: string): string {
  return text.replace(/[.!?]\s*$/u, "");
}

/** Two speakers' words arrive as one utterance when they overlap. */
export function merge(...parts: string[]): string {
  return parts.join(" ");
}

/**
 * A line of meeting speech, and what the room should get for it.
 *
 * `why` is not decoration: when one of these fails it is the only thing that
 * says whether the engine got the language wrong or the vendor did.
 */
export interface SpokenLine {
  /** What a person said, written properly. */
  said: string;
  /** What the vendor delivered, after the damage above. */
  heard: string;
  /** Whether this should earn the agent a turn. */
  triggers: boolean;
  why: string;
}
