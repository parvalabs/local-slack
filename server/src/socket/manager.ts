import type { ServerWebSocket } from "bun";
import type { Store } from "../state/store.ts";

export type SocketData = { kind: "socket"; connId: string } | { kind: "ui" };

export type EnvelopeType = "events_api" | "slash_commands" | "interactive";

interface Pending {
  resolve: (payload: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks Socket Mode WebSocket connections (the bot opens one after calling
 * apps.connections.open) and delivers envelopes to them, Slack Socket Mode style.
 */
export class SocketManager {
  private conns = new Set<ServerWebSocket<SocketData>>();
  private pending = new Map<string, Pending>();

  constructor(private store: Store) {}

  get connected(): boolean {
    return this.conns.size > 0;
  }

  add(ws: ServerWebSocket<SocketData>) {
    this.conns.add(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        num_connections: this.conns.size,
        connection_info: { app_id: this.store.config.app.appId },
        debug_info: { host: "local-slack", started: new Date().toISOString() },
      }),
    );
    this.store.addLog("to_bot", "socket", "socket connected (hello)");
    this.store.emit("socket_status", true);
  }

  remove(ws: ServerWebSocket<SocketData>) {
    this.conns.delete(ws);
    this.store.emit("socket_status", this.connected);
  }

  /** Handle an inbound frame from the bot — acks carry an envelope_id. */
  onMessage(_ws: ServerWebSocket<SocketData>, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.envelope_id && this.pending.has(msg.envelope_id)) {
      const p = this.pending.get(msg.envelope_id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.envelope_id);
      p.resolve(msg.payload);
      this.store.addLog("from_bot", "ack", `ack ${msg.envelope_id}`, msg.payload);
    }
  }

  /**
   * Send an envelope to the connected bot and resolve with the ack payload
   * (or undefined on timeout / no connection).
   */
  send(type: EnvelopeType, payload: unknown): Promise<unknown> {
    if (this.conns.size === 0) {
      this.store.addLog("internal", "socket", `no socket connection; dropped ${type} envelope`);
      return Promise.resolve(undefined);
    }
    const envelopeId = crypto.randomUUID();
    const envelope = {
      envelope_id: envelopeId,
      type,
      payload,
      accepts_response_payload: type !== "events_api",
    };
    const body = JSON.stringify(envelope);
    for (const ws of this.conns) ws.send(body);
    this.store.addLog("to_bot", type, `envelope ${type}`, payload);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelopeId);
        resolve(undefined);
      }, 5000);
      this.pending.set(envelopeId, { resolve, timer });
    });
  }
}
