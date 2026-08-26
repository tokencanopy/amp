/**
 * The realtime fan-out to browsers.
 *
 * One socket per open meeting view, subscribed by meeting id. Events are
 * fire-and-forget: a browser that missed something reloads and re-reads the
 * meeting from the database, which is the whole reason the transcript is
 * persisted rather than held in memory.
 */
import type { WebSocket } from "ws";

import type { GatewayEvent } from "../gateway/gateway.js";

export class RealtimeHub {
  readonly #sockets = new Map<string, Set<WebSocket>>();

  subscribe(meetingId: string, socket: WebSocket): () => void {
    let sockets = this.#sockets.get(meetingId);
    if (sockets === undefined) {
      sockets = new Set();
      this.#sockets.set(meetingId, sockets);
    }
    sockets.add(socket);
    return () => {
      sockets?.delete(socket);
      if (sockets?.size === 0) this.#sockets.delete(meetingId);
    };
  }

  publish(meetingId: string, event: GatewayEvent): void {
    const sockets = this.#sockets.get(meetingId);
    if (sockets === undefined) return;
    const payload = JSON.stringify({ meetingId, ...event });
    for (const socket of sockets) {
      // readyState 1 is OPEN; anything else is a socket mid-teardown.
      if (socket.readyState === 1) {
        try {
          socket.send(payload);
        } catch {
          sockets.delete(socket);
        }
      }
    }
  }

  count(meetingId: string): number {
    return this.#sockets.get(meetingId)?.size ?? 0;
  }

  closeAll(): void {
    for (const sockets of this.#sockets.values()) {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // Already gone.
        }
      }
    }
    this.#sockets.clear();
  }
}
