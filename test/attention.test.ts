import { describe, expect, it } from "vitest";

import { decideAttention, splitSentences } from "../src/gateway/attention.js";

const WAKE = ["cofounder", "codex", "claude"];

function speech(text: string, addressed = false) {
  return decideAttention({
    text,
    channel: "speech" as const,
    addressed,
    speakerKind: "human" as const,
    wakeNames: WAKE,
  });
}

function chat(text: string) {
  return decideAttention({
    text,
    channel: "chat" as const,
    addressed: false,
    speakerKind: "human" as const,
    wakeNames: WAKE,
  });
}

describe("wake-name detection", () => {
  it.each([
    "Cofounder, what do you think?",
    "Hey Codex, inspect the webhook retries.",
    "Claude: summarize our decision.",
    "cofounder, can you draft the plan?",
    "Ok cofounder, give us the tradeoffs.",
    "So what do you think, cofounder?",
    "Codex can you check the retries?",
    "Cofounder — what would you cut first?",
    "Claude, please review the migration.",
  ])("triggers on %j", (text) => {
    const decision = speech(text);
    expect(decision.triggered).toBe(true);
    expect(decision.matchedWakeName).toBeTypeOf("string");
  });
});

describe("false positives", () => {
  it.each([
    "I used Codex yesterday.",
    "Claude helped write this.",
    "We should ask the cofounder later.",
    "The cofounder should decide that one.",
    "Our cofounder is out this week.",
    "Codex and Claude are both ACP agents.",
    "I think Claude wrote the first draft of that spec.",
    "Let's loop in Codex after standup.",
    "Anyone else remember what Claude said last time?",
    "That was a codex of medieval law, oddly enough.",
    "Cofounder mode is what we called it internally.",
  ])("stays silent on %j", (text) => {
    expect(speech(text).triggered).toBe(false);
  });

  it("stays silent on ordinary side conversation", () => {
    const decision = speech("Did the deploy finish before lunch?");
    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe("no_wake_name");
  });

  it("reports why a mention did not trigger", () => {
    expect(speech("I used Codex yesterday.").reason).toBe("mention_only");
  });

  it("does not trigger on a bare vocative with no request", () => {
    const decision = speech("Cofounder, nice to have you here.");
    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe("no_directive");
  });
});

describe("explicit address", () => {
  it("triggers when the speaker marks the utterance addressed", () => {
    const decision = speech("what about the retries", true);
    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("explicit_flag");
  });

  it("triggers on an at-mention in chat", () => {
    const decision = chat("@cofounder what is the retry budget?");
    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("chat_directed");
  });

  it("does not trigger on a chat message that only mentions the agent", () => {
    expect(chat("codex is what I used for that").triggered).toBe(false);
  });
});

describe("guards", () => {
  it("never triggers on the agent's own speech", () => {
    const decision = decideAttention({
      text: "Cofounder, what do you think?",
      channel: "speech",
      addressed: true,
      speakerKind: "agent",
      wakeNames: WAKE,
    });
    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe("agent_speaker");
  });

  it("ignores empty text", () => {
    expect(speech("   ").reason).toBe("empty");
  });

  it("matches multi-word wake names ahead of their prefix", () => {
    const decision = decideAttention({
      text: "Claude Code, run the test suite.",
      channel: "speech",
      addressed: false,
      speakerKind: "human",
      wakeNames: ["claude", "claude code"],
    });
    expect(decision.triggered).toBe(true);
    expect(decision.matchedWakeName).toBe("claude code");
  });

  it("finds a trigger in a later sentence", () => {
    const decision = speech(
      "That covers the billing work. Cofounder, what did we decide about retries?",
    );
    expect(decision.triggered).toBe(true);
  });
});

describe("splitSentences", () => {
  it("keeps terminators with their sentence", () => {
    expect(splitSentences("One thing. Then another? Yes!")).toEqual([
      "One thing.",
      "Then another?",
      "Yes!",
    ]);
  });
});
