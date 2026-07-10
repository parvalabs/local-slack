import { useState } from "react";
import { customEmojis } from "../blockkit/emoji.ts";

// A small fixed set covers the common testing cases; the text field covers everything else.
const COMMON: { emoji: string; name: string }[] = [
  { emoji: "👍", name: "+1" },
  { emoji: "❤️", name: "heart" },
  { emoji: "😂", name: "joy" },
  { emoji: "🎉", name: "tada" },
  { emoji: "👀", name: "eyes" },
  { emoji: "✅", name: "white_check_mark" },
  { emoji: "🚀", name: "rocket" },
  { emoji: "😢", name: "cry" },
];

export function EmojiPicker({ onPick, onClose }: { onPick: (name: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");

  return (
    <div className="emoji-picker-overlay" onClick={onClose}>
      <div className="emoji-picker" onClick={(e) => e.stopPropagation()}>
        <div className="emoji-grid">
          {COMMON.map((e) => (
            <button key={e.name} className="emoji-option" title={`:${e.name}:`} onClick={() => onPick(e.name)}>
              {e.emoji}
            </button>
          ))}
          {[...customEmojis.entries()].map(([name, url]) => (
            <button key={name} className="emoji-option" title={`:${name}:`} onClick={() => onPick(name)}>
              <img className="emoji-img" src={url} alt={`:${name}:`} />
            </button>
          ))}
        </div>
        <form
          className="emoji-custom"
          onSubmit={(e) => {
            e.preventDefault();
            const name = custom.trim().replace(/^:|:$/g, "");
            if (name) onPick(name);
          }}
        >
          <input
            className="emoji-custom-input"
            placeholder="custom_emoji_name"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            autoFocus
          />
        </form>
      </div>
    </div>
  );
}
