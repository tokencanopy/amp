# Meeting providers

How AMP puts an agent into a real call, and what the vendor actually does.
Extracted from the README so the front page stays short; nothing here is
required reading to run AMP, and all of it is required reading before
changing the Recall provider.

Two are wired in. The simulator is the default and always available; Recall.ai
is offered only when fully configured.

|              | `mock` (simulator)        | `recall`                                     |
| ------------ | ------------------------- | -------------------------------------------- |
| Meetings     | simulated, in this UI     | real Zoom / Meet / Teams calls               |
| Transcript   | typed                     | live, speaker-attributed, streaming          |
| Agent chat   | in-app                    | posted into the meeting's own chat           |
| Agent speech | browser `speechSynthesis` | a page whose audio is streamed into the call |
| Needs        | nothing                   | API key, public webhook URL, shared secret   |

Create a meeting against one by naming it:

```jsonc
POST /api/meetings
{ "title": "Retry sync", "provider": "recall",
  "meetingUrl": "https://meet.google.com/abc-defg-hij" }
```

### Why Recall rather than Meet's own API

Google's [Meet Media API](https://developers.google.com/workspace/meet/media-api/guides/overview)
gives real-time audio, and cannot carry this product: it is **receive-only**
(no sending media or messages, so the agent could never speak or post), and
its Developer Preview requires **every participant in the conference** to be
enrolled — so it cannot be used in a meeting with a guest. It is useful for
listening-only experiments and nothing more.

A bot vendor is therefore the only path, and of those, Recall is currently the
only one that closes the loop: transcript in, **and** chat and speech out.
Vexa (Apache-2.0, self-hostable, cheaper) and Meeting BaaS are listen-only for
our purposes — good for testing the transcript path, not for a participant.

### Three constraints worth knowing before you wire it up

1. **Output Media always carries video.** There is no audio-only mode and the
   camera cannot be off, so the agent is a visible tile in the call.
2. **The speaker page is the speech engine.** Recall streams a webpage's audio
   into the call; that page must make the sound itself. `public/speaker.html`
   is that page. Without it configured, the agent posts to chat instead of
   talking — mute, but never silently so.
3. **The webhook is public and unauthenticated by the vendor.** Its URL
   carries a shared secret (`AMP_RECALL_WEBHOOK_SECRET`) compared in constant
   time, because that transcript is the one input the agent is told to trust.

### Latency: what a room will tolerate

A meeting is a conversation, and a conversation has a clock. Measured against
a live Google Meet call, the first version took **ten to fifteen seconds** to
say its first word, and almost none of that was the model:

| stage                                           | before              | now                   |
| ----------------------------------------------- | ------------------- | --------------------- |
| ASR finalization                                | 1–2s                | ~0.3–0.5s             |
| attention                                       | <10ms               | <10ms                 |
| agent's first token                             | ~3.5s               | ~3.5s                 |
| **waiting for the turn to END before speaking** | **the whole turn**  | **removed**           |
| synthesis                                       | 0.65s, whole answer | ~0.2s, first sentence |
| bytes before the first word                     | 650KB–1.2MB         | ~31KB                 |

Three changes, none of them making the model faster:

1. **Speech is released a sentence at a time, while the agent is still
   writing** (`src/gateway/streaming-speech.ts`). Waiting for the complete
   response was the single largest cost, and it grew with the length of the
   answer — the better the answer, the longer the silence.
2. **Audio ships as 64 kbps AAC, not PCM.** Those bytes cross a tunnel before
   anything can play, and 650KB of WAV is what made a live call stutter.
3. **Recall is asked for `prioritize_low_latency`.** Its default,
   `prioritize_accuracy`, uses async non-real-time transcription models by its
   own documentation — a meeting bot left on the default is transcribing
   offline while the room waits.

What is _not_ claimed: the agent's own turn still takes seconds, and no amount
of pipelining changes that. The goal is a room that never feels dead, not a
model that answers instantly.

### How the agent gets a voice

`public/speaker.html` is the page Recall streams into the call. It subscribes
to the meeting's realtime feed, and when the gateway decides something should
be said aloud it plays that text — one utterance at a time, in order, because
a meeting can wait for a late answer but cannot un-hear two voices at once.

**The audio is synthesized on the machine running AMP, not in the browser.**
That is not a preference; it is forced. The browser that loads this page is
headless Chrome inside Recall's infrastructure, where `speechSynthesis` reports
zero voices and speaks silence. So the page fetches WAV bytes from
`POST /api/meetings/:id/tts`, which shells out to macOS `say` and `afconvert`
(see `src/speech/tts.ts`). Both ship with the OS, so speech adds no dependency,
no credential, no cost and no third party — the same trade `node:sqlite` makes,
for the same reason: this has to run from a clone.

The cost is that **speech is macOS-only**. Elsewhere the route answers 503
`tts_unavailable` and the page falls back to `speechSynthesis`, which on a
developer's own machine has voices and works.

That TTS route is reachable through the same public tunnel as the webhook, so
it carries the same shared secret and 404s without it. Unauthenticated it would
be an open text-to-audio endpoint on your laptop, and a way to make your machine
run `say` on demand.

**The one thing this cannot verify from here is autoplay.** A browser may refuse
to start audio without a user gesture, and Recall's is configured not to —
streaming page audio is the entire product — but if that is ever wrong the agent
is mute in a live call. So the page says so in the tile itself, in red, where a
participant can see it, rather than only in a console nobody is reading. A
blocked spoken answer is **not** re-routed to chat: `planSpeech` split the
answer before it reached the page, so the spoken half is lost to the call and
survives only in the transcript. That is the first thing to check on a real
call, and `docs/TODO.md` item 71 is where it is tracked until it has been.

### The wire format, reconciled

`src/providers/recall/wire.ts` was originally written **without access to
Recall's API or its documentation**, so its endpoint paths and payload field
names were guesses. It has since been reconciled against
<https://docs.recall.ai> (2026-08-25). What is still unverified is the live
behaviour: **no bot has been dispatched from this code against a real call**,
because that needs an API key this repo does not have.

The quarantine did its job — `provider.ts` named no Recall field, so the
corrections landed in `wire.ts`, `translate.ts` and the fixtures, and the
suite reported the rest. What the guesses got right: the host template, every
endpoint path, `Token` auth, the Create Bot body (including
`recording_config.transcript.provider` and `realtime_endpoints` nested inside
`recording_config`), and `output_media.camera.kind: "webpage"`.

Three were wrong, and each would have failed differently:

- **The transcript payload is at `data.data`.** The sibling `data.transcript`
  is a reference to the transcript _record_ (`{ id, metadata }`), not the
  words. The old code read `data.transcript` first, so every utterance would
  have been dropped as "transcript was empty" — a silent, total failure of
  the one thing the integration exists to do.
- **There is no `is_final` field.** Finality is the event name:
  `transcript.partial_data` for a growing hypothesis, `transcript.data` once
  it settles. The old code read a flag that never arrives and never
  subscribed to partials at all, so the interim logic below was unreachable.
- **`bot.status_change` is not a real-time event.** Bot status is an
  account-level Svix webhook whose event names are per-status
  (`bot.in_call_recording`, `bot.done`, …). Naming it in a real-time
  endpoint's `events` array put an unknown value in every Create Bot call.

`test/recall.test.ts` carries fixtures copied from the published payloads,
including a `data.transcript` record reference that must not be mistaken for
content.

### Live transcription changes one thing upstream

Speech recognition emits a growing hypothesis before it settles. An interim
result (`isFinal: false`) is shown as a live caption and nothing else: not
persisted, and never handed to the attention engine — otherwise the agent
answers a question that has not finished being asked. Anything not explicitly
marked as a partial is treated as final, so every non-streaming provider stays
correct by default.
