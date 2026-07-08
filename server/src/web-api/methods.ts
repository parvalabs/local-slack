import { nextTs, type Store } from "../state/store.ts";
import type { BotGateway } from "../gateway/bot.ts";
import type { SlackMessage } from "../types.ts";
import { resolveChannelId } from "../actions.ts";
import { botId, formatUser, formatChannel } from "./format.ts";
import type { Interactions } from "../interactions.ts";

export interface MethodContext {
  store: Store;
  gateway: BotGateway;
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
function buildBotMessage(store: Store, args: Record<string, any>, ts: string, channel: string): SlackMessage {
  return {
    type: "message",
    ts,
    channel,
    user: store.botUserId,
    bot_id: botId(store),
    app_id: store.config.app.appId,
    username: args.username,
    text: args.text ?? "",
    ...(args.blocks ? { blocks: args.blocks } : {}),
    ...(args.attachments ? { attachments: args.attachments } : {}),
    ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
  };
}

export const methods: Record<string, Handler> = {
  // ---- identity / boot ----------------------------------------------------
  "auth.test": (_args, { store }) =>
    ok({
      url: `http://${store.config.workspace.domain}.slack.local/`,
      team: store.config.workspace.name,
      team_id: store.config.workspace.teamId,
      user: store.config.app.botName,
      user_id: store.botUserId,
      bot_id: botId(store),
      is_enterprise_install: false,
    }),

  "apps.connections.open": (_args, { store }) => {
    const connId = store.newId("conn").toLowerCase();
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

  "bots.info": (_args, { store }) =>
    ok({
      bot: {
        id: botId(store),
        deleted: false,
        name: store.config.app.botName,
        app_id: store.config.app.appId,
        user_id: store.botUserId,
      },
    }),

  // ---- messaging ----------------------------------------------------------
  "chat.postMessage": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    if (!store.channels.has(channel)) return err("channel_not_found");
    const ts = nextTs();
    const message = buildBotMessage(store, args, ts, channel);
    store.addMessage(message);
    return ok({ channel, ts, message });
  },

  "chat.update": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const patch: Partial<SlackMessage> = {
      text: args.text,
      blocks: args.blocks,
      edited: { user: store.botUserId, ts: nextTs() },
    };
    const updated = store.updateMessage(channel, args.ts, patch);
    if (!updated) return err("message_not_found");
    return ok({ channel, ts: args.ts, text: updated.text, message: updated });
  },

  "chat.delete": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    if (!store.deleteMessage(channel, args.ts)) return err("message_not_found");
    return ok({ channel, ts: args.ts });
  },

  "chat.postEphemeral": (args, { store }) => {
    // Rendered like a normal message in the UI, tagged ephemeral + target user.
    const channel = resolveChannelId(store, args.channel);
    const ts = nextTs();
    const message = buildBotMessage(store, args, ts, channel);
    message.subtype = "ephemeral";
    (message as any).ephemeral_to = args.user;
    store.addMessage(message);
    return ok({ message_ts: ts });
  },

  "chat.meMessage": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const ts = nextTs();
    const message = buildBotMessage(store, { text: args.text }, ts, channel);
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

  "conversations.info": (args, { store }) => {
    const c = store.channels.get(resolveChannelId(store, args.channel));
    if (!c) return err("channel_not_found");
    return ok({ channel: formatChannel(c) });
  },

  "conversations.history": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const messages = withThreadMeta(
      store,
      channel,
      store.channelMessages(channel).filter((m) => !m.thread_ts),
    )
      .slice()
      .reverse();
    return ok({ messages, has_more: false, response_metadata: { next_cursor: "" } });
  },

  "conversations.replies": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const messages = withThreadMeta(
      store,
      channel,
      store.channelMessages(channel).filter((m) => m.ts === args.ts || m.thread_ts === args.ts),
    );
    return ok({ messages, has_more: false });
  },

  "conversations.members": (args, { store }) => {
    const c = store.channels.get(resolveChannelId(store, args.channel));
    if (!c) return err("channel_not_found");
    return ok({ members: c.members, response_metadata: { next_cursor: "" } });
  },

  "conversations.open": (args, { store }) => {
    const userRef: string = args.users ?? args.user ?? "";
    const userId = String(userRef).split(",")[0];
    const channel = store.openDm(userId);
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

  "users.conversations": (_args, { store }) => {
    const channels = [...store.channels.values()]
      .filter((c) => c.members.includes(store.botUserId))
      .map(formatChannel);
    return ok({ channels, response_metadata: { next_cursor: "" } });
  },

  // ---- views (modals + App Home) -----------------------------------------
  "views.open": (args, { store, interactions }) => {
    if (!interactions.consumeTrigger(args.trigger_id)) return err("invalid_trigger_id");
    const view = interactions.instantiateView(args.view);
    store.setRootView(view);
    return ok({ view });
  },

  "views.push": (args, { store, interactions }) => {
    if (!interactions.consumeTrigger(args.trigger_id)) return err("invalid_trigger_id");
    const view = interactions.instantiateView(args.view, {
      previous_view_id: store.modalStack.at(-1)?.id ?? null,
      root_view_id: store.modalStack[0]?.id ?? null,
    });
    store.pushView(view);
    return ok({ view });
  },

  "views.update": (args, { store, interactions }) => {
    const view = interactions.instantiateView(args.view, {
      root_view_id: store.modalStack[0]?.id ?? null,
    });
    store.updateView(args.view_id ?? args.external_id, view);
    return ok({ view });
  },

  "views.publish": (args, { store, interactions }) => {
    const view = interactions.instantiateView(args.view);
    store.publishHome(args.user_id, view);
    return ok({ view });
  },

  // ---- reactions ----------------------------------------------------------
  "reactions.add": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const msg = store.findMessage(channel, args.timestamp);
    if (!msg) return err("message_not_found");
    msg.reactions ??= [];
    let r = msg.reactions.find((x) => x.name === args.name);
    if (!r) {
      r = { name: args.name, users: [], count: 0 };
      msg.reactions.push(r);
    }
    if (!r.users.includes(store.botUserId)) {
      r.users.push(store.botUserId);
      r.count = r.users.length;
    }
    store.updateMessage(channel, args.timestamp, {});
    return ok();
  },

  "reactions.remove": (args, { store }) => {
    const channel = resolveChannelId(store, args.channel);
    const msg = store.findMessage(channel, args.timestamp);
    if (!msg?.reactions) return err("message_not_found");
    msg.reactions = msg.reactions.filter((r) => r.name !== args.name);
    store.updateMessage(channel, args.timestamp, {});
    return ok();
  },
};
