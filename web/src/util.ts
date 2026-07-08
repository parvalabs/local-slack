import type { Channel, User } from "./types.ts";

export function userLabel(users: User[], id?: string): string {
  if (!id) return "unknown";
  const u = users.find((x) => x.id === id);
  return u?.real_name || u?.name || id;
}

/** For a DM, shows the human participant's name (excluding whichever bot(s) it's with) —
 *  same convention Slack uses for a bot's own DM list. */
export function channelLabel(channel: Channel, users: User[], botUserIds: string[] = []): string {
  if (channel.is_im) {
    const other = channel.members.find((m) => !botUserIds.includes(m));
    return userLabel(users, other);
  }
  return channel.name;
}

const COLORS = ["#4a154b", "#2eb67d", "#ecb22e", "#e01e5a", "#36c5f0", "#611f69", "#1264a3"];
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function initials(label: string): string {
  const parts = label.trim().split(/\s+/);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0]?.toUpperCase() ?? "");
}

export function formatTime(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
