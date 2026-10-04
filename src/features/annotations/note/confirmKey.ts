/** A key event as far as the confirm rule needs it (React's `KeyboardEvent` fits). */
interface KeyLike {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent: { isComposing?: boolean };
}

/** Enter confirms a note or comment field, Shift+Enter is a line break, and an Enter that belongs to an IME composition is left alone. */
export function isConfirmKey(event: KeyLike): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  // keyCode 229 is the legacy marker of a key handled by an IME.
  return event.nativeEvent.isComposing !== true && event.keyCode !== 229;
}
