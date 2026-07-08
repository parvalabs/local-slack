import type { Message as Msg, User } from "../types.ts";
import { Blocks } from "../blockkit/BlockKit.tsx";
import { mrkdwn } from "../blockkit/mrkdwn.tsx";
import { sendBlockAction } from "../client.ts";
import { avatarColor, formatTime, initials, userLabel } from "../util.ts";

export function Message({
  message,
  users,
  botUserId,
  actingUser,
  replyCount = 0,
  lastReplyTs,
  onOpenThread,
  hideThreadAffordance = false,
}: {
  message: Msg;
  users: User[];
  botUserId?: string;
  actingUser: string;
  replyCount?: number;
  lastReplyTs?: string;
  onOpenThread?: (ts: string) => void;
  hideThreadAffordance?: boolean;
}) {
  const isBot = !!message.bot_id || message.user === botUserId;
  const name = message.username || userLabel(users, message.user);
  const label = isBot ? name : name;

  const onAction = (action: any) =>
    sendBlockAction(message.channel, message.ts, actingUser, action);

  return (
    <div className="msg">
      <div className="msg-avatar" style={{ background: avatarColor(message.user ?? "bot") }}>
        {initials(label)}
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{label}</span>
          {isBot && <span className="badge-app">APP</span>}
          {message.subtype === "ephemeral" && <span className="badge-eph">only visible to you</span>}
          <span className="msg-time">{formatTime(message.ts)}</span>
        </div>
        {message.text && message.subtype !== "me_message" && (
          <div className="msg-text">{mrkdwn(message.text)}</div>
        )}
        {message.subtype === "me_message" && <div className="msg-text me">{mrkdwn(message.text)}</div>}
        <Blocks blocks={message.blocks} ctx={{ onAction }} />
        {message.reactions && message.reactions.length > 0 && (
          <div className="msg-reactions">
            {message.reactions.map((r) => (
              <span key={r.name} className="reaction">
                :{r.name}: {r.count}
              </span>
            ))}
          </div>
        )}
        {replyCount > 0 && (
          <button className="thread-summary" onClick={() => onOpenThread?.(message.ts)}>
            <span className="thread-summary-count">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
            {lastReplyTs && <span className="thread-summary-time">Last reply {formatTime(lastReplyTs)}</span>}
          </button>
        )}
      </div>
      {!hideThreadAffordance && onOpenThread && (
        <div className="msg-hover-actions">
          <button
            className="msg-hover-btn"
            title="Reply in thread"
            onClick={() => onOpenThread(message.ts)}
          >
            💬
          </button>
        </div>
      )}
    </div>
  );
}
