/**
 * The HTTP + WebSocket surface.
 *
 * Fastify with zod validation, following `apps/chat`'s shape: every input is
 * parsed by a schema before a handler sees it, and every failure comes back
 * as `{ error: { code, message } }` rather than a stack trace.
 *
 * Two route families that are not ordinary CRUD:
 *   - `/ws` is the realtime feed the meeting room subscribes to;
 *   - `/api/mcp/*` is the loopback bridge the meeting MCP server calls back
 *     through. It is authenticated by a per-meeting capability that only ever
 *     reaches the agent's own MCP subprocess, and it is the only way a tool
 *     call can affect a meeting.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

import {
  checkAgent,
  loadAgentRegistry,
  type AgentDefinition,
} from "../acp/registry.js";
import type { AppConfig } from "../config.js";
import { MeetingGateway } from "../gateway/gateway.js";
import type { MockMeetingProvider } from "../providers/mock.js";
import type { RecallMeetingProvider } from "../providers/recall/provider.js";
import type { RecallWebhookEnvelope } from "../providers/recall/wire.js";
import { MAX_TTS_CHARS, synthesizeWav } from "../speech/tts.js";
import { RealtimeHub } from "./hub.js";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const meetingParams = z.object({ meetingId: z.string().min(1).max(64) });

const createMeetingBody = z.object({
  title: z.string().min(1).max(200),
  agentDisplayName: z.string().min(1).max(64).default("Cofounder"),
  wakeNames: z.array(z.string().min(1).max(64)).max(10).default([]),
  participants: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        kind: z.enum(["human", "agent"]).default("human"),
        role: z.string().min(1).max(64).optional(),
      }),
    )
    .max(20)
    .default([]),
  workspacePath: z.string().min(1).max(4_096).optional(),
  agentId: z.string().min(1).max(64).optional(),
  /** Which meeting platform drives this meeting. */
  provider: z.string().min(1).max(32).default("mock"),
  /** Required by a real provider: the platform meeting to join. */
  meetingUrl: z.string().url().max(2_048).optional(),
});

const utteranceBody = z.object({
  participantId: z.string().min(1).max(64),
  text: z.string().min(1).max(4_000),
  addressed: z.boolean().default(false),
  channel: z.enum(["speech", "chat"]).default("speech"),
});

const connectBody = z.object({
  agentId: z.string().min(1).max(64),
  workspacePath: z.string().min(1).max(4_096).optional(),
  /** Only honoured for the generic agent, and only when opted in. */
  command: z.string().min(1).max(1_024).optional(),
  args: z.array(z.string().max(1_024)).max(50).optional(),
  resume: z.boolean().default(true),
});

const permissionBody = z.object({
  decision: z.enum(["allow", "deny"]),
  optionId: z.string().min(1).max(128).optional(),
});

const memoryBody = z.object({
  kind: z.enum(["decision", "action_item", "fact", "note"]),
  content: z.string().min(1).max(2_000),
  sourceParticipantId: z.string().min(1).max(64).optional(),
  sourceTranscriptEntryId: z.string().min(1).max(64).optional(),
});

export interface BuildAppDependencies {
  config: AppConfig;
  gateway: MeetingGateway;
  hub: RealtimeHub;
  agents: AgentDefinition[];
  /**
   * The simulator, when one is driving. Present only for the mock provider:
   * with a real meeting behind the gateway, utterances arrive from the room
   * and nobody types them, so those routes have nothing to do and say so
   * rather than pretending.
   */
  simulator?: MockMeetingProvider;
  /** Present when a Recall bot is driving meetings. */
  recall?: RecallMeetingProvider;
}

const PUBLIC_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../public",
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/** Constant-time string compare, so a secret is not leaked by response timing. */
function timingSafeEqualString(expected: string, offered: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(offered);
  if (a.length !== b.length) {
    // Compare against itself to keep the timing profile flat, then fail.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildApp(deps: BuildAppDependencies): FastifyInstance {
  const { config, gateway, hub } = deps;
  const app = Fastify({ logger: { level: config.logLevel } });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    // Zod validation failures arrive with a statusCode already set.
    const failure = error as { statusCode?: number; message?: string };
    const status = failure.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.status(status).send({
      error: {
        code: status === 400 ? "invalid_request" : "internal_error",
        message:
          status >= 500
            ? "The request could not be completed."
            : (failure.message ?? "Invalid request."),
      },
    });
  });

  const routes = app.withTypeProvider<ZodTypeProvider>();
  const store = gateway.store;

  function requireSimulator(): MockMeetingProvider {
    if (deps.simulator === undefined) {
      throw new ApiError(
        409,
        "not_simulated",
        "This meeting is driven by a real meeting provider. Speech and chat come from the meeting itself, not from this API.",
      );
    }
    return deps.simulator;
  }

  function findAgent(agentId: string): AgentDefinition {
    const agent = deps.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      throw new ApiError(404, "unknown_agent", `No agent named "${agentId}".`);
    }
    return agent;
  }

  function requireMeeting(meetingId: string) {
    const meeting = store.getMeeting(meetingId);
    if (meeting === null) {
      throw new ApiError(404, "unknown_meeting", `No meeting ${meetingId}.`);
    }
    return meeting;
  }

  // ---- health and agents ------------------------------------------------

  routes.get("/api/health", async () => ({
    status: "ok",
    prototype: "amp v0 (local developer prototype)",
    host: config.host,
    mcpEnabled: config.enableMcp,
  }));

  routes.get("/api/agents", async () => ({
    items: deps.agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      command: agent.command,
      args: agent.args,
      // The exact string that will be executed, shown before anything runs.
      commandPreview: [agent.command, ...agent.args].join(" "),
      description: agent.description,
      confidence: agent.confidence,
      generic: agent.generic === true,
    })),
    genericAllowed: config.allowGenericAgent,
  }));

  routes.post(
    "/api/agents/:agentId/check",
    { schema: { params: z.object({ agentId: z.string().min(1).max(64) }) } },
    async (request) => checkAgent(findAgent(request.params.agentId)),
  );

  // ---- meetings ---------------------------------------------------------

  routes.post(
    "/api/meetings",
    { schema: { body: createMeetingBody } },
    async (request, reply) => {
      const body = request.body;
      const provider = gateway.providerNamed(body.provider);
      if (provider === undefined) {
        throw new ApiError(
          400,
          "unknown_provider",
          `No meeting provider named "${body.provider}" is configured. Configure its credentials, or use "mock".`,
        );
      }
      const meeting = await provider.createMeeting({
        title: body.title,
        agentDisplayName: body.agentDisplayName,
        wakeNames: body.wakeNames,
        participants: body.participants.map((participant) => ({
          name: participant.name,
          kind: participant.kind,
          ...(participant.role === undefined ? {} : { role: participant.role }),
        })),
        ...(body.workspacePath === undefined
          ? { workspacePath: config.defaultWorkspace }
          : { workspacePath: body.workspacePath }),
        ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
        ...(body.meetingUrl === undefined
          ? {}
          : { meetingUrl: body.meetingUrl }),
      } as Parameters<typeof provider.createMeeting>[0]);
      return reply.status(201).send({
        meeting,
        participants: store.listParticipants(meeting.id),
      });
    },
  );

  routes.get("/api/meetings", async () => ({ items: store.listMeetings() }));

  routes.get(
    "/api/meetings/:meetingId",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      return {
        meeting,
        participants: store.listParticipants(meeting.id),
        transcript: store.listTranscript(meeting.id),
        chat: store.listChat(meeting.id),
        memories: store.listMemories(meeting.id),
        agentEvents: store.listAgentEvents(meeting.id, 100),
        agent: gateway.snapshot(meeting.id),
      };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/start",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      if (meeting.status === "ended") {
        throw new ApiError(409, "meeting_ended", "That meeting has ended.");
      }
      gateway.startConsuming(meeting.id);
      await gateway.providerFor(meeting.id).startMeeting(meeting.id);
      return { meeting: store.requireMeeting(meeting.id) };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/end",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      await gateway.disconnectAgent(meeting.id);
      await gateway.providerFor(meeting.id).endMeeting(meeting.id);
      return { meeting: store.requireMeeting(meeting.id) };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/participants",
    {
      schema: {
        params: meetingParams,
        body: z.object({
          name: z.string().min(1).max(64),
          kind: z.enum(["human", "agent"]).default("human"),
          role: z.string().min(1).max(64).optional(),
        }),
      },
    },
    async (request, reply) => {
      const meeting = requireMeeting(request.params.meetingId);
      await requireSimulator().addParticipant(meeting.id, {
        name: request.body.name,
        kind: request.body.kind,
        ...(request.body.role === undefined ? {} : { role: request.body.role }),
      });
      return reply
        .status(201)
        .send({ participants: store.listParticipants(meeting.id) });
    },
  );

  routes.post(
    "/api/meetings/:meetingId/utterances",
    { schema: { params: meetingParams, body: utteranceBody } },
    async (request, reply) => {
      const meeting = requireMeeting(request.params.meetingId);
      if (meeting.status !== "live") {
        throw new ApiError(
          409,
          "meeting_not_live",
          "That meeting is not live.",
        );
      }
      const participant = store.getParticipant(
        meeting.id,
        request.body.participantId,
      );
      if (participant === null) {
        throw new ApiError(
          404,
          "unknown_participant",
          "That participant is not in this meeting.",
        );
      }

      const input = {
        meetingId: meeting.id,
        participantId: participant.id,
        text: request.body.text,
        addressed: request.body.addressed,
      };
      if (request.body.channel === "chat") {
        await requireSimulator().emitChat(input);
      } else {
        await requireSimulator().emitUtterance(input);
      }
      return reply.status(202).send({ accepted: true });
    },
  );

  routes.get(
    "/api/meetings/:meetingId/transcript",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      return {
        items: store.listTranscript(meeting.id),
        chat: store.listChat(meeting.id),
      };
    },
  );

  // ---- agent control ----------------------------------------------------

  routes.post(
    "/api/meetings/:meetingId/agent/connect",
    { schema: { params: meetingParams, body: connectBody } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      const base = findAgent(request.body.agentId);

      let agent = base;
      if (base.generic === true) {
        if (!config.allowGenericAgent) {
          throw new ApiError(
            403,
            "generic_agent_disabled",
            "The generic agent is disabled. Start the server with AMP_ALLOW_GENERIC=true to launch a command supplied by the client.",
          );
        }
        if (request.body.command === undefined) {
          throw new ApiError(
            400,
            "command_required",
            "The generic agent needs a command.",
          );
        }
        agent = {
          ...base,
          command: request.body.command,
          args: request.body.args ?? [],
        };
      }

      const workspacePath =
        request.body.workspacePath ??
        meeting.workspacePath ??
        config.defaultWorkspace;

      try {
        const result = await gateway.connectAgent(meeting.id, agent, {
          workspacePath,
          resume: request.body.resume,
        });
        return {
          ...result,
          agent: {
            id: agent.id,
            label: agent.label,
            commandPreview: [agent.command, ...agent.args].join(" "),
            workspacePath,
          },
        };
      } catch (error) {
        throw new ApiError(
          502,
          "agent_launch_failed",
          error instanceof Error
            ? error.message
            : "Could not launch the agent.",
        );
      }
    },
  );

  routes.post(
    "/api/meetings/:meetingId/agent/cancel",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      const cancelled = gateway.cancelAgentWork(meeting.id);
      if (!cancelled) {
        throw new ApiError(409, "no_agent", "No agent is connected.");
      }
      return { cancelled: true };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/agent/disconnect",
    { schema: { params: meetingParams } },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      await gateway.disconnectAgent(meeting.id);
      return { disconnected: true };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/permissions/:requestId/respond",
    {
      schema: {
        params: meetingParams.extend({
          requestId: z.string().min(1).max(128),
        }),
        body: permissionBody,
      },
    },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      const optionId =
        request.body.decision === "allow"
          ? (request.body.optionId ?? "allow_once")
          : null;
      const answered = gateway.respondToPermission(
        meeting.id,
        request.params.requestId,
        optionId,
      );
      if (!answered) {
        throw new ApiError(
          404,
          "unknown_request",
          "That permission request is no longer waiting.",
        );
      }
      return { answered: true, decision: request.body.decision };
    },
  );

  // ---- memory -----------------------------------------------------------

  routes.get(
    "/api/meetings/:meetingId/memories",
    {
      schema: {
        params: meetingParams,
        querystring: z.object({
          kind: z.enum(["decision", "action_item", "fact", "note"]).optional(),
          status: z.enum(["active", "superseded"]).optional(),
        }),
      },
    },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      return {
        items: store.listMemories(meeting.id, {
          ...(request.query.kind === undefined
            ? {}
            : { kind: request.query.kind }),
          ...(request.query.status === undefined
            ? {}
            : { status: request.query.status }),
        }),
      };
    },
  );

  routes.post(
    "/api/meetings/:meetingId/memories",
    { schema: { params: meetingParams, body: memoryBody } },
    async (request, reply) => {
      const meeting = requireMeeting(request.params.meetingId);
      try {
        const memory = gateway.remember(meeting.id, request.body);
        return reply.status(201).send({ memory });
      } catch (error) {
        throw new ApiError(
          400,
          "invalid_memory",
          error instanceof Error
            ? error.message
            : "Could not store that memory.",
        );
      }
    },
  );

  routes.post(
    "/api/meetings/:meetingId/memories/:memoryId/supersede",
    {
      schema: {
        params: meetingParams.extend({ memoryId: z.string().min(1).max(64) }),
      },
    },
    async (request) => {
      const meeting = requireMeeting(request.params.meetingId);
      try {
        return {
          memory: gateway.supersedeMemory(meeting.id, request.params.memoryId),
        };
      } catch {
        throw new ApiError(404, "unknown_memory", "No such memory.");
      }
    },
  );

  // ---- MCP bridge -------------------------------------------------------
  //
  // The meeting MCP server runs as a child of the AGENT, not of this server,
  // so it reaches meeting state over loopback HTTP. Its capability is minted
  // per meeting, handed to the subprocess through its environment, and never
  // written to disk.

  const mcpHeaders = z.object({
    "x-meeting-id": z.string().min(1).max(64),
    "x-meeting-mcp-token": z.string().min(8).max(128),
  });

  function authorizeMcp(headers: unknown): string {
    const parsed = mcpHeaders.safeParse(headers);
    if (!parsed.success) {
      throw new ApiError(401, "unauthorized", "Missing meeting capability.");
    }
    const meetingId = parsed.data["x-meeting-id"];
    if (
      !gateway.verifyMcpToken(meetingId, parsed.data["x-meeting-mcp-token"])
    ) {
      throw new ApiError(403, "forbidden", "That capability is not valid.");
    }
    requireMeeting(meetingId);
    return meetingId;
  }

  routes.get("/api/mcp/active", async (request) => {
    const meetingId = authorizeMcp(request.headers);
    const meeting = store.requireMeeting(meetingId);
    return {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        status: meeting.status,
        topic: meeting.topic,
        summary: meeting.summary,
        agentDisplayName: meeting.agentDisplayName,
        startedAt: meeting.startedAt,
      },
    };
  });

  routes.get("/api/mcp/participants", async (request) => {
    const meetingId = authorizeMcp(request.headers);
    return { items: store.listParticipants(meetingId) };
  });

  routes.get(
    "/api/mcp/transcript",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
    },
    async (request) => {
      const meetingId = authorizeMcp(request.headers);
      return { items: store.recentTranscript(meetingId, request.query.limit) };
    },
  );

  routes.post(
    "/api/mcp/chat",
    { schema: { body: z.object({ text: z.string().min(1).max(8_000) }) } },
    async (request) => {
      const meetingId = authorizeMcp(request.headers);
      try {
        await gateway.agentSendChat(meetingId, request.body.text);
      } catch (error) {
        throw new ApiError(
          409,
          "meeting_not_live",
          error instanceof Error ? error.message : "Could not post to chat.",
        );
      }
      return { posted: true };
    },
  );

  routes.post(
    "/api/mcp/speak",
    { schema: { body: z.object({ text: z.string().min(1).max(4_000) }) } },
    async (request) => {
      const meetingId = authorizeMcp(request.headers);
      try {
        await gateway.agentSpeak(meetingId, request.body.text);
      } catch (error) {
        throw new ApiError(
          409,
          "meeting_not_live",
          error instanceof Error ? error.message : "Could not speak.",
        );
      }
      return { spoken: true };
    },
  );

  routes.post(
    "/api/mcp/memories",
    { schema: { body: memoryBody } },
    async (request) => {
      const meetingId = authorizeMcp(request.headers);
      try {
        return { memory: gateway.remember(meetingId, request.body) };
      } catch (error) {
        throw new ApiError(
          400,
          "invalid_memory",
          error instanceof Error
            ? error.message
            : "Could not store that memory.",
        );
      }
    },
  );

  routes.get(
    "/api/mcp/memories",
    {
      schema: {
        querystring: z.object({
          kind: z.enum(["decision", "action_item", "fact", "note"]).optional(),
          status: z.enum(["active", "superseded"]).default("active"),
        }),
      },
    },
    async (request) => {
      const meetingId = authorizeMcp(request.headers);
      return {
        items: store.listMemories(meetingId, {
          ...(request.query.kind === undefined
            ? {}
            : { kind: request.query.kind }),
          status: request.query.status,
        }),
      };
    },
  );

  // ---- Recall.ai webhook ingress ---------------------------------------
  //
  // Recall's real-time webhooks are unauthenticated POSTs to a public URL, so
  // the meeting id alone would let anyone who learns it write into a live
  // meeting's transcript — the one input the agent is told to trust. The
  // shared secret in the path is what prevents that, and it is compared in
  // constant time so the route does not leak it a character at a time.
  //
  // The body is NOT validated field-by-field here: the payload shape is the
  // unverified part of this integration (see providers/recall/wire.ts), and a
  // strict schema would reject real events the moment a vendor adds a field.
  // Translation is defensive instead, and anything it cannot read is skipped
  // and reported rather than guessed at.

  if (deps.recall !== undefined) {
    const recall = deps.recall;
    routes.post(
      "/api/providers/recall/:meetingId",
      {
        schema: {
          params: meetingParams,
          querystring: z.object({ secret: z.string().max(256).optional() }),
          body: z.object({}).passthrough(),
        },
        config: { rawBody: false },
      },
      async (request, reply) => {
        const expected = config.recall.webhookSecret;
        const offered = request.query.secret ?? "";
        if (
          expected === undefined ||
          !timingSafeEqualString(expected, offered)
        ) {
          // Deliberately uninformative: a webhook caller that fails this has
          // no business learning whether the meeting exists.
          return reply
            .status(404)
            .send({ error: { code: "not_found", message: "Not found." } });
        }

        const outcome = recall.ingestWebhook(
          request.params.meetingId,
          request.body as unknown as RecallWebhookEnvelope,
        );
        // 200 either way: a webhook that is retried forever because this app
        // skipped an event it did not need is a worse problem than a lost
        // event. What was skipped, and why, is in the response and the log.
        if (!outcome.accepted) {
          request.log.info(
            { meetingId: request.params.meetingId, reason: outcome.reason },
            "recall webhook skipped",
          );
        }
        return reply.status(200).send(outcome);
      },
    );
  }

  // ---- speech synthesis for the speaker page ----------------------------
  //
  // The speaker page runs in Recall's browser, not the operator's, and that
  // browser has no `speechSynthesis` voices — so the audio has to be made
  // here and fetched. See src/speech/tts.ts for why it is local synthesis.
  //
  // This route is reachable through the same public tunnel as the webhook, so
  // it carries the same shared secret and is refused identically without it.
  // Unauthenticated, it would be an open text-to-audio endpoint on a stranger's
  // machine, and a way to make this host run `say` on demand.
  routes.post(
    "/api/meetings/:meetingId/tts",
    {
      schema: {
        params: meetingParams,
        querystring: z.object({ secret: z.string().max(256).optional() }),
        body: z.object({
          text: z.string().min(1).max(MAX_TTS_CHARS),
          voice: z.string().max(64).optional(),
          rate: z.number().int().min(80).max(400).optional(),
        }),
      },
    },
    async (request, reply) => {
      const expected = config.recall.webhookSecret;
      if (expected !== undefined) {
        const offered = request.query.secret ?? "";
        if (!timingSafeEqualString(expected, offered)) {
          return reply
            .status(404)
            .send({ error: { code: "not_found", message: "Not found." } });
        }
      }
      if (store.getMeeting(request.params.meetingId) === null) {
        throw new ApiError(404, "unknown_meeting", "Meeting not found.");
      }
      try {
        const wav = await synthesizeWav(request.body.text, {
          voice: request.body.voice,
          rate: request.body.rate,
        });
        return reply
          .header("content-type", "audio/wav")
          .header("cache-control", "no-store")
          .send(wav);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "speech synthesis failed";
        // 503 rather than 500: the speaker page treats this as "fall back to
        // whatever voice you have", which is a different thing from a bug.
        request.log.warn({ err: message }, "tts unavailable");
        return reply
          .status(503)
          .send({ error: { code: "tts_unavailable", message } });
      }
    },
  );

  // ---- realtime ---------------------------------------------------------

  app.register(async (instance) => {
    await instance.register(websocket);
    instance.get<{ Querystring: { meetingId?: string } }>(
      "/ws",
      { websocket: true },
      (socket, request) => {
        const meetingId = request.query.meetingId;
        const meeting =
          typeof meetingId === "string" ? store.getMeeting(meetingId) : null;
        if (typeof meetingId !== "string" || meeting === null) {
          socket.send(
            JSON.stringify({ type: "error", message: "unknown meeting" }),
          );
          socket.close();
          return;
        }
        const unsubscribe = hub.subscribe(meetingId, socket);
        socket.send(
          JSON.stringify({
            type: "hello",
            meetingId,
            // Just enough for a subscriber to name the room it joined. The
            // speaker page needs this and must NOT need `GET /api/meetings/:id`
            // to get it: that returns the transcript, chat and memories, and
            // the page is reachable from the public edge.
            meeting: {
              title: meeting.title,
              agentDisplayName: meeting.agentDisplayName,
            },
            agent: gateway.snapshot(meetingId),
          }),
        );
        socket.on("close", unsubscribe);
        socket.on("error", unsubscribe);
      },
    );
  });

  // ---- static UI --------------------------------------------------------
  //
  // Served by hand rather than through a plugin: three files, an extension
  // allowlist, and a resolved-path check that a request cannot escape.

  app.get("/*", async (request, reply) => {
    const requested = (request.params as { "*": string })["*"];
    const relative = requested === "" ? "index.html" : requested;
    const target = resolve(join(PUBLIC_DIR, normalize(relative)));
    if (!target.startsWith(PUBLIC_DIR)) {
      return reply.status(404).send({
        error: { code: "not_found", message: "Not found." },
      });
    }
    const contentType = CONTENT_TYPES[extname(target)];
    if (contentType === undefined) {
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "Not found." } });
    }
    try {
      if (!statSync(target).isFile()) throw new Error("not a file");
      return reply
        .header("content-type", contentType)
        .header("cache-control", "no-store")
        .send(readFileSync(target));
    } catch {
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "Not found." } });
    }
  });

  return app;
}

export { loadAgentRegistry };
