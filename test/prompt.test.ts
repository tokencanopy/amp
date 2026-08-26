import { describe, expect, it } from "vitest";

import {
  buildAgentPrompt,
  containsCode,
  parseAgentResponse,
  planSpeech,
  sanitizeForSpeech,
} from "../src/gateway/prompt.js";
import type { Participant, TranscriptEntry } from "../src/domain.js";

const participant = (name: string, kind: Participant["kind"]): Participant => ({
  id: `p_${name}`,
  meetingId: "mtg_1",
  name,
  kind,
  role: kind === "agent" ? "AI cofounder" : "founder",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const entry = (speakerName: string, text: string): TranscriptEntry => ({
  id: `utt_${speakerName}_${text.length}`,
  meetingId: "mtg_1",
  participantId: `p_${speakerName}`,
  speakerName,
  speakerKind: "human",
  text,
  addressed: false,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("buildAgentPrompt", () => {
  const prompt = buildAgentPrompt({
    meetingTitle: "Weekly product sync",
    agentName: "Cofounder",
    participants: [
      participant("Ada", "human"),
      participant("Cofounder", "agent"),
    ],
    topic: "webhook retries",
    summary: "The team reviewed billing.",
    recentTranscript: [
      entry("Ada", "Retries are failing at the third attempt."),
    ],
    trigger: { speakerName: "Ada", text: "Cofounder, what do you think?" },
    memories: [
      {
        id: "mem_1",
        meetingId: "mtg_1",
        kind: "decision",
        content: "Ship the retry fix this week.",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem_2",
        meetingId: "mtg_1",
        kind: "note",
        content: "An idea we dropped.",
        status: "superseded",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  it("states the role, meeting, and agent name", () => {
    expect(prompt).toContain("You are participating as an AI cofounder");
    expect(prompt).toContain("Meeting: Weekly product sync");
    expect(prompt).toContain("Your meeting name: Cofounder");
  });

  it("lists participants with their kind", () => {
    expect(prompt).toContain("- Ada (human, founder)");
    expect(prompt).toContain("- Cofounder (agent, AI cofounder)");
  });

  it("fences the transcript so room text cannot pose as instructions", () => {
    expect(prompt).toContain("--- BEGIN TRANSCRIPT ---");
    expect(prompt).toContain("Ada: Retries are failing at the third attempt.");
    expect(prompt).toContain("--- END TRANSCRIPT ---");
  });

  it("carries the trigger utterance and the behavior contract", () => {
    expect(prompt).toContain(
      "The latest utterance explicitly addressed to you:\nAda: Cofounder, what do you think?",
    );
    expect(prompt).toContain(
      "Keep the spoken portion below approximately 80 words.",
    );
    expect(prompt).toContain("SPEAK:");
    expect(prompt).toContain("CHAT:");
  });

  it("includes active memories and omits superseded ones", () => {
    expect(prompt).toContain("- [decision] Ship the retry fix this week.");
    expect(prompt).not.toContain("An idea we dropped.");
  });

  it("degrades cleanly with no context at all", () => {
    const bare = buildAgentPrompt({
      meetingTitle: "Standup",
      agentName: "Cofounder",
      participants: [],
      topic: null,
      summary: null,
      recentTranscript: [],
      trigger: { speakerName: "Ada", text: "Cofounder, hello?" },
    });
    expect(bare).toContain("(none recorded)");
    expect(bare).toContain("(no prior utterances)");
    expect(bare).toContain("(not set)");
  });
});

describe("parseAgentResponse", () => {
  it("splits markers on their own lines", () => {
    const parsed = parseAgentResponse(
      "SPEAK:\nRetries look fine.\n\nCHAT:\nDetail: backoff is 3x.",
    );
    expect(parsed.structured).toBe(true);
    expect(parsed.speak).toBe("Retries look fine.");
    expect(parsed.chat).toBe("Detail: backoff is 3x.");
  });

  it("accepts inline markers", () => {
    const parsed = parseAgentResponse(
      "SPEAK: Short answer.\nCHAT: Long answer.",
    );
    expect(parsed.speak).toBe("Short answer.");
    expect(parsed.chat).toBe("Long answer.");
  });

  it("handles a SPEAK section with no CHAT section", () => {
    const parsed = parseAgentResponse("SPEAK:\nJust this.");
    expect(parsed.speak).toBe("Just this.");
    expect(parsed.chat).toBeNull();
  });

  it("handles a CHAT section with no SPEAK section", () => {
    const parsed = parseAgentResponse("CHAT:\nOnly detail.");
    expect(parsed.speak).toBeNull();
    expect(parsed.chat).toBe("Only detail.");
  });

  it("reports unstructured responses as such", () => {
    const parsed = parseAgentResponse("Just a plain reply.");
    expect(parsed.structured).toBe(false);
    expect(parsed.speak).toBeNull();
  });

  it("drops preamble before the SPEAK marker", () => {
    const parsed = parseAgentResponse(
      "Let me think about that.\nSPEAK:\nHere is the answer.",
    );
    expect(parsed.speak).toBe("Here is the answer.");
  });
});

describe("planSpeech", () => {
  it("speaks the SPEAK section and routes CHAT to meeting chat", () => {
    const plan = planSpeech(
      "SPEAK:\nWe should cap retries at three.\nCHAT:\n```ts\nconst n = 3;\n```",
    );
    expect(plan.decision).toBe("speak_section");
    expect(plan.speak).toBe("We should cap retries at three.");
    expect(plan.chat).toContain("const n = 3;");
  });

  it("speaks a short plain response", () => {
    const plan = planSpeech("Agreed, three retries is the right cap.");
    expect(plan.decision).toBe("short_response");
    expect(plan.speak).toBe("Agreed, three retries is the right cap.");
    expect(plan.chat).toBeNull();
  });

  it("never speaks a code block", () => {
    const plan = planSpeech("Here is the fix:\n```ts\nconst n = 3;\n```");
    expect(plan.decision).toBe("contains_code");
    expect(plan.speak).toBeNull();
    expect(plan.chat).toContain("const n = 3;");
  });

  it("never speaks raw tool output", () => {
    const plan = planSpeech("$ npm test\nERROR failing suite at src/x.ts:12");
    expect(plan.decision).toBe("looks_like_tool_output");
    expect(plan.speak).toBeNull();
  });

  it("does not speak a long unstructured response", () => {
    const plan = planSpeech(Array.from({ length: 90 }, () => "word").join(" "));
    expect(plan.decision).toBe("too_long");
    expect(plan.speak).toBeNull();
    expect(plan.chat).not.toBeNull();
  });

  it("truncates an over-long SPEAK section rather than reading it all", () => {
    const long = `SPEAK:\n${Array.from({ length: 200 }, () => "word").join(" ")}`;
    const plan = planSpeech(long);
    expect(plan.truncated).toBe(true);
    expect(plan.speak).toContain("The rest is in the meeting chat.");
    expect(plan.speak!.split(/\s+/).length).toBeLessThan(130);
  });

  it("strips code and URLs out of a SPEAK section", () => {
    const plan = planSpeech(
      "SPEAK:\nSee https://example.test/docs and run `npm test` locally.",
    );
    expect(plan.speak).toBe("See a link in the chat and run npm test locally.");
  });

  it("returns silence for an empty response", () => {
    expect(planSpeech("   ").decision).toBe("empty");
    expect(planSpeech("   ").speak).toBeNull();
  });
});

describe("speech sanitizers", () => {
  it("detects fenced and indented code", () => {
    expect(containsCode("```js\nx\n```")).toBe(true);
    expect(containsCode("    const x = 1;")).toBe(true);
    expect(containsCode("plain prose")).toBe(false);
  });

  it("removes list bullets and markdown emphasis", () => {
    expect(sanitizeForSpeech("- **one**\n- two")).toBe("one two");
  });
});
