import { useEffect, useMemo, useRef, useState } from "react";
import {
  connect,
  markChannelRead,
  markThreadRead,
  openHome,
  postMessage,
  sendSlashCommand,
  setSelfUserId,
  toggleSound,
} from "./client.ts";
import { useLocalSlack } from "./useStore.ts";
import { Sidebar, appIdFromHomeId, isHomeId } from "./components/Sidebar.tsx";
import { Message } from "./components/Message.tsx";
import { Composer } from "./components/Composer.tsx";
import { Modal } from "./components/Modal.tsx";
import { HomeTab } from "./components/HomeTab.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { ThreadPane } from "./components/ThreadPane.tsx";
import { NotificationCenter, type Notification } from "./components/NotificationCenter.tsx";
import { setChannelClickHandler } from "./blockkit/channels.ts";
import { channelLabel } from "./util.ts";

export function App() {
  const state = useLocalSlack();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actingUser, setActingUser] = useState<string>("");
  const [activeAppId, setActiveAppId] = useState<string>("");
  const [showInspector, setShowInspector] = useState(false);
  const [openThreadTs, setOpenThreadTs] = useState<string | null>(null);
  const [threadWidth, setThreadWidth] = useState(380);

  useEffect(() => {
    connect();
  }, []);

  // Clicking a #channel reference in a rendered message jumps to that channel tab.
  useEffect(() => {
    setChannelClickHandler(setSelectedId);
  }, []);

  const botUserIds = useMemo(() => state.apps.map((a) => a.botUserId), [state.apps]);
  const humans = useMemo(
    () => state.users.filter((u) => !u.is_bot && !botUserIds.includes(u.id)),
    [state.users, botUserIds],
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
  useEffect(() => {
    if (!activeAppId && state.apps.length) setActiveAppId(state.apps[0].appId);
  }, [state.apps, activeAppId]);

  const isHome = isHomeId(selectedId);
  const homeAppId = isHome ? appIdFromHomeId(selectedId!) : null;
  const homeApp = state.apps.find((a) => a.appId === homeAppId) ?? null;

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

  // Close the thread pane whenever the channel changes — unless a notification
  // asked to land on a specific thread in the channel being opened.
  const pendingThreadTs = useRef<string | null>(null);
  useEffect(() => {
    setOpenThreadTs(pendingThreadTs.current);
    pendingThreadTs.current = null;
  }, [selectedId]);

  // Mark the open channel as read - both when it's first opened, and again
  // whenever a new message arrives while it's still the one being viewed.
  useEffect(() => {
    if (!selectedId || isHome) return;
    markChannelRead(selectedId);
  }, [selectedId, isHome, state.messages[selectedId ?? ""]]);

  // Which sidebar channels have a message newer than the last one the user
  // saw - the channel currently open is never "unread" no matter how fresh.
  const unreadChannelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of state.channels) {
      if (c.id === selectedId) continue;
      const last = state.messages[c.id]?.at(-1);
      if (last && state.lastReadTs[c.id] !== last.ts) ids.add(c.id);
    }
    return ids;
  }, [state.channels, state.messages, state.lastReadTs, selectedId]);

  // Keep the open thread marked read as replies stream in.
  useEffect(() => {
    if (!selectedId || !openThreadTs) return;
    markThreadRead(selectedId, openThreadTs);
  }, [selectedId, openThreadTs, openThreadReplies.length]);

  // Thread roots in this channel whose newest reply hasn't been seen. Unlike
  // channels, these survive opening the channel - only opening the thread itself
  // clears them, so a reply inside a collapsed thread stays visible.
  const unreadThreadTs = useMemo(() => {
    const ids = new Set<string>();
    for (const [rootTs, replies] of repliesByRoot) {
      if (rootTs === openThreadTs) continue;
      const newest = replies.at(-1);
      if (newest && state.lastReadThreadTs[rootTs] !== newest.ts) ids.add(rootTs);
    }
    return ids;
  }, [repliesByRoot, state.lastReadThreadTs, openThreadTs]);

  // Everything unread, newest first — one source of truth behind the bell's
  // badge, its dropdown, and the browser-tab count, so the three can't drift.
  // Deliberately avoids double-counting: a channel you're not in contributes all
  // its unseen messages, while the open one contributes only replies hidden
  // inside threads you aren't currently reading.
  const notifications = useMemo(() => {
    const out: Notification[] = [];
    const push = (m: Notification["message"], channelId: string) => {
      if (m.user === actingUser) return; // your own sends aren't news
      out.push({ message: m, channelId });
    };
    for (const c of state.channels) {
      const list = state.messages[c.id] ?? [];
      if (c.id === selectedId) {
        for (const m of list) {
          if (!m.thread_ts || m.thread_ts === openThreadTs) continue;
          const seen = state.lastReadThreadTs[m.thread_ts];
          if (!seen || m.ts > seen) push(m, c.id);
        }
      } else {
        const seen = state.lastReadTs[c.id];
        for (const m of list) if (!seen || m.ts > seen) push(m, c.id);
      }
    }
    return out.sort((a, b) => (a.message.ts < b.message.ts ? 1 : -1)).slice(0, 50);
  }, [
    state.channels,
    state.messages,
    state.lastReadTs,
    state.lastReadThreadTs,
    selectedId,
    openThreadTs,
    actingUser,
  ]);

  useEffect(() => {
    document.title = notifications.length > 0 ? `(${notifications.length}) local-slack` : "local-slack";
  }, [notifications.length]);

  // Jumping to a notification may need to switch channel *and* open a thread —
  // but switching channels clears the open thread (above), so hand the thread to
  // that effect rather than racing it.
  const openNotification = (channelId: string, threadTs?: string) => {
    if (channelId === selectedId) {
      setOpenThreadTs(threadTs ?? null);
      return;
    }
    pendingThreadTs.current = threadTs ?? null;
    setSelectedId(channelId);
  };

  // Your own messages shouldn't chime.
  useEffect(() => {
    setSelfUserId(actingUser);
  }, [actingUser]);

  // (Re)request the App Home whenever it's shown or the acting user changes.
  useEffect(() => {
    if (isHome && homeAppId && actingUser) openHome(homeAppId, actingUser);
  }, [isHome, homeAppId, actingUser]);

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
      sendSlashCommand(activeAppId, selectedId, actingUser, command, rest);
    } else {
      postMessage(selectedId, actingUser, text);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">local-slack</div>
        <div className="topbar-right">
          {state.apps.map((a) => (
            <span key={a.appId} className="app-status" title={a.appId}>
              <span className={`pill ${a.mode === "socket" ? "pill-socket" : "pill-events"}`}>
                {a.botName}: {a.mode}
              </span>
              {a.mode === "socket" && (
                <span className={`status ${a.connected ? "ok" : "bad"}`}>
                  {a.connected ? "connected" : "offline"}
                </span>
              )}
            </span>
          ))}
          <span className={`status ${state.connected ? "ok" : "bad"}`}>
            ui {state.connected ? "live" : "reconnecting"}
          </span>
          {state.apps.length > 1 && (
            <label className="actas">
              As app{" "}
              <select value={activeAppId} onChange={(e) => setActiveAppId(e.target.value)}>
                {state.apps.map((a) => (
                  <option key={a.appId} value={a.appId}>
                    {a.botName}
                  </option>
                ))}
              </select>
            </label>
          )}
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
          <NotificationCenter
            notifications={notifications}
            users={state.users}
            channels={state.channels}
            botUserIds={botUserIds}
            onOpen={openNotification}
          />
          <button
            className="sound-toggle"
            onClick={toggleSound}
            title={state.soundMuted ? "Unmute the new-message sound" : "Mute the new-message sound"}
            aria-label={state.soundMuted ? "Unmute the new-message sound" : "Mute the new-message sound"}
          >
            {state.soundMuted ? "🔇" : "🔊"}
          </button>
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
          apps={state.apps}
          selectedId={selectedId}
          unreadChannelIds={unreadChannelIds}
          onSelect={setSelectedId}
        />

        {isHome ? (
          <main className="main">
            <div className="channel-header">
              <span className="channel-title">🏠 {homeApp?.botName ?? "…"} — Home</span>
              <span className="channel-sub">viewing as {humans.find((u) => u.id === actingUser)?.name}</span>
            </div>
            <HomeTab
              appId={homeAppId ?? ""}
              view={actingUser && homeAppId ? state.homeViews[actingUser]?.[homeAppId] : undefined}
              botName={homeApp?.botName ?? "app"}
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
                    {channelLabel(channel, state.users, botUserIds)}
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
                    actingUser={actingUser}
                    replyCount={replies.length}
                    lastReplyTs={replies.at(-1)?.ts}
                    hasUnreadReplies={unreadThreadTs.has(m.ts)}
                    onOpenThread={setOpenThreadTs}
                  />
                );
              })}
            </div>

            {channel && (
              <Composer
                placeholder={`Message ${channel.is_im ? "" : "#"}${channelLabel(channel, state.users, botUserIds)} as ${humans.find((u) => u.id === actingUser)?.name ?? "…"} — try /echo hi`}
                onSend={send}
                users={state.users}
                channels={state.channels}
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
            channels={state.channels}
            actingUser={actingUser}
            activeAppId={activeAppId}
            width={threadWidth}
            onWidthChange={setThreadWidth}
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
