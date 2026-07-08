import type { ServerWebSocket } from "bun";
import type { Store } from "../state/store.ts";
import type { BotGateway } from "./bot.ts";
import type { SocketData } from "../socket/manager.ts";
import type { SocketManager } from "../socket/manager.ts";
import type { Interactions } from "../interactions.ts";
import {
  userPostMessage,
  userBlockAction,
  userViewSubmit,
  userViewClose,
  userSlashCommand,
  openAppHome,
} from "../actions.ts";

/**
 * Bridges the browser UI to the store over a WebSocket:
 *  - pushes an initial snapshot + live store events to the UI
 *  - handles UI-originated actions (a human posting as a workspace user)
 */
export class UiGateway {
  private conns = new Set<ServerWebSocket<SocketData>>();

  constructor(
    private store: Store,
    private gateway: BotGateway,
    private socket: SocketManager,
    private interactions: Interactions,
  ) {
    const fwd = (t: string, extra: Record<string, unknown>) => this.broadcast({ t, ...extra });
    store.on("message", (m) => fwd("message", { message: m }));
    store.on("message_update", (m) => fwd("message_update", { message: m }));
    store.on("message_delete", (d) => fwd("message_delete", d as Record<string, unknown>));
    store.on("channel", (c) => fwd("channel", { channel: c }));
    store.on("log", (e) => fwd("log", { entry: e }));
    store.on("view", (v) => fwd("view", v as Record<string, unknown>));
    store.on("view_errors", (e) => fwd("view_errors", e as Record<string, unknown>));
    store.on("home", (h) => fwd("home", h as Record<string, unknown>));
    store.on("socket_status", (connected) => fwd("socket_status", { connected }));
    store.on("reset", () => this.broadcast({ t: "init", state: this.snapshot() }));
  }

  add(ws: ServerWebSocket<SocketData>) {
    this.conns.add(ws);
    ws.send(JSON.stringify({ t: "init", state: this.snapshot() }));
  }

  remove(ws: ServerWebSocket<SocketData>) {
    this.conns.delete(ws);
  }

  private broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of this.conns) ws.send(s);
  }

  private snapshot() {
    return {
      workspace: this.store.config.workspace,
      app: {
        appId: this.store.config.app.appId,
        botUserId: this.store.botUserId,
        botName: this.store.config.app.botName,
        mode: this.store.config.app.mode,
      },
      users: this.store.allUsers(),
      channels: [...this.store.channels.values()],
      messages: Object.fromEntries(this.store.messages.entries()),
      modalStack: this.store.modalStack,
      homeViews: Object.fromEntries(this.store.homeViews.entries()),
      log: this.store.log,
      socketConnected: this.socket.connected,
    };
  }

  async onMessage(_ws: ServerWebSocket<SocketData>, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case "post_message":
        await userPostMessage(this.store, this.gateway, {
          channel: msg.channel,
          user: msg.user,
          text: msg.text,
          thread_ts: msg.thread_ts,
        });
        break;
      case "block_action":
        await userBlockAction(this.store, this.gateway, this.interactions, {
          channel: msg.channel,
          messageTs: msg.messageTs,
          user: msg.user,
          action: msg.action,
        });
        break;
      case "view_submit":
        await userViewSubmit(this.store, this.gateway, this.interactions, {
          user: msg.user,
          values: msg.values,
        });
        break;
      case "view_close":
        await userViewClose(this.store, this.gateway, this.interactions, { user: msg.user });
        break;
      case "slash_command":
        await userSlashCommand(this.store, this.gateway, this.interactions, {
          user: msg.user,
          channel: msg.channel,
          command: msg.command,
          text: msg.text,
        });
        break;
      case "open_home":
        await openAppHome(this.store, this.gateway, { user: msg.user });
        break;
    }
  }
}
