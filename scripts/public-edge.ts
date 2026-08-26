/**
 * The only part of this prototype that should ever face the internet.
 *
 * Recall runs in its own infrastructure, so it has to reach this machine: it
 * POSTs transcript webhooks, and its browser loads the speaker page and
 * fetches synthesized audio. The obvious way to arrange that — point a tunnel
 * at the app — publishes ALL of it, and this app has no authentication and a
 * route that launches a coding agent on the host with a caller-supplied
 * working directory. A tunnel straight to `AMP_PORT` is therefore a remote
 * process-launcher with a four-word URL.
 *
 * So the tunnel points here instead. This forwards a fixed allowlist of paths
 * and answers everything else with 404 and no detail. Two rules:
 *
 *   1. Only the paths Recall genuinely needs, matched exactly.
 *   2. Every one of them must carry the shared secret, compared in constant
 *      time. The app checks it again on the routes that care; this is the
 *      outer wall, not the only one. `/ws` and `/speaker.html` have no
 *      authentication of their own at all, so here is where they get it.
 *
 * Run it beside the app and tunnel THIS port:
 *
 *   npm run edge                     # 127.0.0.1:4322 by default
 *   cloudflared tunnel --url http://127.0.0.1:4322
 *
 * It is a developer convenience with a security purpose, not a production
 * gateway. It terminates nothing, rewrites nothing, and holds no state.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { env, exit } from "node:process";

const EDGE_PORT = Number(env["AMP_EDGE_PORT"] ?? 4322);
const APP_HOST = env["AMP_HOST"] ?? "127.0.0.1";
const APP_PORT = Number(env["AMP_PORT"] ?? 4321);
const SECRET = env["AMP_RECALL_WEBHOOK_SECRET"] ?? "";

if (SECRET === "") {
  console.error(
    "AMP_RECALL_WEBHOOK_SECRET is not set. The edge refuses to start without\n" +
      "it: with no secret every allowlisted path would be open to anyone who\n" +
      "finds the tunnel URL, which is the situation this exists to prevent.",
  );
  exit(1);
}

/**
 * What Recall actually needs, and nothing else.
 *
 * Deliberately NOT here: `GET /api/meetings/:id`, which returns the whole
 * meeting — transcript, chat and memories. The speaker page reads its title
 * from the realtime feed instead, so publishing the room's contents to anyone
 * holding the URL buys nothing.
 */
const ALLOWED: { method: string; pattern: RegExp; why: string }[] = [
  {
    method: "GET",
    pattern: /^\/speaker\.html$/u,
    why: "the page Recall streams into the call",
  },
  {
    method: "POST",
    pattern: /^\/api\/meetings\/[A-Za-z0-9_-]{1,64}\/tts$/u,
    why: "audio for that page, synthesized here",
  },
  {
    method: "POST",
    pattern: /^\/api\/providers\/recall\/[A-Za-z0-9_-]{1,64}$/u,
    why: "the transcript webhook",
  },
];

/** The realtime feed the speaker page listens on. Upgrade, not a plain GET. */
const WS_PATH = /^\/ws$/u;

function secretOk(offered: string): boolean {
  const a = Buffer.from(SECRET);
  const b = Buffer.from(offered);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Uninformative on purpose: a caller who fails has nothing to learn here. */
function deny(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "not_found" } }));
}

function parse(url: string | undefined): URL | null {
  try {
    return new URL(url ?? "/", "http://placeholder.invalid");
  } catch {
    return null;
  }
}

const server = createServer((incoming: IncomingMessage, response) => {
  const parsed = parse(incoming.url);
  if (parsed === null) return deny(response);

  const method = incoming.method ?? "GET";
  const route = ALLOWED.find(
    (candidate) =>
      candidate.method === method && candidate.pattern.test(parsed.pathname),
  );
  if (route === undefined) {
    console.warn(`[edge] refused ${method} ${parsed.pathname}`);
    return deny(response);
  }
  if (!secretOk(parsed.searchParams.get("secret") ?? "")) {
    console.warn(`[edge] refused ${method} ${parsed.pathname} — bad secret`);
    return deny(response);
  }

  const upstream = httpRequest(
    {
      host: APP_HOST,
      port: APP_PORT,
      method,
      path: incoming.url,
      headers: { ...incoming.headers, host: `${APP_HOST}:${String(APP_PORT)}` },
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "upstream_unreachable" } }));
  });
  incoming.pipe(upstream);
});

// The speaker page's realtime feed. `/ws` has no authentication of its own —
// a meeting id is enough to read a room — so the secret is required here and
// the raw socket is piped only after it checks out.
server.on("upgrade", (incoming, socket) => {
  const parsed = parse(incoming.url);
  const refuse = () => {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  };
  if (parsed === null || !WS_PATH.test(parsed.pathname)) return refuse();
  if (!secretOk(parsed.searchParams.get("secret") ?? "")) {
    console.warn("[edge] refused websocket — bad secret");
    return refuse();
  }

  const upstream = connect(APP_PORT, APP_HOST, () => {
    const head = [
      `GET ${incoming.url ?? "/ws"} HTTP/1.1`,
      ...Object.entries(incoming.headers).map(
        ([key, value]) => `${key}: ${String(value)}`,
      ),
      "\r\n",
    ].join("\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(EDGE_PORT, "127.0.0.1", () => {
  console.log(
    `\n▸ amp public edge on http://127.0.0.1:${String(EDGE_PORT)} → ${APP_HOST}:${String(APP_PORT)}\n`,
  );
  console.log("  Tunnel THIS port, never the app's. Forwarding only:\n");
  for (const route of ALLOWED) {
    console.log(
      `    ${route.method.padEnd(4)} ${String(route.pattern.source).padEnd(48)} ${route.why}`,
    );
  }
  console.log(`    GET  /ws (upgrade)${" ".repeat(35)}the realtime feed\n`);
  console.log("  Every one of them must carry the shared secret.\n");
});
