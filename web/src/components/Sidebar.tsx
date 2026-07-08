import type { AppInfo, Channel, User, Workspace } from "../types.ts";
import { channelLabel } from "../util.ts";

const HOME_PREFIX = "__home__:";
export const homeId = (appId: string) => HOME_PREFIX + appId;
export const appIdFromHomeId = (id: string) => id.slice(HOME_PREFIX.length);
export const isHomeId = (id: string | null) => !!id && id.startsWith(HOME_PREFIX);

export function Sidebar({
  workspace,
  channels,
  users,
  apps,
  selectedId,
  onSelect,
}: {
  workspace: Workspace | null;
  channels: Channel[];
  users: User[];
  apps: AppInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const botUserIds = apps.map((a) => a.botUserId);
  const publicChannels = channels.filter((c) => !c.is_im);
  const dms = channels.filter((c) => c.is_im);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">{workspace?.name ?? "Workspace"}</div>

      <div className="sidebar-section">Channels</div>
      {publicChannels.map((c) => (
        <button
          key={c.id}
          className={`sidebar-item ${c.id === selectedId ? "active" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          <span className="hash">{c.is_private ? "🔒" : "#"}</span>
          {c.name}
        </button>
      ))}

      {dms.length > 0 && <div className="sidebar-section">Direct messages</div>}
      {dms.map((c) => (
        <button
          key={c.id}
          className={`sidebar-item ${c.id === selectedId ? "active" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          <span className="dot" /> {channelLabel(c, users, botUserIds)}
        </button>
      ))}

      <div className="sidebar-section">Apps</div>
      {apps.map((a) => (
        <button
          key={a.appId}
          className={`sidebar-item ${selectedId === homeId(a.appId) ? "active" : ""}`}
          onClick={() => onSelect(homeId(a.appId))}
        >
          <span className="hash">🏠</span> {a.botName}
          <span className={`app-dot ${a.connected ? "on" : "off"}`} title={a.connected ? "connected" : "offline"} />
        </button>
      ))}
    </aside>
  );
}
