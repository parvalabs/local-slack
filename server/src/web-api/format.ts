import type { Store } from "../state/store.ts";
import type { UserConfig, ChannelConfig, AppConfig } from "../config/schema.ts";
import type { StoredFile } from "../state/files.ts";

/** A stable synthetic bot_id derived from an app's bot user id (e.g. U0BOT -> B0BOT). */
export function botId(app: AppConfig): string {
  return "B" + app.botUserId.slice(1);
}

export function formatUser(store: Store, u: UserConfig) {
  return {
    id: u.id,
    team_id: store.config.workspace.teamId,
    name: u.name,
    real_name: u.real_name ?? u.name,
    deleted: false,
    is_bot: !!u.is_bot,
    is_admin: false,
    tz: u.tz ?? "America/Los_Angeles",
    tz_offset: 0,
    profile: {
      real_name: u.real_name ?? u.name,
      display_name: u.name,
      email: u.email,
      image_48: undefined,
    },
  };
}

export function formatChannel(c: ChannelConfig) {
  return {
    id: c.id,
    name: c.name,
    is_channel: c.is_channel,
    is_group: c.is_private && !c.is_im,
    is_im: c.is_im,
    is_private: c.is_private,
    is_member: true,
    is_archived: false,
    num_members: c.members.length,
    topic: { value: c.topic ?? "", creator: "", last_set: 0 },
    purpose: { value: c.purpose ?? "", creator: "", last_set: 0 },
  };
}

/** Slack's image thumbnail sizes. The mock doesn't resize — every thumb_* is the
 *  original — but bots that pick a size to fetch get a working URL. */
const THUMB_SIZES = [64, 80, 160, 360, 480, 720, 960, 1024];

/**
 * A stored file as Slack's file object — what files.info/list/completeUpload
 * return and what `files` on a message or event carries.
 *
 * url_private / url_private_download are served by files/router.ts and, as in
 * Slack, need `Authorization: Bearer <bot token>`. The permalink is the human,
 * browser-facing view, which the web UI links to.
 */
export function formatFile(store: Store, f: StoredFile) {
  const teamId = store.config.workspace.teamId;
  const base = store.runtime.httpBase;
  const name = encodeURIComponent(f.name);
  const urlPrivate = `${base}/files-pri/${teamId}-${f.id}/${name}`;

  // Slack splits where a file lives by conversation kind, and nests share details
  // under public/private, keyed by channel.
  const channels: string[] = [];
  const groups: string[] = [];
  const ims: string[] = [];
  const shares: Record<"public" | "private", Record<string, any[]>> = { public: {}, private: {} };
  for (const s of f.shares) {
    const c = store.channels.get(s.channel);
    const bucket = c?.is_im ? ims : c?.is_private ? groups : channels;
    if (!bucket.includes(s.channel)) bucket.push(s.channel);
    const visibility = c?.is_private || c?.is_im ? "private" : "public";
    (shares[visibility][s.channel] ??= []).push({
      reply_users: [],
      reply_users_count: 0,
      reply_count: 0,
      ts: s.ts,
      ...(s.thread_ts ? { thread_ts: s.thread_ts } : {}),
      channel_name: c?.name ?? "",
      team_id: teamId,
      share_user_id: f.user,
    });
  }

  return {
    id: f.id,
    created: f.created,
    timestamp: f.created,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    pretty_type: f.prettyType,
    user: f.user,
    user_team: teamId,
    editable: false,
    size: f.size,
    mode: "hosted",
    is_external: false,
    external_type: "",
    is_public: channels.length > 0,
    public_url_shared: false,
    display_as_bot: false,
    username: "",
    url_private: urlPrivate,
    url_private_download: `${base}/files-pri/${teamId}-${f.id}/download/${name}`,
    ...(f.mimetype.startsWith("image/")
      ? Object.fromEntries(THUMB_SIZES.map((px) => [`thumb_${px}`, urlPrivate]))
      : {}),
    permalink: `${base}/files/${f.user}/${f.id}/${name}`,
    channels,
    groups,
    ims,
    shares: Object.fromEntries(Object.entries(shares).filter(([, v]) => Object.keys(v).length)),
    comments_count: 0,
    is_starred: false,
    has_rich_preview: false,
    file_access: "visible",
    ...(f.altTxt ? { alt_txt: f.altTxt } : {}),
  };
}
