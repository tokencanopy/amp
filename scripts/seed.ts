/**
 * Seed a demo meeting so the UI has something in it on first run.
 *
 * Writes straight to the store rather than through the API, so it works
 * whether or not the server is running. The meeting is left in "created" —
 * start it from the UI (or with POST /api/meetings/:id/start) so the gateway
 * is the thing that opens the event stream.
 */
import { loadConfig } from "../src/config.js";
import { MeetingStore } from "../src/store/store.js";

const config = loadConfig();
const store = new MeetingStore(config.databasePath);

const meeting = store.createMeeting({
  title: "Demo: retry policy sync",
  provider: "mock",
  agentDisplayName: "Cofounder",
  wakeNames: ["cofounder", "codex", "claude"],
  agentId: "fake",
  workspacePath: config.defaultWorkspace,
});

const people = [
  { name: "Ada", role: "founder" },
  { name: "Grace", role: "engineer" },
  { name: "Lin", role: "design" },
] as const;

const participants = people.map((person) =>
  store.addParticipant({
    meetingId: meeting.id,
    name: person.name,
    kind: "human",
    role: person.role,
  }),
);
store.addParticipant({
  meetingId: meeting.id,
  name: "Cofounder",
  kind: "agent",
  role: "AI cofounder",
});

const script: [number, string][] = [
  [0, "Webhook retries are failing for two customers since Tuesday."],
  [1, "I used Codex yesterday to trace it — the third attempt just drops."],
  [2, "Do we tell the customers before or after the fix?"],
];
for (const [index, text] of script) {
  store.appendTranscript({
    meetingId: meeting.id,
    participantId: participants[index]!.id,
    speakerName: participants[index]!.name,
    speakerKind: "human",
    text,
    addressed: false,
  });
}

store.addMemory({
  meetingId: meeting.id,
  kind: "action_item",
  content: "Grace to reproduce the dropped retry locally.",
  sourceParticipantId: participants[1]!.id,
});

store.close();

console.log(`seeded meeting ${meeting.id} ("${meeting.title}")`);
console.log(`open http://${config.host}:${config.port}/ and reopen it, or:`);
console.log(
  `  curl -X POST http://${config.host}:${config.port}/api/meetings/${meeting.id}/start`,
);
