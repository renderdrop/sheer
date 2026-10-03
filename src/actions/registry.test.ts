import { describe, expect, it } from 'vitest';

import type { Platform } from '../api/app';
import { catalogs } from '../i18n/catalog';
import { translators } from '../i18n';
import { TOOLS } from '../stores/ui';
import { ACTIONS, ACTION_IDS, actionOf, actionShortcut, getAction, shortcutFor, type ActionId } from './registry';
import { isBareKey, resolveBinding } from './shortcut';
import { NO_DOCUMENT, type ActionState } from './state';

// Save and Save As join the menu bar with the Rust allowlist (src-tauri/src/menu/spec.rs); until then they are keyboard and More commands.
const PLATFORMS: readonly (Platform | null)[] = ['macos', 'windows', 'linux', null];
const WITH_DOCUMENT: ActionState = {
  hasDocument: true,
  zoomAtMin: false,
  zoomAtMax: false,
  canUndo: true,
  canRedo: true,
};

describe('the registry', () => {
  it('has the initial actions, one per tool, and no id twice', () => {
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    const expected: ActionId[] = [
      'open',
      'close-document',
      'save',
      'save-as',
      'undo',
      'redo',
      'zoom-in',
      'zoom-out',
      'actual-size',
      'fit-width',
      'fit-page',
      'scroll-continuous',
      'scroll-single',
      'scroll-spread',
      'next-page',
      'previous-page',
      'next-tab',
      'previous-tab',
      'go-to-page',
      'find',
      'find-next',
      'find-previous',
      'rotate-view-right',
      'rotate-view-left',
      'rotate-view-reset',
      'toggle-left-panel',
      'toggle-inspector',
      'settings',
      'about',
      ...TOOLS.map((tool): ActionId => `tool-${tool}`),
    ];
    expect([...ACTION_IDS].sort()).toEqual([...expected].sort());
  });

  it('finds an action by id, and nothing for a string that is not one', () => {
    expect(getAction('open')).toBe(actionOf('open'));
    for (const id of ['', 'Open', 'quit', 'toString', '__proto__', 'constructor', 'close_document']) {
      expect(getAction(id), id).toBeUndefined();
    }
  });

  it('names every action in both catalogs', () => {
    for (const action of ACTIONS) {
      for (const locale of ['en', 'de'] as const) {
        expect(catalogs[locale][action.labelKey], `${locale} ${action.id}`).toBeTruthy();
      }
    }
  });

  it('keeps tool actions together as their own group, and the rest out of it', () => {
    for (const action of ACTIONS) expect(action.group === 'tools', action.id).toBe(action.id.startsWith('tool-'));
  });
});

describe('shortcuts per platform', () => {
  /** What each action's chip says on each platform, in English: the table of ux-patterns section 5, resolved. */
  const LABELS: Readonly<Record<ActionId, { macos: string | null; windows: string | null }>> = {
    open: { macos: '⌘O', windows: 'Ctrl+O' },
    'close-document': { macos: '⌘W', windows: 'Ctrl+W' },
    save: { macos: '⌘S', windows: 'Ctrl+S' },
    'save-as': { macos: '⇧⌘S', windows: 'Ctrl+Shift+S' },
    undo: { macos: '⌘Z', windows: 'Ctrl+Z' },
    redo: { macos: '⇧⌘Z', windows: 'Ctrl+Y' },
    'zoom-in': { macos: '⌘+', windows: 'Ctrl++' },
    'zoom-out': { macos: '⌘−', windows: 'Ctrl+−' },
    'actual-size': { macos: '⌘1', windows: 'Ctrl+1' },
    'fit-width': { macos: '⌘2', windows: 'Ctrl+2' },
    'fit-page': { macos: '⌘0', windows: 'Ctrl+0' },
    'scroll-continuous': { macos: null, windows: null },
    'scroll-single': { macos: null, windows: null },
    'scroll-spread': { macos: null, windows: null },
    'next-page': { macos: '⌘↓', windows: 'Ctrl+↓' },
    'previous-page': { macos: '⌘↑', windows: 'Ctrl+↑' },
    'next-tab': { macos: '⇧⌘]', windows: 'Ctrl+PageDown' },
    'previous-tab': { macos: '⇧⌘[', windows: 'Ctrl+PageUp' },
    'go-to-page': { macos: '⇧⌘N', windows: 'Ctrl+Shift+N' },
    find: { macos: '⌘F', windows: 'Ctrl+F' },
    'find-next': { macos: '⌘G', windows: 'Ctrl+G' },
    'find-previous': { macos: '⇧⌘G', windows: 'Ctrl+Shift+G' },
    'rotate-view-right': { macos: '⌘R', windows: 'Ctrl+R' },
    'rotate-view-left': { macos: '⌘L', windows: 'Ctrl+L' },
    'rotate-view-reset': { macos: null, windows: null },
    'toggle-left-panel': { macos: '⌥⌘1', windows: 'F4' },
    'toggle-inspector': { macos: '⌥⌘I', windows: 'Shift+F4' },
    settings: { macos: '⌘,', windows: 'Ctrl+,' },
    about: { macos: null, windows: null },
    'tool-select': { macos: 'V', windows: 'V' },
    'tool-highlight': { macos: 'H', windows: 'H' },
    'tool-note': { macos: 'N', windows: 'N' },
    'tool-text': { macos: 'T', windows: 'T' },
    'tool-draw': { macos: 'D', windows: 'D' },
    'tool-shapes': { macos: 'R', windows: 'R' },
    'tool-form': { macos: 'F', windows: 'F' },
    'tool-signature': { macos: 'S', windows: 'S' },
    'tool-pages': { macos: 'P', windows: 'P' },
  };

  it('resolve to the platform modifier and the platform chip', () => {
    for (const action of ACTIONS) {
      const expected = LABELS[action.id];
      expect(actionShortcut(action, 'macos', translators.en)?.label ?? null, `macos ${action.id}`).toBe(expected.macos);
      for (const platform of ['windows', 'linux', null] as const) {
        expect(actionShortcut(action, platform, translators.en)?.label ?? null, `${platform} ${action.id}`).toBe(
          expected.windows,
        );
      }
    }
  });

  it('are written in the UI language on Windows and not on macOS', () => {
    expect(shortcutFor('open', 'windows', translators.de)?.label).toBe('Strg+O');
    expect(shortcutFor('toggle-inspector', 'windows', translators.de)?.label).toBe('Umschalt+F4');
    expect(shortcutFor('open', 'macos', translators.de)?.label).toBe('⌘O');
  });

  it('announce the key of the platform only', () => {
    expect(shortcutFor('open', 'windows', translators.en)?.aria).toBe('Control+O');
    expect(shortcutFor('open', 'macos', translators.en)?.aria).toBe('Meta+O');
    expect(shortcutFor('tool-draw', 'macos', translators.en)?.aria).toBe('D');
    expect(shortcutFor('about', 'macos', translators.en)).toBeNull();
  });

  it('never bind one key combination to two actions on the same platform', () => {
    for (const platform of PLATFORMS) {
      const seen = new Map<string, ActionId>();
      for (const action of ACTIONS) {
        const binding = resolveBinding(action.shortcut, platform);
        if (binding === null) continue;
        const mods = [...(binding.mods ?? [])].sort().join('+');
        const combination = `${mods}+${binding.key}`;
        expect(
          seen.get(combination),
          `${platform}: ${action.id} and ${seen.get(combination)} share ${combination}`,
        ).toBe(undefined);
        seen.set(combination, action.id);
      }
    }
  });

  it('turn pages with the primary modifier and the arrows, and never with Option or Alt: that is the thumbnails Move up and Move down (DESIGN 3.9)', () => {
    for (const platform of PLATFORMS) {
      for (const [id, key] of [
        ['next-page', 'ArrowDown'],
        ['previous-page', 'ArrowUp'],
      ] as const) {
        expect(resolveBinding(actionOf(id).shortcut, platform), `${platform} ${id}`).toEqual({
          key,
          mods: ['primary'],
        });
      }
      for (const action of ACTIONS) {
        const binding = resolveBinding(action.shortcut, platform);
        const arrow = binding?.key === 'ArrowUp' || binding?.key === 'ArrowDown';
        expect(arrow && binding.mods?.includes('alt') === true, `${platform} ${action.id}`).toBe(false);
      }
    }
  });

  it('never use Ctrl and Alt together off macOS (AltGr)', () => {
    for (const platform of ['windows', 'linux', null] as const) {
      for (const action of ACTIONS) {
        const mods = resolveBinding(action.shortcut, platform)?.mods ?? [];
        expect(mods.includes('primary') && mods.includes('alt'), `${platform} ${action.id}`).toBe(false);
      }
    }
  });

  it('make exactly the tool letters single-key shortcuts, so only they need the canvas focus', () => {
    for (const platform of PLATFORMS) {
      for (const action of ACTIONS) {
        const binding = resolveBinding(action.shortcut, platform);
        expect(binding !== null && isBareKey(binding), `${platform} ${action.id}`).toBe(action.group === 'tools');
      }
    }
  });

  it('keep every other shortcut to a modifier, an arrow or a function key', () => {
    for (const platform of PLATFORMS) {
      for (const action of ACTIONS) {
        const binding = resolveBinding(action.shortcut, platform);
        if (binding === null || action.group === 'tools') continue;
        const typesText = (binding.mods ?? []).every((mod) => mod === 'shift') && binding.key.length === 1;
        expect(typesText, `${platform} ${action.id}`).toBe(false);
      }
    }
  });
});

describe('enabled', () => {
  const enabledIds = (state: ActionState): ActionId[] =>
    ACTIONS.filter((action) => action.enabled(state)).map((action) => action.id);

  it('without a document only Open, Settings and About can run', () => {
    expect(enabledIds(NO_DOCUMENT)).toEqual(['open', 'settings', 'about']);
  });

  it('with a document everything can run, except a zoom step that is at its limit', () => {
    expect(enabledIds(WITH_DOCUMENT)).toEqual(ACTION_IDS);
    expect(enabledIds({ ...WITH_DOCUMENT, zoomAtMax: true })).not.toContain('zoom-in');
    expect(enabledIds({ ...WITH_DOCUMENT, zoomAtMax: true })).toContain('zoom-out');
    expect(enabledIds({ ...WITH_DOCUMENT, zoomAtMin: true })).not.toContain('zoom-out');
    expect(enabledIds({ ...WITH_DOCUMENT, zoomAtMin: true })).toContain('zoom-in');
    // The flags mean nothing without a document.
    expect(
      enabledIds({ hasDocument: false, zoomAtMin: false, zoomAtMax: false, canUndo: true, canRedo: true }),
    ).not.toContain('zoom-in');
  });

  it('is a pure question: asking changes nothing', () => {
    const before = JSON.stringify(enabledIds(WITH_DOCUMENT));
    enabledIds(WITH_DOCUMENT);
    expect(JSON.stringify(enabledIds(WITH_DOCUMENT))).toBe(before);
  });
});

describe('where an action is listed', () => {
  it('puts in More the commands that have no toolbar button, in groups', () => {
    const more = ACTIONS.filter((action) => action.more === true).map((action) => `${action.group}:${action.id}`);
    expect(more).toEqual([
      'file:open',
      'file:close-document',
      'file:save',
      'file:save-as',
      'edit:undo',
      'edit:redo',
      'view:actual-size',
      'view:fit-width',
      'view:fit-page',
      'view:scroll-continuous',
      'view:scroll-single',
      'view:scroll-spread',
      'page:next-page',
      'page:previous-page',
      'page:next-tab',
      'page:previous-tab',
      'page:go-to-page',
      'page:find',
      'page:find-next',
      'page:find-previous',
      'view:rotate-view-right',
      'view:rotate-view-left',
      'view:rotate-view-reset',
      'app:settings',
      'app:about',
    ]);
  });

  it('puts every action but the tools and About in the macOS menu bar (About is the system panel there)', () => {
    const inMenu = ACTIONS.filter((action) => action.menuBar === true).map((action) => action.id);
    // Find, Go to page and the view rotation join the menu bar with the Rust allowlist (src-tauri/src/menu/spec.rs); until then
    // they are keyboard and More commands.
    expect(inMenu).toEqual(ACTION_IDS.filter((id) => !id.startsWith('tool-') && id !== 'about'));
  });

  it('lets a held key repeat the zoom and page steps and nothing else', () => {
    expect(ACTIONS.filter((action) => action.repeat === true).map((action) => action.id)).toEqual([
      'zoom-in',
      'zoom-out',
      'next-page',
      'previous-page',
      'find-next',
      'find-previous',
    ]);
  });
});
