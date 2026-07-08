import { useEffect, useMemo, useRef, useState } from "react";
import { connect, openHome, postMessage, sendSlashCommand } from "./client.ts";
import { useLocalSlack } from "./useStore.ts";
import { Sidebar, HOME_ID } from "./components/Sidebar.tsx";
import { Message } from "./components/Message.tsx";
import { Composer } from "./components/Composer.tsx";
import { Modal } from "./components/Modal.tsx";
import { HomeTab } from "./components/HomeTab.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { ThreadPane } from "./components/ThreadPane.tsx";
import { channelLabel } from "./util.ts";

export function App() {
  const state = useLocalSlack();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actingUser, setActingUser] = useState<string>("");
  const [showInspector, setShowInspector] = useState(false);
  const [openThreadTs, setOpenThreadTs] = useState<string | null>(null);

  useEffect(() => {
    connect();
  }, []);

  const humans = useMemo(
    () => state.users.filter((u) => u.id !== state.app?.botUserId && !u.is_bot),
    [state.users, state.app?.botUserId],
  );

  // Default selections once data arrives.
  useEffect(() => {
    if (!selectedId && state.channels.length) {
      setSelectedId(state.channels.find((c) => !c.is_im)?.id ?? state.channels[0].id);
    }
  }, [state.channels, selectedId]);
  useEffect(() => {
    if (!actingUser && humans.length) setActingUser(humans[0].id);
  }, [humans, actingUser]);

  const isHome = selectedId === HOME_ID;
  const channel = state.channels.find((c) => c.id === selectedId) ?? null;
  const messages = selectedId && !isHome ? (state.messages[selectedId] ?? []) : [];

  // Top-level messages (threads render inline as a "N replies" summary instead).
  const rootMessages = useMemo(() => messages.filter((m) => !m.thread_ts), [messages]);
  const repliesByRoot = useMemo(() => {
    const map = new Map<string, typeof messages>();
    for (const m of messages) {
      if (!m.thread_ts) continue;
      const list = map.get(m.thread_ts) ?? [];
      list.push(m);
      map.set(m.thread_ts, list);
    }
    return map;
  }, [messages]);

  const openThreadRoot = openThreadTs ? messages.find((m) => m.ts === openThreadTs) : undefined;
  const openThreadReplies = openThreadTs ? (repliesByRoot.get(openThreadTs) ?? []) : [];

  // Close the thread pane whenever the channel changes.
  useEffect(() => {
    setOpenThreadTs(null);
  }, [selectedId]);

  // (Re)request the App Home whenever it's shown or the acting user changes.
  useEffect(() => {
    if (isHome && actingUser) openHome(actingUser);
  }, [isHome, actingUser]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, selectedId]);

  const send = (text: string) => {
    if (!selectedId || !actingUser) return;
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const command = sp === -1 ? text : text.slice(0, sp);
      const rest = sp === -1 ? "" : text.slice(sp + 1);
      sendSlashCommand(selectedId, actingUser, command, rest);
    } else {
      postMessage(selectedId, actingUser, text);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">local-slack</div>
        <div className="topbar-right">
          <span className={`pill ${state.app?.mode === "socket" ? "pill-socket" : "pill-events"}`}>
            {state.app?.mode ?? "…"} mode
          </span>
          {state.app?.mode === "socket" && (
            <span className={`status ${state.socketConnected ? "ok" : "bad"}`}>
              bot {state.socketConnected ? "connected" : "offline"}
            </span>
          )}
          <span className={`status ${state.connected ? "ok" : "bad"}`}>
            ui {state.connected ? "live" : "reconnecting"}
          </span>
          <label className="actas">
            Act as{" "}
            <select value={actingUser} onChange={(e) => setActingUser(e.target.value)}>
              {humans.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.real_name || u.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`inspector-toggle ${showInspector ? "on" : ""}`}
            onClick={() => setShowInspector((s) => !s)}
          >
            Inspector {state.log.length > 0 ? `(${state.log.length})` : ""}
          </button>
        </div>
      </header>

      <div className="body">
        <Sidebar
          workspace={state.workspace}
          channels={state.channels}
          users={state.users}
          botUserId={state.app?.botUserId}
          botName={state.app?.botName ?? "app"}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {isHome ? (
          <main className="main">
            <div className="channel-header">
              <span className="channel-title">🏠 {state.app?.botName} — Home</span>
              <span className="channel-sub">viewing as {humans.find((u) => u.id === actingUser)?.name}</span>
            </div>
            <HomeTab
              view={actingUser ? state.homeViews[actingUser] : undefined}
              botName={state.app?.botName ?? "app"}
              actingUser={actingUser}
            />
          </main>
        ) : (
          <main className="main">
            <div className="channel-header">
              {channel ? (
                <>
                  <span className="channel-title">
                    {channel.is_im ? "" : channel.is_private ? "🔒 " : "# "}
                    {channelLabel(channel, state.users, state.app?.botUserId)}
                  </span>
                  <span className="channel-sub">{channel.members.length} members</span>
                </>
              ) : (
                <span className="channel-title">Select a channel</span>
              )}
            </div>

            <div className="messages" ref={listRef}>
              {messages.length === 0 && (
                <div className="empty">No messages yet. Say something below.</div>
              )}
              {rootMessages.map((m) => {
                const replies = repliesByRoot.get(m.ts) ?? [];
                return (
                  <Message
                    key={m.ts}
                    message={m}
                    users={state.users}
                    botUserId={state.app?.botUserId}
                    actingUser={actingUser}
                    replyCount={replies.length}
                    lastReplyTs={replies.at(-1)?.ts}
                    onOpenThread={setOpenThreadTs}
                  />
                );
              })}
            </div>

            {channel && (
              <Composer
                placeholder={`Message ${channel.is_im ? "" : "#"}${channelLabel(channel, state.users, state.app?.botUserId)} as ${humans.find((u) => u.id === actingUser)?.name ?? "…"} — try /echo hi`}
                onSend={send}
              />
            )}
          </main>
        )}

        {!isHome && openThreadRoot && channel && (
          <ThreadPane
            channelId={channel.id}
            root={openThreadRoot}
            replies={openThreadReplies}
            users={state.users}
            botUserId={state.app?.botUserId}
            actingUser={actingUser}
            onClose={() => setOpenThreadTs(null)}
          />
        )}
      </div>

      {showInspector && <Inspector log={state.log} onClose={() => setShowInspector(false)} />}

      {state.modalStack.length > 0 && (
        <Modal stack={state.modalStack} errors={state.viewErrors} actingUser={actingUser} />
      )}
    </div>
  );
}
