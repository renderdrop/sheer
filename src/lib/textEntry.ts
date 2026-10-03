/** Input types that take no text: a key typed on them is not typing, so shortcuts still work there. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const EDITABLE =
  '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';

/**
 * Whether `target` is somewhere the user types: a text field, a text area, a select, or an element that is editable or
 * says it is a text box. A key pressed there belongs to the field, whatever shortcut it looks like.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest(EDITABLE) !== null;
}
