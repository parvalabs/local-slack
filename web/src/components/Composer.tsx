import { useMemo, useRef, useState } from "react";
import type { User } from "../types.ts";
import { avatarColor, initials, userLabel } from "../util.ts";

interface MentionQuery {
  start: number; // index of the '@' in the text
  query: string;
}

/** If the cursor sits right after an "@word" (word started at a line start or
 *  after whitespace), returns where that mention starts and what's typed so far. */
function findMentionQuery(text: string, cursor: number): MentionQuery | null {
  let i = cursor;
  while (i > 0 && /[a-zA-Z0-9_'.-]/.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === "@") {
    const before = text[i - 2];
    if (i - 1 === 0 || /\s/.test(before ?? "")) {
      return { start: i - 1, query: text.slice(i, cursor) };
    }
  }
  return null;
}

export function Composer({
  placeholder,
  onSend,
  users = [],
}: {
  placeholder: string;
  onSend: (text: string) => void;
  users?: User[];
}) {
  const [text, setText] = useState("");
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return users
      .filter((u) => u.name.toLowerCase().includes(q) || (u.real_name ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, users]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    setMention(null);
  };

  const selectMention = (user: User) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const insertion = `<@${user.id}> `;
    const newText = before + insertion + after;
    setText(newText);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    setMention(findMentionQuery(value, e.target.selectionStart ?? value.length));
    setActiveIndex(0);
  };

  return (
    <div className="composer">
      {mention && matches.length > 0 && (
        <div className="mention-list">
          {matches.map((u, i) => (
            <button
              key={u.id}
              className={`mention-option ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus so selectMention's own focus() wins
                selectMention(u);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="mention-option-avatar" style={{ background: avatarColor(u.id) }}>
                {initials(userLabel(users, u.id))}
              </span>
              <span className="mention-option-name">{u.real_name || u.name}</span>
              <span className="mention-option-handle">@{u.name}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        placeholder={placeholder}
        rows={1}
        onChange={onChange}
        onKeyDown={(e) => {
          if (mention && matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => (i + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              selectMention(matches[activeIndex]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onBlur={() => setMention(null)}
      />
      <button className="composer-send" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}
