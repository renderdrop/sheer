import type { Platform } from '../api/app';
import type { MenuEntry } from '../components';
import { APP_NAME } from '../config/app';
import { isPlainKey, type PlainKey, type Translate } from '../i18n';
import layoutJson from './menu.json';
import { MODES } from '../stores/ui';
import { actionShortcut, getAction, type ActionDef } from './registry';
import type { ActionState } from './state';

/**
 * The in-window menu bar of Windows (DESIGN 3.56) as data. It is built from the same `menu.json` as the native macOS menu, so the
 * labels, the order and the shortcuts cannot drift: a label is the item's catalog key, the shortcut and the enabled state come
 * from the action of the registry. Items marked `"platform": "windows"` are only here; system items (`predefined`, which AppKit acts
 * on) and the app and Window menus are macOS's and are left out.
 */
interface ActionItem {
  action: string;
  label: string;
  platform?: 'windows' | 'macos';
}
interface SeparatorItem {
  separator: true;
  platform?: 'windows' | 'macos';
}
interface PredefinedItem {
  predefined: string;
}
interface SubmenuItem {
  submenu: string;
  label: string;
  clearLabel?: string;
  platform?: 'windows' | 'macos';
}
type Item = ActionItem | SeparatorItem | PredefinedItem | SubmenuItem;
interface MenuSpec {
  id: string;
  label?: string;
  access?: string;
  items: Item[];
}
interface Layout {
  barLabel?: string;
  menus: MenuSpec[];
}

const layout = layoutJson as Layout;

const MODE_ACTION = /^mode-(.+)$/;
const MODE_ORDER: readonly string[] = MODES;

/** The label of the bar for assistive technology (`menu.bar`). */
export const BAR_LABEL_KEY: string = layout.barLabel ?? 'menu.bar';

/** One recent file of the Open recent submenu. */
export interface RecentItem {
  id: string;
  label: string;
  onSelect: () => void;
}

export interface MenuContext {
  t: Translate;
  platform: Platform | null;
  /** What the actions' `enabled` looks at. */
  state: ActionState;
  /** Runs an action of the registry (`runAction`). */
  run: (id: string) => void;
  /** Whether the action's menu item shows a check: the active tool, the sidebar, a view mode. `undefined`: it has none. */
  checked: (id: string) => boolean | undefined;
  /** The page has a text selection (Add comment needs one). */
  hasTextSelection: boolean;
  /** The recent files, newest first, and what Clear does. */
  recents: { items: readonly RecentItem[]; clear: () => void };
}

/** A menu of the bar. */
export interface BarMenu {
  id: string;
  /** The title, already translated. */
  label: string;
  /** The access key letter (Alt plus this opens the menu), already translated. */
  access: string;
  entries: MenuEntry[];
}

/** The text of a catalog key given as data; the key itself when it is not one (a gap shows up as a key). */
function text(t: Translate, key: string): string {
  return isPlainKey(key) ? t(key, { app: APP_NAME }) : key;
}

/** The menus of the bar that Windows draws, in order, without their entries (for the bar's titles and its keys). */
const SPECS = layout.menus.flatMap((menu) =>
  menu.label === undefined || menu.access === undefined
    ? []
    : [{ id: menu.id, labelKey: menu.label, accessKey: menu.access }],
);

export function barMenuSpecs(): readonly { id: string; labelKey: string; accessKey: string }[] {
  return SPECS;
}

/** Actions that also need a text selection on the page. */
const NEEDS_SELECTION = new Set(['add-comment', 'cite-selection']);

function isEnabled(action: ActionDef, context: MenuContext): boolean {
  if (!action.enabled(context.state)) return false;
  return !NEEDS_SELECTION.has(action.id) || context.hasTextSelection;
}

/**
 * Why a disabled action cannot run, as a catalog key, derived from the predicate that really disables it (`action.enabled` on the
 * state, then the text selection). Order, the blocker the user cannot lift in place first: the state blockers (signature lock,
 * signed file, read-only, running recognition, no recognizer, permissions) while `enabled` still refuses; only an action that
 * `enabled` allows and that lacks a text selection says "select text first". A state blocker counts only when it is necessary
 * (the action stays disabled when all the others are lifted), so an unrelated blocker is never named. `null` when it is enabled,
 * there is no document, or the cause has no reason text (zoom at its limit, nothing to undo).
 */
export function disabledReasonKey(action: ActionDef, context: MenuContext): PlainKey | null {
  const { state } = context;
  if (!state.hasDocument || isEnabled(action, context)) return null;
  if (action.enabled(state)) return 'tool.needSelection';
  const blockers: [PlainKey, boolean, Partial<ActionState>][] = [
    ['cert.locked.tool', state.signatureLocked === true, { signatureLocked: false }],
    ['hf.signed', state.signedFile === true, { signedFile: false }],
    ['tool.readOnly', state.readOnly === true || state.canEdit === false, { readOnly: false, canEdit: true }],
    ['ocr.busy', state.ocrBusy === true, { ocrBusy: false }],
    ['ocr.unavailable', state.ocrUnavailable === true, { ocrUnavailable: false }],
    ['output.notAllowed', state.canPrint === false || state.canCopy === false, { canPrint: true, canCopy: true }],
  ];
  const present = blockers.filter(([, there]) => there);
  const liftedWithout = (skip: number | null): ActionState =>
    present.reduce((acc, [, , patch], index) => (index === skip ? acc : { ...acc, ...patch }), state);
  // Not enabled even with every known blocker lifted: the cause is none of them.
  if (!action.enabled(liftedWithout(null))) return null;
  // A necessary blocker: keeping only this one still disables the action.
  const necessary = present.findIndex((_, index) => !action.enabled(liftedWithout(index)));
  if (necessary >= 0) return present[necessary]?.[0] ?? null;
  // Redundant blockers (any one of several suffices): the first whose removal alone enables the action.
  const sole = present.findIndex(([, , patch]) => action.enabled({ ...state, ...patch }));
  return present[sole >= 0 ? sole : 0]?.[0] ?? null;
}

/** Drops a separator that starts or ends the list or follows another one. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator' && (out.length === 0 || out.at(-1)?.type === 'separator')) continue;
    out.push(entry);
  }
  while (out.at(-1)?.type === 'separator') out.pop();
  return out;
}

function recentEntries(context: MenuContext, clearLabel: string | undefined): MenuEntry[] {
  const { items, clear } = context.recents;
  const entries: MenuEntry[] = items.map((item) => ({
    id: `recent:${item.id}`,
    label: item.label,
    onSelect: item.onSelect,
  }));
  if (clearLabel !== undefined && items.length > 0) {
    entries.push({ type: 'separator', id: 'recent:divider' });
    entries.push({ id: 'recent:clear', label: text(context.t, clearLabel), onSelect: clear });
  }
  return entries;
}

function reasonText(action: ActionDef, context: MenuContext): string | undefined {
  const key = disabledReasonKey(action, context);
  return key === null ? undefined : context.t(key);
}

/** The entries of one menu of the layout for the Windows bar. */
export function buildMenuEntries(menuId: string, context: MenuContext): MenuEntry[] {
  const menu = layout.menus.find((candidate) => candidate.id === menuId);
  if (menu === undefined) return [];
  const entries: MenuEntry[] = [];
  menu.items.forEach((item, index) => {
    if ('predefined' in item) return;
    if ('platform' in item && item.platform === 'macos') return;
    if ('separator' in item) {
      entries.push({ type: 'separator', id: `separator:${index}` });
      return;
    }
    if ('submenu' in item) {
      const submenu = recentEntries(context, item.clearLabel);
      entries.push({
        id: `submenu:${item.submenu}`,
        label: text(context.t, item.label),
        // Nothing to open when there are no recent files.
        disabled: submenu.length === 0,
        submenu,
      });
      return;
    }
    const action = getAction(item.action);
    if (action === undefined) return;
    const shortcut = actionShortcut(action, context.platform, context.t);
    // The modes are radio items; the digit that switches them is hint text here, never an accelerator.
    const mode = MODE_ACTION.exec(action.id)?.[1];
    const radio = mode !== undefined;
    entries.push({
      id: action.id,
      label: text(context.t, item.label),
      icon: action.icon,
      shortcut: radio ? String(MODE_ORDER.indexOf(mode) + 1) : shortcut?.label,
      checked: radio ? context.checked(action.id) === true : context.checked(action.id),
      radio: radio || undefined,
      disabled: !isEnabled(action, context),
      reason: reasonText(action, context),
      onSelect: () => context.run(action.id),
    });
  });
  return tidy(entries);
}

/** Every menu of the Windows bar with its entries. */
export function buildBarMenus(context: MenuContext): BarMenu[] {
  return barMenuSpecs().map((spec) => ({
    id: spec.id,
    label: text(context.t, spec.labelKey),
    access: text(context.t, spec.accessKey),
    entries: buildMenuEntries(spec.id, context),
  }));
}
