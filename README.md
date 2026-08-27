# AMP — Agent Meeting Protocol

**AMP is the Agent Meeting Protocol — the channel a coding agent joins a meeting
through.**

Give any ACP-speaking coding agent a seat in a live meeting: it hears
speaker-attributed transcript, knows when it is being addressed, answers out
loud, posts detail to the meeting chat, works while the conversation continues,
and asks a human before it acts.

> "Protocol" here names the channel, not a wire format: AMP composes two
> existing open protocols rather than defining one (see _What AMP is,
> precisely_, below).

**Status: v0. Working end to end, and not yet production software.** It has been
run against a real Google Meet call with a real coding agent answering out loud.
It also has no authentication of its own, launches processes on the machine it
runs on, and binds to loopback deliberately. Read _Security_ before exposing it
to anything.

## What AMP is, precisely

AMP is **not a new wire protocol**. It is a gateway that composes two existing
ones, pointing in opposite directions, and that is the whole design:

```
meeting platform            Google Meet · Zoom · Teams, via a bot vendor
      ⇅  MeetingProvider    six methods; nothing above knows the platform
Meeting Gateway             attention · prompt · speech · permissions · memory
      ⇅  ACP                the gateway drives the agent: prompt, stream, cancel
your coding agent           Claude Code · Codex · anything ACP-speaking
      ⇅  MCP                the agent drives the meeting: read, chat, speak, remember
meeting context · chat · speech · memory
```

**ACP is how the gateway drives the agent** — prompt it, watch it stream, cancel
it. **MCP is how the agent drives the meeting** — read the transcript, post to
chat, speak aloud, remember a decision. Neither can do the other's job, and
neither is defined here: AMP is the thing in the middle that makes a meeting
look like something an agent can join.

The consequence worth caring about: **your agent stays your agent.** Its model,
workspace, instructions, skills, tools, session and memory are its own and none
of them change. AMP adds the one thing it does not have — a room to be in.

## Runtime-agnostic by construction

An agent, to AMP, is a command whose stdin and stdout speak ACP. That is the
entire contract, which means **where the agent runs is not AMP's business**:

| the agent runs    | how AMP reaches it                          |
| ----------------- | ------------------------------------------- |
| on this machine   | `claude-agent-acp`                          |
| in a container    | `docker exec -i <worker> claude-agent-acp`  |
| on another host   | `ssh worker claude-agent-acp`               |
| in a cluster      | `kubectl exec -i <pod> -- claude-agent-acp` |
| in your own cloud | any command that bridges stdio to it        |

All of those are one row in `agents.config.json`. No AMP code changes.

**One honest caveat, being fixed:** the reverse direction is not yet portable.
AMP currently hands the agent its meeting tools as a _local command to spawn_
plus a loopback URL, which a remote agent can do nothing with. Making MCP an
HTTP transport with a reachable URL is what finishes this claim, and it is the
next substantive change. Until then, remote agents get ACP but not the meeting
tools.

## Quick start

```bash
npm install
npm run dev            # http://127.0.0.1:4321
```

Then, in the browser: pick **Fake ACP agent (built in)**, create the meeting,
click **Launch agent**, and talk. Nothing else needs installing — the fake agent
ships in this app and speaks real ACP.

Try, in this order:

| Say                                   | What happens                             |
| ------------------------------------- | ---------------------------------------- |
| `I used Codex yesterday.`             | ignored — mentioned, not addressed       |
| `We should ask the cofounder later.`  | ignored — a proposal about it, not to it |
| `Cofounder, what do you think?`       | **answers**, streams, and speaks aloud   |
| `Codex, inspect the webhook retries.` | asks permission first; you allow or deny |

To see the same run without a browser:

```bash
npm run smoke          # drives the whole slice against the fake agent
```

## Commands

Run from the repository root:

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `npm install`       | install dependencies (this app installs independently)           |
| `npm run dev`       | start with reload on `127.0.0.1:4321`                            |
| `npm run build`     | compile TypeScript to `dist/`                                    |
| `npm start`         | run the compiled build                                           |
| `npm test`          | the full suite (223 tests, spawns real child processes)          |
| `npm run lint`      | eslint                                                           |
| `npm run typecheck` | `tsc --noEmit` over src, tests and scripts                       |
| `npm run format`    | prettier                                                         |
| `npm run db:init`   | create the SQLite database and print its tables                  |
| `npm run seed`      | insert a demo meeting with participants, transcript and a memory |
| `npm run smoke`     | end-to-end run against the fake ACP agent, no browser            |

Configuration is environment variables — see `.env.example`, which documents
every one and why its default is what it is.

## Where things live

```
src/
  domain.ts              the vocabulary every layer shares
  config.ts              environment configuration
  acp/
    client.ts            ONE ACP client: spawn, initialize, session, prompt,
                         stream, permissions, cancel, crash, shutdown
    registry.ts          the configurable agent registry + executable checks
    events.ts            session/update → normalized events
    sanitize.ts          ANSI/control stripping, bounded diagnostic log
  gateway/
    gateway.ts           the Meeting Gateway — the only place meeting and agent meet
    attention.ts         the deterministic attention engine
    prompt.ts            prompt construction, SPEAK:/CHAT: parsing, speech safety
    context.ts           topic and rolling summary (extractive, not generated)
  providers/
    mock.ts              the working v0 provider: a simulated room
    external.ts          the seam for Recall.ai / Meeting BaaS / Vexa / Meet / Zoom
    queue.ts             single-consumer async queue behind `events()`
  mcp/
    server.ts            the meeting MCP server (7 tools)
    bridge.ts            its capability-scoped client back into the gateway
  store/                 SQLite schema and repository
  fake-agent/            a real ACP server with a scripted model behind it
  server/                Fastify app, realtime hub, composition root
public/                  the meeting simulator UI (no build step)
```

## The attention engine

A meeting is a continuous stream of speech and almost none of it is for the
agent. Forwarding every fragment would burn a model turn per sentence, and an
agent that answers side conversation is one nobody invites back. So the default
is silence and the bar for breaking it is deterministic — **no model decides
whether a model gets to speak**.

Three things earn a turn:

1. a human explicitly marks an utterance as addressed (the checkbox in the UI);
2. a chat message directed at it (`@cofounder …`);
3. a wake name used **vocatively** _and_ followed by a question or instruction.

Rule 3 does the work, because a wake name is also an ordinary noun in a meeting
about coding agents. The grammar it exploits is that English marks direct
address positionally: a vocative sits at the edge of its clause, set off by
punctuation, and is not preceded by a determiner or a verb.

| Triggers                                  | Stays silent                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `Cofounder, what do you think?`           | `I used Codex yesterday.`                                          |
| `Hey Codex, inspect the webhook retries.` | `Claude helped write this.`                                        |
| `Claude: summarize our decision.`         | `We should ask the cofounder later.`                               |
| `So what do you think, cofounder?`        | `Our cofounder is out this week.`                                  |
| `Codex can you check the retries?`        | `Codex and Claude are both ACP agents.`                            |
|                                           | `Cofounder, nice to have you here.` (addressed, but nothing asked) |

`test/attention.test.ts` holds 31 cases, weighted toward false positives.

### It has to work on speech, not writing

A caption stream does not punctuate. `cofounder what do you think` arrives with
no comma, no question mark and no capitals, and the first version of these
rules — which required the comma — lost **six of eight** genuine addresses when
measured against that input. It did not get them wrong; it went deaf, which in
a meeting is just as useless.

So punctuation is evidence, never a precondition. When the comma is there it
settles the vocative outright; when it is missing the same decision is made
from syntax:

- **the predicate guard** — what follows a vocative is an imperative or a
  question, never a predicate. `claude helped write this` has the name as the
  _subject_ of a finite verb, so it stays silent, while `claude write the
migration note` is an instruction and does not;
- **the addressee is already named** — a leading vocative means the clause
  after it need not say "you" again, so `codex what's the retry budget` and
  `cofounder your thoughts` are heard;
- **fillers are stripped** before the directive test, because speech opens with
  them constantly (`um so cofounder …`).

One deliberate limit: with no comma, a _trailing_ vocative is only recognized
after an opinion verb (`what do you think cofounder`). A name at the end of a
clause is usually its object — `did you try codex`, `remind me to ping codex`,
`when did you last use codex` are all addressed to a person about the agent,
and admitting them cost three false positives when measured. Any other trailing
address needs the comma, a leading vocative, or the "address the agent"
checkbox.

`test/asr.test.ts` asserts every rule twice, once written and once as ASR would
emit it, deriving the spoken form mechanically so the two cannot drift.

## Speech

Browser `speechSynthesis` in v0, behind a `SpeechOutput` interface so a
server-side TTS provider can replace it without the gateway noticing.

The agent is asked to split its answer with `SPEAK:` and `CHAT:`. `planSpeech`
enforces the split whether or not it complied:

- a `SPEAK:` section is spoken (sanitized: no code, URLs become "a link in the
  chat", capped and truncated at a sentence boundary);
- a short plain response is spoken as-is;
- anything containing code, resembling tool output, or over ~60 words is **not
  spoken** — it is posted to meeting chat instead;
- tool activity is a status update, never speech.

**Stopping speech and cancelling work are separate controls, deliberately.**
"Stop talking" is a local browser action that never reaches the agent; "stop
working" is an ACP `session/cancel` that never touches the voice. A new direct
question while the agent is speaking is a barge-in: the voice stops, the work
does not.

## Agents

The registry (`src/acp/registry.ts`, overridable via `agents.config.json` — see
`agents.config.example.json`) ships:

| id         | command                                 | status                                                            |
| ---------- | --------------------------------------- | ----------------------------------------------------------------- |
| `fake`     | the built-in fake ACP agent             | works out of the box, no install                                  |
| `codex`    | `npx -y @agentclientprotocol/codex-acp` | package verified on npm (1.6.2 at time of writing)                |
| `claude`   | `claude-agent-acp`                      | bin published by `@agentclientprotocol/claude-agent-acp` (0.70.0) |
| `hermes`   | `hermes acp`                            | **unverified** — set your own command if it differs               |
| `openclaw` | `openclaw acp`                          | **unverified** — set your own command if it differs               |
| `generic`  | whatever you pass                       | disabled unless `AMP_ALLOW_GENERIC=true`                          |

Adapter package and binary names move. **Check before trusting a row**: the UI
has a "Check this agent is installed" button, and `POST /api/agents/:id/check`
resolves the executable on `PATH` without running it.

### Setting each one up

- **Fake** — nothing. It is spawned from this app's own `dist/` (or through
  `tsx` in dev).
- **Codex** — `npm i -g @agentclientprotocol/codex-acp`, or leave the default
  `npx -y …` and let npx fetch it. It authenticates through Codex's own
  credentials; the client prefers the `chat-gpt` auth method when several are
  advertised, because the first advertised method is not always the working one.
- **Claude Code** — `npm i -g @agentclientprotocol/claude-agent-acp` gives you
  the `claude-agent-acp` bin. `@zed-industries/claude-code-acp` is an
  alternative that installs `claude-code-acp` instead; set whichever you have in
  `agents.config.json`.
- **Hermes** — placeholder: `hermes acp`. Verify against your build and override
  if it differs.
- **OpenClaw** — placeholder: `openclaw acp`. Same caveat.

Any ACP-speaking executable works: put it in `agents.config.json` and it appears
in the picker. Arguments are always passed as a vector; there is no code path in
this app that builds a shell command string.

## MCP: the agent's hands in the meeting

When an ACP session is created, the gateway passes the meeting MCP server in
`session/new`'s `mcpServers`, so a compliant agent gets these tools
automatically:

| Tool                            | Does                                               |
| ------------------------------- | -------------------------------------------------- |
| `meeting_get_active`            | title, status, topic, rolling summary              |
| `meeting_get_participants`      | who is in the room                                 |
| `meeting_get_recent_transcript` | attributed entries, oldest first                   |
| `meeting_send_chat`             | post to meeting chat as the agent                  |
| `meeting_speak`                 | say something out loud (unspeakable text → chat)   |
| `meeting_remember`              | store a decision/action item/fact/note with source |
| `meeting_list_memories`         | read what has been remembered                      |

The MCP server is spawned by the **agent**, so it reaches meeting state over
loopback HTTP with a per-meeting capability handed to it in its environment.
That capability is minted per connection, held in memory only, and never written
to disk. State-changing tools validate that the meeting is live and that the
caller holds that meeting's capability.

**If your adapter ignores client-provided MCP servers**, the ACP demo is
unaffected — everything above still works. Configure it in the agent's own MCP
config instead:

```json
{
  "mcpServers": {
    "meeting": {
      "command": "node",
      "args": ["/abs/path/to/amp/dist/mcp/bin.js"],
      "env": {
        "AMP_MCP_BASE_URL": "http://127.0.0.1:4321",
        "AMP_MCP_MEETING_ID": "mtg_...",
        "AMP_MCP_TOKEN": "<capability>"
      }
    }
  }
}
```

Set `AMP_ENABLE_MCP=false` to stop passing it through ACP.

## API

All input is schema-validated; failures return `{ error: { code, message } }`.

```
GET    /api/health
GET    /api/agents
POST   /api/agents/:agentId/check
POST   /api/meetings
GET    /api/meetings
GET    /api/meetings/:meetingId
POST   /api/meetings/:meetingId/start
POST   /api/meetings/:meetingId/end
POST   /api/meetings/:meetingId/participants
POST   /api/meetings/:meetingId/utterances
POST   /api/meetings/:meetingId/agent/connect
POST   /api/meetings/:meetingId/agent/cancel
POST   /api/meetings/:meetingId/agent/disconnect
POST   /api/meetings/:meetingId/permissions/:requestId/respond
GET    /api/meetings/:meetingId/transcript
GET    /api/meetings/:meetingId/memories
POST   /api/meetings/:meetingId/memories
POST   /api/meetings/:meetingId/memories/:memoryId/supersede
GET    /ws?meetingId=…            realtime meeting feed
        /api/mcp/*                loopback bridge for the meeting MCP server
```

## Meeting providers

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

## Persistence

SQLite through Node's built-in `node:sqlite` — no native compile, no database
service, nothing added to the repo's dependency surface. (The repo's convention
is Postgres + Drizzle, as in `apps/chat` and `apps/hub`; this prototype takes
the v0 escape hatch so it runs from a clone with `npm install && npm run dev`.
`node:sqlite` is flagged experimental on Node 22 and prints one warning on first
import — that is expected.)

Persisted: meetings, participants, transcript entries, chat messages, agent
definitions (command and args, never credentials), ACP session associations,
sanitized agent audit events, and memories with provenance.

**Not persisted, by construction:** authentication tokens (the MCP capability
lives in memory), environment secrets, hidden chain-of-thought (thought chunks
are normalized to an event carrying no text at all), and unsanitized process
output.

Reads order by `rowid`, not by id or timestamp — several rows routinely land in
the same millisecond, and rowid is the only column that records the order they
were actually written in.

## Security

This is a local developer prototype and it behaves like one:

- binds `127.0.0.1` by default, and warns loudly if you bind it wider;
- **an agent is only ever launched by an explicit human action**, and the
  command, argument vector and working directory are shown before it runs;
- `spawn` with an argument array, `shell: false`, always. No command strings;
- the browser cannot name an arbitrary executable — the generic agent is off
  unless the operator enables it on the machine;
- **permission requests are never auto-approved.** They go to a human, and the
  timeout denies rather than allows: silence is not consent;
- the agent's own sandbox and approval rules are untouched — nothing here
  bypasses them;
- ANSI escapes and control characters are stripped at the process boundary;
  transcripts, diagnostics and logs are bounded;
- child processes are terminated on shutdown (SIGTERM, then SIGKILL).

## Troubleshooting

| Symptom                                        | Cause and fix                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "`hermes` is not on PATH" when launching       | The adapter is not installed, or the command name differs in your build. Use the **Check** button, then override the command in `agents.config.json`.                 |
| Agent launches, then immediately shows `error` | The adapter exited. Look at **Diagnostics** in the Agent activity column — adapters report auth and quota problems on stderr.                                         |
| The agent never answers                        | Check the **Turn & tool activity** column for `ignored — …`. The attention engine explains every decision it makes. Tick "Address the agent explicitly" to bypass it. |
| A turn hangs, then reports a timeout           | Idle timeout (no output at all) or total timeout. Both are configurable; both cancel the turn rather than leaving the process running.                                |
| Permission requests never appear               | Some agents auto-approve read-only tools internally, so the callback never fires. That is the agent's own policy, not this app's.                                     |
| Nothing is spoken                              | Speech is off, the browser has no `speechSynthesis`, or the response was suppressed — check Diagnostics for "response not spoken (…)".                                |
| `ExperimentalWarning: SQLite` on startup       | Expected on Node 22; `node:sqlite` is flagged experimental.                                                                                                           |
| Port already in use                            | `AMP_PORT=… npm run dev`.                                                                                                                                             |

## What is real and what is stubbed

**Real:** the ACP client (handshake, capability negotiation, session create and
load, streaming, permissions, cancellation, timeouts, crash handling, graceful
shutdown), the agent registry and executable checks, the attention engine, the
prompt and speech pipeline, the MCP server and its capability model, the mock
meeting provider, persistence, the realtime feed, the UI, and the fake ACP
agent.

**Stubbed:** `ExternalMeetingProvider` — the seam for Recall.ai, Meeting BaaS,
Vexa, Meet, Zoom and Teams. Its `ingest()` and `events()` work; the four
lifecycle methods throw `NotImplementedError` with the reason. Nothing else in
the app knows what a meeting platform is, which is what makes filling it in a
contained job.

**Not attempted in v0:** server-side TTS and audio injection, speaker
diarization, multiple agents in one meeting, cross-meeting memory, and
authentication.

## Next step: a real meeting provider

Implement `MeetingProvider` against a bot vendor (Recall.ai or Meeting BaaS are
the shortest paths, since they handle joining and diarization):

1. `createMeeting` registers the platform meeting URL and returns the local record;
2. `startMeeting` dispatches the bot and waits for admission;
3. a webhook route translates the vendor's transcript events into `utterance`
   events and pushes them onto the provider's queue — this is the only new code
   with real substance;
4. `sendChat` posts through the vendor's in-call chat API;
5. `sendSpeech` sends text to the vendor's TTS/audio endpoint, which is the
   point at which browser `speechSynthesis` stops being the speech layer;
6. `endMeeting` removes the bot and closes the queue.

Consent is a product requirement before step 1, not a technical one: a bot that
joins a call is a recording device, and whatever the platform requires for
disclosure has to happen first.
