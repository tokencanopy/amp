# Architecture — AMP (Agent Meeting Protocol)

Why the pieces are where they are. The README says how to run it; this says why
it is shaped this way, and what the load-bearing decisions were.

## The problem

Claude Code, Codex, Hermes and OpenClaw are **turn-driven**. They are alive
between prompts and have no way to be woken by anything: no socket, no timer, no
room. That is fine for an editor and useless in a meeting, where the thing you
need is an agent that hears the conversation, knows the 2% of it that concerns
it, and speaks at the right moment.

The temptation is to build an agent that can do meetings. That is the wrong
build: it throws away the model, workspace, instructions, skills, tools, session
and memory that make the user's existing agent worth having. So the agent stays
the agent of record and we build **the event loop it does not have**, plus a
channel it can talk through.

Token Canopy's `tc-acp` does the narrow version of this for agent chat — one
message, one turn, one reply. This app is the same insight applied to a live
multiparty conversation, where the hard parts are different: deciding when to
speak, showing work in progress, keeping the voice separate from the work, and
putting a human in front of anything sensitive.

## The layers

```
┌──────────────────────────────────────────────────────────────────┐
│ meeting platform          mock simulator today; Meet/Zoom/Recall  │
├──────────────────────────────────────────────────────────────────┤
│ MeetingProvider           createMeeting/start/end/events/         │
│                           sendChat/sendSpeech — six methods, and  │
│                           nothing above this line knows which     │
│                           platform is behind them                 │
├──────────────────────────────────────────────────────────────────┤
│ Meeting Gateway           attention · prompt · turn · speech      │
│                           routing · permissions · memory · audit  │
├──────────────────────────────────────────────────────────────────┤
│ ACP client                one client, a registry of agents        │
├──────────────────────────────────────────────────────────────────┤
│ the agent                 unchanged, and unaware of all of this   │
│      └── MCP ────────────▶ back into the meeting                  │
└──────────────────────────────────────────────────────────────────┘
```

### Why `events()` is an async iterable

A callback fires whether or not the consumer is ready. The gateway is
routinely _not_ ready — an agent turn takes minutes — so a callback API forces
either dropped events or a buffer inside every provider. An async iterable makes
backpressure the consumer's, with one bounded queue in one place
(`providers/queue.ts`).

### Why the mock provider is first and complete

Google Meet automation is a bot-joins-a-call problem with vendor accounts,
recording consent and audio pipelines attached. Making it a prerequisite would
mean nothing else could be built or tested until it worked. Everything above the
provider line — attention, prompting, ACP, speech routing, memory — is identical
whether the words came from a simulator or a real call. So the simulator ships
first, fully working, and `ExternalMeetingProvider` documents the seam.

### Why one ACP client and a registry

Codex, Claude Code, Hermes and OpenClaw differ only in which executable is
spawned. Four native integrations would be four times the surface for none of
the benefit, and would rot four times as fast when adapter names change (which
they do). Adding an agent is a row in `agents.config.json`.

## The decisions worth arguing about

### 1. Attention is deterministic, and conservative

No model decides whether a model gets to speak. A wake name is also an ordinary
noun in a meeting about coding agents — "I used Codex yesterday", "we should ask
the cofounder later" — so the engine requires the name to be used _vocatively_
(at a clause edge, set off by punctuation, not preceded by a determiner or verb)
**and** followed by a question or an instruction.

The cost is that some genuine addresses are missed. That is the right trade: a
missed address is fixed by ticking a checkbox or saying the name again, while a
false positive means an agent talking over a meeting, which is the failure that
gets the whole idea thrown out.

**Punctuation is evidence, not a precondition** — and getting that wrong was
the engine's first real bug. The original rules keyed on the comma in
"Cofounder, what do you think?", which quietly assumed written text; measured
against the unpunctuated lowercase output a caption stream actually produces,
they lost six of eight genuine addresses. The fix was not more rules but the
right ones: what the comma was standing in for is the difference between a name
as the _subject_ of a finite verb ("claude helped write this") and a name as
the _addressee_ of an imperative or question ("claude write the migration
note"). Punctuation now only skips a guard it makes redundant.

The remaining asymmetry is deliberate and measured. A _trailing_ name with no
comma is admitted only after an opinion verb, because a clause-final name is
normally the verb's object: "did you try codex" and "remind me to ping codex"
are addressed to people, and admitting them cost three false positives. Every
rule is tested twice, written and spoken, with the spoken form derived
mechanically from the written one.

### 2. Permission requests are never auto-approved

A one-agent-one-owner ACP client can auto-approve by default, and is right to:
there, the only
principal who can start a turn is the person the agent answers to, running it on
their own machine, so a permission prompt is that person's machine asking them
to confirm what they just asked for.

A meeting breaks that pairing. Anyone in the room can address the agent, so the
author gate is wide by construction — and an approval nobody in particular gave
is not consent. Requests go to the UI with allow/deny, and **the timeout denies**.

### 3. Speech and work are separate controls

"Stop talking" and "stop working" are different instructions, and a meeting
needs both. Stopping speech is a local browser action that never reaches the
agent. Cancelling work is `session/cancel`, which never touches the voice. A new
direct question during a response is a barge-in: the voice stops, the work
continues.

### 4. The response is split before it is spoken

A response that is correct but unspeakable — a code block, a URL, forty seconds
of list — is a failure in an audio medium. The agent is asked to split its own
answer with `SPEAK:`/`CHAT:`, and `planSpeech` enforces the split whether or not
it complied: code, tool-output-shaped text and long responses are posted, never
read. Tool activity is status, not speech.

### 5. Reasoning is dropped at the boundary

`agent_thought_chunk` normalizes to an event that carries **no text**. Not
filtered later, not stored and hidden — discarded where it arrives, so no
later change can accidentally start persisting or displaying it.

### 6. Provenance is resolved, not accepted

`meeting_remember` takes a transcript entry id and the gateway looks it up in
_this_ meeting, failing if it is not there, and reads the timestamp and speaker
from the entry itself. A memory whose source cannot be pointed at is an
assertion, and an agent asserting that somebody decided something is exactly the
failure mode meeting memory has to avoid.

### 7. The MCP capability never touches disk

The MCP server is spawned by the agent, not by this server, so it needs a way
back in. It gets a per-meeting capability through its environment at
`session/new` time: minted per connection, held in memory, scoped to one
meeting, re-validated on every call. Nothing about it is persisted.

## Data flow of one answered question

1. The simulator (or a real provider) emits an `utterance` event.
2. The gateway persists it, publishes it to the browser, and recomputes topic
   and rolling summary.
3. The attention engine decides. Every decision — trigger or not, and why — is
   published to the activity log.
4. On a trigger, the gateway builds the prompt: meeting, agent name,
   participants, topic, summary, active memories, the recent transcript
   (**fenced**, because it is other people's words and must not be able to pose
   as instructions), and the addressed utterance.
5. `session/prompt` goes out. Updates stream back: message chunks to the browser
   as they arrive, tool calls as status, thoughts as a content-free marker.
6. A permission request suspends the turn until a human answers it.
7. On completion, `planSpeech` decides what is said and what is posted. Chat
   goes first — details should be readable before the spoken summary ends.
8. The spoken part is sent through the provider (appearing as an agent utterance
   in the transcript) and to the browser, which speaks it.

## Where this would go next

- **A real provider.** The contained job: translate a vendor's transcript
  webhook into `MeetingEvent`. See the README's last section.
- **Server-side speech.** `SpeechOutput` already exists as the seam. A real
  meeting needs the agent's voice in the call's audio, not on the operator's
  laptop speakers.
- **Several agents in one meeting.** The gateway is per-meeting with one runtime;
  it would become a map of agent runtimes, and the attention engine would need
  to route by wake name rather than answer yes/no.
- **A durable database.** SQLite is the v0 escape hatch that lets this run from
  a clone. Multi-tenant hosting wants Postgres, and the schema is written plainly
  enough to port: nothing outside `store/` would change.
- **Portable meeting tools.** MCP is currently handed to the agent as a local
  command plus a loopback URL, which is the one thing still tying the agent to
  this machine. An HTTP transport finishes the runtime-agnostic claim the
  README makes.
