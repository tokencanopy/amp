/**
 * The attention engine against speech, not writing.
 *
 * A caption stream does not punctuate. Every rule in the engine is therefore
 * asserted twice here — once on the written form, once on the same words as
 * ASR would emit them — and the two must agree. The ASR form is derived
 * MECHANICALLY from the written one rather than typed out by hand, so the two
 * halves of each pair cannot drift apart as cases are added.
 *
 * This file exists because the original rules, measured against unpunctuated
 * text, lost six of eight genuine addresses. They did not become wrong; they
 * went deaf. A test suite written only in punctuated English could never have
 * shown that, which is the point.
 */
import { describe, expect, it } from "vitest";

import { decideAttention } from "../src/gateway/attention.js";

const WAKE = ["cofounder", "codex", "claude"];

const decide = (text: string) =>
  decideAttention({
    text,
    channel: "speech",
    addressed: false,
    speakerKind: "human",
    wakeNames: WAKE,
  });

/**
 * What a caption stream does to a sentence: no capitals, no terminal
 * punctuation, no commas. Apostrophes survive, because the engines that
 * matter (Whisper and the hosted vendors built on it) do emit contractions.
 */
export function toAsr(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:—–]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Written forms that must earn a turn — in speech as well as in writing. */
const ADDRESSES = [
  "Cofounder, what do you think?",
  "Hey Codex, inspect the webhook retries.",
  "Claude: summarize our decision.",
  "Cofounder, can you draft the plan?",
  "Ok cofounder, give us the tradeoffs.",
  "So what do you think, cofounder?",
  "Codex can you check the retries?",
  "Claude, please review the migration.",
  "Cofounder, how would you approach this?",
  "Codex, walk us through the failure.",
];

/** Written forms that must stay silent — in speech as well as in writing. */
const NOT_ADDRESSES = [
  "I used Codex yesterday.",
  "Claude helped write this.",
  "We should ask the cofounder later.",
  "Our cofounder is out this week.",
  "Codex and Claude are both ACP agents.",
  "Cofounder mode is what we called it internally.",
  "That was a codex of medieval law, oddly enough.",
  "Anyone else remember what Claude said last time?",
  "I think Claude wrote the first draft of that spec.",
  "Codex says the retry path is fine.",
];

describe("written and spoken forms agree", () => {
  it.each(ADDRESSES)("hears %j spoken as well as written", (written) => {
    expect(decide(written).triggered).toBe(true);
    expect(decide(toAsr(written)).triggered).toBe(true);
  });

  it.each(NOT_ADDRESSES)("ignores %j spoken as well as written", (written) => {
    expect(decide(written).triggered).toBe(false);
    expect(decide(toAsr(written)).triggered).toBe(false);
  });
});

describe("speech the written corpus never produces", () => {
  // Disfluencies, contractions and elliptical requests: ordinary out loud,
  // and absent from anything anyone writes down.
  it.each([
    "um so cofounder what would you cut first",
    "hey claude can you take the retry work",
    "ok codex summarize where we landed",
    "so codex what's the retry budget",
    "claude what's your read on that",
    "alright cofounder your thoughts",
    "and cofounder anything to add",
    "uh cofounder how are we doing on time",
  ])("triggers on %j", (text) => {
    expect(decide(text).triggered).toBe(true);
  });

  it.each([
    "can you send this to codex",
    "i think codex said it was fine",
    "we talked to claude about this yesterday",
    "did anyone ask codex about it",
    "so claude wrote most of that",
    "i'll check with codex after this",
    "the cofounder thing is still open",
    "we could use claude for that",
    "codex and i paired on it",
  ])("stays silent on %j", (text) => {
    expect(decide(text).triggered).toBe(false);
  });
});

describe("a clause-final name is usually an object, not a vocative", () => {
  // Each of these ends with the wake name AND contains a question or an
  // imperative — the exact shape a naive unpunctuated rule admits. Every one
  // of them is addressed to a person ABOUT the agent.
  it.each([
    "when did you last use codex",
    "did you try codex",
    "remind me to ping codex",
    "should we ask codex",
    "who set up codex",
    "tell grace about codex",
    "can you check with claude",
    "what do you think about codex",
    "how do we bill for codex",
    "any thoughts on codex",
  ])("stays silent on %j", (text) => {
    expect(decide(text).triggered).toBe(false);
  });

  it("hears an opinion question that ends on the name", () => {
    expect(decide("what do you think cofounder").triggered).toBe(true);
    expect(decide("so how do you feel cofounder").triggered).toBe(true);
  });

  it("still hears any trailing vocative when the comma survives", () => {
    // The narrow spoken rule costs nothing where punctuation exists.
    expect(decide("Could you take a look, codex?").triggered).toBe(true);
  });
});

describe("the predicate guard", () => {
  // What the comma used to carry: whether the name is the SUBJECT of what
  // follows, or the person being spoken to.
  it("ignores a name that opens a statement about it", () => {
    for (const text of [
      "claude helped write this",
      "codex says the retry path is fine",
      "cofounder wants to ship on friday",
      "claude said can you check this",
      "codex mentioned can you look at the retries",
      "claude asked could you review it",
    ]) {
      const decision = decide(text);
      expect(decision.triggered).toBe(false);
      expect(decision.reason).toBe("mention_only");
    }
  });

  it("hears a name that opens an instruction", () => {
    for (const text of [
      "claude write the migration note",
      "codex check the retry path",
      "cofounder update us on billing",
    ]) {
      expect(decide(text).triggered).toBe(true);
    }
  });

  it("does not apply the guard when a comma settles it", () => {
    // With the comma present the vocative is not in doubt, so the sentence is
    // judged on whether it asks for something.
    expect(decide("Claude, note that we shipped it.").triggered).toBe(true);
  });
});

describe("explicit address still bypasses everything", () => {
  it("triggers on unpunctuated text marked as addressed", () => {
    const decision = decideAttention({
      text: "what about the retries",
      channel: "speech",
      addressed: true,
      speakerKind: "human",
      wakeNames: WAKE,
    });
    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("explicit_flag");
  });

  it("triggers on a lowercase at-mention in chat", () => {
    expect(
      decideAttention({
        text: "@cofounder whats the retry budget",
        channel: "chat",
        addressed: false,
        speakerKind: "human",
        wakeNames: WAKE,
      }).triggered,
    ).toBe(true);
  });
});
