/**
 * A neural voice, for when the agent has to sound like someone in the room.
 *
 * macOS `say` is free, local, credential-less and instant, which is why it is
 * still the default and the fallback. It also sounds like 2005. In a product
 * where the agent is a *participant* in a human conversation rather than a
 * notification, that is not cosmetic — a robotic voice is the difference
 * between a colleague and a phone tree.
 *
 * Two properties matter as much as the voice itself:
 *
 *   - **Tight clips.** Speech is synthesized a sentence at a time so the room
 *     hears the first one while the rest is still being written. `say` pads
 *     every utterance with leading and trailing silence, and at a sentence
 *     boundary that padding IS the seam. Asking for no padding is half of what
 *     makes a stream of clips sound like one voice.
 *   - **A format the browser can decode cheaply.** The speaker page schedules
 *     clips back to back on a Web Audio timeline, so every clip is decoded
 *     before it is needed; MP3 is universally supported and small enough to
 *     cross a tunnel without being the bottleneck.
 *
 * This is a provider behind `synthesizeSpeech`, not a replacement for it. The
 * repo still has to run from a clone with no credential, so a missing key is
 * a fallback, never an error.
 */

/** Fast enough for a live meeting; the slower models are for narration. */
export const ELEVENLABS_DEFAULT_MODEL = "eleven_turbo_v2_5";

/** "Sarah — mature, reassuring, confident." Overridable per deployment. */
export const ELEVENLABS_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";

export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId?: string | undefined;
  modelId?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Synthesize one sentence to MP3.
 *
 * `optimize_streaming_latency` trades a little prosody for time-to-first-byte,
 * which is the right trade here: this clip is holding up a live conversation,
 * and the sentence after it is already being written.
 */
export async function synthesizeWithElevenLabs(
  text: string,
  options: ElevenLabsOptions,
): Promise<Buffer> {
  const spoken = text.trim();
  if (spoken === "") throw new ElevenLabsError(0, "nothing to say");

  const voice = options.voiceId ?? ELEVENLABS_DEFAULT_VOICE;
  const model = options.modelId ?? ELEVENLABS_DEFAULT_MODEL;
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  try {
    const response = await doFetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}` +
        `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
      {
        method: "POST",
        headers: {
          "xi-api-key": options.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: spoken,
          model_id: model,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ElevenLabsError(
        response.status,
        `ElevenLabs returned ${String(response.status)}: ${detail.slice(0, 200)}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof ElevenLabsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A vendor that is slow or down must degrade to the local voice, not take
    // the meeting silent.
    throw new ElevenLabsError(0, `ElevenLabs unreachable: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
