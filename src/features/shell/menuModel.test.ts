import { describe, expect, it, vi } from 'vitest';

import { buildBarMenus, buildMenuEntries, disabledReasonKey, type MenuContext } from '../../actions/menuModel';
import { ACTIONS, getAction } from '../../actions/registry';
import { NO_DOCUMENT, type ActionState } from '../../actions/state';
import { translators, type PlainKey } from '../../i18n';

const context = (overrides: Partial<MenuContext> = {}): MenuContext => ({
  t: translators.en,
  platform: 'windows',
  state: { ...NO_DOCUMENT, hasDocument: true },
  run: vi.fn(),
  checked: () => undefined,
  hasTextSelection: false,
  recents: { items: [], clear: vi.fn() },
  ...overrides,
});

const labels = (menuId: string, ctx = context()) =>
  buildMenuEntries(menuId, ctx).map((entry) => (entry.type === 'separator' ? '-' : entry.label));

describe('the Windows menus built from menu.json', () => {
  it('are File, Edit, View, Tools and Help with their access keys, in English and German', () => {
    expect(buildBarMenus(context()).map((menu) => [menu.label, menu.access])).toEqual([
      ['File', 'F'],
      ['Edit', 'E'],
      ['View', 'V'],
      ['Tools', 'T'],
      ['Help', 'H'],
    ]);
    expect(buildBarMenus(context({ t: translators.de })).map((menu) => [menu.label, menu.access])).toEqual([
      ['Datei', 'D'],
      ['Bearbeiten', 'B'],
      ['Ansicht', 'A'],
      ['Werkzeuge', 'W'],
      ['Hilfe', 'H'],
    ]);
  });

  it('leave out the system items of macOS and never start, end or double a divider', () => {
    const edit = labels('edit');
    expect(edit).not.toContain('Cut');
    expect(edit.at(0)).not.toBe('-');
    expect(edit.at(-1)).not.toBe('-');
    expect(edit.join('|')).not.toContain('-|-');
    expect(edit).toEqual(expect.arrayContaining(['Undo', 'Redo', 'Delete', 'Add Comment', 'Find…']));
  });

  it('keep Settings, Exit, Full Screen and About for Windows', () => {
    expect(labels('file')).toEqual(expect.arrayContaining(['Settings…', 'Exit']));
    expect(labels('view')).toContain('Full Screen');
    expect(labels('help')).toEqual(['Welcome Tour', 'Show Tips Again', '-', 'About sheer.']);
  });

  it('take shortcuts from the registry, so the menu and the keys cannot differ', () => {
    const open = buildMenuEntries('file', context()).find((entry) => entry.id === 'open');
    expect(open?.type !== 'separator' && open?.shortcut).toBe('Ctrl+O');
  });

  it('enable Add Comment only with a text selection', () => {
    const find = (ctx: MenuContext) => {
      const entry = buildMenuEntries('edit', ctx).find((candidate) => candidate.id === 'add-comment');
      return entry?.type === 'separator' ? undefined : entry?.disabled;
    };
    expect(find(context({ hasTextSelection: false }))).toBe(true);
    expect(find(context({ hasTextSelection: true }))).toBe(false);
  });

  it('say why a disabled item is disabled, and only then', () => {
    const reason = (id: string, state: Partial<MenuContext['state']>) => {
      const menu = id === 'save' ? 'file' : 'tools';
      const entry = buildMenuEntries(menu, context({ state: { ...NO_DOCUMENT, hasDocument: true, ...state } })).find(
        (candidate) => candidate.id === id,
      );
      return entry?.type === 'separator' ? undefined : entry?.reason;
    };
    expect(reason('recognize-text', { ocrBusy: true })).toBe('Wait until text recognition finishes.');
    expect(reason('recognize-text', { canEdit: false })).toBe("This document can't be edited.");
    expect(reason('recognize-text', { ocrUnavailable: true })).toBe(
      "Text recognition isn't available on this computer.",
    );
    expect(reason('recognize-text', { signatureLocked: true, ocrBusy: true })).toBe(
      'Signed and locked. Make an editable copy to change it.',
    );
    expect(reason('header-footer', { signedFile: true })).toContain('signed');
    expect(reason('save', { ocrBusy: true })).toBe('Wait until text recognition finishes.');
    expect(reason('recognize-text', {})).toBeUndefined();
    expect(reason('save', {})).toBeUndefined();
  });

  it('says "select text first" for Add Comment and Cite on a signed document, not the signature reason', () => {
    const state = { ...NO_DOCUMENT, hasDocument: true, signedFile: true, canEdit: true };
    for (const id of ['add-comment', 'cite-selection']) {
      const action = getAction(id);
      if (action === undefined) throw new Error(id);
      // Signed files stay editable for comments here: only the selection is missing.
      if (action.enabled(state)) {
        expect(disabledReasonKey(action, context({ state }))).toBe('tool.needSelection');
        expect(disabledReasonKey(action, context({ state, hasTextSelection: true }))).toBeNull();
      }
    }
    const comment = getAction('add-comment');
    if (comment === undefined) throw new Error('add-comment');
    const open = { ...NO_DOCUMENT, hasDocument: true, canEdit: true };
    expect(disabledReasonKey(comment, context({ state: open }))).toBe('tool.needSelection');
    expect(disabledReasonKey(comment, context({ state: open, hasTextSelection: true }))).toBeNull();
  });

  it('names a reason only when it is a blocker that disables the item', () => {
    const base = { ...NO_DOCUMENT, hasDocument: true, canEdit: true, canPrint: true, canCopy: true };
    const cases: [PlainKey, Partial<ActionState>, Partial<ActionState>][] = [
      ['cert.locked.tool', { signatureLocked: true }, { signatureLocked: false }],
      ['hf.signed', { signedFile: true }, { signedFile: false }],
      ['tool.readOnly', { readOnly: true }, { readOnly: false }],
      ['tool.readOnly', { canEdit: false }, { canEdit: true }],
      ['ocr.busy', { ocrBusy: true }, { ocrBusy: false }],
      ['ocr.unavailable', { ocrUnavailable: true }, { ocrUnavailable: false }],
      ['output.notAllowed', { canPrint: false }, { canPrint: true }],
      ['output.notAllowed', { canCopy: false }, { canCopy: true }],
    ];
    for (const action of ACTIONS) {
      for (const [key, on, off] of cases) {
        const blocked: ActionState = { ...base, ...on };
        const reason = disabledReasonKey(action, context({ state: blocked, hasTextSelection: true }));
        const shouldName = !action.enabled(blocked) && action.enabled({ ...blocked, ...off });
        expect(reason, `${action.id} with ${key}`).toBe(shouldName ? key : null);
      }
    }
  });

  it('has the File menu of the design: the commands outside the modes, Close, Settings and Exit last', () => {
    expect(labels('file')).toEqual([
      'Open…',
      'Restore…',
      '-',
      'Save',
      'Save As…',
      'Export Copy…',
      'Export Images…',
      'Create PDF From Images…',
      'Compress…',
      '-',
      'Flatten Form…',
      'Protect…',
      'Document Properties…',
      'Signatures…',
      'Copy Citation List',
      'Save Citation List…',
      'Export Comments…',
      '-',
      'Print…',
      'Close Document',
      '-',
      'Settings…',
      'Exit',
    ]);
    expect(labels('file', context({ t: translators.de }))).toEqual(
      expect.arrayContaining([
        'Speichern',
        'Speichern unter…',
        'Kopie exportieren…',
        'Als Bilder exportieren…',
        'Drucken…',
        'Formular reduzieren…',
        'Dokumenteigenschaften…',
        'PDF aus Bildern erstellen…',
      ]),
    );
  });

  it('lose the Properties item in View', () => {
    expect(buildMenuEntries('view', context()).map((entry) => entry.id)).not.toContain('toggle-inspector');
  });

  it('list form highlight and signatures without mode items (F22.2), and no tools', () => {
    const entries = buildMenuEntries('tools', context());
    expect(labels('tools')).toEqual([
      'Highlight Form Fields',
      'Manage Signatures…',
      '-',
      'Recognize Text…',
      'Save As Text PDF…',
      'Headers & Footers…',
    ]);
    expect(entries.map((entry) => entry.id).some((id) => id.startsWith('tool-') || id.startsWith('mode-'))).toBe(false);
    expect(labels('tools', context({ t: translators.de })).slice(0, 2)).toEqual([
      'Formularfelder hervorheben',
      'Unterschriften verwalten…',
    ]);
  });

  it('run the action of the item and show its check state', () => {
    const run = vi.fn();
    const entries = buildMenuEntries('tools', context({ run, checked: (id) => id === 'form-highlight' }));
    const draw = entries.find((entry) => entry.id === 'form-highlight');
    if (draw === undefined || draw.type === 'separator') throw new Error('no form highlight');
    expect(draw.checked).toBe(true);
    draw.onSelect?.();
    expect(run).toHaveBeenCalledWith('form-highlight');
  });
});
