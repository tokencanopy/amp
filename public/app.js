/**
 * The meeting simulator UI.
 *
 * Plain ES modules, no build step and no framework — this is a developer
 * prototype whose job is to make the gateway's behaviour visible, not to be a
 * product surface.
 *
 * The one piece of real design here is the speech layer. Speech and agent
 * work are deliberately separate concerns: stopping the voice is a local
 * browser action that never reaches the agent, while cancelling work is an
 * ACP `session/cancel` that never touches the voice. Conflating them is the
 * obvious shortcut and it is wrong — "stop talking" and "stop working" are
 * different instructions, and a meeting needs both.
 */

const state = {
  meetingId: null,
  meeting: null,
  participants: [],
  agents: [],
  socket: null,
  transcriptEntries: [],
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- speech

/**
 * SpeechOutput, backed by the browser. The interface is the seam: a
 * server-side TTS provider (which is what a real meeting needs, since the
 * agent's voice has to reach the call's audio, not the operator's laptop
 * speakers) implements the same three methods.
 */
const speech = (() => {
  const synth = window.speechSynthesis;
  let voices = [];
  let speaking = false;

  function refreshVoices() {
    if (synth === undefined) return;
    voices = synth.getVoices();
    const select = el("voice-select");
    const previous = select.value;
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Browser default";
    select.append(auto);
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      select.append(option);
    }
    if (previous) select.value = previous;
  }

  if (synth !== undefined) {
    refreshVoices();
    synth.addEventListener?.("voiceschanged", refreshVoices);
  }

  function setIndicator(text) {
    el("speaking-indicator").textContent = text;
  }

  return {
    supported: synth !== undefined,
    speak(text) {
      if (synth === undefined || !el("speech-enabled").checked) {
        return Promise.resolve();
      }
      const trimmed = String(text ?? "").trim();
      if (trimmed === "") return Promise.resolve();
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(trimmed);
        const chosen = el("voice-select").value;
        const voice = voices.find((candidate) => candidate.name === chosen);
        if (voice !== undefined) utterance.voice = voice;
        utterance.onstart = () => {
          speaking = true;
          setIndicator("Speaking…");
        };
        const done = () => {
          speaking = false;
          setIndicator("Silent.");
          resolve();
        };
        utterance.onend = done;
        utterance.onerror = done;
        synth.speak(utterance);
      });
    },
    cancel() {
      if (synth === undefined) return;
      synth.cancel();
      speaking = false;
      setIndicator("Stopped.");
    },
    isSpeaking() {
      return speaking;
    },
  };
})();

// ------------------------------------------------------------------ api

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined ? {} : { "content-type": "application/json" },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------- setup

async function loadAgents() {
  const payload = await api("/api/agents");
  state.agents = payload.items;
  const select = el("agent-select");
  select.innerHTML = "";
  for (const agent of payload.items) {
    if (agent.generic && !payload.genericAllowed) continue;
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.label}${
      agent.confidence === "unverified" ? " — command unverified" : ""
    }`;
    select.append(option);
  }
  select.addEventListener("change", showAgentCommand);
  showAgentCommand();
}

function selectedAgent() {
  return state.agents.find((agent) => agent.id === el("agent-select").value);
}

function showAgentCommand() {
  const agent = selectedAgent();
  el("agent-command").textContent =
    agent?.commandPreview || "(supplied at launch)";
  el("agent-description").textContent = agent?.description ?? "";
  el("agent-check").textContent = "";
}

async function checkAgent() {
  const agent = selectedAgent();
  if (agent === undefined) return;
  const output = el("agent-check");
  output.textContent = " checking…";
  try {
    const check = await api(`/api/agents/${agent.id}/check`, {
      method: "POST",
    });
    output.textContent = ` ${check.available ? "✓" : "✕"} ${check.note}`;
  } catch (error) {
    output.textContent = ` ✕ ${error.message}`;
  }
}

function parseParticipants(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const match = /^(.*?)\s*\((.*)\)$/u.exec(entry);
      return match === null
        ? { name: entry, kind: "human" }
        : { name: match[1], kind: "human", role: match[2] };
    });
}

async function createMeeting(event) {
  event.preventDefault();
  const error = el("setup-error");
  error.hidden = true;
  try {
    const created = await api("/api/meetings", {
      method: "POST",
      body: {
        title: el("meeting-title").value,
        agentDisplayName: el("agent-name").value,
        wakeNames: el("wake-names")
          .value.split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
        participants: parseParticipants(el("participants").value),
        agentId: el("agent-select").value,
        ...(el("workspace-path").value.trim() === ""
          ? {}
          : { workspacePath: el("workspace-path").value.trim() }),
      },
    });
    await api(`/api/meetings/${created.meeting.id}/start`, { method: "POST" });
    await openMeeting(created.meeting.id);
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
}

// --------------------------------------------------------------- meeting

async function openMeeting(meetingId) {
  const payload = await api(`/api/meetings/${meetingId}`);
  state.meetingId = meetingId;
  state.meeting = payload.meeting;
  state.participants = payload.participants;
  // Deliberately NOT payload.transcript: appendTranscript() pushes onto
  // state.transcriptEntries, so aliasing the payload array would make the
  // replay loop below feed the array it is iterating, and never terminate.
  state.transcriptEntries = [];
  localStorage.setItem("amp:last", meetingId);

  el("setup").hidden = true;
  el("meeting").hidden = false;
  el("meeting-title-display").textContent = payload.meeting.title;
  el("meeting-id").textContent = meetingId;
  el("meeting-status-display").textContent = payload.meeting.status;
  el("meeting-topic").textContent = payload.meeting.topic ?? "—";
  el("workspace-path").value =
    payload.meeting.workspacePath ?? el("workspace-path").value;
  // The launcher reads the picker, not the meeting, so a reopened meeting has
  // to put its own agent back. Without this, reloading the page and pressing
  // "Launch agent" silently rebinds the meeting to whichever agent happens to
  // be first in the list — the fake one — while the UI still says otherwise.
  if (payload.meeting.agentId !== null) {
    el("agent-select").value = payload.meeting.agentId;
    showAgentCommand();
  }

  renderParticipants();
  el("transcript").innerHTML = "";
  resetMemorySource();
  for (const entry of payload.transcript) appendTranscript(entry);
  el("chat").innerHTML = "";
  for (const message of payload.chat) appendChat(message);
  renderMemories(payload.memories);
  renderAgentSnapshot(payload.agent);
  for (const event of payload.agentEvents) {
    appendEvent(`${event.kind}: ${event.detail}`, false);
  }
  connectSocket(meetingId);
}

function renderParticipants() {
  const list = el("participants-list");
  const speakers = el("speaker-select");
  list.innerHTML = "";
  speakers.innerHTML = "";
  for (const participant of state.participants) {
    const item = document.createElement("li");
    item.dataset.kind = participant.kind;
    item.textContent = participant.role
      ? `${participant.name} · ${participant.role}`
      : participant.name;
    list.append(item);

    if (participant.kind === "human") {
      const option = document.createElement("option");
      option.value = participant.id;
      option.textContent = participant.name;
      speakers.append(option);
    }
  }
}

// appendTranscript() appends to the provenance picker as well as the
// transcript list, so replaying a meeting has to reset both or the picker
// accumulates a duplicate row per entry every time a meeting is reopened.
function resetMemorySource() {
  const source = el("memory-source");
  source.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(none)";
  source.append(none);
}

function appendTranscript(entry) {
  const item = document.createElement("li");
  item.dataset.kind = entry.speakerKind;
  item.dataset.addressed = String(entry.addressed);
  const speaker = document.createElement("span");
  speaker.className = "speaker";
  speaker.textContent = `${entry.speakerName}: `;
  item.append(speaker, document.createTextNode(entry.text));
  if (entry.addressed) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "addressed";
    item.append(tag);
  }
  const list = el("transcript");
  list.append(item);
  list.scrollTop = list.scrollHeight;

  state.transcriptEntries.push(entry);
  const source = el("memory-source");
  const option = document.createElement("option");
  option.value = entry.id;
  option.textContent = `${entry.speakerName}: ${entry.text.slice(0, 50)}`;
  source.append(option);
}

function appendChat(message) {
  const item = document.createElement("li");
  item.dataset.kind = message.speakerKind;
  const speaker = document.createElement("span");
  speaker.className = "speaker";
  speaker.textContent = `${message.speakerName}: `;
  item.append(speaker, document.createTextNode(message.text));
  const list = el("chat");
  list.append(item);
  list.scrollTop = list.scrollHeight;
}

function appendEvent(text, highlight) {
  const list = el("acp-events");
  const item = document.createElement("li");
  item.textContent = text;
  if (highlight) item.dataset.triggered = "true";
  list.append(item);
  list.scrollTop = list.scrollHeight;
  while (list.children.length > 200) list.firstChild?.remove();
}

function appendLog(line, at) {
  const list = el("logs");
  const item = document.createElement("li");
  item.textContent = `${(at ?? new Date().toISOString()).slice(11, 19)} ${line}`;
  list.append(item);
  list.scrollTop = list.scrollHeight;
  while (list.children.length > 200) list.firstChild?.remove();
}

function renderMemories(memories) {
  const list = el("memories");
  list.innerHTML = "";
  if (memories.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing remembered yet.";
    list.append(empty);
    return;
  }
  for (const memory of memories) {
    const item = document.createElement("li");
    item.dataset.status = memory.status;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = memory.kind.replace("_", " ");
    item.append(kind, document.createTextNode(memory.content));

    if (memory.sourceTranscriptEntryId || memory.sourceTimestamp) {
      const provenance = document.createElement("span");
      provenance.className = "provenance";
      const source = state.transcriptEntries.find(
        (entry) => entry.id === memory.sourceTranscriptEntryId,
      );
      provenance.textContent = source
        ? `from ${source.speakerName} at ${(memory.sourceTimestamp ?? "").slice(11, 19)}: “${source.text.slice(0, 60)}”`
        : `source ${memory.sourceTranscriptEntryId ?? "—"}`;
      item.append(provenance);
    }

    if (memory.status === "active") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link";
      button.textContent = "supersede";
      button.addEventListener("click", async () => {
        await api(
          `/api/meetings/${state.meetingId}/memories/${memory.id}/supersede`,
          { method: "POST" },
        );
        await refreshMemories();
      });
      item.append(document.createTextNode(" "), button);
    }
    list.append(item);
  }
}

async function refreshMemories() {
  const payload = await api(`/api/meetings/${state.meetingId}/memories`);
  renderMemories(payload.items);
}

function renderAgentSnapshot(snapshot) {
  setAgentStatus(snapshot.status, "");
  el("acp-session").textContent = snapshot.acpSessionId ?? "—";
  el("acp-capabilities").textContent =
    snapshot.capabilities === null
      ? "—"
      : `loadSession: ${snapshot.capabilities.loadSession}`;
  el("acp-command").textContent =
    snapshot.agent === null
      ? "—"
      : [snapshot.agent.command, ...snapshot.agent.args].join(" ");
  for (const record of snapshot.log) appendLog(record.line, record.at);
  for (const request of snapshot.pendingPermissions) renderPermission(request);
}

function setAgentStatus(status, detail) {
  const node = el("agent-status");
  node.dataset.status = status;
  el("agent-status-text").textContent = detail
    ? `${status} — ${detail}`
    : status;
}

function renderPermission(request) {
  const list = el("permissions");
  list.querySelector(".empty")?.remove();
  if (document.getElementById(`perm-${request.requestId}`)) return;

  const item = document.createElement("li");
  item.id = `perm-${request.requestId}`;
  const title = document.createElement("strong");
  title.textContent = `${request.toolName} (${request.toolKind})`;
  const detail = document.createElement("code");
  detail.className = "detail";
  detail.textContent = request.detail;
  item.append(title, detail);

  const actions = document.createElement("div");
  actions.className = "actions";
  for (const option of request.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = option.kind.startsWith("allow")
      ? "btn btn-primary"
      : "btn";
    button.textContent = option.name;
    button.addEventListener("click", () =>
      respondToPermission(
        request.requestId,
        option.kind.startsWith("allow") ? "allow" : "deny",
        option.optionId,
      ),
    );
    actions.append(button);
  }
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "btn btn-danger";
  deny.textContent = "Deny";
  deny.addEventListener("click", () =>
    respondToPermission(request.requestId, "deny"),
  );
  actions.append(deny);
  item.append(actions);
  list.append(item);
}

async function respondToPermission(requestId, decision, optionId) {
  await api(
    `/api/meetings/${state.meetingId}/permissions/${requestId}/respond`,
    {
      method: "POST",
      body: { decision, ...(optionId === undefined ? {} : { optionId }) },
    },
  );
  document.getElementById(`perm-${requestId}`)?.remove();
  if (el("permissions").children.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing waiting. Requests are never auto-approved.";
    el("permissions").append(empty);
  }
}

// -------------------------------------------------------------- realtime

function connectSocket(meetingId) {
  state.socket?.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${protocol}://${location.host}/ws?meetingId=${encodeURIComponent(meetingId)}`,
  );
  state.socket = socket;
  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(payload);
  });
  socket.addEventListener("close", () => appendLog("realtime feed closed"));
}

function handleEvent(event) {
  switch (event.type) {
    case "transcript":
      appendTranscript(event.entry);
      break;
    case "chat":
      appendChat(event.message);
      break;
    case "participant":
      state.participants.push(event.participant);
      renderParticipants();
      break;
    case "meeting_status":
      el("meeting-status-display").textContent = event.status;
      el("meeting-topic").textContent = event.topic ?? "—";
      break;
    case "agent_status":
      setAgentStatus(event.status, event.detail);
      break;
    case "attention":
      appendEvent(
        `${event.triggered ? "TRIGGERED" : "ignored"} — ${event.detail} (${event.speaker})`,
        event.triggered,
      );
      break;
    case "acp_event":
      appendEvent(`${event.kind}: ${event.description}`, false);
      break;
    case "agent_stream":
      el("agent-stream").textContent += event.text;
      break;
    case "permission_requested":
      renderPermission(event.request);
      break;
    case "permission_resolved":
      document.getElementById(`perm-${event.requestId}`)?.remove();
      appendEvent(`permission ${event.outcome}`, false);
      break;
    case "speak":
      if (event.source === "barge_in") {
        // Somebody addressed the agent again while it was talking. Stop the
        // voice; the agent's work is untouched.
        speech.cancel();
      } else {
        el("agent-stream").textContent = "";
        void speech.speak(event.text);
      }
      break;
    case "memory":
      void refreshMemories();
      break;
    case "log":
      appendLog(event.line, event.at);
      break;
    case "session":
      el("acp-session").textContent = event.acpSessionId ?? "—";
      el("acp-command").textContent = event.command ?? "—";
      el("acp-capabilities").textContent =
        event.capabilities === null
          ? "—"
          : `loadSession: ${event.capabilities.loadSession}`;
      break;
    default:
      break;
  }
}

// --------------------------------------------------------------- actions

async function connectAgent() {
  const agent = selectedAgent();
  if (agent === undefined) return;
  const workspacePath =
    el("workspace-path").value.trim() || state.meeting?.workspacePath || ".";

  // Explicit consent, with the exact command, argument vector, and working
  // directory shown before anything is spawned.
  const confirmed = window.confirm(
    [
      "Launch this agent process on this machine?",
      "",
      `Command:   ${agent.command}`,
      `Arguments: ${JSON.stringify(agent.args)}`,
      `Directory: ${workspacePath}`,
      "",
      "The agent runs with your permissions and its own sandbox and approval rules.",
    ].join("\n"),
  );
  if (!confirmed) return;

  const button = el("connect-agent");
  button.disabled = true;
  try {
    const result = await api(`/api/meetings/${state.meetingId}/agent/connect`, {
      method: "POST",
      body: { agentId: agent.id, workspacePath },
    });
    appendLog(
      `agent connected: session ${result.acpSessionId}${result.resumed ? " (resumed)" : ""}`,
    );
  } catch (error) {
    appendLog(`launch failed: ${error.message}`);
    window.alert(`Could not launch the agent:\n\n${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function sendUtterance(event) {
  event.preventDefault();
  const text = el("utterance-text").value.trim();
  if (text === "") return;
  await api(`/api/meetings/${state.meetingId}/utterances`, {
    method: "POST",
    body: {
      participantId: el("speaker-select").value,
      text,
      addressed: el("addressed").checked,
      channel: el("as-chat").checked ? "chat" : "speech",
    },
  });
  el("utterance-text").value = "";
  el("addressed").checked = false;
}

async function addMemory(event) {
  event.preventDefault();
  const content = el("memory-content").value.trim();
  if (content === "") return;
  const source = el("memory-source").value;
  await api(`/api/meetings/${state.meetingId}/memories`, {
    method: "POST",
    body: {
      kind: el("memory-kind").value,
      content,
      ...(source === "" ? {} : { sourceTranscriptEntryId: source }),
    },
  });
  el("memory-content").value = "";
  await refreshMemories();
}

// ------------------------------------------------------------------ boot

el("setup-form").addEventListener("submit", createMeeting);
el("check-agent").addEventListener("click", checkAgent);
el("utterance-form").addEventListener("submit", sendUtterance);
el("memory-form").addEventListener("submit", addMemory);
el("connect-agent").addEventListener("click", connectAgent);
el("stop-speech").addEventListener("click", () => speech.cancel());
el("cancel-work").addEventListener("click", async () => {
  try {
    await api(`/api/meetings/${state.meetingId}/agent/cancel`, {
      method: "POST",
    });
    appendLog("cancel sent to the agent (speech untouched)");
  } catch (error) {
    appendLog(`cancel failed: ${error.message}`);
  }
});
el("end-meeting").addEventListener("click", async () => {
  if (!window.confirm("End this meeting and shut the agent down?")) return;
  await api(`/api/meetings/${state.meetingId}/end`, { method: "POST" });
  speech.cancel();
  location.reload();
});
el("load-existing").addEventListener("click", async () => {
  const last = localStorage.getItem("amp:last");
  if (last === null) {
    window.alert("No previous meeting on this browser.");
    return;
  }
  await openMeeting(last).catch((error) => window.alert(error.message));
});

await loadAgents();

// Reopen the last meeting automatically, which is what makes "reload the page
// and the transcript is still there" true rather than a claim.
const last = localStorage.getItem("amp:last");
if (last !== null) {
  try {
    await openMeeting(last);
  } catch {
    localStorage.removeItem("amp:last");
  }
}

if (!speech.supported) {
  el("speaking-indicator").textContent =
    "This browser has no speechSynthesis; responses appear in the transcript only.";
}
