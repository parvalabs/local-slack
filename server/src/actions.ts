import { nextTs, type Store } from "./state/store.ts";
import type { AppConfig } from "./config/schema.ts";
import type { BotGateway } from "./gateway/bot.ts";
import type { Interactions } from "./interactions.ts";
import type { SlackMessage } from "./types.ts";
import type { StoredFile } from "./state/files.ts";
import { botId, formatFile } from "./web-api/format.ts";

/** Resolve a channel reference (id, "#name", "name", or a user id for a DM) to a
 *  channel id. `dmBotUserId` is the bot to open a DM with if `ref` turns out to be
 *  a user id (the "post to a user by id" convenience real Slack also supports). */
export function resolveChannelId(store: Store, ref: string, dmBotUserId: string): string {
  if (!ref) return ref;
  if (store.channels.has(ref)) return ref;
  if (ref.startsWith("U")) return store.openDm(ref, dmBotUserId).id;
  const name = ref.replace(/^#/, "");
  for (const c of store.channels.values()) if (c.name === name) return c.id;
  return ref;
}

export function channelType(store: Store, channelId: string): "im" | "channel" {
  return store.channels.get(channelId)?.is_im ? "im" : "channel";
}

/** Deliver an already-built event to every app whose bot is a member of the channel —
 *  the same fan-out real Slack does for every app subscribed to that conversation. */
async function fanOutEvent(store: Store, gateway: BotGateway, channel: string, event: any): Promise<void> {
  const apps = store.appsInChannel(channel);
  await Promise.all(apps.map((a) => gateway.deliverEvent(a.appId, event)));
}

/** Resolve which app a piece of bot-authored content (a message or a view) belongs
 *  to, falling back to the primary app if it's missing or unrecognized. */
function appFor(store: Store, appId: string | undefined): AppConfig {
  return (appId && store.appById(appId)) || store.primaryApp();
}

/**
 * Deliver `app_mention` to every app whose bot user is `<@…>`-mentioned in the text.
 * Real Slack sends this *in addition to* the `message` event (an app subscribed to
 * both receives two events for one mention), and only to the app that was actually
 * named — unlike `message`, which fans out to every app in the channel. Mentions of
 * an app that isn't in the channel are ignored, matching Slack: it can't see the
 * conversation, so it can't be mentioned in it.
 */
async function fanOutAppMentions(
  store: Store,
  gateway: BotGateway,
  channel: string,
  msg: { user?: string; text?: string; ts: string; thread_ts?: string },
): Promise<void> {
  const mentioned = new Set([...(msg.text ?? "").matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]));
  if (!mentioned.size) return;

  const apps = store.appsInChannel(channel).filter((a) => mentioned.has(a.botUserId));
  await Promise.all(
    apps.map((a) =>
      gateway.deliverEvent(a.appId, {
        type: "app_mention",
        user: msg.user,
        text: msg.text ?? "",
        ts: msg.ts,
        channel,
        event_ts: msg.ts,
        ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
      }),
    ),
  );
}

/**
 * A human (via the UI or the control API) posts a message as a workspace user.
 * Stores it and fans out a `message` event to every app in the channel.
 */
export async function userPostMessage(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; user: string; text?: string; blocks?: any[]; thread_ts?: string },
): Promise<SlackMessage> {
  const channel = resolveChannelId(store, opts.channel, store.primaryApp().botUserId);
  const ts = nextTs();
  const msg: SlackMessage = {
    type: "message",
    ts,
    channel,
    user: opts.user,
    text: opts.text ?? "",
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
    ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
  };
  store.addMessage(msg);

  const event: any = {
    type: "message",
    channel,
    user: opts.user,
    text: opts.text ?? "",
    ts,
    event_ts: ts,
    channel_type: channelType(store, channel),
  };
  if (opts.thread_ts) event.thread_ts = opts.thread_ts;

  await fanOutEvent(store, gateway, channel, event);
  await fanOutAppMentions(store, gateway, channel, msg);
  return msg;
}

/**
 * Shares files into a channel (or thread) as a single `file_share` message —
 * the step both a bot's files.completeUploadExternal and a human's upload end
 * in. Stores the message and records the share on each file; delivering events
 * is left to the caller, since only human shares fan out.
 */
export function postFileShare(
  store: Store,
  opts: {
    channel: string;
    files: StoredFile[];
    /** `user`, plus `bot_id`/`app_id` when a bot is the one sharing. */
    author: Pick<SlackMessage, "user" | "bot_id" | "app_id">;
    text?: string;
    blocks?: any[];
    thread_ts?: string;
  },
): SlackMessage {
  const ts = nextTs();
  for (const f of opts.files) {
    f.shares.push({ channel: opts.channel, ts, ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}) });
  }
  return store.addMessage({
    type: "message",
    subtype: "file_share",
    ts,
    channel: opts.channel,
    ...opts.author,
    text: opts.text ?? "",
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
    files: opts.files.map((f) => formatFile(store, f)),
    upload: true,
    display_as_bot: false,
    ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
  });
}

/**
 * A human uploads files (via the UI or the control API), optionally with a
 * message. Delivers what Slack does for a user's upload: a `message` event with
 * subtype `file_share` carrying the files, `app_mention` if the comment names an
 * app, and one `file_shared` per file.
 */
export async function userShareFiles(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; user: string; text?: string; thread_ts?: string; files: File[] },
): Promise<{ ok: true; message: SlackMessage } | { ok: false; error: string }> {
  const channel = resolveChannelId(store, opts.channel, store.primaryApp().botUserId);
  if (!store.channels.has(channel)) return { ok: false, error: "channel_not_found" };
  if (!opts.files.length) return { ok: false, error: "no_file_data" };

  const stored: StoredFile[] = [];
  for (const upload of opts.files) {
    const { file } = store.files.create({ name: upload.name, user: opts.user });
    await store.files.write(file, upload);
    stored.push(file);
  }
  const msg = postFileShare(store, {
    channel,
    files: stored,
    author: { user: opts.user },
    text: opts.text,
    thread_ts: opts.thread_ts,
  });

  await fanOutEvent(store, gateway, channel, {
    type: "message",
    subtype: "file_share",
    channel,
    user: opts.user,
    text: msg.text,
    ts: msg.ts,
    event_ts: msg.ts,
    channel_type: channelType(store, channel),
    files: msg.files,
    upload: true,
    display_as_bot: false,
    ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
  });
  await fanOutAppMentions(store, gateway, channel, msg);
  for (const f of stored) {
    await fanOutEvent(store, gateway, channel, {
      type: "file_shared",
      channel_id: channel,
      file_id: f.id,
      user_id: opts.user,
      file: { id: f.id },
      event_ts: msg.ts,
    });
  }
  return { ok: true, message: msg };
}

/** A human adds or removes a reaction on a message from the UI. */
export async function userReaction(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; ts: string; user: string; name: string; present: boolean },
): Promise<void> {
  const msg = store.setReaction(opts.channel, opts.ts, opts.name, opts.user, opts.present);
  if (!msg) return;
  await fanOutEvent(store, gateway, opts.channel, {
    type: opts.present ? "reaction_added" : "reaction_removed",
    user: opts.user,
    reaction: opts.name,
    item: { type: "message", channel: opts.channel, ts: opts.ts },
    item_user: msg.user,
    event_ts: nextTs(),
  });
}

/** A human edits their own message from the UI. Bots' messages can't be edited this way. */
export async function userEditMessage(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; ts: string; user: string; text: string },
): Promise<{ ok: boolean; error?: string; message?: SlackMessage }> {
  const msg = store.findMessage(opts.channel, opts.ts);
  if (!msg) return { ok: false, error: "message_not_found" };
  if (msg.user !== opts.user) return { ok: false, error: "not_authorized" };

  const previous_message = { ...msg };
  const updated = store.updateMessage(opts.channel, opts.ts, {
    text: opts.text,
    edited: { user: opts.user, ts: nextTs() },
  })!;

  await fanOutEvent(store, gateway, opts.channel, {
    type: "message",
    subtype: "message_changed",
    channel: opts.channel,
    ts: nextTs(),
    event_ts: nextTs(),
    message: updated,
    previous_message,
  });
  return { ok: true, message: updated };
}

/** A human deletes their own message from the UI. Bots' messages can't be deleted this way. */
export async function userDeleteMessage(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; ts: string; user: string },
): Promise<{ ok: boolean; error?: string }> {
  const msg = store.findMessage(opts.channel, opts.ts);
  if (!msg) return { ok: false, error: "message_not_found" };
  if (msg.user !== opts.user) return { ok: false, error: "not_authorized" };

  store.deleteMessage(opts.channel, opts.ts);
  await fanOutEvent(store, gateway, opts.channel, {
    type: "message",
    subtype: "message_deleted",
    channel: opts.channel,
    ts: nextTs(),
    event_ts: nextTs(),
    deleted_ts: opts.ts,
    previous_message: msg,
  });
  return { ok: true };
}

/** A human typed a slash command in the composer, addressed to a specific app
 *  (Slack routes each command to exactly one app based on its registration —
 *  this mock doesn't model that, so the caller picks the target app explicitly). */
export async function userSlashCommand(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { appId: string; user: string; channel: string; command: string; text: string },
): Promise<void> {
  const app = appFor(store, opts.appId);
  const payload = interactions.buildSlashCommand(app, opts);
  const resp: any = await gateway.deliverSlashCommand(app.appId, payload);
  // If the bot answered inline via ack(message) (rather than response_url), post it.
  if (resp && typeof resp === "object" && (resp.text || resp.blocks)) {
    const ephemeral = resp.response_type === "ephemeral";
    store.addMessage({
      type: "message",
      ts: nextTs(),
      channel: opts.channel,
      user: app.botUserId,
      bot_id: botId(app),
      app_id: app.appId,
      text: resp.text ?? "",
      ...(resp.blocks ? { blocks: resp.blocks } : {}),
      ...(ephemeral ? { subtype: "ephemeral", ephemeral_to: opts.user } : {}),
    } as SlackMessage);
  }
}

/** A human opened a specific app's Home tab. */
export async function openAppHome(
  store: Store,
  gateway: BotGateway,
  opts: { appId: string; user: string },
): Promise<void> {
  const app = appFor(store, opts.appId);
  const channel = store.openDm(opts.user, app.botUserId).id;
  const ts = nextTs();
  await gateway.deliverEvent(app.appId, {
    type: "app_home_opened",
    user: opts.user,
    channel,
    tab: "home",
    event_ts: ts,
  });
}

/** A human clicked an interactive element (button/select/overflow) in the UI —
 *  routed to whichever app posted the message it's attached to. App Home actions
 *  have no container message to infer that from, so an explicit `appId` (whose
 *  Home tab is showing) is required there instead. */
export async function userBlockAction(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { channel: string; messageTs: string; user: string; action: any; appId?: string },
): Promise<void> {
  const message = store.findMessage(opts.channel, opts.messageTs);
  const app = appFor(store, opts.appId ?? message?.app_id);
  const payload = interactions.buildBlockActions(app, {
    user: opts.user,
    channel: opts.channel,
    message,
    action: opts.action,
  });
  await gateway.deliverInteractive(app.appId, payload);
}

/** Apply the bot's response_action (or default close) after a view_submission. */
function applyViewResponse(store: Store, app: AppConfig, interactions: Interactions, resp: any): void {
  if (!resp || typeof resp !== "object" || !resp.response_action) {
    store.clearViews(); // default: a successful submission closes the modal
    return;
  }
  switch (resp.response_action) {
    case "clear":
      store.clearViews();
      break;
    case "update":
      store.updateView(undefined, interactions.instantiateView(app, resp.view));
      break;
    case "push":
      store.pushView(interactions.instantiateView(app, resp.view));
      break;
    case "errors":
      store.emit("view_errors", { errors: resp.errors });
      break;
    default:
      store.clearViews();
  }
}

/** A human submitted the current modal in the UI — routed to whichever app opened it. */
export async function userViewSubmit(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { user: string; values: any },
): Promise<void> {
  const view = store.modalStack.at(-1);
  if (!view) return;
  const app = appFor(store, view.app_id);
  const payload = interactions.buildViewSubmission(app, { user: opts.user, view, values: opts.values });
  const resp = await gateway.deliverInteractive(app.appId, payload);
  applyViewResponse(store, app, interactions, resp);
}

/** A human closed the current modal in the UI — routed to whichever app opened it. */
export async function userViewClose(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { user: string },
): Promise<void> {
  const view = store.modalStack.at(-1);
  store.clearViews();
  if (view?.notify_on_close) {
    const app = appFor(store, view.app_id);
    await gateway.deliverInteractive(app.appId, interactions.buildViewClosed(app, { user: opts.user, view }));
  }
}
