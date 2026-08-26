# AMP — Agent Meeting Protocol

`apps/amp` — a Meeting Channel for Agents.

**Local v0 developer prototype.** It launches agent processes on the machine
it runs on and has no authentication of its own. It binds to loopback and says
so on startup. Do not deploy it.

Your existing coding agent — Codex, Claude Code, Hermes, OpenClaw — stays the
agent of record. Its model, workspace, instructions, skills, tools, session and
memory are its own and none of them change. AMP gives it one thing it does not
have: **a meeting to participate in**. Through that channel it can join a
meeting, receive speaker-attributed transcript, know when it is being addressed,
speak or post to meeting chat, work asynchronously while the meeting continues,
stream progress back to the room, ask a human for approval, read recent context,
and remember what was decided.

```
meeting platform (mock today, Meet/Zoom/Recall later)
      ⇅  MeetingProvider
Meeting Gateway  ── attention engine, prompt construction, speech routing
      ⇅  ACP over stdio (one client, a registry of agents)
Codex · Claude Code · Hermes · OpenClaw · the built-in fake agent
      ⇅  MCP over stdio (the agent calls back into the meeting)
meeting context · chat · speech · memory
```

**ACP and MCP point in opposite directions, and that is the design.** ACP is how
the gateway drives the agent — prompt it, watch it, cancel it. MCP is how the
agent drives the meeting — read the transcript, post to chat, speak, remember.
Neither can do the other's job.

## Quick start

```bash
cd apps/amp
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

Run from `apps/amp/`:

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `npm install`       | install dependencies (this app installs independently)           |
| `npm run dev`       | start with reload on `127.0.0.1:4321`                            |
| `npm run build`     | compile TypeScript to `dist/`                                    |
| `npm start`         | run the compiled build                                           |
| `npm test`          | the full suite (211 tests, spawns real child processes)          |
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
      "args": ["/abs/path/to/apps/amp/dist/mcp/bin.js"],
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
   into the call; that page must make the sound itself. Browser
   `speechSynthesis` may have no voices in a server-side browser, so plan for
   a real TTS there. Without a page configured, the agent posts to chat
   instead of talking — mute, but never silently so.
3. **The webhook is public and unauthenticated by the vendor.** Its URL
   carries a shared secret (`AMP_RECALL_WEBHOOK_SECRET`) compared in constant
   time, because that transcript is the one input the agent is told to trust.

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
