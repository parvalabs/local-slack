import { useState } from "react";
import type { Message as Msg, User } from "../types.ts";
import { Blocks } from "../blockkit/BlockKit.tsx";
import { mrkdwn } from "../blockkit/mrkdwn.tsx";
import { sendBlockAction, sendReaction, editMessage, deleteMessage } from "../client.ts";
import { EmojiPicker } from "./EmojiPicker.tsx";
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
  const [showPicker, setShowPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text ?? "");

  const isBot = !!message.bot_id || message.user === botUserId;
  const name = message.username || userLabel(users, message.user);
  const isMine = !isBot && message.user === actingUser;

  const onAction = (action: any) =>
    sendBlockAction(message.channel, message.ts, actingUser, action);

  const toggleReaction = (reactionName: string) => {
    const already = message.reactions?.find((r) => r.name === reactionName)?.users.includes(actingUser);
    sendReaction(message.channel, message.ts, actingUser, reactionName, !already);
  };

  const startEdit = () => {
    setDraft(message.text ?? "");
    setEditing(true);
  };
  const saveEdit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== message.text) editMessage(message.channel, message.ts, actingUser, trimmed);
    setEditing(false);
  };

  return (
    <div className="msg">
      <div className="msg-avatar" style={{ background: avatarColor(message.user ?? "bot") }}>
        {initials(name)}
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{name}</span>
          {isBot && <span className="badge-app">APP</span>}
          {message.subtype === "ephemeral" && <span className="badge-eph">only visible to you</span>}
          <span className="msg-time">{formatTime(message.ts)}</span>
          {message.edited && <span className="msg-edited">(edited)</span>}
        </div>

        {editing ? (
          <div className="msg-edit">
            <textarea
              className="msg-edit-input"
              value={draft}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
            />
            <div className="msg-edit-actions">
              <button className="modal-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="modal-btn primary" onClick={saveEdit}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.text && message.subtype !== "me_message" && (
              <div className="msg-text">{mrkdwn(message.text)}</div>
            )}
            {message.subtype === "me_message" && <div className="msg-text me">{mrkdwn(message.text)}</div>}
            <Blocks blocks={message.blocks} ctx={{ onAction }} />
          </>
        )}

        {message.reactions && message.reactions.length > 0 && (
          <div className="msg-reactions">
            {message.reactions.map((r) => (
              <button
                key={r.name}
                className={`reaction ${r.users.includes(actingUser) ? "mine" : ""}`}
                onClick={() => toggleReaction(r.name)}
                title={`:${r.name}:`}
              >
                :{r.name}: {r.count}
              </button>
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

      {!hideThreadAffordance && !editing && (
        <div className="msg-hover-actions">
          <button className="msg-hover-btn" title="Add reaction" onClick={() => setShowPicker(true)}>
            😀
          </button>
          {onOpenThread && (
            <button
              className="msg-hover-btn"
              title="Reply in thread"
              onClick={() => onOpenThread(message.ts)}
            >
              💬
            </button>
          )}
          {isMine && (
            <>
              <button className="msg-hover-btn" title="Edit message" onClick={startEdit}>
                ✏️
              </button>
              <button
                className="msg-hover-btn"
                title="Delete message"
                onClick={() => deleteMessage(message.channel, message.ts, actingUser)}
              >
                🗑️
              </button>
            </>
          )}
        </div>
      )}

      {showPicker && (
        <EmojiPicker
          onPick={(reactionName) => {
            toggleReaction(reactionName);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
