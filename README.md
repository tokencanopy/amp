# AMP — Agent Meeting Proxy

**AMP is the Agent Meeting Proxy — the channel a coding agent joins a meeting
through.**

Give any ACP-speaking coding agent a seat in a live meeting: it hears
speaker-attributed transcript, knows when it is being addressed, answers out
loud, posts detail to the meeting chat, works while the conversation continues,
and asks a human before it changes anything.

> A proxy, not a protocol: AMP defines no wire format of its own. It stands
> between two that already exist — ACP toward your agent, MCP toward the
> meeting — and that is exactly what the name claims.

**Status: v0. Working end to end, and not yet production software.** It has been
run against a real Google Meet call with a real coding agent answering out loud.
It also has no authentication of its own, launches processes on the machine it
runs on, and binds to loopback deliberately. Read _Security_ before exposing it
to anything.

## What AMP is, precisely

AMP is **not a new wire protocol**. It is a proxy between two existing ones
pointing in opposite directions, and that is the whole design:

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

| Say                                   | What happens                                      |
| ------------------------------------- | ------------------------------------------------- |
| `I used Codex yesterday.`             | ignored — mentioned, not addressed                |
| `We should ask the cofounder later.`  | ignored — a proposal about it, not to it          |
| `Cofounder, what do you think?`       | **answers**, streams, and speaks aloud            |
| `Codex, inspect the webhook retries.` | reads a file without asking, then answers         |
| `Codex, fix the webhook retries.`     | asks permission first — a write waits for a human |
| `Cofounder, what are the options?`    | answers **with a question of its own**            |
| `yes`                                 | answers again — a reply needs no name             |

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
is silence, and the bar for breaking it is deterministic — **no model decides
whether a model gets to speak**.

Four things earn a turn:

1. a human marks an utterance as addressed (the checkbox in the UI);
2. a chat message directed at it (`@cofounder …`);
3. a wake name used **vocatively** _and_ followed by a question or instruction;
4. **anything at all, for 30 seconds after the agent ends a turn on a
   question** — because somebody answering says "yes", not "Cofounder, yes".

Rule 3 does the work, because a wake name is also an ordinary noun in a meeting
about coding agents. The grammar it exploits is that English marks direct
address positionally: a vocative sits at the edge of its clause and is not
preceded by a determiner or a verb.

| Triggers                                     | Stays silent                                                   |
| -------------------------------------------- | -------------------------------------------------------------- |
| `Cofounder, what do you think?`              | `I used Codex yesterday.`                                      |
| `Hey Codex, inspect the webhook retries.`    | `Claude helped write this.`                                    |
| `Claude: summarize our decision.`            | `We should ask the cofounder later.`                           |
| `So what do you think, cofounder?`           | `Our cofounder is out this week.`                              |
| `Codex can you check the retries?`           | `Codex and Claude are both ACP agents.`                        |
| `yes` — _right after it asked you something_ | `Cofounder, nice to have you here.` (addressed, nothing asked) |

Rule 4 is deliberately narrow, because the costs are asymmetric: a missed
follow-up costs one repetition, a false one costs an interruption. It opens
only after a turn that _ends_ on a question — a question hands the turn back, a
statement does not — and it is consumed by the first thing anyone says, so the
agent cannot drift into the conversation carrying on around it.

### It has to work on speech, not writing

A caption stream does not punctuate. `cofounder what do you think` arrives with
no comma, no question mark and no capitals, and the first version of these
rules — which required the comma — lost **six of eight** genuine addresses
against that input. It did not answer them wrongly; it went deaf, which in a
meeting is just as useless.

So punctuation is evidence, never a precondition. When the comma is missing the
same decision is made from syntax:

- **the predicate guard** — what follows a vocative is an imperative or a
  question, never a predicate. `claude helped write this` has the name as the
  _subject_ of a finite verb and stays silent; `claude write the migration
note` is an instruction and does not;
- **the addressee is already named** — a leading vocative means the clause need
  not say "you" again, so `codex what's the retry budget` is heard;
- **fillers are stripped** first, because speech opens with them constantly
  (`um so cofounder …`).

Transcribers also break a name apart and punctuate a pause as a full stop, so
`Co founder`, `co-founder` and `Cofounder.` are all matched as the one name —
each of those was observed on a live call, and each had made the agent silently
deaf.

One deliberate limit: with no comma, a _trailing_ vocative is recognized only
after an opinion verb (`what do you think cofounder`). A name at the end of a
clause is usually its object — `did you try codex`, `remind me to ping codex` —
and admitting those cost three false positives when measured.

`test/attention.test.ts` holds 38 cases, weighted toward false positives.
`test/asr.test.ts` re-asserts the rules as ASR would emit them, deriving the
spoken form mechanically so the two cannot drift.

## Speech

Synthesized server-side behind a `synthesizeSpeech` seam: a neural voice
(ElevenLabs) when a key is present, macOS `say` when it is not. The fallback
matters more than it looks — the repo has to run from a clone with no
credentials, so a missing key is a downgrade, never an error.

**Sentences are released as the agent writes them**, not when the turn ends.
The room hears the first sentence while the third is still being generated,
which is the difference between roughly two seconds to first audio and roughly
ten. A sentence is held back until it is actually finished, because half a
clause sounds worse than a pause.

The agent is asked to split its answer with `SPEAK:` and `CHAT:`, and
`planSpeech` enforces the split whether or not it complied:

- a `SPEAK:` section is spoken — sanitized, with code removed and URLs turned
  into "a link in the chat", capped and truncated at a sentence boundary;
- a short plain response is spoken as-is;
- anything containing code, resembling tool output, or over ~110 words is
  **not spoken** — it goes to meeting chat instead;
- tool activity is a status update, never speech.

**Stopping speech and cancelling work are separate controls, deliberately.**
"Stop talking" is a local action that never reaches the agent; "stop working"
is an ACP `session/cancel` that never touches the voice. A new direct question
while the agent is speaking is a barge-in: the voice stops, the work does not.

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

Two are wired in, behind one six-method `MeetingProvider` interface — nothing
above it knows which platform is in use.

|            | `mock` (simulator)     | `recall`                          |
| ---------- | ---------------------- | --------------------------------- |
| needs      | nothing                | a Recall.ai API key, a public URL |
| meetings   | scripted, in-process   | real Google Meet · Zoom · Teams   |
| use it for | development, tests, CI | actually being in a call          |

The simulator is the default and always available, so the whole system runs
from a clone with no credentials. Recall is offered only when fully configured.

**[docs/meeting-providers.md](docs/meeting-providers.md)** covers the rest: why
a bot vendor rather than Meet's own API, the three vendor constraints that
shape the design, where the latency goes, how the agent gets a voice, and the
wire format as actually observed. Read it before changing the Recall provider.

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
- **writes and commands are never auto-approved.** They go to a human, and the
  timeout denies rather than allows: silence is not consent;
- **reads are auto-approved**, because a meeting has no approval UI and a
  request that waits for a human waits for nobody — measured, that was 120
  seconds of silence in a live call before the agent gave up and answered
  without the file. Note what this widens: the agent's working directory is a
  starting point, not a sandbox, and it runs with the permissions of the user
  who started it. Set `autoApproveReads: false` on the gateway to take it
  back;
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
| Nothing is spoken                              | No speaker page is configured, synthesis failed, or the response was suppressed — check Diagnostics for "response not spoken (…)".                                    |
| `ExperimentalWarning: SQLite` on startup       | Expected on Node 22; `node:sqlite` is flagged experimental.                                                                                                           |
| Port already in use                            | `AMP_PORT=… npm run dev`.                                                                                                                                             |

## What is real and what is stubbed

**Real:** the ACP client (handshake, capability negotiation, session create and
load, streaming, permissions, cancellation, timeouts, crash handling, graceful
shutdown), the agent registry, the attention engine, the prompt and speech
pipeline including synthesis, the MCP server and its capability model, the mock
provider, **the Recall provider — dispatched into real Google Meet calls with a
real coding agent answering out loud**, persistence, the realtime feed, the UI,
and the fake ACP agent.

**Stubbed:** `ExternalMeetingProvider`, the generic seam for other vendors
(Meeting BaaS, Vexa). Its `ingest()` and `events()` work; the lifecycle methods
throw `NotImplementedError` naming what is missing. Recall is the reference
implementation to copy — nothing above the interface knows what a platform is,
which is what keeps a second one a contained job.

**Not attempted:** authentication, cross-meeting memory, and speaker
diarization beyond what the vendor supplies.

## Known gaps

Honest about what is not done, in the order it bites:

- **MCP is stdio-only.** The gateway spawns the meeting's MCP server and hands
  the agent a loopback URL, which works precisely because the agent is on this
  machine. An agent reached over SSH, in a cluster, or in someone's cloud can
  still be prompted and can still speak — but it gets no meeting tools. Until
  this is served over HTTP, "runtime-agnostic" is true of ACP and only
  partly true of MCP.
- **A wake name split across two transcript events is missed.** The in-utterance
  fixes handle `Co founder` inside one event; a name broken across two needs a
  bounded same-speaker buffer that does not exist yet.
- **Attention is rules, not judgement.** Deterministic is the right default and
  the reason it is cheap, but a model asked "was that meant for me?" would
  catch what grammar cannot. The decision and its reason are recorded for every
  utterance, so this can be settled on evidence rather than taste.
- **One meeting, one agent.** Nothing in the design forbids several; nothing
  implements it either.

Consent is a product requirement, not a technical one: a bot that joins a call
is a recording device, and whatever the platform and the people in the room
require has to happen first.
