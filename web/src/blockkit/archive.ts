import type { ArchiveTarget } from "../permalink.ts";

// Routes clicks on rendered /archives/… permalinks back to the app, so they jump
// to the message in place instead of reloading the page (set once by App.tsx) —
// same pattern as channels.ts.
let onArchiveClick: ((target: ArchiveTarget) => void) | null = null;

export function setArchiveClickHandler(fn: (target: ArchiveTarget) => void) {
  onArchiveClick = fn;
}

export function clickArchive(target: ArchiveTarget) {
  onArchiveClick?.(target);
}
