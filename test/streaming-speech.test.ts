/**
 * Streaming speech, which is where latency is won and where the safety
 * property is easiest to lose.
 *
 * The cases that matter are the ones where releasing early would be WRONG:
 * a half-finished sentence, code inside a SPEAK section, an agent that never
 * declared one, and a response that turns out to be tool output. Each of those
 * has to behave exactly as the non-streaming path already does.
 */
import { describe, expect, it } from "vitest";

import { SpeechStreamer } from "../src/gateway/streaming-speech.js";

/** Feed a response in fragments the way a model actually emits it. */
function stream(chunks: string[]): {
  spoken: string[];
  finish: ReturnType<SpeechStreamer["finish"]>;
  streamer: SpeechStreamer;
} {
  const streamer = new SpeechStreamer();
  const spoken: string[] = [];
  for (const chunk of chunks) spoken.push(...streamer.push(chunk));
  return { spoken, finish: streamer.finish(), streamer };
}

describe("speaking while the agent is still answering", () => {
  it("releases a sentence as soon as it is complete, not when the turn ends", () => {
    const { spoken } = stream([
      "SPEAK:\nCap retries at three.",
      " Then dead-letter the event.",
      " Details in the chat.",
    ]);
    expect(spoken).toEqual([
      "Cap retries at three.",
      "Then dead-letter the event.",
      "Details in the chat.",
    ]);
  });

  it("waits for the terminator rather than speaking half a clause", () => {
    const streamer = new SpeechStreamer();
    // The sentence is still being written; saying this much would sound worse
    // than saying nothing.
    expect(streamer.push("SPEAK:\nCap retries at three with")).toEqual([]);
    expect(streamer.push(" exponential backoff.")).toEqual([
      "Cap retries at three with exponential backoff.",
    ]);
  });

  it("says nothing until the agent has declared a SPEAK section", () => {
    // Before the marker this build cannot tell prose from the first line of a
    // stack trace, so it stays silent and lets the turn end normally.
    const streamer = new SpeechStreamer();
    expect(streamer.push("Let me look at that file.")).toEqual([]);
    expect(streamer.push(" Reading src/webhooks/retry.ts")).toEqual([]);
    expect(streamer.streamed).toBe(false);
  });

  it("falls back to planSpeech when the agent ignores the format", () => {
    const { spoken, finish } = stream(["A short plain answer about retries."]);
    expect(spoken).toEqual([]);
    // Exactly today's behaviour: a short unstructured response is still spoken.
    expect(finish.plan.speak).toBe("A short plain answer about retries.");
    expect(finish.plan.decision).toBe("short_response");
  });

  it("does not read code aloud even inside a SPEAK section", () => {
    const { spoken } = stream([
      "SPEAK:\nHere is the shape.",
      " ```ts\nconst backoff = 2 ** n;\n```",
      " That is the idea.",
    ]);
    expect(spoken).toEqual(["Here is the shape.", "That is the idea."]);
    expect(spoken.join(" ")).not.toContain("backoff");
  });

  it("stops at the CHAT marker and hands that half to chat", () => {
    const { spoken, finish } = stream([
      "SPEAK:\nShort version: it drops the event.",
      "\nCHAT:\n`src/webhooks/retry.ts:10` logs and returns.",
    ]);
    expect(spoken).toEqual(["Short version: it drops the event."]);
    expect(finish.plan.chat).toContain("retry.ts");
    // Already said aloud — handing it back would speak the answer twice.
    expect(finish.plan.speak).toBeNull();
  });

  it("speaks a trailing clause the model never punctuated", () => {
    const { spoken, finish } = stream([
      "SPEAK:\nFirst point is done.",
      " and the second one trails off",
    ]);
    expect(spoken).toEqual(["First point is done."]);
    expect(finish.tail).toEqual(["and the second one trails off"]);
  });

  it("caps total spoken words across the whole stream", () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${String(i)} about the retry budget.`,
    ).join(" ");
    const { spoken, finish } = stream([`SPEAK:\n${long}`]);
    const words = spoken.join(" ").split(/\s+/u).length;
    expect(words).toBeLessThanOrEqual(110);
    expect(finish.plan.truncated).toBe(true);
  });

  it("never speaks the same words twice", () => {
    // The failure this guards: finish() handing back the whole SPEAK section
    // after it has already been streamed out sentence by sentence.
    const { spoken, finish } = stream([
      "SPEAK:\nOne. Two. Three.",
      "\nCHAT:\ndetail",
    ]);
    expect(spoken).toEqual(["One.", "Two.", "Three."]);
    expect(finish.plan.speak).toBeNull();
    expect(finish.tail).toEqual([]);
  });

  it("handles the marker arriving split across chunks", () => {
    // Models do not respect token boundaries around markers.
    const { spoken } = stream(["SPE", "AK:\nRetries cap at three.", ""]);
    expect(spoken).toEqual(["Retries cap at three."]);
  });

  it("is silent on an empty turn", () => {
    const { spoken, finish } = stream([""]);
    expect(spoken).toEqual([]);
    expect(finish.plan.speak).toBeNull();
    expect(finish.plan.decision).toBe("empty");
  });
});
