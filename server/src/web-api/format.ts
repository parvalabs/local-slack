import type { Store } from "../state/store.ts";
import type { UserConfig, ChannelConfig, AppConfig } from "../config/schema.ts";

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
