import { EventEmitter } from "node:events";
import type { Config, UserConfig, ChannelConfig, AppConfig } from "../config/schema.ts";
import type { LogEntry, LogDirection, SlackMessage } from "../types.ts";

let tsSeq = 0;
/** Slack-style message timestamp: `seconds.microseconds`, monotonic within a run. */
export function nextTs(): string {
  const seconds = Math.floor(Date.now() / 1000);
  tsSeq = (tsSeq + 1) % 1_000_000;
  return `${seconds}.${tsSeq.toString().padStart(6, "0")}`;
}

let idSeq = 0;
function shortId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${idSeq}`;
}

/**
 * Single source of truth for the mock workspace. Both the Slack-facing surfaces
 * (Web API, Socket Mode, Events API) and the browser UI read/write this and
 * subscribe to its events.
 *
 * Events emitted:
 *   "message"      (msg)            — a message was added
 *   "message_update" (msg)          — a message was edited
 *   "message_delete" ({channel,ts}) — a message was removed
 *   "log"          (LogEntry)       — traffic to/from the bot (for the Inspector)
 *   "view"         ({action,view})  — modal opened/updated/pushed/closed (M2)
 *   "home"         ({user,view})    — App Home published (M3)
 */
export class Store extends EventEmitter {
  readonly config: Config;
  readonly users = new Map<string, UserConfig>();
  readonly channels = new Map<string, ChannelConfig>();
  readonly messages = new Map<string, SlackMessage[]>(); // channelId -> messages
  readonly homeViews = new Map<string, Map<string, any>>(); // userId -> appId -> published home view
  readonly log: LogEntry[] = [];

  /** The active modal stack (top = currently shown). Slack shows one modal stack per user;
   *  the mock has a single human "actor" at a time so one stack is enough. */
  modalStack: any[] = [];

  /** Filled in once the server is listening (used to build the Socket Mode URL). */
  runtime: { httpBase: string; wsBase: string } = { httpBase: "", wsBase: "" };

  constructor(config: Config) {
    super();
    this.setMaxListeners(0);
    this.config = config;
    for (const u of config.users) this.users.set(u.id, u);
    for (const c of config.channels) {
      this.channels.set(c.id, c);
      this.messages.set(c.id, []);
    }
  }

  /** The first configured app — the sensible default for actions that need "a" bot
   *  identity but no other context to pick from (DM/channel creation fallback, the
   *  CLI banner, the UI's default "as app" selection for slash commands / Home tab). */
  primaryApp(): AppConfig {
    return this.config.apps[0];
  }

  /** @deprecated single-app leftover — prefer resolving a specific AppConfig. Kept for
   *  the handful of call sites that only need *a* bot identity, not a specific one. */
  get botUserId(): string {
    return this.primaryApp().botUserId;
  }

  appById(appId: string): AppConfig | undefined {
    return this.config.apps.find((a) => a.appId === appId);
  }

  /** Resolve the app a Bearer token belongs to (matches either its bot or app-level
   *  token), falling back to the primary app — this mock doesn't hard-enforce auth. */
  appByToken(token: string | undefined): AppConfig {
    return (
      (token && this.config.apps.find((a) => a.botToken === token || a.appToken === token)) ||
      this.primaryApp()
    );
  }

  /** The bot's own user record for a given app (not part of config.users, synthesized
   *  from its app config). */
  botUser(app: AppConfig): UserConfig {
    return {
      id: app.botUserId,
      name: app.botName,
      real_name: app.botName,
      is_bot: true,
      tz: "America/Los_Angeles",
    };
  }

  allBotUsers(): UserConfig[] {
    return this.config.apps.map((a) => this.botUser(a));
  }

  /** All users including every configured app's bot, for users.list / the UI snapshot. */
  allUsers(): UserConfig[] {
    return [...this.allBotUsers(), ...this.users.values()];
  }

  /** Every configured app whose bot is a member of the given channel — the set of
   *  apps that should receive Events API traffic (messages/reactions/edits) for it. */
  appsInChannel(channelId: string): AppConfig[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    return this.config.apps.filter((a) => channel.members.includes(a.botUserId));
  }

  channelMessages(channelId: string): SlackMessage[] {
    return this.messages.get(channelId) ?? [];
  }

  addMessage(msg: SlackMessage): SlackMessage {
    const list = this.messages.get(msg.channel);
    if (!list) {
      // Unknown channel (e.g. a freshly opened DM) — create it lazily.
      this.messages.set(msg.channel, [msg]);
    } else {
      list.push(msg);
    }
    this.emit("message", msg);
    return msg;
  }

  findMessage(channel: string, ts: string): SlackMessage | undefined {
    return this.messages.get(channel)?.find((m) => m.ts === ts);
  }

  updateMessage(channel: string, ts: string, patch: Partial<SlackMessage>): SlackMessage | undefined {
    const msg = this.findMessage(channel, ts);
    if (!msg) return undefined;
    Object.assign(msg, patch);
    this.emit("message_update", msg);
    return msg;
  }

  deleteMessage(channel: string, ts: string): boolean {
    const list = this.messages.get(channel);
    if (!list) return false;
    const idx = list.findIndex((m) => m.ts === ts);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.emit("message_delete", { channel, ts });
    return true;
  }

  /** Add or remove a single user's reaction on a message. Used by both the bot's
   *  reactions.add/remove (Web API) and human reactions from the UI/control API. */
  setReaction(
    channel: string,
    ts: string,
    name: string,
    userId: string,
    present: boolean,
  ): SlackMessage | undefined {
    const msg = this.findMessage(channel, ts);
    if (!msg) return undefined;
    msg.reactions ??= [];
    let r = msg.reactions.find((x) => x.name === name);
    if (present) {
      if (!r) {
        r = { name, users: [], count: 0 };
        msg.reactions.push(r);
      }
      if (!r.users.includes(userId)) {
        r.users.push(userId);
        r.count = r.users.length;
      }
    } else if (r) {
      r.users = r.users.filter((u) => u !== userId);
      r.count = r.users.length;
      if (r.count === 0) msg.reactions = msg.reactions.filter((x) => x.name !== name);
    }
    this.emit("message_update", msg);
    return msg;
  }

  /** Find or create a direct-message channel between a user and a specific bot. */
  openDm(userId: string, botUserId: string): ChannelConfig {
    for (const c of this.channels.values()) {
      if (c.is_im && c.members.includes(userId) && c.members.includes(botUserId)) return c;
    }
    const channel: ChannelConfig = {
      id: shortId("D"),
      name: `dm-${userId}`,
      is_channel: false,
      is_private: true,
      is_im: true,
      topic: "",
      purpose: "",
      members: [userId, botUserId],
    };
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    this.emit("channel", channel);
    return channel;
  }

  /** New channels are visible to every configured bot — this mock doesn't model
   *  per-channel app invites/joins. */
  createChannel(name: string, isPrivate = false): ChannelConfig {
    const channel: ChannelConfig = {
      id: shortId(isPrivate ? "G" : "C"),
      name,
      is_channel: true,
      is_private: isPrivate,
      is_im: false,
      topic: "",
      purpose: "",
      members: this.config.apps.map((a) => a.botUserId),
    };
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    this.emit("channel", channel);
    return channel;
  }

  // ---- modal stack --------------------------------------------------------
  private emitViews() {
    this.emit("view", { stack: this.modalStack });
  }

  setRootView(view: any) {
    this.modalStack = [view];
    this.emitViews();
  }

  pushView(view: any) {
    this.modalStack.push(view);
    this.emitViews();
  }

  updateView(idOrExternal: string | undefined, view: any) {
    if (!idOrExternal) {
      // No id: update the top view.
      if (this.modalStack.length) this.modalStack[this.modalStack.length - 1] = view;
    } else {
      const idx = this.modalStack.findIndex(
        (v) => v.id === idOrExternal || v.external_id === idOrExternal,
      );
      if (idx !== -1) this.modalStack[idx] = view;
      else if (this.modalStack.length) this.modalStack[this.modalStack.length - 1] = view;
    }
    this.emitViews();
  }

  popView() {
    this.modalStack.pop();
    this.emitViews();
  }

  clearViews() {
    this.modalStack = [];
    this.emitViews();
  }

  publishHome(userId: string, appId: string, view: any) {
    let byApp = this.homeViews.get(userId);
    if (!byApp) {
      byApp = new Map();
      this.homeViews.set(userId, byApp);
    }
    byApp.set(appId, view);
    this.emit("home", { user: userId, appId, view });
  }

  /** All of a user's published Home views, keyed by appId — for the UI snapshot. */
  homeViewsFor(userId: string): Record<string, any> {
    return Object.fromEntries(this.homeViews.get(userId) ?? []);
  }

  /** Restore the workspace to its config baseline: clear messages, log, modals,
   *  home views and any dynamically-created channels (DMs). */
  reset() {
    this.messages.clear();
    this.channels.clear();
    this.homeViews.clear();
    this.modalStack = [];
    this.log.length = 0;
    for (const c of this.config.channels) {
      this.channels.set(c.id, c);
      this.messages.set(c.id, []);
    }
    this.emit("reset");
  }

  addLog(direction: LogDirection, kind: string, summary: string, detail?: unknown): LogEntry {
    const entry: LogEntry = {
      id: shortId("L"),
      time: Date.now(),
      direction,
      kind,
      summary,
      detail,
    };
    this.log.push(entry);
    if (this.log.length > 1000) this.log.shift();
    this.emit("log", entry);
    return entry;
  }

  newId = shortId;
}
