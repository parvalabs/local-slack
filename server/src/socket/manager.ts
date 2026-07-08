import type { ServerWebSocket } from "bun";
import type { Store } from "../state/store.ts";

export type SocketData = { kind: "socket"; connId: string } | { kind: "ui" };

export type EnvelopeType = "events_api" | "slash_commands" | "interactive";

interface Pending {
  resolve: (payload: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks Socket Mode WebSocket connections — one bucket per app, since each
 * configured app opens its own connection(s) after calling apps.connections.open —
 * and delivers envelopes to the right app's bucket, Slack Socket Mode style.
 */
export class SocketManager {
  private connIdToApp = new Map<string, string>();
  private connsByApp = new Map<string, Set<ServerWebSocket<SocketData>>>();
  private wsToApp = new Map<ServerWebSocket<SocketData>, string>();
  private pending = new Map<string, Pending>();

  constructor(private store: Store) {}

  /** A connId from apps.connections.open is good for exactly one connection,
   *  matching real Socket Mode (each call mints a URL for one new connection). */
  registerConn(connId: string, appId: string) {
    this.connIdToApp.set(connId, appId);
  }

  connectedFor(appId: string): boolean {
    return (this.connsByApp.get(appId)?.size ?? 0) > 0;
  }

  /** Attaches the connection to its app's bucket. Returns false for an unknown/expired
   *  connId, in which case the caller should close the socket immediately. */
  add(ws: ServerWebSocket<SocketData>, connId: string): boolean {
    const appId = this.connIdToApp.get(connId);
    if (!appId) return false;
    this.connIdToApp.delete(connId);
    this.wsToApp.set(ws, appId);

    let set = this.connsByApp.get(appId);
    if (!set) {
      set = new Set();
      this.connsByApp.set(appId, set);
    }
    set.add(ws);

    ws.send(
      JSON.stringify({
        type: "hello",
        num_connections: set.size,
        connection_info: { app_id: appId },
        debug_info: { host: "local-slack", started: new Date().toISOString() },
      }),
    );
    this.store.addLog("to_bot", "socket", `socket connected (hello) [${appId}]`);
    this.store.emit("socket_status", { appId, connected: true });
    return true;
  }

  remove(ws: ServerWebSocket<SocketData>) {
    const appId = this.wsToApp.get(ws);
    if (!appId) return;
    this.wsToApp.delete(ws);
    this.connsByApp.get(appId)?.delete(ws);
    this.store.emit("socket_status", { appId, connected: this.connectedFor(appId) });
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
   * Send an envelope to the given app's connected bot and resolve with the ack
   * payload (or undefined on timeout / no connection for that app).
   */
  send(appId: string, type: EnvelopeType, payload: unknown): Promise<unknown> {
    const conns = this.connsByApp.get(appId);
    if (!conns || conns.size === 0) {
      this.store.addLog(
        "internal",
        "socket",
        `no socket connection for ${appId}; dropped ${type} envelope`,
      );
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
    for (const ws of conns) ws.send(body);
    this.store.addLog("to_bot", type, `envelope ${type} [${appId}]`, payload);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelopeId);
        resolve(undefined);
      }, 5000);
      this.pending.set(envelopeId, { resolve, timer });
    });
  }
}
