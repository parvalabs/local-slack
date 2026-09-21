import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Channel, User } from "../types.ts";
import { avatarColor, formatSize, initials, userLabel } from "../util.ts";

type TriggerKind = "user" | "channel";

interface TriggerQuery {
  start: number; // index of the '@' or '#' in the text
  kind: TriggerKind;
  query: string;
}

/** A confirmed reference: the [start, end) range in `text` currently displaying
 *  "@Real Name" or "#channel-name", and what it should serialize to on send.
 *  Offsets are kept in sync as the surrounding text is edited (see
 *  `applyEdit`); editing inside the range itself drops it back to plain,
 *  uncoupled text. */
interface RefSpan {
  start: number;
  end: number;
  kind: TriggerKind;
  id: string;
  channelName?: string; // only for kind "channel" — <#id|name> needs the name too
}

/** `handle` is the thing you actually *type* (a user's `name`, a channel's name),
 *  as opposed to `label`/`display` which show the friendlier real name — space
 *  autocompletion matches on it. */
type Candidate =
  | { kind: "user"; id: string; display: string; label: string; handle: string }
  | { kind: "channel"; id: string; display: string; label: string; handle: string };

/** If the cursor sits right after an "@word" or "#word" (word started at a
 *  line start or after whitespace), returns where that reference starts,
 *  which kind it is, and what's typed so far. */
function findTriggerQuery(text: string, cursor: number): TriggerQuery | null {
  let i = cursor;
  while (i > 0 && /[a-zA-Z0-9_'.-]/.test(text[i - 1])) i--;
  const trigger = text[i - 1];
  if (i > 0 && (trigger === "@" || trigger === "#")) {
    const before = text[i - 2];
    if (i - 1 === 0 || /\s/.test(before ?? "")) {
      return { start: i - 1, kind: trigger === "@" ? "user" : "channel", query: text.slice(i, cursor) };
    }
  }
  return null;
}

/** Diffs two strings assuming a single contiguous edit (true for normal typing,
 *  pasting, and deleting at a cursor/selection) — the region of `oldText` that
 *  was replaced, and what replaced it. */
function diffEdit(oldText: string, newText: string) {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { removedStart: start, removedEnd: oldEnd, insertedLength: newEnd - start };
}

/** Shifts spans after an edit; any span the edit touched is dropped (it reverts
 *  to plain text — editing into the middle of a reference un-links it). */
function applyEdit(spans: RefSpan[], oldText: string, newText: string): RefSpan[] {
  const { removedStart, removedEnd, insertedLength } = diffEdit(oldText, newText);
  const delta = insertedLength - (removedEnd - removedStart);
  const next: RefSpan[] = [];
  for (const s of spans) {
    if (s.end <= removedStart) next.push(s);
    else if (s.start >= removedEnd) next.push({ ...s, start: s.start + delta, end: s.end + delta });
    // else: the edit overlapped this span — drop it.
  }
  return next;
}

/** Builds the raw Slack-format text (<@USER_ID> / <#CHANNEL_ID|name> instead of
 *  the friendly display) to actually send, from the display text and spans. */
function serialize(text: string, spans: RefSpan[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const raw = s.kind === "user" ? `<@${s.id}>` : `<#${s.id}|${s.channelName}>`;
    out = out.slice(0, s.start) + raw + out.slice(s.end);
  }
  return out;
}

/**
 * Resolves leftover bare "@handle" / "#channel" text into real reference syntax
 * on send, so a fully typed handle links whether you finish it with space, Tab
 * or just Enter — no need to confirm the menu first.
 *
 * Exact matches only, the same rule space completion uses: a half-typed "@bo"
 * stays literal rather than guessing at a person. Runs *after* serialize, whose
 * output has references as "<@U…>" — the leading `(^|\s)` means the "@" inside
 * those is never re-matched, since it's preceded by "<".
 */
function resolveBareHandles(text: string, users: User[], channels: Channel[]): string {
  return text
    .replace(/(^|\s)@([a-zA-Z0-9._'-]+)/g, (whole, pre: string, handle: string) => {
      const u = users.find((x) => x.name.toLowerCase() === handle.toLowerCase());
      return u ? `${pre}<@${u.id}>` : whole;
    })
    .replace(/(^|\s)#([a-zA-Z0-9._-]+)/g, (whole, pre: string, name: string) => {
      const c = channels.find((x) => !x.is_im && x.name.toLowerCase() === name.toLowerCase());
      return c ? `${pre}<#${c.id}|${c.name}>` : whole;
    });
}

/**
 * Splits text into plain/reference chunks for the highlight overlay (see the
 * comment on `.composer-input-wrap` in styles.css for why this is a separate
 * div layered under a text-transparent textarea, not styling the textarea
 * itself — plain <textarea>s can't render styled substrings).
 */
function renderHighlighted(text: string, spans: RefSpan[]): React.ReactNode[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((s, i) => {
    if (s.start > cursor) parts.push(text.slice(cursor, s.start));
    parts.push(
      <span key={i} className="composer-mention">
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length || parts.length === 0) parts.push(text.slice(cursor));
  return parts;
}

/**
 * Unsent text, kept per conversation. What you type in a thread belongs to that
 * thread (and each channel keeps its own), the way Slack holds a draft in place
 * rather than carrying it along as you move around.
 *
 * Spans ride along with the text: dropping them would turn already-resolved
 * mentions back into plain "@Name" on restore. So do attached files. Session-only
 * by design — a draft doesn't survive a reload.
 *
 * Callers pass `draftKey` *and* use it as React's `key`, so switching
 * conversations remounts the composer and re-seeds state from here.
 */
const drafts = new Map<string, { text: string; spans: RefSpan[]; attachments: File[] }>();

export function Composer({
  draftKey,
  placeholder,
  onSend,
  users = [],
  channels = [],
}: {
  draftKey: string;
  placeholder: string;
  /** May return a promise (an upload); if it rejects, the message is put back. */
  onSend: (text: string, attachments: File[]) => void | Promise<void>;
  users?: User[];
  channels?: Channel[];
}) {
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? "");
  const [spans, setSpans] = useState<RefSpan[]>(() => drafts.get(draftKey)?.spans ?? []);
  const [attachments, setAttachments] = useState<File[]>(() => drafts.get(draftKey)?.attachments ?? []);
  const [trigger, setTrigger] = useState<TriggerQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Also clears the entry once the box is empty, so a sent message doesn't leave
  // a stale draft behind.
  useEffect(() => {
    if (text || attachments.length) drafts.set(draftKey, { text, spans, attachments });
    else drafts.delete(draftKey);
  }, [draftKey, text, spans, attachments]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Grows the textarea to fit its content (capped by the CSS max-height, past
  // which it scrolls normally) — the height reset to "auto" first is what lets
  // it shrink back down when text is deleted, not just grow.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const matches = useMemo((): Candidate[] => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === "user") {
      return users
        .filter((u) => u.name.toLowerCase().includes(q) || (u.real_name ?? "").toLowerCase().includes(q))
        .slice(0, 8)
        .map((u) => ({
          kind: "user" as const,
          id: u.id,
          display: `@${u.real_name || u.name}`,
          label: u.real_name || u.name,
          handle: u.name,
        }));
    }
    return channels
      .filter((c) => !c.is_im && c.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => ({ kind: "channel" as const, id: c.id, display: `#${c.name}`, label: c.name, handle: c.name }));
  }, [trigger, users, channels]);

  const send = () => {
    const trimmed = resolveBareHandles(serialize(text, spans), users, channels).trim();
    if (!trimmed && !attachments.length) return;
    const sent = { text, spans, attachments };
    const result = onSend(trimmed, attachments);
    setText("");
    setSpans([]);
    setAttachments([]);
    setTrigger(null);
    setError(null);
    result?.catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setText(sent.text);
      setSpans(sent.spans);
      setAttachments(sent.attachments);
    });
  };

  const addFiles = (files: FileList | null | undefined) => {
    if (files?.length) setAttachments((prev) => [...prev, ...Array.from(files)]);
  };
  // Only react to drags that carry files, not e.g. selected text being dragged.
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  const selectCandidate = (c: Candidate) => {
    if (!trigger) return;
    const before = text.slice(0, trigger.start);
    const after = text.slice(trigger.start + 1 + trigger.query.length);
    const insertion = `${c.display} `;
    const newText = before + insertion + after;

    setSpans((prev) => [
      ...applyEdit(prev, text, before + after), // shift/drop existing spans past the removed query
      {
        start: before.length,
        end: before.length + c.display.length,
        kind: c.kind,
        id: c.id,
        channelName: c.kind === "channel" ? c.label : undefined,
      },
    ]);
    setText(newText);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setSpans((prev) => applyEdit(prev, text, value));
    setText(value);
    setTrigger(findTriggerQuery(value, e.target.selectionStart ?? value.length));
    setActiveIndex(0);
  };

  return (
    <div
      className={`composer ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // dragleave also fires moving between the composer's own children.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
        textareaRef.current?.focus();
      }}
    >
      {error && <div className="composer-error">Couldn't send: {error}</div>}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((f, i) => (
            <span key={`${i}:${f.name}`} className="composer-attachment" title={f.name}>
              <span aria-hidden="true">{f.type.startsWith("image/") ? "🖼️" : "📄"}</span>
              <span className="composer-attachment-name">{f.name}</span>
              <span className="composer-attachment-size">{formatSize(f.size)}</span>
              <button
                className="composer-attachment-remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = ""; // so picking the same file again still fires onChange
        }}
      />
      <button
        className="composer-attach"
        title="Attach files"
        aria-label="Attach files"
        onClick={() => fileInputRef.current?.click()}
      >
        📎
      </button>
      {trigger && matches.length > 0 && (
        <div className="mention-list">
          {matches.map((c, i) => (
            <button
              key={`${c.kind}:${c.id}`}
              className={`mention-option ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus so selectCandidate's own focus() wins
                selectCandidate(c);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {c.kind === "user" ? (
                <>
                  <span className="mention-option-avatar" style={{ background: avatarColor(c.id) }}>
                    {initials(userLabel(users, c.id))}
                  </span>
                  <span className="mention-option-name">{c.label}</span>
                  <span className="mention-option-handle">{c.display}</span>
                </>
              ) : (
                <>
                  <span className="mention-option-avatar mention-option-channel">#</span>
                  <span className="mention-option-name">{c.label}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
          {renderHighlighted(text, spans)}
        </div>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          placeholder={placeholder}
          rows={1}
          onChange={onChange}
          onPaste={(e) => {
            // A pasted screenshot or copied file arrives as clipboard files; keep
            // it from also pasting its name as text.
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (trigger && matches.length > 0) {
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
                selectCandidate(matches[activeIndex]);
                return;
              }
              // Space confirms the reference when what you typed *is* the handle,
              // the way finishing "@alice " in Slack links it without a keystroke.
              // Deliberately an exact match rather than "whatever's highlighted":
              // on a prefix like "@al" the highlighted row is a guess, and silently
              // turning plain text into the wrong person is worse than making you
              // press Tab. selectCandidate appends the space itself.
              if (e.key === " ") {
                const exact = matches.find(
                  (c) => c.handle.toLowerCase() === trigger.query.toLowerCase(),
                );
                if (exact) {
                  e.preventDefault();
                  selectCandidate(exact);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onBlur={() => setTrigger(null)}
        />
      </div>
      <button className="composer-send" onClick={send} disabled={!text.trim() && !attachments.length}>
        Send
      </button>
    </div>
  );
}
