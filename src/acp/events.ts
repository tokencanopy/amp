/**
 * Normalizing `session/update` into events this app understands.
 *
 * ACP adapters differ in what they emit and in what they call it, and new
 * update kinds appear as adapters move. Everything unknown becomes an
 * explicit `unknown` event rather than being dropped, so the activity log can
 * show that something happened even when this build has never heard of it.
 *
 * `agent_thought_chunk` is normalized to an event that carries NO text. The
 * model's reasoning is not meeting content: it is not spoken, not posted, and
 * not persisted. Discarding it here rather than downstream means no later
 * change can accidentally start storing it.
 */
import { sanitizeText } from "./sanitize.js";

export type NormalizedAcpEvent =
  | { type: "message_chunk"; text: string }
  | { type: "thought" }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      status: string;
      title: string | null;
    }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | { type: "unknown"; sessionUpdate: string };

function text(value: unknown): string {
  return typeof value === "string" ? sanitizeText(value) : "";
}

/** ACP content blocks are a string, an object with `text`, or an array of both. */
function contentText(content: unknown): string {
  if (typeof content === "string") return sanitizeText(content);
  if (Array.isArray(content)) {
    return content.map((part) => contentText(part)).join("");
  }
  if (content !== null && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record["text"] === "string") return sanitizeText(record["text"]);
  }
  return "";
}

export function normalizeUpdate(
  update: Record<string, unknown> | undefined | null,
): NormalizedAcpEvent | null {
  if (update === undefined || update === null) return null;
  const kind = update["sessionUpdate"];
  if (typeof kind !== "string") return null;

  switch (kind) {
    case "agent_message_chunk": {
      const value = contentText(update["content"]);
      return value === "" ? null : { type: "message_chunk", text: value };
    }
    case "agent_thought_chunk":
      return { type: "thought" };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: text(update["toolCallId"]) || "unknown",
        title: text(update["title"]) || "tool call",
        kind: text(update["kind"]) || "other",
        status: text(update["status"]) || "pending",
      };
    case "tool_call_update":
      return {
        type: "tool_call_update",
        toolCallId: text(update["toolCallId"]) || "unknown",
        status: text(update["status"]) || "unknown",
        title:
          typeof update["title"] === "string" ? text(update["title"]) : null,
      };
    case "plan": {
      const raw = Array.isArray(update["entries"]) ? update["entries"] : [];
      return {
        type: "plan",
        entries: raw.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>;
          return {
            content: text(record["content"]),
            status: text(record["status"]) || "pending",
          };
        }),
      };
    }
    default:
      return { type: "unknown", sessionUpdate: sanitizeText(kind) };
  }
}

/** A one-line, human-readable summary for the activity log and audit trail. */
export function describeEvent(event: NormalizedAcpEvent): string {
  switch (event.type) {
    case "message_chunk":
      return `message chunk (${event.text.length} chars)`;
    case "thought":
      return "agent is reasoning (content withheld)";
    case "tool_call":
      return `tool call: ${event.title} [${event.kind}] ${event.status}`;
    case "tool_call_update":
      return `tool call ${event.toolCallId} is ${event.status}`;
    case "plan":
      return `plan updated (${event.entries.length} steps)`;
    case "unknown":
      return `unrecognized update: ${event.sessionUpdate}`;
  }
}
