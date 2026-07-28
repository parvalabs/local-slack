import { useState } from "react";
import type { Channel, Message, User } from "../types.ts";
import { userNames } from "../blockkit/mentions.ts";
import { channelNames } from "../blockkit/channels.ts";
import { avatarColor, channelLabel, formatTime, initials, userLabel } from "../util.ts";

export interface Notification {
  message: Message;
  channelId: string;
}

/** Flattens Slack's raw reference syntax back to something readable for a
 *  one-line preview — the real Block Kit/mrkdwn renderer is overkill (and too
 *  tall) for a dropdown row. */
function preview(text: string | undefined, max = 80): string {
  const flat = (text ?? "")
    .replace(/<@([A-Z0-9]+)>/g, (_m, id) => `@${userNames.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_m, name) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (_m, id) => `#${channelNames.get(id) ?? id}`)
    .replace(/<(?:https?:[^|>]+)\|([^>]+)>/g, (_m, label) => label)
    .replace(/<(https?:[^>]+)>/g, (_m, url) => url)
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "sent a message";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function NotificationCenter({
  notifications,
  users,
  channels,
  botUserIds,
  onOpen,
}: {
  notifications: Notification[];
  users: User[];
  channels: Channel[];
  botUserIds: string[];
  onOpen: (channelId: string, threadTs?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = notifications.length;

  return (
    <div className="notif">
      <button
        className={`notif-bell ${count > 0 ? "has-unread" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={count > 0 ? `${count} unread` : "No unread messages"}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
      >
        🔔
        {count > 0 && <span className="notif-badge">{count > 99 ? "99+" : count}</span>}
      </button>

      {open && (
        <>
          <div className="notif-overlay" onClick={() => setOpen(false)} />
          <div className="notif-panel">
            <div className="notif-head">Unread</div>
            {count === 0 && <div className="notif-empty">Nothing new.</div>}
            {notifications.map(({ message, channelId }) => {
              const channel = channels.find((c) => c.id === channelId);
              const name = message.username || userLabel(users, message.user);
              return (
                <button
                  key={`${channelId}:${message.ts}`}
                  className="notif-item"
                  onClick={() => {
                    onOpen(channelId, message.thread_ts);
                    setOpen(false);
                  }}
                >
                  <span className="notif-avatar" style={{ background: avatarColor(message.user ?? "bot") }}>
                    {initials(name)}
                  </span>
                  <span className="notif-body">
                    <span className="notif-meta">
                      <span className="notif-name">{name}</span>
                      <span className="notif-where">
                        {channel
                          ? `${channel.is_im ? "" : "#"}${channelLabel(channel, users, botUserIds)}`
                          : channelId}
                        {message.thread_ts ? " · thread" : ""}
                      </span>
                      <span className="notif-time">{formatTime(message.ts)}</span>
                    </span>
                    <span className="notif-text">{preview(message.text)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
