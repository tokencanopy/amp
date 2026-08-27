/**
 * A meeting, replayed through the real ingress, against a real agent process.
 *
 * The unit suites feed the attention engine clean text and the gateway a
 * hand-built event. This drives the path a real call drives — vendor payload
 * in through the webhook route, translation, attention, prompt, a spawned ACP
 * agent, streamed speech back out — using transcripts degraded the way a real
 * vendor degraded them.
 *
 * It exists because a single live Google Meet call found four defects that 228
 * passing tests did not. Not because those tests were weak, but because every
 * one of them spoke perfect English. The transforms in `asr-observed.ts` are
 * the difference, and this is where they meet the whole system.
 *
 * The agent here is the built-in fake one: deterministic, free, and the same
 * ACP over the same stdio a real adapter speaks. What that buys is a test that
 * runs on every pull request. What it cannot buy is real model latency — that
 * needs a real agent, and belongs in a script someone runs deliberately.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer, type AmpServer } from "../src/server/create.js";
import { RECALL_EVENTS } from "../src/providers/recall/wire.js";
import {
  merge,
  pausePeriod,
  runTogether,
  splitCompound,
} from "./asr-observed.js";

let server: AmpServer;
let workdir: string;
const SECRET = "s3cret";

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "amp-replay-"));
  server = createServer(
    {
      port: 0,
      host: "127.0.0.1",
      databasePath: join(workdir, "replay.db"),
      logLevel: "silent",
      permissionTimeoutMs: 4_000,
    },
    {
      ...process.env,
      AMP_RECALL_API_KEY: "test-key",
      AMP_RECALL_WEBHOOK_BASE_URL: "https://tunnel.test",
      AMP_RECALL_WEBHOOK_SECRET: SECRET,
      // With no speaker page the provider routes speech to the meeting's chat
      // instead, which is correct but means an answer never reaches the
      // transcript. A configured page is also what a real deployment has.
      AMP_RECALL_SPEAKER_URL: "https://tunnel.test/speaker.html",
    },
    {
      // Dispatching a bot is the only thing here that would touch the network.
      // Everything after it — the webhook ingress, translation, attention, the
      // spawned agent, streamed speech — is the real code path.
      fetch: (async () =>
        new Response(JSON.stringify({ id: "bot_replay" }), {
          status: 200,
        })) as typeof globalThis.fetch,
    },
  );
  await server.start();
});

afterEach(async () => {
  await server.stop();
  rmSync(workdir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${server.origin()}${path}`, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
  return (await response.json()) as T;
}

/** One speaker's line, as the vendor would deliver it. */
function transcript(speaker: { id: number; name: string }, heard: string) {
  return {
    event: RECALL_EVENTS.transcript,
    data: {
      bot: { id: "bot_replay", metadata: {} },
      transcript: { id: "tr_replay", metadata: {} },
      data: {
        language_code: "en",
        participant: { id: speaker.id, name: speaker.name },
        words: heard.split(" ").map((text, index) => ({
          text,
          start_timestamp: { relative: index },
          end_timestamp: { relative: index + 1 },
        })),
      },
    },
  };
}

interface MeetingView {
  meeting: { id: string; status: string };
  transcript: {
    speakerName: string;
    speakerKind: string;
    text: string;
    addressed: boolean;
  }[];
  chat: { speakerName: string; text: string }[];
  agent: { status: string };
}

async function liveMeeting(): Promise<string> {
  const created = await call<{ meeting: { id: string } }>("/api/meetings", {
    method: "POST",
    body: {
      title: "Replayed standup",
      provider: "recall",
      meetingUrl: "https://meet.google.invalid/replay-test",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder", "claude"],
      participants: [],
      agentId: "fake",
    },
  });
  await call(`/api/meetings/${created.meeting.id}/start`, { method: "POST" });
  // A real ACP agent process over real stdio — the fake one, so the test is
  // deterministic and free, but the same protocol a real adapter speaks.
  await call(`/api/meetings/${created.meeting.id}/agent/connect`, {
    method: "POST",
    body: { agentId: "fake", workspacePath: workdir },
  });
  return created.meeting.id;
}

/** Post one vendor payload the way Recall does, and let it settle. */
async function say(
  meetingId: string,
  speaker: { id: number; name: string },
  heard: string,
  settleMs = 250,
): Promise<void> {
  const response = await fetch(
    `${server.origin()}/api/providers/recall/${meetingId}?secret=${SECRET}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transcript(speaker, heard)),
    },
  );
  expect(response.status).toBe(200);
  await sleep(settleMs);
}

async function view(meetingId: string): Promise<MeetingView> {
  return await call<MeetingView>(`/api/meetings/${meetingId}`);
}

const ADA = { id: 11, name: "Ada" };
const GRACE = { id: 12, name: "Grace" };

describe("a meeting replayed as the vendor delivered it", () => {
  it("hears a question the vendor ran together into one token", async () => {
    // Observed shape: an English question inside otherwise Chinese speech came
    // back with every space removed. The words are all there; the boundaries
    // are not.
    const meetingId = await liveMeeting();
    const heard = runTogether("Claude what should we do about retries");

    await say(meetingId, ADA, heard);

    const room = await view(meetingId);
    const line = room.transcript.find((entry) => entry.text === heard);
    expect(
      line,
      "the utterance should still be recorded verbatim",
    ).toBeTruthy();
    // Nothing to assert about triggering yet — with no spaces there is no wake
    // name to find, and the engine is right to stay silent. What must NOT
    // happen is a crash or a mis-attribution.
    expect(line?.speakerName).toBe("Ada");
  });

  it("ignores side conversation that merely names the agent", async () => {
    const meetingId = await liveMeeting();
    await say(meetingId, ADA, "I used Claude yesterday to clean up migrations");
    await say(meetingId, GRACE, "We should ask the cofounder later about it");

    const room = await view(meetingId);
    expect(room.transcript).toHaveLength(2);
    expect(
      room.transcript.every((entry) => entry.speakerKind === "human"),
    ).toBe(true);
  });

  it("attributes two speakers correctly across a whole exchange", async () => {
    // Mis-attribution is the failure worth being paranoid about: the
    // transcript is what the agent is told the room said.
    const meetingId = await liveMeeting();
    await say(meetingId, ADA, "the retry budget worries me");
    await say(meetingId, GRACE, "mine too but lets ship it");
    await say(meetingId, ADA, "fair");

    const room = await view(meetingId);
    expect(room.transcript.map((entry) => entry.speakerName)).toEqual([
      "Ada",
      "Grace",
      "Ada",
    ]);
  });

  it("does not answer one speaker's words attributed to another", async () => {
    const meetingId = await liveMeeting();
    await say(meetingId, ADA, merge("so", "anyway"), 100);
    await say(meetingId, GRACE, "claude what do you think about the budget");

    const room = await view(meetingId);
    const addressed = room.transcript.filter((entry) => entry.addressed);
    expect(addressed.every((entry) => entry.speakerName === "Grace")).toBe(
      true,
    );
  });

  // --- the two shapes that went deaf on a real call ----------------------
  //
  // Both of these describe how a person naturally addresses an agent out
  // loud, and both were silently ignored in a live Google Meet. They are the
  // reason this file exists.

  it("hears a vocative the vendor punctuated as its own sentence", async () => {
    // "Cofounder, what do you think?" spoken with a natural pause after the
    // name arrives as "Cofounder. What do you think?" — and that full stop is
    // a sentence boundary. One half addresses nobody, the other asks nothing.
    const meetingId = await liveMeeting();
    const heard = pausePeriod("Claude, what do you think about the retries?");
    expect(heard).toBe("Claude. What do you think about the retries?");

    await say(meetingId, ADA, heard, 2_500);

    const room = await view(meetingId);
    expect(
      room.transcript.some((entry) => entry.speakerKind === "agent"),
      "a pause after the name must not make the agent deaf",
    ).toBe(true);
  });

  it("hears a wake name the vendor split into two words", async () => {
    // "cofounder" came back as "Co founder", so the name stopped existing.
    const meetingId = await liveMeeting();
    const heard = splitCompound(
      "Cofounder, can you summarize the retry decision?",
      "cofounder",
      "co",
    );
    expect(heard.toLowerCase()).toContain("co founder");

    await say(meetingId, ADA, heard, 2_500);

    const room = await view(meetingId);
    expect(
      room.transcript.some((entry) => entry.speakerKind === "agent"),
      "a split compound must not make the agent deaf",
    ).toBe(true);
  });
});
