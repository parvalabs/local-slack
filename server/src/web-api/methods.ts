import { nextTs, type Store } from "../state/store.ts";
import type { AppConfig } from "../config/schema.ts";
import type { BotGateway } from "../gateway/bot.ts";
import type { SocketManager } from "../socket/manager.ts";
import type { SlackMessage } from "../types.ts";
import { resolveChannelId, postFileShare } from "../actions.ts";
import { botId, formatUser, formatChannel, formatFile } from "./format.ts";
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

  "chat.getPermalink": (args, { store, app }) => {
    const channel = resolveChannelId(store, args.channel, app.botUserId);
    if (!store.channels.has(channel)) return err("channel_not_found");
    const ts: string = args.message_ts ?? "";
    const message = store.findMessage(channel, ts);
    if (!message) return err("message_not_found");
    // Slack's permalink form: the ts with its dot removed, behind a "p". A reply
    // also carries the thread it lives in, which is what makes the link open the
    // thread pane rather than just the channel.
    const permalinkId = `p${ts.replace(".", "")}`;
    const query = message.thread_ts ? `?thread_ts=${message.thread_ts}&cid=${channel}` : "";
    return ok({
      channel,
      permalink: `${store.runtime.httpBase}/archives/${channel}/${permalinkId}${query}`,
    });
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

  // ---- files --------------------------------------------------------------
  // Slack's upload flow, which is what the SDKs' files.uploadV2 / files_upload_v2
  // drive: reserve a file id and upload_url, POST the bytes there (files/router.ts),
  // then complete — which is also where it gets shared into a conversation.

  "files.getUploadURLExternal": (args, { store, app }) => {
    const length = Number(args.length);
    if (!args.filename || args.length === undefined || !Number.isInteger(length) || length < 0) {
      return err("invalid_arguments");
    }
    const { file, uploadToken } = store.files.create({
      name: String(args.filename),
      user: app.botUserId,
      // The documented name is alt_txt; @slack/web-api sends alt_text.
      altTxt: args.alt_txt ?? args.alt_text,
      snippetType: args.snippet_type,
    });
    return ok({ upload_url: `${store.runtime.httpBase}/upload/v1/${uploadToken}`, file_id: file.id });
  },

  "files.completeUploadExternal": (args, { store, app }) => {
    const entries: any[] = Array.isArray(args.files) ? args.files : [];
    if (!entries.length) return err("invalid_arguments");

    const files = entries.map((e) => store.files.get(e?.id));
    for (const [i, f] of files.entries()) {
      // Only the app that reserved a file can complete it.
      if (!f || f.deleted || f.user !== app.botUserId) return err("file_not_found");
      if (!f.path) {
        store.addLog("internal", "files", `${f.id} completed before its bytes were uploaded`, {
          hint: "POST the file's content to the upload_url from files.getUploadURLExternal first",
        });
        return err("file_not_found");
      }
      if (entries[i].title) f.title = String(entries[i].title);
    }

    // channel_id is one conversation; the newer `channels` takes a comma list.
    const targets = String(args.channel_id ?? args.channels ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => resolveChannelId(store, c, app.botUserId));
    if (targets.some((c) => !store.channels.has(c))) return err("channel_not_found");

    for (const channel of targets) {
      postFileShare(store, {
        channel,
        files: files as NonNullable<(typeof files)[number]>[],
        author: { user: app.botUserId, bot_id: botId(app), app_id: app.appId },
        text: args.initial_comment,
        blocks: args.blocks,
        thread_ts: args.thread_ts,
      });
    }
    return ok({ files: files.map((f) => formatFile(store, f!)) });
  },

  "files.info": (args, { store }) => {
    const f = store.files.get(args.file);
    if (f?.deleted) return err("file_deleted");
    if (!f?.path) return err("file_not_found");
    return ok({ file: formatFile(store, f), comments: [], response_metadata: { next_cursor: "" } });
  },

  "files.list": (args, { store }) => {
    const types = String(args.types ?? "all").split(",");
    const matchesType = (f: { mimetype: string; filetype: string }) =>
      types.includes("all") ||
      (types.includes("images") && f.mimetype.startsWith("image/")) ||
      (types.includes("pdfs") && f.filetype === "pdf") ||
      (types.includes("zips") && f.filetype === "zip") ||
      (types.includes("snippets") && f.mimetype.startsWith("text/"));

    const all = store.files
      .all()
      .filter((f) => !args.channel || f.shares.some((s) => s.channel === args.channel))
      .filter((f) => !args.user || f.user === args.user)
      .filter(matchesType)
      .sort((a, b) => b.created - a.created);

    const count = Math.max(1, Number(args.count) || 100);
    const page = Math.max(1, Number(args.page) || 1);
    return ok({
      files: all.slice((page - 1) * count, page * count).map((f) => formatFile(store, f)),
      paging: { count, total: all.length, page, pages: Math.max(1, Math.ceil(all.length / count)) },
    });
  },

  "files.delete": (args, { store, app }) => {
    const f = store.files.get(args.file);
    if (!f) return err("file_not_found");
    if (f.deleted) return err("file_deleted");
    // A bot token can only delete what that bot uploaded.
    if (f.user !== app.botUserId) return err("cant_delete_file");
    store.deleteFile(f);
    return ok();
  },

  // Retired by Slack on 2025-11-12 in favor of the flow above. Refused here too,
  // so a bot still on it finds out now rather than in production.
  "files.upload": () => err("method_deprecated"),

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
