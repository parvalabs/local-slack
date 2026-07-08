import { nextTs, type Store } from "./state/store.ts";
import type { BotGateway } from "./gateway/bot.ts";
import type { Interactions } from "./interactions.ts";
import type { SlackMessage } from "./types.ts";

/** Resolve a channel reference (id, "#name", "name", or a user id for a DM) to a channel id. */
export function resolveChannelId(store: Store, ref: string): string {
  if (!ref) return ref;
  if (store.channels.has(ref)) return ref;
  if (ref.startsWith("U")) return store.openDm(ref).id; // posting to a user opens a DM
  const name = ref.replace(/^#/, "");
  for (const c of store.channels.values()) if (c.name === name) return c.id;
  return ref;
}

export function channelType(store: Store, channelId: string): "im" | "channel" {
  return store.channels.get(channelId)?.is_im ? "im" : "channel";
}

/**
 * A human (via the UI or the control API) posts a message as a workspace user.
 * Stores it and delivers a `message` event to the bot.
 */
export async function userPostMessage(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; user: string; text?: string; blocks?: any[]; thread_ts?: string },
): Promise<SlackMessage> {
  const channel = resolveChannelId(store, opts.channel);
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

  await gateway.deliverEvent(event);
  return msg;
}

/** A human adds or removes a reaction on a message from the UI. */
export async function userReaction(
  store: Store,
  gateway: BotGateway,
  opts: { channel: string; ts: string; user: string; name: string; present: boolean },
): Promise<void> {
  const msg = store.setReaction(opts.channel, opts.ts, opts.name, opts.user, opts.present);
  if (!msg) return;
  await gateway.deliverEvent({
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

  await gateway.deliverEvent({
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
  await gateway.deliverEvent({
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

/** A human typed a slash command in the composer. */
export async function userSlashCommand(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { user: string; channel: string; command: string; text: string },
): Promise<void> {
  const payload = interactions.buildSlashCommand(opts);
  const resp: any = await gateway.deliverSlashCommand(payload);
  // If the bot answered inline via ack(message) (rather than response_url), post it.
  if (resp && typeof resp === "object" && (resp.text || resp.blocks)) {
    const ephemeral = resp.response_type === "ephemeral";
    store.addMessage({
      type: "message",
      ts: nextTs(),
      channel: opts.channel,
      user: store.botUserId,
      bot_id: "B" + store.botUserId.slice(1),
      text: resp.text ?? "",
      ...(resp.blocks ? { blocks: resp.blocks } : {}),
      ...(ephemeral ? { subtype: "ephemeral", ephemeral_to: opts.user } : {}),
    } as SlackMessage);
  }
}

/** A human opened the bot's App Home tab. */
export async function openAppHome(
  store: Store,
  gateway: BotGateway,
  opts: { user: string },
): Promise<void> {
  const channel = store.openDm(opts.user).id;
  const ts = nextTs();
  await gateway.deliverEvent({
    type: "app_home_opened",
    user: opts.user,
    channel,
    tab: "home",
    event_ts: ts,
  });
}

/** A human clicked an interactive element (button/select/overflow) in the UI. */
export async function userBlockAction(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { channel: string; messageTs: string; user: string; action: any },
): Promise<void> {
  const message = store.findMessage(opts.channel, opts.messageTs);
  const payload = interactions.buildBlockActions({
    user: opts.user,
    channel: opts.channel,
    message,
    action: opts.action,
  });
  await gateway.deliverInteractive(payload);
}

/** Apply the bot's response_action (or default close) after a view_submission. */
function applyViewResponse(store: Store, interactions: Interactions, resp: any): void {
  if (!resp || typeof resp !== "object" || !resp.response_action) {
    store.clearViews(); // default: a successful submission closes the modal
    return;
  }
  switch (resp.response_action) {
    case "clear":
      store.clearViews();
      break;
    case "update":
      store.updateView(undefined, interactions.instantiateView(resp.view));
      break;
    case "push":
      store.pushView(interactions.instantiateView(resp.view));
      break;
    case "errors":
      store.emit("view_errors", { errors: resp.errors });
      break;
    default:
      store.clearViews();
  }
}

/** A human submitted the current modal in the UI. */
export async function userViewSubmit(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { user: string; values: any },
): Promise<void> {
  const view = store.modalStack.at(-1);
  if (!view) return;
  const payload = interactions.buildViewSubmission({ user: opts.user, view, values: opts.values });
  const resp = await gateway.deliverInteractive(payload);
  applyViewResponse(store, interactions, resp);
}

/** A human closed the current modal in the UI. */
export async function userViewClose(
  store: Store,
  gateway: BotGateway,
  interactions: Interactions,
  opts: { user: string },
): Promise<void> {
  const view = store.modalStack.at(-1);
  store.clearViews();
  if (view?.notify_on_close) {
    await gateway.deliverInteractive(interactions.buildViewClosed({ user: opts.user, view }));
  }
}
