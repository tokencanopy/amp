/**
 * Turning agent speech into audio bytes, on the machine this app runs on.
 *
 * Why local synthesis rather than a TTS vendor: the speaker page that Recall
 * streams into a call is a headless browser in Recall's infrastructure, and a
 * headless Chrome on Linux ships no `speechSynthesis` voices — it returns an
 * empty voice list and speaks silence. Something has to produce real samples,
 * and the only machine in this picture that already can is this one.
 *
 * macOS `say` writes AIFF; `afconvert` (also stock macOS) turns that into the
 * PCM WAV a browser will play without a codec. Both ship with the OS, so this
 * adds no dependency, no credential, no cost and no network hop — which is the
 * same trade `node:sqlite` makes elsewhere in this prototype, for the same
 * reason: it has to run from a clone.
 *
 * The cost is that speech is macOS-only. That is checked explicitly and
 * reported as a capability rather than discovered as a stack trace, so the
 * speaker page can fall back to `speechSynthesis` and say why it did.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

/** Longer than any single spoken section `planSpeech` will emit. */
export const MAX_TTS_CHARS = 1_200;

export class TtsUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TtsUnavailableError";
  }
}

export interface TtsOptions {
  /** A `say` voice name. Unknown names are rejected by `say` itself. */
  voice?: string | undefined;
  /** Words per minute. `say` defaults to about 175. */
  rate?: number | undefined;
  timeoutMs?: number;
}

/** Whether this host can synthesize at all. */
export function ttsAvailable(): boolean {
  return platform === "darwin";
}

/**
 * Run one command with an argument vector. No shell, ever — the text being
 * spoken comes from a model, over a network, and the whole point of this file
 * is that it never reaches a command line as a string.
 */
function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded: a runaway process must not be able to grow this without limit.
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TtsUnavailableError(`${command} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new TtsUnavailableError(`${command} failed to start: ${error.message}`),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(
          new TtsUnavailableError(
            `${command} exited ${String(code)}${stderr === "" ? "" : `: ${stderr.trim()}`}`,
          ),
        );
      }
    });
  });
}

/**
 * Synthesize `text` to 64 kbps AAC in an MP4 container.
 *
 * Speech going into a meeting's audio mix does not need more, and every byte
 * is fetched across a tunnel before it can be played: 64 kbps AAC is roughly
 * a fifth of the equivalent PCM, which is the difference between speech that
 * plays and speech that stutters.
 */
export async function synthesizeSpeech(
  text: string,
  options: TtsOptions = {},
): Promise<Buffer> {
  if (!ttsAvailable()) {
    throw new TtsUnavailableError(
      `local speech synthesis needs macOS \`say\`; this host is ${platform}`,
    );
  }
  const spoken = text.trim();
  if (spoken === "") throw new TtsUnavailableError("nothing to say");
  if (spoken.length > MAX_TTS_CHARS) {
    throw new TtsUnavailableError(
      `text is ${String(spoken.length)} characters; the cap is ${String(MAX_TTS_CHARS)}`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const dir = await mkdtemp(join(tmpdir(), "amp-tts-"));
  const aiff = join(dir, "speech.aiff");
  const out = join(dir, "speech.m4a");
  try {
    const sayArgs = ["-o", aiff];
    if (options.voice !== undefined && options.voice !== "") {
      sayArgs.push("-v", options.voice);
    }
    if (options.rate !== undefined) {
      sayArgs.push("-r", String(options.rate));
    }
    // `--` so a line of speech that begins with a hyphen is text, not a flag.
    sayArgs.push("--", spoken);
    await run("say", sayArgs, timeoutMs);
    // AAC, not PCM. Measured on one real answer: 649 KB as 22 kHz WAV against
    // 122 KB as 64 kbps AAC — and that payload crosses a tunnel before a word
    // can play, which is what made speech stutter in a live call. `<audio>`
    // decodes AAC natively, so this costs nothing at the other end.
    await run(
      "afconvert",
      ["-f", "mp4f", "-d", "aac", "-b", "64000", aiff, out],
      timeoutMs,
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // A leftover temp directory is not worth failing a meeting over.
    });
  }
}
