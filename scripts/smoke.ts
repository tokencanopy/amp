/**
 * End-to-end smoke test against the fake ACP agent, with no browser.
 *
 * Drives the exact path the UI drives — create, start, launch, speak, get
 * ignored, get answered, approve a tool call, cancel — and prints what
 * happened at each step. Run it with `npm run smoke`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../src/server/create.js";

const workdir = mkdtempSync(join(tmpdir(), "amp-smoke-"));
const server = createServer({
  port: 0,
  host: "127.0.0.1",
  databasePath: join(workdir, "smoke.db"),
  logLevel: "silent",
  permissionTimeoutMs: 15_000,
});

const step = (message: string) => console.log(`\n▸ ${message}`);
const detail = (message: string) => console.log(`   ${message}`);

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
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${path} → ${response.status} ${JSON.stringify((payload as Record<string, unknown>)["error"])}`,
    );
  }
  return payload as T;
}

interface MeetingView {
  meeting: { id: string; title: string; status: string; topic: string | null };
  participants: { id: string; name: string; kind: string }[];
  transcript: { speakerName: string; speakerKind: string; text: string }[];
  chat: { speakerName: string; text: string }[];
  memories: {
    kind: string;
    content: string;
    sourceTranscriptEntryId?: string;
  }[];
  agent: {
    status: string;
    acpSessionId: string | null;
    capabilities: { loadSession: boolean } | null;
    pendingPermissions: { requestId: string; toolName: string }[];
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  what: string,
  predicate: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(120);
  }
}

try {
  await server.start();
  step(`server listening on ${server.origin()}`);

  const created = await call<MeetingView>("/api/meetings", {
    method: "POST",
    body: {
      title: "Retry policy sync",
      agentDisplayName: "Cofounder",
      wakeNames: ["cofounder", "codex"],
      participants: [
        { name: "Ada", kind: "human", role: "founder" },
        { name: "Grace", kind: "human", role: "engineer" },
      ],
      agentId: "fake",
    },
  });
  const meetingId = created.meeting.id;
  step(`created meeting ${meetingId}`);

  await call(`/api/meetings/${meetingId}/start`, { method: "POST" });
  const view = await call<MeetingView>(`/api/meetings/${meetingId}`);
  const ada = view.participants.find((p) => p.name === "Ada")!;
  const grace = view.participants.find((p) => p.name === "Grace")!;
  detail(
    `participants: ${view.participants.map((p) => `${p.name}/${p.kind}`).join(", ")}`,
  );

  step("launching the fake ACP agent");
  const connected = await call<{
    acpSessionId: string;
    capabilities: { loadSession: boolean };
    agent: { commandPreview: string; workspacePath: string };
  }>(`/api/meetings/${meetingId}/agent/connect`, {
    method: "POST",
    body: { agentId: "fake", workspacePath: process.cwd() },
  });
  detail(`command:  ${connected.agent.commandPreview}`);
  detail(`cwd:      ${connected.agent.workspacePath}`);
  detail(`session:  ${connected.acpSessionId}`);
  detail(`loadSession capability: ${connected.capabilities.loadSession}`);

  step("side conversation (must NOT wake the agent)");
  for (const [participantId, text] of [
    [ada.id, "I used Codex yesterday to clean up the migration."],
    [grace.id, "We should ask the cofounder later about the retry budget."],
  ] as const) {
    await call(`/api/meetings/${meetingId}/utterances`, {
      method: "POST",
      body: { participantId, text },
    });
    detail(`"${text}"`);
  }
  await sleep(500);
  const afterSmallTalk = await call<MeetingView>(`/api/meetings/${meetingId}`);
  const agentSpokeEarly = afterSmallTalk.transcript.some(
    (entry) => entry.speakerKind === "agent",
  );
  detail(
    agentSpokeEarly ? "FAIL: the agent answered" : "agent stayed silent ✓",
  );

  step('direct question: "Cofounder, what do you think?"');
  await call(`/api/meetings/${meetingId}/utterances`, {
    method: "POST",
    body: { participantId: ada.id, text: "Cofounder, what do you think?" },
  });
  const answer = await waitFor("the agent to answer", async () => {
    const now = await call<MeetingView>(`/api/meetings/${meetingId}`);
    const spoken = now.transcript.filter(
      (entry) => entry.speakerKind === "agent",
    );
    return spoken.length > 0 ? spoken[spoken.length - 1]! : null;
  });
  detail(`spoken: "${answer.text}"`);
  const withChat = await call<MeetingView>(`/api/meetings/${meetingId}`);
  const agentChat = withChat.chat.filter(
    (message) => message.speakerName === "Cofounder",
  );
  detail(
    `chat carried the detail: ${
      agentChat.length > 0 &&
      agentChat[agentChat.length - 1]!.text.includes("```")
        ? "yes, including a code block that was never spoken ✓"
        : "no"
    }`,
  );

  step(
    'work request with a permission gate: "Codex, inspect the webhook retries."',
  );
  await call(`/api/meetings/${meetingId}/utterances`, {
    method: "POST",
    body: {
      participantId: grace.id,
      text: "Codex, inspect the webhook retries.",
    },
  });
  const pending = await waitFor("a permission request", async () => {
    const now = await call<MeetingView>(`/api/meetings/${meetingId}`);
    return now.agent.pendingPermissions[0] ?? null;
  });
  detail(`agent asked for: ${pending.toolName} (nothing auto-approved)`);
  await call(
    `/api/meetings/${meetingId}/permissions/${pending.requestId}/respond`,
    { method: "POST", body: { decision: "allow", optionId: "allow_once" } },
  );
  detail("a human allowed it");

  const secondAnswer = await waitFor("the follow-up answer", async () => {
    const now = await call<MeetingView>(`/api/meetings/${meetingId}`);
    const spoken = now.transcript.filter(
      (entry) => entry.speakerKind === "agent",
    );
    return spoken.length > 1 ? spoken[spoken.length - 1]! : null;
  });
  detail(`spoken: "${secondAnswer.text}"`);

  step("recording a decision with provenance");
  const finalView = await call<MeetingView>(`/api/meetings/${meetingId}`);
  const sourceEntry = (
    await call<{ items: { id: string; text: string }[] }>(
      `/api/meetings/${meetingId}/transcript`,
    )
  ).items.find((entry) => entry.text.includes("what do you think"))!;
  await call(`/api/meetings/${meetingId}/memories`, {
    method: "POST",
    body: {
      kind: "decision",
      content: "Cap webhook retries at three, then dead-letter.",
      sourceTranscriptEntryId: sourceEntry.id,
    },
  });
  const memories = await call<{ items: MeetingView["memories"] }>(
    `/api/meetings/${meetingId}/memories`,
  );
  for (const memory of memories.items) {
    detail(
      `[${memory.kind}] ${memory.content} (source ${memory.sourceTranscriptEntryId})`,
    );
  }
  detail(`current topic: ${finalView.meeting.topic ?? "—"}`);

  step("cancelling agent work (speech is a separate control)");
  await call(`/api/meetings/${meetingId}/utterances`, {
    method: "POST",
    body: { participantId: ada.id, text: "Cofounder, check the retry budget." },
  });
  await sleep(150);
  const cancelled = await call<{ cancelled: boolean }>(
    `/api/meetings/${meetingId}/agent/cancel`,
    { method: "POST" },
  );
  detail(`cancel accepted: ${cancelled.cancelled}`);

  step("ending the meeting (agent process terminated)");
  await call(`/api/meetings/${meetingId}/end`, { method: "POST" });
  const ended = await call<MeetingView>(`/api/meetings/${meetingId}`);
  detail(`status: ${ended.meeting.status}, agent: ${ended.agent.status}`);
  detail(
    `persisted: ${ended.transcript.length} transcript entries, ${ended.chat.length} chat messages, ${ended.memories.length} memories`,
  );

  console.log("\n✓ smoke run complete\n");
} finally {
  await server.stop();
  rmSync(workdir, { recursive: true, force: true });
}
