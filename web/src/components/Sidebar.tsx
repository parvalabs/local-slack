import type { Channel, User, Workspace } from "../types.ts";
import { channelLabel } from "../util.ts";

export const HOME_ID = "__home__";

export function Sidebar({
  workspace,
  channels,
  users,
  botUserId,
  botName,
  selectedId,
  onSelect,
}: {
  workspace: Workspace | null;
  channels: Channel[];
  users: User[];
  botUserId?: string;
  botName: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
          <span className="dot" /> {channelLabel(c, users, botUserId)}
        </button>
      ))}

      <div className="sidebar-section">Apps</div>
      <button
        className={`sidebar-item ${selectedId === HOME_ID ? "active" : ""}`}
        onClick={() => onSelect(HOME_ID)}
      >
        <span className="hash">🏠</span> {botName}
      </button>
    </aside>
  );
}
