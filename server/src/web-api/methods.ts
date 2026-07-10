import { nextTs, type Store } from "../state/store.ts";
import type { AppConfig } from "../config/schema.ts";
import type { BotGateway } from "../gateway/bot.ts";
import type { SocketManager } from "../socket/manager.ts";
import type { SlackMessage } from "../types.ts";
import { resolveChannelId } from "../actions.ts";
import { botId, formatUser, formatChannel } from "./format.ts";
import type { Interactions } from "../interactions.ts";

export interface MethodContext {
  store: Store;
  app: AppConfig; // the app this call is authenticated as (resolved from its token)
  gateway: BotGateway;
  socket: SocketManager;
  interactions: Interactions;
}

type Handler = (args: Record<string, any>, ctx: MethodContext) => any | Promise<any>;

const ok = (extra: Record<string, any> = {}) => ({ ok: true, ...extra });
const err = (error: string, extra: Record<string, any> = {}) => ({ ok: false, error, ...extra });

/**
 * Adds Slack's thread-summary fields (reply_count, reply_users_count, latest_reply,
 * thread_ts) to root messages that have replies — computed on read, like real Slack,
 * rather than tracked incrementally on the stored message.
 */
function withThreadMeta(store: Store, channel: string, messages: SlackMessage[]): SlackMessage[] {
  return messages.map((m) => {
    if (m.thread_ts) return m; // already a reply
    const replies = store.channelMessages(channel).filter((r) => r.thread_ts === m.ts);
    if (!replies.length) return m;
    const users = [...new Set(replies.map((r) => r.user).filter(Boolean))];
    return {
      ...m,
      thread_ts: m.ts,
      reply_count: replies.length,
      reply_users_count: users.length,
      reply_users: users,
      latest_reply: replies.at(-1)!.ts,
    } as SlackMessage;
  });
}

/** Build a message object for a bot-posted message (chat.postMessage / update / ephemeral). */
function buildBotMessage(app: AppConfig, args: Record<string, any>, ts: string, channel: string): SlackMessage {
  return {
    type: "message",
    ts,
    channel,
    user: app.botUserId,
    bot_id: botId(app),
    app_id: app.appId,
    username: args.username,
    text: args.text ?? "",
    ...(args.blocks ? { blocks: args.blocks } : {}),
    ...(args.attachments ? { attachments: args.attachments } : {}),
    ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
  };
}

export const methods: Record<string, Handler> = {
  // ---- identity / boot ----------------------------------------------------
  "auth.test": (_args, { store, app }) =>
    ok({
      url: `http://${store.config.workspace.domain}.slack.local/`,
      team: store.config.workspace.name,
      team_id: store.config.workspace.teamId,
      user: app.botName,
      user_id: app.botUserId,
      bot_id: botId(app),
      is_enterprise_install: false,
    }),

  "apps.connections.open": (_args, { store, app, socket }) => {
    const connId = store.newId("conn").toLowerCase();
    socket.registerConn(connId, app.appId);
    const wsBase = store.runtime.wsBase || "ws://localhost:3000";
    return ok({ url: `${wsBase}/socket/${connId}` });
  },

  "team.info": (_args, { store }) =>
    ok({
      team: {
        id: store.config.workspace.teamId,
        name: store.config.workspace.name,
        domain: store.config.workspace.domain,
      },
    }),

  "bots.info": (_args, { app }) =>
    ok({
      bot: {
        id: botId(app),
        deleted: false,
        name: app.botName,
        app_id: app.appId,
        user_id: app.botUserId,
      },
    }),

  // ---- messaging ----------------------------------------------------------
  "chat.postMessage": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    if (!store.channels.has(channel)) return err("channel_not_found");
    const ts = nextTs();
    const message = buildBotMessage(app, args, ts, channel);
    store.addMessage(message);
    return ok({ channel, ts, message });
  },

  "chat.update": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    const patch: Partial<SlackMessage> = {
      text: args.text,
      blocks: args.blocks,
      edited: { user: app.botUserId, ts: nextTs() },
    };
    const updated = store.updateMessage(channel, args.ts, patch);
    if (!updated) return err("message_not_found");
    return ok({ channel, ts: args.ts, text: updated.text, message: updated });
  },

  "chat.delete": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    if (!store.deleteMessage(channel, args.ts)) return err("message_not_found");
    return ok({ channel, ts: args.ts });
  },

  "chat.postEphemeral": (args, { store, app }) => {
    // Rendered like a normal message in the UI, tagged ephemeral + target user.
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    const ts = nextTs();
    const message = buildBotMessage(app, args, ts, channel);
    message.subtype = "ephemeral";
    (message as any).ephemeral_to = args.user;
    store.addMessage(message);
    return ok({ message_ts: ts });
  },

  "chat.meMessage": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    const ts = nextTs();
    const message = buildBotMessage(app, { text: args.text }, ts, channel);
    message.subtype = "me_message";
    store.addMessage(message);
    return ok({ channel, ts });
  },

  // ---- conversations ------------------------------------------------------
  "conversations.list": (args, { store }) => {
    const types = String(args.types ?? "public_channel,private_channel").split(",");
    const wantIm = types.includes("im");
    const channels = [...store.channels.values()]
      .filter((c) => (c.is_im ? wantIm : true))
      .map(formatChannel);
    return ok({ channels, response_metadata: { next_cursor: "" } });
  },

  "conversations.info": (args, { store, app }) => {
    const c = store.channels.get(resolveChannelId(store, args.channel, app.botUserId));
    if (!c) return err("channel_not_found");
    return ok({ channel: formatChannel(c) });
  },

  "conversations.history": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    const messages = withThreadMeta(
      store,
      channel,
      store.channelMessages(channel).filter((m) => !m.thread_ts),
    )
      .slice()
      .reverse();
    return ok({ messages, has_more: false, response_metadata: { next_cursor: "" } });
  },

  "conversations.replies": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    const messages = withThreadMeta(
      store,
      channel,
      store.channelMessages(channel).filter((m) => m.ts === args.ts || m.thread_ts === args.ts),
    );
    return ok({ messages, has_more: false });
  },

  "conversations.members": (args, { store, app }) => {
    const c = store.channels.get(resolveChannelId(store, args.channel, app.botUserId));
    if (!c) return err("channel_not_found");
    return ok({ members: c.members, response_metadata: { next_cursor: "" } });
  },

  "conversations.open": (args, { store, app }) => {
    const userRef: string = args.users ?? args.user ?? "";
    const userId = String(userRef).split(",")[0];
    const channel = store.openDm(userId, app.botUserId);
    return ok({ channel: { id: channel.id } });
  },

  "conversations.create": (args, { store }) => {
    const channel = store.createChannel(args.name, !!args.is_private);
    return ok({ channel: formatChannel(channel) });
  },

  // ---- users --------------------------------------------------------------
  "users.list": (_args, { store }) =>
    ok({
      members: store.allUsers().map((u) => formatUser(store, u)),
      response_metadata: { next_cursor: "" },
    }),

  "users.info": (args, { store }) => {
    const u = store.allUsers().find((x) => x.id === args.user);
    if (!u) return err("user_not_found");
    return ok({ user: formatUser(store, u) });
  },

  "users.lookupByEmail": (args, { store }) => {
    const u = store.allUsers().find((x) => x.email && x.email === args.email);
    if (!u) return err("users_not_found");
    return ok({ user: formatUser(store, u) });
  },

  "users.conversations": (_args, { store, app }) => {
    const channels = [...store.channels.values()]
      .filter((c) => c.members.includes(app.botUserId))
      .map(formatChannel);
    return ok({ channels, response_metadata: { next_cursor: "" } });
  },

  // ---- views (modals + App Home) -----------------------------------------
  "views.open": (args, { store, app, interactions }) => {
    if (!interactions.consumeTrigger(args.trigger_id)) return err("invalid_trigger_id");
    const view = interactions.instantiateView(app, args.view);
    store.setRootView(view);
    return ok({ view });
  },

  "views.push": (args, { store, app, interactions }) => {
    if (!interactions.consumeTrigger(args.trigger_id)) return err("invalid_trigger_id");
    const view = interactions.instantiateView(app, args.view, {
      previous_view_id: store.modalStack.at(-1)?.id ?? null,
      root_view_id: store.modalStack[0]?.id ?? null,
    });
    store.pushView(view);
    return ok({ view });
  },

  "views.update": (args, { store, app, interactions }) => {
    const view = interactions.instantiateView(app, args.view, {
      root_view_id: store.modalStack[0]?.id ?? null,
    });
    store.updateView(args.view_id ?? args.external_id, view);
    return ok({ view });
  },

  "views.publish": (args, { app, store, interactions }) => {
    const view = interactions.instantiateView(app, args.view);
    store.publishHome(args.user_id, app.appId, view);
    return ok({ view });
  },

  // ---- reactions ----------------------------------------------------------
  "reactions.add": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    if (!store.findMessage(channel, args.timestamp)) return err("message_not_found");
    store.setReaction(channel, args.timestamp, args.name, app.botUserId, true);
    return ok();
  },

  "reactions.remove": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    if (!store.findMessage(channel, args.timestamp)) return err("message_not_found");
    store.setReaction(channel, args.timestamp, args.name, app.botUserId, false);
    return ok();
  },

  // ---- emoji ----------------------------------------------------------
  "emoji.list": (_args, { store }) =>
    ok({
      emoji: Object.fromEntries(
        Object.keys(store.config.emojis).map((name) => [
          name,
          `${store.runtime.httpBase}/emoji/${encodeURIComponent(name)}`,
        ]),
      ),
    }),
};
