/**
 * "Add comment" (Edit menu, Cmd or Ctrl+Shift+M, DESIGN 3.56) is a command of the menu bars; what it does belongs to the comments
 * feature: it makes a Highlight with contents from the current text selection. The registry only announces the request here, and
 * the feature that owns the selection bar listens (`onAddComment`). With no listener, or no selection, nothing happens.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Asks the comments feature to add a comment to the current text selection. */
export function requestAddComment(): void {
  for (const listener of [...listeners]) listener();
}

/** Registers the feature that answers `add-comment`; returns the function that removes it. */
export function onAddComment(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the page has a text selection a comment could attach to (the menu item is enabled only then, on Windows). */
export function hasTextSelection(): boolean {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== '';
}
