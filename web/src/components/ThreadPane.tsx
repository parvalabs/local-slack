import { useEffect, useRef } from "react";
import type { Message as Msg, User } from "../types.ts";
import { Message } from "./Message.tsx";
import { Composer } from "./Composer.tsx";
import { postMessage, sendSlashCommand } from "../client.ts";

// Docked panel showing a message's thread: the root message, its replies, and a
// composer that posts back into the same thread (thread_ts = root.ts).
export function ThreadPane({
  channelId,
  root,
  replies,
  users,
  botUserId,
  actingUser,
  onClose,
}: {
  channelId: string;
  root: Msg;
  replies: Msg[];
  users: User[];
  botUserId?: string;
  actingUser: string;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [replies.length, root.ts]);

  const send = (text: string) => {
    if (!actingUser) return;
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const command = sp === -1 ? text : text.slice(0, sp);
      const rest = sp === -1 ? "" : text.slice(sp + 1);
      // Slash commands in a thread still deliver normally; the reply just isn't threaded.
      sendSlashCommand(channelId, actingUser, command, rest);
    } else {
      postMessage(channelId, actingUser, text, root.ts);
    }
  };

  return (
    <aside className="thread-pane">
      <div className="thread-head">
        <span className="thread-title">Thread</span>
        <button className="thread-x" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="thread-body" ref={listRef}>
        <Message
          message={root}
          users={users}
          botUserId={botUserId}
          actingUser={actingUser}
          hideThreadAffordance
        />
        <div className="thread-divider">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
        {replies.map((r) => (
          <Message
            key={r.ts}
            message={r}
            users={users}
            botUserId={botUserId}
            actingUser={actingUser}
            hideThreadAffordance
          />
        ))}
      </div>

      <Composer placeholder="Reply in thread…" onSend={send} />
    </aside>
  );
}
