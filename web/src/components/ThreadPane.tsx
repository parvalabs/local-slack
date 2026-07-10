import { useEffect, useRef } from "react";
import type { Channel, Message as Msg, User } from "../types.ts";
import { Message } from "./Message.tsx";
import { Composer } from "./Composer.tsx";
import { postMessage, sendSlashCommand } from "../client.ts";

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;

// Docked panel showing a message's thread: the root message, its replies, and a
// composer that posts back into the same thread (thread_ts = root.ts).
export function ThreadPane({
  channelId,
  root,
  replies,
  users,
  channels,
  actingUser,
  activeAppId,
  width,
  onWidthChange,
  onClose,
}: {
  channelId: string;
  root: Msg;
  replies: Msg[];
  users: User[];
  channels: Channel[];
  actingUser: string;
  activeAppId: string;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Dragging the left-edge handle: the pane sits at the right edge of the window,
  // so moving the mouse left (a negative clientX delta) should grow it — hence
  // `startWidth - delta` rather than `+ delta`.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const maxWidth = Math.min(MAX_WIDTH, window.innerWidth - 400);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      onWidthChange(Math.min(Math.max(startWidth - delta, MIN_WIDTH), maxWidth));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
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
      sendSlashCommand(activeAppId, channelId, actingUser, command, rest);
    } else {
      postMessage(channelId, actingUser, text, root.ts);
    }
  };

  return (
    <aside className="thread-pane" style={{ width }}>
      <div className="thread-resize-handle" onMouseDown={startResize} />
      <div className="thread-head">
        <span className="thread-title">Thread</span>
        <button className="thread-x" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="thread-body" ref={listRef}>
        <Message message={root} users={users} actingUser={actingUser} hideThreadAffordance />
        <div className="thread-divider">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
        {replies.map((r) => (
          <Message key={r.ts} message={r} users={users} actingUser={actingUser} hideThreadAffordance />
        ))}
      </div>

      <Composer placeholder="Reply in thread…" onSend={send} users={users} channels={channels} />
    </aside>
  );
}
