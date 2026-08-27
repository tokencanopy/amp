/**
 * Local speech synthesis, and the route the speaker page fetches it from.
 *
 * The synthesis tests are macOS-only and say so rather than passing vacuously
 * elsewhere: `say` and `afconvert` are the implementation, not an interface.
 * The route tests run everywhere, because the thing worth protecting there —
 * that a public tunnel does not expose an open audio endpoint on someone's
 * laptop — has nothing to do with which platform synthesized the bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, type AmpServer } from "../src/server/create.js";
import {
  MAX_TTS_CHARS,
  synthesizeSpeech,
  ttsAvailable,
} from "../src/speech/tts.js";

const onMac = platform === "darwin";

/**
 * Loudest sample in the clip; ~0 means a well-formed but SILENT container,
 * which is the failure this file exists to catch.
 *
 * The audio ships as AAC, so it is decoded back to PCM to be measured — with
 * `afconvert`, the same stock tool that encoded it, so the test needs nothing
 * the implementation does not already require.
 */
function peakAmplitude(encoded: Buffer): number {
  const dir = mkdtempSync(join(tmpdir(), "amp-tts-peak-"));
  try {
    const src = join(dir, "clip.m4a");
    const pcm = join(dir, "clip.wav");
    writeFileSync(src, encoded);
    execFileSync("afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEI16@22050",
      "-c",
      "1",
      src,
      pcm,
    ]);
    const wav = readFileSync(pcm);
    let peak = 0;
    for (let offset = 44; offset + 1 < wav.length; offset += 2) {
      const sample = Math.abs(wav.readInt16LE(offset));
      if (sample > peak) peak = sample;
    }
    return peak;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(onMac)("local speech synthesis", () => {
  it("produces a WAV a browser can play", async () => {
    const audio = await synthesizeSpeech(
      "Cap retries at three, then dead letter.",
    );

    // An MP4/AAC container, which <audio> decodes natively. Every MP4 carries
    // its `ftyp` box at offset 4.
    expect(audio.subarray(4, 8).toString("ascii")).toBe("ftyp");
    // Compressed, and that is the point: the same speech as 22 kHz PCM was
    // ~5x this, and those bytes cross a tunnel before a word can play.
    expect(audio.length).toBeGreaterThan(1_000);
    expect(audio.length).toBeLessThan(120_000);
  }, 30_000);

  it("treats text opening with a hyphen as words, not flags", async () => {
    // `say` would read "-v" as an option. The argument vector ends with `--`
    // before the text precisely so a model cannot smuggle one in.
    const audio = await synthesizeSpeech("-v Alex is not a voice request");
    expect(audio.subarray(4, 8).toString("ascii")).toBe("ftyp");
  }, 30_000);

  it("still speaks when the voice name is wrong", async () => {
    // Measured, not assumed: `say -v NotAVoice -o file` exits 0 and falls
    // back to the system default voice, producing byte-identical audio to the
    // default. So a typo in AMP_RECALL_SPEAKER_VOICE costs you the wrong
    // voice, never a mute agent — which is the right way round, and is
    // asserted here so nobody later "fixes" it into a hard failure that would
    // take a live meeting silent.
    const audio = await synthesizeSpeech("hello there", {
      voice: "NotARealVoice",
    });
    expect(audio.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(peakAmplitude(audio)).toBeGreaterThan(1_000);
  }, 30_000);

  it("emits audible samples, not a well-formed silent container", async () => {
    // The failure this whole file exists to rule out is a bot that looks fine
    // and says nothing, so a header check alone is not enough.
    const audio = await synthesizeSpeech(
      "Cap retries at three, then dead letter.",
    );
    expect(peakAmplitude(audio)).toBeGreaterThan(1_000);
  }, 30_000);

  it("refuses empty and oversized text", async () => {
    await expect(synthesizeSpeech("   ")).rejects.toThrow(/nothing to say/u);
    await expect(
      synthesizeSpeech("a".repeat(MAX_TTS_CHARS + 1)),
    ).rejects.toThrow(/cap is/u);
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
              botVariant: undefined,
              transcriptLanguage: undefined,
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
    expect(response.headers.get("content-type")).toContain("audio/mp4");
    const audio = Buffer.from(await response.arrayBuffer());
    expect(audio.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(peakAmplitude(audio)).toBeGreaterThan(1_000);
  }, 30_000);
});
