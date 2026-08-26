/**
 * Local speech synthesis, and the route the speaker page fetches it from.
 *
 * The synthesis tests are macOS-only and say so rather than passing vacuously
 * elsewhere: `say` and `afconvert` are the implementation, not an interface.
 * The route tests run everywhere, because the thing worth protecting there —
 * that a public tunnel does not expose an open audio endpoint on someone's
 * laptop — has nothing to do with which platform synthesized the bytes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, type AmpServer } from "../src/server/create.js";
import {
  MAX_TTS_CHARS,
  synthesizeWav,
  ttsAvailable,
} from "../src/speech/tts.js";

const onMac = platform === "darwin";

/** Loudest sample in a 16-bit PCM WAV; ~0 means a silent container. */
function peakAmplitude(wav: Buffer): number {
  let peak = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    const sample = Math.abs(wav.readInt16LE(offset));
    if (sample > peak) peak = sample;
  }
  return peak;
}

describe.runIf(onMac)("local speech synthesis", () => {
  it("produces a WAV a browser can play", async () => {
    const wav = await synthesizeWav("Cap retries at three, then dead letter.");

    // RIFF/WAVE header, so the speaker page can hand it straight to an
    // <audio> element without a codec or a container guess.
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // Real samples, not an empty container — silence is the failure mode this
    // whole file exists to rule out.
    expect(wav.length).toBeGreaterThan(10_000);
  }, 30_000);

  it("treats text opening with a hyphen as words, not flags", async () => {
    // `say` would read "-v" as an option. The argument vector ends with `--`
    // before the text precisely so a model cannot smuggle one in.
    const wav = await synthesizeWav("-v Alex is not a voice request");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  }, 30_000);

  it("still speaks when the voice name is wrong", async () => {
    // Measured, not assumed: `say -v NotAVoice -o file` exits 0 and falls
    // back to the system default voice, producing byte-identical audio to the
    // default. So a typo in AMP_RECALL_SPEAKER_VOICE costs you the wrong
    // voice, never a mute agent — which is the right way round, and is
    // asserted here so nobody later "fixes" it into a hard failure that would
    // take a live meeting silent.
    const wav = await synthesizeWav("hello there", { voice: "NotARealVoice" });
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(peakAmplitude(wav)).toBeGreaterThan(1_000);
  }, 30_000);

  it("emits audible samples, not a well-formed silent container", async () => {
    // The failure this whole file exists to rule out is a bot that looks fine
    // and says nothing, so a header check alone is not enough.
    const wav = await synthesizeWav("Cap retries at three, then dead letter.");
    expect(peakAmplitude(wav)).toBeGreaterThan(1_000);
  }, 30_000);

  it("refuses empty and oversized text", async () => {
    await expect(synthesizeWav("   ")).rejects.toThrow(/nothing to say/u);
    await expect(synthesizeWav("a".repeat(MAX_TTS_CHARS + 1))).rejects.toThrow(
      /cap is/u,
    );
  });
});

describe("the tts route", () => {
  let server: AmpServer;
  let workdir: string;

  const start = async (withSecret: boolean) => {
    workdir = mkdtempSync(join(tmpdir(), "amp-tts-"));
    server = createServer({
      port: 0,
      host: "127.0.0.1",
      databasePath: join(workdir, "tts.db"),
      logLevel: "silent",
      ...(withSecret
        ? {
            recall: {
              apiKey: "test-key",
              region: "us-west-2",
              webhookBaseUrl: "https://tunnel.test",
              webhookSecret: "s3cret",
              speakerUrl: undefined,
              speakerVoice: undefined,
              botName: "AMP cofounder",
            },
          }
        : {}),
    });
    await server.start();
  };

  const makeMeeting = async () => {
    const response = await fetch(`${server.origin()}/api/meetings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Retry policy sync",
        agentDisplayName: "Cofounder",
        wakeNames: ["cofounder"],
        participants: [{ name: "Ada", kind: "human" }],
        agentId: "fake",
      }),
    });
    const payload = (await response.json()) as { meeting: { id: string } };
    return payload.meeting.id;
  };

  afterEach(async () => {
    await server.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it("refuses without the shared secret, and says nothing about the meeting", async () => {
    await start(true);
    const meetingId = await makeMeeting();

    const response = await fetch(
      `${server.origin()}/api/meetings/${meetingId}/tts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    // 404, not 401: a caller who fails this has no business learning that the
    // meeting exists — the same posture as the webhook route.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("refuses a wrong secret", async () => {
    await start(true);
    const meetingId = await makeMeeting();
    const response = await fetch(
      `${server.origin()}/api/meetings/${meetingId}/tts?secret=wrong`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("rejects text past the cap before synthesizing anything", async () => {
    await start(false);
    const meetingId = await makeMeeting();
    const response = await fetch(
      `${server.origin()}/api/meetings/${meetingId}/tts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(MAX_TTS_CHARS + 1) }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("404s for a meeting that does not exist", async () => {
    await start(false);
    const response = await fetch(
      `${server.origin()}/api/meetings/mtg_nope/tts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("returns audio when the secret is right", async () => {
    await start(true);
    const meetingId = await makeMeeting();
    const response = await fetch(
      `${server.origin()}/api/meetings/${meetingId}/tts?secret=s3cret`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Cap retries at three." }),
      },
    );

    if (!ttsAvailable()) {
      // Off macOS this is a capability gap, reported as one so the speaker
      // page can fall back rather than treating it as a bug.
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("tts_unavailable");
      return;
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    const wav = Buffer.from(await response.arrayBuffer());
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.length).toBeGreaterThan(10_000);
  }, 30_000);
});
