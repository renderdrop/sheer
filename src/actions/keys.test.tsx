// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Platform } from '../api/app';
import type { DocumentInfo } from '../api/documents';
import { useSettingsPopover } from '../features/settings/state';
import { useViewer } from '../features/viewer/useViewer';
import { useAnnotations } from '../stores/annotations';
import { useSettings } from '../stores/settings';
import { activeDocument, opened, resetDocuments } from '../stores/documents.testutil';
import { useUi } from '../stores/ui';
import { useView } from '../stores/view';
import { ActionKeys, handleKeyDown, isImeEvent, isInCanvas, isInModal, isTextEntry, useActionKeys } from './keys';
import { ACTIONS } from './registry';
import { resolveBinding, type Binding } from './shortcut';
import { NO_DOCUMENT } from './state';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../api/documents', () => documentsApi);
vi.mock('../api/render', () => ({
  renderPage: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  getPageSizes: vi.fn().mockResolvedValue([]),
}));

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const settingsInitial = useSettings.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useSettingsPopover.setState({ open: false });
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useAnnotations.setState({ byDoc: {} });
  useView.setState({ byDoc: {} });
  useSettings.setState({ ...settingsInitial, platform: null }, true);
}

/** The window's key listener, mounted for every test the way the shell mounts it. */
let keys: ReturnType<typeof render>;

beforeEach(() => {
  reset();
  keys = render(<ActionKeys />);
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
});

afterEach(reset);

const setPlatform = (platform: Platform | null) => useSettings.setState({ platform });
const openDocument = () => act(() => useViewer.getState().open());
const zoom = () => useView.getState().byDoc[REPORT.id]?.zoom;

/** Presses a key at `target` the way the browser would, and returns the event (cancelable, so `defaultPrevented` tells). */
function press(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
}

/**
 * The elements the handler reasons about, in a document body that goes away after the test. The markup is a literal of the test,
 * never data, which is why this one helper may parse it (the lint rule against DOMParser is for strings from outside).
 */
function build(html: string): HTMLElement {
  const host = document.createElement('div');
  // eslint-disable-next-line no-restricted-syntax -- fixture markup written in this file, not an untrusted string
  host.append(...new DOMParser().parseFromString(html, 'text/html').body.childNodes);
  document.body.append(host);
  return host;
}

describe('the primary modifier', () => {
  it('is Ctrl on Windows and Linux, and until the platform is known', async () => {
    await openDocument();
    for (const platform of ['windows', 'linux', null] as const) {
      setPlatform(platform);
      useView.getState().setZoom(REPORT.id, 1);
      press({ key: '+', ctrlKey: true });
      expect(zoom(), `${platform} ctrl`).toBe(1.1);
      press({ key: '+', metaKey: true });
      expect(zoom(), `${platform} meta`).toBe(1.1);
    }
  });

  it('is Cmd on macOS, and Control does nothing there', async () => {
    await openDocument();
    setPlatform('macos');
    press({ key: '+', metaKey: true });
    expect(zoom()).toBe(1.1);
    const control = press({ key: '+', ctrlKey: true });
    expect(zoom()).toBe(1.1);
    expect(control.defaultPrevented).toBe(false);
  });

  it('opens with Ctrl+O on Windows and with Cmd+O on macOS', async () => {
    press({ key: 'o', ctrlKey: true });
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    // Let the dialog finish: a second Open while one is up is refused by the viewer.
    await act(async () => undefined);
    setPlatform('macos');
    press({ key: 'o', ctrlKey: true });
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    press({ key: 'O', metaKey: true });
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(2);
  });
});

describe('the bindings', () => {
  beforeEach(async () => {
    await openDocument();
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  });

  it('zoom with plus, equals, minus and underscore, and Ctrl+1, Ctrl+2 and Ctrl+0 are Actual Size, Fit Width and Fit Page', () => {
    act(() => useViewer.getState().setViewport({ width: 816 + 16, height: 528 }));
    press({ key: '+', ctrlKey: true });
    press({ key: '=', ctrlKey: true });
    expect(zoom()).toBe(1.25);
    press({ key: '-', ctrlKey: true });
    press({ key: '_', ctrlKey: true, shiftKey: true });
    expect(zoom()).toBe(1);
    press({ key: '0', code: 'Digit0', ctrlKey: true });
    expect(zoom()).toBeCloseTo(0.5);
    press({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(zoom()).toBe(1);
    press({ key: '2', code: 'Digit2', ctrlKey: true });
    expect(zoom()).toBeCloseTo(1);
    useView.getState().setZoom(REPORT.id, 3);
    press({ key: '1', ctrlKey: true });
    expect(zoom()).toBe(1);
  });

  it('Ctrl+Down and Ctrl+Up turn pages, F4 and Shift+F4 toggle the panels on Windows', () => {
    press({ key: 'ArrowDown', ctrlKey: true });
    press({ key: 'ArrowDown', ctrlKey: true });
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(2);
    press({ key: 'ArrowUp', ctrlKey: true });
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
    press({ key: 'F4' });
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    press({ key: 'F4', shiftKey: true });
    expect(useUi.getState().inspector).toBe('open');
  });

  it('Option+Cmd+1 and Option+Cmd+I toggle the panels on macOS, although Option changes the characters', () => {
    setPlatform('macos');
    press({ key: '¡', code: 'Digit1', altKey: true, metaKey: true });
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    press({ key: 'ˆ', code: 'KeyI', altKey: true, metaKey: true });
    expect(useUi.getState().inspector).toBe('open');
    // F4 is not the macOS key.
    press({ key: 'F4' });
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
  });

  it('Cmd+Down and Cmd+Up turn pages on macOS, where Control with the arrows does nothing', () => {
    setPlatform('macos');
    press({ key: 'ArrowDown', metaKey: true });
    press({ key: 'ArrowDown', metaKey: true });
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(2);
    press({ key: 'ArrowUp', metaKey: true });
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
    expect(press({ key: 'ArrowDown', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
  });

  it('Alt+Down and Alt+Up are not page keys (they move a thumbnail), so the browser keeps them', () => {
    for (const platform of ['windows', 'macos'] as const) {
      setPlatform(platform);
      for (const key of ['ArrowDown', 'ArrowUp']) {
        expect(press({ key, altKey: true }).defaultPrevented, `${platform} ${key}`).toBe(false);
      }
    }
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
  });

  it('Ctrl+W closes the document', () => {
    press({ key: 'w', ctrlKey: true });
    expect(activeDocument()).toBeNull();
  });

  it('a key that is not bound, or is bound with other modifiers, does nothing and is left to the browser', () => {
    for (const init of [
      { key: 'q', ctrlKey: true },
      { key: 'o', ctrlKey: true, shiftKey: true },
      { key: 'o', ctrlKey: true, altKey: true },
      { key: 'o' },
      { key: 'F5' },
      { key: 'Escape' },
      { key: 'ArrowDown' },
      { key: 'ArrowDown', ctrlKey: true, shiftKey: true },
      { key: 'ArrowDown', altKey: true },
    ]) {
      const event = press(init);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(zoom()).toBe(1);
  });

  it('takes the browser meaning of a key it binds away (Ctrl and plus would zoom the window)', () => {
    expect(press({ key: '+', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'w', ctrlKey: true, cancelable: true }).defaultPrevented).toBe(true);
  });

  it('takes it away also when the action cannot run, and does not run it', () => {
    act(() => useViewer.getState().close());
    documentsApi.closeDocument.mockClear();
    for (const init of [{ key: '+', ctrlKey: true }, { key: 'w', ctrlKey: true }, { key: 'F4' }]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(true);
    }
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });
});

describe('repeating keys', () => {
  it('a held zoom or page key repeats, a held Open or Close key does not run again', async () => {
    await openDocument();
    press({ key: '+', ctrlKey: true, repeat: true });
    press({ key: '+', ctrlKey: true, repeat: true });
    expect(zoom()).toBe(1.25);
    press({ key: 'ArrowDown', ctrlKey: true, repeat: true });
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
    documentsApi.openDocumentDialog.mockClear();
    const held = press({ key: 'o', ctrlKey: true, repeat: true });
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
    expect(held.defaultPrevented).toBe(true);
    press({ key: 'F4', repeat: true });
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
  });
});

describe('inputs keep their keys', () => {
  beforeEach(async () => {
    await openDocument();
  });

  const TEXT_FIELDS: Readonly<Record<string, string>> = {
    'a text input': '<input type="text" />',
    'an input without a type': '<input />',
    'a number input': '<input type="number" />',
    'a search input': '<input type="search" />',
    'a password input': '<input type="password" />',
    'a text area': '<textarea></textarea>',
    'a select': '<select><option>1</option></select>',
    'an editable element': '<div contenteditable="true" id="target">x</div>',
    'a child of an editable element': '<div contenteditable="true"><span id="target">x</span></div>',
    'a text box role': '<div role="textbox" tabindex="0"></div>',
    'a combobox': '<div role="combobox" tabindex="0"></div>',
    'a spin button': '<div role="spinbutton" tabindex="0"></div>',
  };

  for (const [name, html] of Object.entries(TEXT_FIELDS)) {
    it(`ignores every key pressed in ${name}`, () => {
      const host = build(html);
      const target = host.querySelector<HTMLElement>('#target') ?? (host.firstElementChild as HTMLElement);
      for (const init of [
        { key: '+', ctrlKey: true },
        { key: 'o', ctrlKey: true },
        { key: 'w', ctrlKey: true },
        { key: 'v' },
        { key: 'F4' },
        { key: 'ArrowDown', ctrlKey: true },
      ]) {
        const event = press(init, target);
        expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
      }
      expect(zoom()).toBe(1);
      expect(activeDocument()).not.toBeNull();
      expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
      expect(useUi.getState().activeTool).toBe('select');
    });
  }

  it('does not ignore a button, a checkbox, a range or a plain element: nobody types there', () => {
    const host = build(
      '<button id="b">b</button><input id="c" type="checkbox" /><input id="r" type="range" /><div id="d" tabindex="0"></div>',
    );
    for (const id of ['b', 'c', 'r', 'd']) {
      useView.getState().setZoom(REPORT.id, 1);
      press({ key: '+', ctrlKey: true }, host.querySelector(`#${id}`) as HTMLElement);
      expect(zoom(), id).toBe(1.1);
    }
  });

  it('tells a text entry from anything else', () => {
    const host = build('<input id="t" /><button id="b"></button>');
    expect(isTextEntry(host.querySelector('#t'))).toBe(true);
    expect(isTextEntry(host.querySelector('#b'))).toBe(false);
    expect(isTextEntry(window)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('single-key shortcuts need the canvas', () => {
  beforeEach(async () => {
    await openDocument();
  });

  const canvas = () =>
    build(
      '<main data-action-scope="canvas"><div id="region" role="region" tabindex="0"><span id="inner"></span></div></main><button id="outside">x</button>',
    );

  it('select a tool when the focus is in the canvas, wherever in it', () => {
    const host = canvas();
    press({ key: 'h' }, host.querySelector('#region') as HTMLElement);
    expect(useUi.getState().activeTool).toBe('highlight');
    press({ key: 'D' }, host.querySelector('#inner') as HTMLElement);
    expect(useUi.getState().activeTool).toBe('draw');
    press({ key: 'v' }, host.querySelector('main') as HTMLElement);
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('do nothing anywhere else: on the window, the body, a toolbar button or another region', () => {
    const host = canvas();
    for (const target of [window, document.body, host.querySelector('#outside') as HTMLElement]) {
      const event = press({ key: 'h' }, target);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('are not a letter with Ctrl, Alt or Cmd, and not typed with Shift held', () => {
    const host = canvas();
    const region = host.querySelector('#region') as HTMLElement;
    for (const init of [
      { key: 'h', ctrlKey: true },
      { key: 'h', altKey: true },
      { key: 'h', metaKey: true },
      { key: 'H', shiftKey: true },
    ]) {
      press(init, region);
    }
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('work in a document without a text layer yet, and not without a document', () => {
    const host = canvas();
    const region = host.querySelector('#region') as HTMLElement;
    act(() => useViewer.getState().close());
    const event = press({ key: 'h' }, region);
    expect(useUi.getState().activeTool).toBe('select');
    // The letter still belongs to the app's bindings, so it is not left to the browser either.
    expect(event.defaultPrevented).toBe(true);
  });

  it('tells the canvas from the rest', () => {
    const host = canvas();
    expect(isInCanvas(host.querySelector('#inner'))).toBe(true);
    expect(isInCanvas(host.querySelector('main'))).toBe(true);
    expect(isInCanvas(host.querySelector('#outside'))).toBe(false);
    expect(isInCanvas(window)).toBe(false);
  });
});

describe('events somebody else has handled', () => {
  it('a key that was already prevented (a menu took the arrow) is not run again', async () => {
    await openDocument();
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true });
    event.preventDefault();
    expect(handleKeyDown(event, 'windows')).toBe(false);
    expect(zoom()).toBe(1);
  });

  it('a key pressed during an IME composition is not a shortcut', async () => {
    await openDocument();
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true, isComposing: true });
    expect(handleKeyDown(event, 'windows')).toBe(false);
    expect(zoom()).toBe(1);
  });

  it('nor is the keydown that ends one in WebKit, which reports key code 229 and isComposing false', async () => {
    await openDocument();
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true, keyCode: 229 });
    expect(event.isComposing).toBe(false);
    expect(handleKeyDown(event, 'windows')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(zoom()).toBe(1);
    // Any other key code is an ordinary key.
    const ordinary = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, keyCode: 187 });
    expect(handleKeyDown(ordinary, 'windows')).toBe(true);
    expect(zoom()).toBe(1.1);
  });

  it('tells an input method key from any other', () => {
    expect(isImeEvent({ isComposing: true, keyCode: 65 })).toBe(true);
    expect(isImeEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeEvent({ isComposing: false, keyCode: 65 })).toBe(false);
  });
});

describe('a modal dialog owns the keyboard', () => {
  beforeEach(async () => {
    await openDocument();
  });

  it('leaves Open, zoom and the other shortcuts alone while a key is pressed inside the dialog', () => {
    const host = build(
      '<div role="dialog" aria-modal="true"><button id="inside">x</button></div><button id="outside">y</button>',
    );
    const inside = host.querySelector<HTMLElement>('#inside') as HTMLElement;
    for (const init of [
      { key: '+', ctrlKey: true },
      { key: 'o', ctrlKey: true },
      { key: 'w', ctrlKey: true },
    ]) {
      expect(press(init, inside).defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(zoom()).toBe(1);
    expect(activeDocument()).not.toBeNull();
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
  });

  it('runs nothing for a key pressed outside the dialog either (focus on the body, behind an inert app) until it is gone', () => {
    const host = build(
      '<div role="dialog" aria-modal="true" id="dialog"><button id="inside">x</button></div><button id="outside">y</button>',
    );
    const outside = host.querySelector<HTMLElement>('#outside') as HTMLElement;
    for (const init of [
      { key: '+', ctrlKey: true },
      { key: 'o', ctrlKey: true },
      { key: 'w', ctrlKey: true },
      { key: ',', ctrlKey: true },
    ]) {
      // The key is still taken from the browser (Ctrl and plus would zoom the whole window), but no command runs.
      expect(press(init, outside).defaultPrevented, JSON.stringify(init)).toBe(true);
      expect(press(init, document.body).defaultPrevented, JSON.stringify(init)).toBe(true);
    }
    expect(zoom()).toBe(1);
    expect(activeDocument()).not.toBeNull();
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(useSettingsPopover.getState().open).toBe(false);
    // The dialog is what stops it: the same key works as soon as it is gone.
    host.querySelector('#dialog')?.remove();
    press({ key: '+', ctrlKey: true }, outside);
    expect(zoom()).toBe(1.1);
  });

  it('is not a popover: a role dialog without aria-modal keeps the shortcuts (the settings popover)', () => {
    const host = build('<div role="dialog"><button id="inside">x</button></div>');
    press({ key: '+', ctrlKey: true }, host.querySelector('#inside') as HTMLElement);
    expect(zoom()).toBe(1.1);
  });

  it('tells a modal from the rest', () => {
    const host = build('<div aria-modal="true"><span id="in"></span></div><span id="out"></span>');
    expect(isInModal(host.querySelector('#in'))).toBe(true);
    expect(isInModal(host.querySelector('#out'))).toBe(false);
    expect(isInModal(window)).toBe(false);
    expect(isInModal(null)).toBe(false);
  });
});

describe('the numpad', () => {
  beforeEach(async () => {
    await openDocument();
    useView.getState().setZoom(REPORT.id, 2);
  });

  it('is Actual Size with Ctrl and 1 while NumLock makes it type digits', () => {
    press({ key: '1', code: 'Numpad1', ctrlKey: true });
    expect(zoom()).toBe(1);
  });

  it('is End, the arrows and so on with NumLock off, which are not digit shortcuts', () => {
    for (const init of [
      { key: 'End', code: 'Numpad1' },
      { key: 'Home', code: 'Numpad7' },
      { key: 'Insert', code: 'Numpad0' },
    ]) {
      const event = press({ ...init, ctrlKey: true });
      expect(event.defaultPrevented, init.key).toBe(false);
    }
    expect(zoom()).toBe(2);
    // Ctrl and the numpad's 2 with NumLock off is Ctrl and Down: the next page, not Fit Width.
    press({ key: 'ArrowDown', code: 'Numpad2', ctrlKey: true });
    expect(useView.getState().byDoc[REPORT.id]?.pageIndex).toBe(1);
    expect(zoom()).toBe(2);
  });
});

describe('the listener', () => {
  it('is one listener on the window for as long as the component is mounted, and is gone after it', async () => {
    await openDocument();
    keys.unmount();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ActionKeys />);
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    press({ key: '+', ctrlKey: true });
    expect(zoom()).toBe(1.1);
    // A zoom step does not bind it again.
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    unmount();
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    press({ key: '+', ctrlKey: true });
    expect(zoom()).toBe(1.1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('can be used as a hook, too', async () => {
    await openDocument();
    keys.unmount();
    function Host() {
      useActionKeys();
      return null;
    }
    render(<Host />);
    press({ key: '-', ctrlKey: true });
    expect(zoom()).toBe(0.9);
  });
});
describe('every binding of the registry, on every platform', () => {
  const PLATFORMS = ['macos', 'windows', 'linux', null] as const;

  /** The keydown a user produces for `binding`: Cmd on macOS and Ctrl elsewhere for `primary`. */
  function eventInit(binding: Binding, platform: Platform | null, strayPrimary = false): KeyboardEventInit {
    const mods = binding.mods ?? [];
    const primary = mods.includes('primary');
    const mac = platform === 'macos';
    const key = binding.key === 'Plus' ? '+' : binding.key === 'Minus' ? '-' : binding.key;
    const code = /^[0-9]$/.test(binding.key)
      ? `Digit${binding.key}`
      : /^[a-z]$/.test(binding.key)
        ? `Key${binding.key.toUpperCase()}`
        : '';
    // `strayPrimary`: the primary modifier of the other platform (Control on macOS, Cmd or the Windows key elsewhere).
    return {
      key,
      code,
      metaKey: primary && (strayPrimary ? !mac : mac),
      ctrlKey: primary && (strayPrimary ? mac : !mac),
      altKey: mods.includes('alt'),
      shiftKey: mods.includes('shift'),
    };
  }

  /** Every action's `run` replaced by a spy, so a key press shows which action it resolved to and nothing really happens. */
  const spies = () =>
    new Map(ACTIONS.map((action) => [action.id, vi.spyOn(action, 'run').mockImplementation(() => undefined)]));
  const calledIds = (all: ReturnType<typeof spies>) =>
    [...all].filter(([, spy]) => spy.mock.calls.length > 0).map(([id]) => id);

  const inCanvas = () => {
    const host = build(
      '<main data-action-scope="canvas"><div id="region" tabindex="0"></div></main><p id="outside"></p>',
    );
    return {
      region: host.querySelector('#region') as HTMLElement,
      outside: host.querySelector('#outside') as HTMLElement,
    };
  };

  it('runs exactly its own action: Cmd on macOS, Ctrl on Windows, Linux and an unknown platform', async () => {
    await openDocument();
    // Undo and Redo run only when the history has the step.
    useAnnotations.getState().applyChanges(REPORT.id, {
      rev: 1,
      upserted: [],
      removed: [],
      pages: null,
      history: { canUndo: true, canRedo: true, undoLabel: null, redoLabel: null, dirty: true },
    });
    const { region } = inCanvas();
    const all = spies();
    try {
      for (const platform of PLATFORMS) {
        setPlatform(platform);
        for (const action of ACTIONS) {
          const binding = resolveBinding(action.shortcut, platform);
          if (binding === null) continue;
          for (const spy of all.values()) spy.mockClear();
          const event = press(eventInit(binding, platform), region);
          expect(calledIds(all), `${platform} ${action.id}`).toEqual([action.id]);
          expect(event.defaultPrevented, `${platform} ${action.id}`).toBe(true);
        }
      }
    } finally {
      for (const spy of all.values()) spy.mockRestore();
    }
  });

  it("runs nothing when the other platform's primary modifier is held instead, and leaves the key to the browser", async () => {
    await openDocument();
    const { region } = inCanvas();
    const all = spies();
    try {
      for (const platform of PLATFORMS) {
        setPlatform(platform);
        for (const action of ACTIONS) {
          const binding = resolveBinding(action.shortcut, platform);
          if (binding === null || !(binding.mods ?? []).includes('primary')) continue;
          const event = press(eventInit(binding, platform, true), region);
          expect(event.defaultPrevented, `${platform} ${action.id}`).toBe(false);
        }
      }
      expect(calledIds(all)).toEqual([]);
    } finally {
      for (const spy of all.values()) spy.mockRestore();
    }
  });

  it('runs the single-key tool shortcuts only from inside the canvas, and leaves the letter alone elsewhere', async () => {
    await openDocument();
    const { region, outside } = inCanvas();
    const all = spies();
    try {
      for (const platform of PLATFORMS) {
        setPlatform(platform);
        for (const action of ACTIONS.filter((candidate) => candidate.group === 'tools')) {
          const binding = resolveBinding(action.shortcut, platform);
          if (binding === null) continue;
          for (const target of [window, document.body, outside]) {
            const event = press(eventInit(binding, platform), target);
            expect(event.defaultPrevented, `${platform} ${action.id}`).toBe(false);
          }
          expect(calledIds(all), `${platform} ${action.id} outside`).toEqual([]);
          press(eventInit(binding, platform), region);
          expect(calledIds(all), `${platform} ${action.id} inside`).toEqual([action.id]);
          for (const spy of all.values()) spy.mockClear();
        }
      }
    } finally {
      for (const spy of all.values()) spy.mockRestore();
    }
  });

  it('runs no action without a document, whatever the key, and still takes the key from the browser', () => {
    const { region } = inCanvas();
    const all = spies();
    try {
      for (const platform of PLATFORMS) {
        setPlatform(platform);
        for (const action of ACTIONS) {
          const binding = resolveBinding(action.shortcut, platform);
          // Open and Settings are the commands that need no document; the real ones are not run here, only their spies.
          if (binding === null || action.enabled(NO_DOCUMENT)) continue;
          const event = press(eventInit(binding, platform), region);
          expect(event.defaultPrevented, `${platform} ${action.id}`).toBe(true);
        }
      }
      expect(calledIds(all)).toEqual([]);
    } finally {
      for (const spy of all.values()) spy.mockRestore();
    }
  });
});

describe('single keys inside the canvas', () => {
  beforeEach(async () => {
    await openDocument();
  });

  const canvasWith = (inner: string) =>
    build(`<main data-action-scope="canvas"><div id="region" tabindex="0"></div>${inner}</main>`);

  it('never fire from a text field, a text area or editable content that sits in the canvas (a comment being typed)', () => {
    const host = canvasWith(
      '<input id="a" type="text" /><textarea id="b"></textarea><div id="c" contenteditable="true">x</div>' +
        '<div id="d" contenteditable=""><span id="e">x</span></div><div id="f" role="textbox" tabindex="0"></div>',
    );
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const init of [{ key: 'h' }, { key: 'D' }, { key: 'v' }, { key: 'o', ctrlKey: true }]) {
        const event = press(init, host.querySelector(`#${id}`) as HTMLElement);
        expect(event.defaultPrevented, `${id} ${JSON.stringify(init)}`).toBe(false);
      }
    }
    expect(useUi.getState().activeTool).toBe('select');
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
  });

  it('fire again from a part of the canvas that says it is not editable', () => {
    const host = canvasWith('<div id="ro" contenteditable="false" tabindex="0"></div>');
    press({ key: 'h' }, host.querySelector('#ro') as HTMLElement);
    expect(useUi.getState().activeTool).toBe('highlight');
  });

  it('are not shortcuts during an IME composition, whether the key is a tool letter or Ctrl and a key', () => {
    const host = canvasWith('');
    const region = host.querySelector('#region') as HTMLElement;
    for (const init of [
      { key: 'h', isComposing: true },
      { key: 'd', isComposing: true },
      { key: '+', ctrlKey: true, isComposing: true },
      { key: 'F4', isComposing: true },
    ]) {
      const event = press(init, region);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(useUi.getState().activeTool).toBe('select');
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
    expect(zoom()).toBe(1);
  });

  it('do not run again while the key is held', () => {
    const host = canvasWith('');
    const region = host.querySelector('#region') as HTMLElement;
    press({ key: 'h', repeat: true }, region);
    expect(useUi.getState().activeTool).toBe('select');
    press({ key: 'h' }, region);
    expect(useUi.getState().activeTool).toBe('highlight');
  });
});
