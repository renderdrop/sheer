// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useRecentColours } from '../../stores/recentColours';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { styleFor, useStyleStore } from '../inspector/style';
import { useOrganize } from '../organize/store';
import { usePages } from '../../stores/pages';
import { usePlacement } from '../signatures/place/store';
import { ModeRow, ToolRow, switchMode } from '.';
import { focusToolItem, TOOL_ITEM_WAIT_MS } from './switch';
import { handleModeKey } from './useModeEffects';

vi.mock('../../api/signing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/signing')>()),
  listSigningIdentities: vi.fn().mockResolvedValue({ status: 'empty', items: [] }),
}));

vi.mock('../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/library')>()),
  listSignatures: vi.fn().mockResolvedValue({ status: 'ready', items: [] }),
}));

const uiInitial = useUi.getState();
const toolsInitial = useTools.getState();
const annotationsInitial = useAnnotations.getState();

function openDocument(id = 1, kind?: 'welcome') {
  act(() =>
    useDocuments
      .getState()
      .add({ id, pageCount: 6, displayName: `d${id}.pdf`, ...(kind === undefined ? {} : { kind }) }),
  );
}

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  useTools.setState({ ...toolsInitial }, true);
  useAnnotations.setState({ ...annotationsInitial }, true);
  useStyleStore.getState().reset();
  useRecentColours.setState({ colours: [] });
  resetDocuments();
  useUi.setState({ mode: 'read', activeTool: 'select', toolLocked: false });
  usePlacement.getState().disarm();
  openDocument();
});

afterEach(() => {
  resetDocuments();
  useUi.setState({ ...uiInitial }, true);
});

const Rows = () => (
  <>
    <ModeRow />
    <ToolRow />
  </>
);

const tab = (name: string) => screen.getByRole('tab', { name });
const item = (name: string | RegExp) => within(screen.getByRole('toolbar')).getByRole('button', { name });
const names = () =>
  within(screen.getByRole('toolbar'))
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);
/** The slots, without the chevron parts of the split items. */
const slotNames = () => names().filter((name) => !name?.startsWith('Options'));

describe('the mode row (DESIGN v2 3.2)', () => {
  it('is a tablist "Mode" with the five modes in order and Lesen selected by default', () => {
    setup(<Rows />);
    expect(screen.getByRole('tablist', { name: 'Mode' })).not.toBeNull();
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual([
      'Read',
      'Comment',
      'Fill & Sign',
      'Pages',
      'Edit',
    ]);
    expect(tab('Read').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(screen.getByRole('toolbar', { name: 'Read' })).not.toBeNull();
  });

  it('a click switches the mode and releases the tool to Auswahl', async () => {
    const { user } = setup(<Rows />);
    act(() => useUi.getState().selectTool('hand'));
    await user.click(tab('Comment'));
    expect(useUi.getState()).toMatchObject({ mode: 'comment', activeTool: 'select', toolLocked: false });
    expect(tab('Comment').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('toolbar', { name: 'Comment' })).not.toBeNull();
  });

  it('is one tab stop, and Left, Right, Home and End move and activate', async () => {
    const { user } = setup(<Rows />);
    expect(screen.getAllByRole('tab').filter((entry) => entry.tabIndex === 0)).toEqual([tab('Read')]);
    tab('Read').focus();
    await user.keyboard('{ArrowRight}');
    expect(useUi.getState().mode).toBe('comment');
    expect(document.activeElement).toBe(tab('Comment'));
    await user.keyboard('{End}');
    expect(useUi.getState().mode).toBe('edit');
    await user.keyboard('{ArrowRight}');
    expect(useUi.getState().mode).toBe('read');
    await user.keyboard('{ArrowLeft}');
    expect(useUi.getState().mode).toBe('edit');
    await user.keyboard('{Home}');
    expect(useUi.getState().mode).toBe('read');
  });

  it('Tab leaves the tab list for the tool row', async () => {
    const { user } = setup(<Rows />);
    tab('Read').focus();
    await user.tab();
    expect(screen.getByRole('toolbar').contains(document.activeElement)).toBe(true);
  });

  it('keeps the mode per document tab for the session, and a new document starts in Lesen', () => {
    setup(<Rows />);
    act(() => switchMode('comment'));
    openDocument(2);
    expect(useUi.getState().mode).toBe('read');
    act(() => switchMode('edit'));
    act(() => useDocuments.getState().setActive(1));
    expect(useUi.getState().mode).toBe('comment');
    act(() => useDocuments.getState().setActive(2));
    expect(useUi.getState().mode).toBe('edit');
  });

  it('a tool of another mode (a v1.1 key) switches the mode and keeps the tool', () => {
    setup(<Rows />);
    act(() => useUi.getState().selectTool('draw'));
    expect(useUi.getState()).toMatchObject({ mode: 'comment', activeTool: 'draw' });
    expect(item('Draw').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the keys 1 to 5', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it('switch the mode from anywhere', () => {
    setup(<Rows />);
    press('2');
    expect(useUi.getState().mode).toBe('comment');
    press('5');
    expect(useUi.getState().mode).toBe('edit');
    press('1', {}, document.body);
    expect(useUi.getState().mode).toBe('read');
  });

  it('are not taken with a modifier: Ctrl+1, Ctrl+2 and Ctrl+0 stay the zoom keys', () => {
    setup(<Rows />);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      const event = press('3', init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(useUi.getState().mode).toBe('read');
  });

  it('are left to inputs, editable elements, menus, dialogs and the form fields', () => {
    setup(
      <div>
        <Rows />
        <input aria-label="field" />
        <div contentEditable suppressContentEditableWarning data-testid="edit" />
        <div role="menu">
          <button role="menuitem">item</button>
        </div>
        <div role="dialog" aria-modal="false">
          <button>in dialog</button>
        </div>
        <div data-form-widget="">
          <button>widget</button>
        </div>
      </div>,
    );
    const targets = [
      screen.getByLabelText('field'),
      screen.getByTestId('edit'),
      screen.getByRole('menuitem'),
      screen.getByRole('button', { name: 'in dialog' }),
      screen.getByRole('button', { name: 'widget' }),
    ];
    for (const target of targets) {
      const event = press('4', {}, target);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(useUi.getState().mode).toBe('read');
  });

  it('are left to a list and to the radios of a group (every selector of the list that owns digits)', () => {
    setup(
      <div>
        <Rows />
        <div role="listbox" aria-label="pages">
          <div role="option" aria-selected="true" tabIndex={0}>
            page
          </div>
        </div>
        <div role="radiogroup" aria-label="choice">
          <button role="radio" aria-checked="true">
            radio
          </button>
        </div>
      </div>,
    );
    for (const target of [screen.getByRole('option'), screen.getByRole('radio')]) {
      expect(press('3', {}, target).defaultPrevented).toBe(false);
    }
    expect(useUi.getState().mode).toBe('read');
  });

  it('are left to a modal dialog and to an event something else took', () => {
    setup(<Rows />);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    press('2', {}, modal);
    modal.remove();
    expect(useUi.getState().mode).toBe('read');
    const taken = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true });
    taken.preventDefault();
    expect(handleModeKey(taken)).toBe(false);
  });

  it('ignore a held key and other keys', () => {
    setup(<Rows />);
    press('2', { repeat: true });
    press('x');
    press('0');
    expect(useUi.getState().mode).toBe('read');
  });
});

describe('Lesen', () => {
  it('has Auswahl, Hand, Textauswahl, Lupe, Drehen and Suche in this order, each with icon and label', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual(['Select', 'Hand', 'Select text', 'Magnifier', 'Rotate', 'Search']);
    for (const button of within(screen.getByRole('toolbar')).getAllByRole('button')) {
      expect(button.querySelector('svg')).not.toBeNull();
    }
  });

  it('marks the active tool with aria-pressed, and Auswahl is on by default', () => {
    setup(<Rows />);
    expect(item('Select').getAttribute('aria-pressed')).toBe('true');
    expect(item('Hand').getAttribute('aria-pressed')).toBe('false');
    expect(item('Search').hasAttribute('aria-pressed')).toBe(false);
  });

  it('Hand, Textauswahl and Lupe select the tool ids hand, textSelect and magnifier', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Hand'));
    expect(useUi.getState().activeTool).toBe('hand');
    expect(item('Hand').getAttribute('aria-pressed')).toBe('true');
    expect(item('Select').getAttribute('aria-pressed')).toBe('false');
    await user.click(item('Select text'));
    expect(useUi.getState().activeTool).toBe('textSelect');
    await user.click(item('Magnifier'));
    expect(useUi.getState().activeTool).toBe('magnifier');
    // A tool stays active on a second click (ADR-056); Auswahl goes back.
    await user.click(item('Magnifier'));
    expect(useUi.getState().activeTool).toBe('magnifier');
    await user.click(item('Select'));
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('keeps data-toolbar-item on the items (the tour and the smoke test find them)', () => {
    setup(<Rows />);
    expect(item('Select').getAttribute('data-toolbar-item')).toBe('select');
    expect(item('Search').getAttribute('data-toolbar-item')).toBe('search');
  });

  it('Drehen is a split item: its chevron opens right, left and reset', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Rotate'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((entry) => entry.textContent),
    ).toEqual(['Rotate right', 'Rotate left', 'Reset rotation']);
  });

  it('a split item is one clipped contour: square parts, a divider on the chevron, no scale on press', () => {
    setup(<Rows />);
    const chevron = item('Options for Rotate');
    const outer = chevron.closest('[data-split]');
    expect(outer).not.toBeNull();
    expect(outer?.className).toContain('overflow-hidden');
    expect(outer?.className).toContain('rounded-md');
    expect(outer?.querySelectorAll('button')).toHaveLength(2);
    expect(chevron.className).toContain('border-s');
    expect(chevron.className).not.toMatch(/rounded/);
    const main = outer?.querySelector('[data-toolbar-item]');
    expect(main?.className).toContain('rounded-none!');
    expect(main?.className).toContain('active:scale-100!');
  });

  it('Suche runs the find action: the Search tab opens', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Search'));
    expect(useUi.getState()).toMatchObject({ leftPanelTab: 'search', leftPanelCollapsed: false });
  });
});

describe('the tool row keys', () => {
  it('is one Tab stop; the arrows move, Home and End jump, and the chevron is its own stop', async () => {
    const { user } = setup(<Rows />);
    const stops = within(screen.getByRole('toolbar'))
      .getAllByRole('button')
      .filter((button) => button.tabIndex === 0);
    expect(stops).toEqual([item('Select')]);
    item('Select').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('Hand'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(item('Search'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('Search'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Options for Rotate'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Rotate'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(item('Select'));
  });

  it('Enter and Space activate an item', async () => {
    const { user } = setup(<Rows />);
    item('Hand').focus();
    await user.keyboard('{Enter}');
    expect(useUi.getState().activeTool).toBe('hand');
    item('Select text').focus();
    await user.keyboard(' ');
    expect(useUi.getState().activeTool).toBe('textSelect');
  });

  it('Alt+Down on a split item opens its menu', async () => {
    const { user } = setup(<Rows />);
    item('Rotate').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByRole('menu')).not.toBeNull();
  });

  it('Esc releases the tool to Auswahl and takes the focus out of the row', async () => {
    const canvas = document.createElement('div');
    canvas.setAttribute('data-action-scope', 'canvas');
    const region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.tabIndex = 0;
    canvas.append(region);
    document.body.append(canvas);
    const { user } = setup(<Rows />);
    await user.click(item('Hand'));
    item('Hand').focus();
    await user.keyboard('{Escape}');
    expect(useUi.getState().activeTool).toBe('select');
    expect(document.activeElement).toBe(region);
    canvas.remove();
  });
});

describe('Kommentieren', () => {
  beforeEach(() => {
    act(() => switchMode('comment'));
  });

  it('has the F14 slots in order, each colour tool with a chevron part', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual([
      'Highlight',
      'Underline',
      'Strikethrough',
      'Cite',
      'Note',
      'Text comment',
      'Draw',
      'Shapes',
    ]);
    expect(names().filter((name) => name?.startsWith('Options'))).toHaveLength(8);
  });

  it('Cite is slot 4: a colour tool with the key Q, and the Cite tool is active after a click', async () => {
    const { user } = setup(<Rows />);
    expect(slotNames()[3]).toBe('Cite');
    await user.click(item('Cite'));
    expect(useUi.getState().activeTool).toBe('cite');
    expect(item('Cite').getAttribute('aria-pressed')).toBe('true');
  });

  it('the three markup slots are the markup tool with a variant', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Underline'));
    expect(useUi.getState().activeTool).toBe('highlight');
    expect(useTools.getState().markup).toBe('underline');
    expect(item('Underline').getAttribute('aria-pressed')).toBe('true');
    expect(item('Highlight').getAttribute('aria-pressed')).toBe('false');
    await user.click(item('Strikethrough'));
    expect(useTools.getState().markup).toBe('strikeout');
    await user.click(item('Highlight'));
    expect(useTools.getState().markup).toBe('highlight');
  });

  it('Notiz, Textkommentar and Zeichnen select their tools', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Note'));
    expect(useUi.getState().activeTool).toBe('note');
    await user.click(item('Text comment'));
    expect(useUi.getState().activeTool).toBe('text');
    await user.click(item('Draw'));
    expect(useUi.getState().activeTool).toBe('draw');
    expect(item('Draw').getAttribute('aria-pressed')).toBe('true');
  });

  it('the chevron of a colour tool opens the swatch row and a swatch sets the colour of the next annotation', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Highlight'));
    const group = await screen.findByRole('radiogroup', { name: 'Colour' });
    const swatches = within(group).getAllByRole('radio');
    expect(swatches).toHaveLength(5);
    expect(swatches[0]?.getAttribute('aria-checked')).toBe('true');
    await user.click(within(group).getByRole('radio', { name: 'Sky' }));
    expect(styleFor('highlight').color).toEqual([163, 222, 255]);
    expect(within(group).getByRole('radio', { name: 'Sky' }).getAttribute('aria-checked')).toBe('true');
  });

  it('the swatch row has More colours: a hex colour is applied, joins the recent ones and shows as a swatch (DESIGN 3.5 B5)', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Highlight'));
    const group = await screen.findByRole('radiogroup', { name: 'Colour' });
    await user.click(within(group).getByRole('button', { name: 'More colours' }));
    await user.type(await screen.findByRole('textbox', { name: 'Hex colour' }), '1f9e6a');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(styleFor('highlight').color).toEqual([31, 158, 106]);
    expect(useRecentColours.getState().colours).toEqual([[31, 158, 106]]);
    // The row shows it as a recent swatch, checked, after the five of the palette.
    const row = await screen.findByRole('radiogroup', { name: 'Colour' });
    const radios = within(row).getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(radios[5]?.getAttribute('aria-label')).toBe('Custom');
    expect(radios[5]?.getAttribute('aria-checked')).toBe('true');
  });

  it('a recent colour of another tool is offered in every swatch row, and picking it sets the colour of that tool', async () => {
    useRecentColours.getState().add([10, 20, 30]);
    const { user } = setup(<Rows />);
    await user.click(item('Options for Draw'));
    const group = await screen.findByRole('radiogroup', { name: 'Colour' });
    // Draw has the stroke palette: the recent colour is not in it, so it is a swatch after the five.
    expect(within(group).getAllByRole('radio')).toHaveLength(6);
    await user.click(within(group).getByRole('radio', { name: '#0A141E' }));
    expect(styleFor('ink').color).toEqual([10, 20, 30]);
  });

  it('Formen has More colours too, and a colour set there is the colour of all four shapes', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Shapes'));
    const group = await screen.findByRole('radiogroup', { name: 'Colour' });
    await user.click(within(group).getByRole('button', { name: 'More colours' }));
    await user.type(await screen.findByRole('textbox', { name: 'Hex colour' }), '#E15C86');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    for (const kind of ['rect', 'ellipse', 'line', 'arrow'] as const) {
      expect(styleFor(kind).color, kind).toEqual([225, 92, 134]);
    }
  });

  it('the Formen menu lists Rectangle, Ellipse, Line and Arrow, and Arrow is the arrow shape of the shapes tool', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Shapes'));
    const names = (await screen.findAllByRole('radio'))
      .map((radio) => radio.textContent)
      .filter((name) => name !== '' && name !== null);
    expect(names).toEqual(['Rectangle', 'Ellipse', 'Line', 'Arrow']);
    await user.click(screen.getByRole('radio', { name: 'Arrow' }));
    expect(useTools.getState().shapes).toBe('arrow');
    expect(useUi.getState().activeTool).toBe('shapes');
  });

  it('Zeichnen has the shape recognition switch at the bottom of its menu, on by default, and it is the stored setting', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Draw'));
    const toggle = await screen.findByRole('switch', { name: 'Straighten shapes automatically' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(useTools.getState().straightenShapes).toBe(false);
    expect(globalThis.localStorage.getItem('sheer.tools.shapeRecognition')).toBe('0');
    expect(screen.getByRole('switch', { name: 'Straighten shapes automatically' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    await user.click(screen.getByRole('switch', { name: 'Straighten shapes automatically' }));
    expect(useTools.getState().straightenShapes).toBe(true);
  });

  it('Formen is a split item with the four shapes and the colour row in one popover', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Shapes'));
    await user.click(await screen.findByRole('radio', { name: 'Ellipse' }));
    expect(useTools.getState().shapes).toBe('ellipse');
    expect(useUi.getState().activeTool).toBe('shapes');
    expect(item('Shapes').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Ausfüllen & Signieren', () => {
  beforeEach(() => {
    act(() => switchMode('fill'));
  });

  it('has Text, Häkchen, Kreuz, Punkt, Datum, Signatur, Initialen and Zertifikat, with no slot for form fields', async () => {
    setup(<Rows />);
    await waitFor(() => expect(names()).toContain('Signature'));
    expect(slotNames()).toEqual(['Text', 'Check', 'Cross', 'Dot', 'Date', 'Signature', 'Initials', 'Certificate']);
  });

  it('a mark is armed and makes the Sign tool the active one', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Cross'));
    expect(useUi.getState().activeTool).toBe('signature');
    expect(usePlacement.getState().item).toEqual({ type: 'mark', glyph: 'cross' });
    expect(item('Cross').getAttribute('aria-pressed')).toBe('true');
    expect(item('Check').getAttribute('aria-pressed')).toBe('false');
    await user.click(item('Date'));
    expect(usePlacement.getState().item).toEqual({ type: 'date' });
  });

  it('the chevron of Signatur offers a new signature when none is saved', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Signature'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((entry) => entry.textContent),
    ).toEqual(['New signature']);
  });

  it('stays usable on the welcome document: marks, date and signature are not disabled (ADR-117)', () => {
    resetDocuments();
    openDocument(7, 'welcome');
    act(() => switchMode('fill'));
    setup(<Rows />);
    for (const name of ['Check', 'Cross', 'Dot', 'Date', 'Signature']) {
      expect(item(name).getAttribute('aria-disabled')).not.toBe('true');
    }
  });
});

describe('Seiten', () => {
  beforeEach(() => {
    usePages.getState().set(
      1,
      Array.from({ length: 6 }, () => [612, 792] as [number, number]),
    );
    act(() => switchMode('pages'));
  });

  it('entering the mode makes the page grid the canvas (the Pages tool) and Ordnen the active slot', () => {
    setup(<Rows />);
    expect(useUi.getState()).toMatchObject({ mode: 'pages', activeTool: 'pages' });
    expect(item('Arrange').getAttribute('aria-pressed')).toBe('true');
  });

  it('has Ordnen, Drehen, Löschen, Einfügen, Extrahieren, Teilen, Zusammenführen and Komprimieren: eight slots', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual(['Arrange', 'Rotate', 'Delete', 'Insert', 'Extract', 'Split', 'Merge', 'Compress']);
  });

  it('page actions are disabled until a card is selected, then enabled; Löschen keeps one page', () => {
    setup(<Rows />);
    for (const name of ['Rotate', 'Delete', 'Extract']) {
      expect(item(name).getAttribute('aria-disabled')).toBe('true');
    }
    act(() => useOrganize.getState().setSelection(1, { selected: [0], focus: 0 }));
    for (const name of ['Rotate', 'Delete', 'Extract']) {
      expect(item(name).hasAttribute('aria-disabled')).toBe(false);
    }
    act(() => useOrganize.getState().setSelection(1, { selected: [0, 1, 2, 3, 4, 5], focus: 0 }));
    expect(item('Delete').getAttribute('aria-disabled')).toBe('true');
    expect(item('Rotate').hasAttribute('aria-disabled')).toBe(false);
  });

  it('Teilen, Zusammenführen, Komprimieren and Einfügen need no selection', () => {
    setup(<Rows />);
    for (const name of ['Split', 'Merge', 'Compress', 'Insert']) {
      expect(item(name).hasAttribute('aria-disabled')).toBe(false);
    }
  });

  it('Einfügen has a menu with a blank page and pages from a file', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Insert'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((entry) => entry.textContent),
    ).toEqual(['Blank page', 'Pages from file…']);
  });

  it('Ordnen cannot be released by Esc: the grid stays until another mode is chosen', async () => {
    const { user } = setup(<Rows />);
    item('Arrange').focus();
    await user.keyboard('{Escape}');
    expect(useUi.getState()).toMatchObject({ mode: 'pages', activeTool: 'pages' });
    await user.click(tab('Read'));
    expect(useUi.getState()).toMatchObject({ mode: 'read', activeTool: 'select' });
  });

  it('entering or leaving Seiten drops the annotation selection, other switches keep it', () => {
    setup(<Rows />);
    act(() => switchMode('comment'));
    act(() => useAnnotations.getState().select(1, [4, 5]));
    act(() => switchMode('edit'));
    expect(useAnnotations.getState().selectedIds[1]).toEqual([4, 5]);
    act(() => switchMode('pages'));
    expect(useAnnotations.getState().selectedIds[1] ?? []).toEqual([]);
    act(() => useAnnotations.getState().select(1, [6]));
    act(() => switchMode('read'));
    expect(useAnnotations.getState().selectedIds[1] ?? []).toEqual([]);
  });

  it('the tool "pages" selected from elsewhere (the hub) lands in Seiten', () => {
    act(() => switchMode('read'));
    act(() => useUi.getState().selectTool('pages'));
    expect(useUi.getState()).toMatchObject({ mode: 'pages', activeTool: 'pages' });
  });
});

describe('Bearbeiten', () => {
  beforeEach(() => {
    act(() => switchMode('edit'));
  });

  it('has Text einfügen, Bild einfügen, Zuschneiden, Schwärzen, Schützen and Metadaten', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual(['Add text', 'Add image', 'Crop', 'Redact', 'Protect', 'Metadata']);
  });

  it('the tools select their tool ids, Schwärzen turns the mode on and stays on', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Add text'));
    expect(useUi.getState().activeTool).toBe('textBox');
    await user.click(item('Add image'));
    expect(useUi.getState().activeTool).toBe('image');
    await user.click(item('Crop'));
    expect(useUi.getState().activeTool).toBe('crop');
    act(() => useUi.getState().releaseTool());
    await user.click(item('Redact'));
    expect(useUi.getState().redactMode).toBe(true);
    expect(item('Redact').getAttribute('aria-pressed')).toBe('true');
    await user.click(item('Redact'));
    expect(useUi.getState().redactMode).toBe(true);
  });

  it('Schützen and Metadaten open their dialogs', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Protect'));
    expect(useUi.getState().protectOpen).toBe(true);
    await user.click(item('Metadata'));
    expect(useUi.getState().propsOpen).toBe(true);
    expect(item('Protect').hasAttribute('aria-pressed')).toBe(false);
  });

  it('a mode switch keeps the redaction mode on until Anwenden or Abbrechen', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Redact'));
    await user.click(tab('Read'));
    expect(useUi.getState().redactMode).toBe(true);
  });
});

describe('the overflow', () => {
  const widths = { client: 0 };
  let scroll: PropertyDescriptor | undefined;
  let client: PropertyDescriptor | undefined;

  beforeEach(() => {
    scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    // jsdom has no layout: an item is 120 wide with its label and 36 without; the row is `widths.client` wide.
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute('role') !== 'toolbar') return 0;
        let total = 0;
        for (const child of Array.from(this.children)) {
          total += child.querySelector('[data-label]') === null ? 36 : 120;
        }
        return total;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'toolbar' ? widths.client : 0;
      },
    });
  });

  afterEach(() => {
    if (scroll !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    if (client !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  });

  const labelled = () =>
    within(screen.getByRole('toolbar'))
      .getAllByRole('button')
      .filter((button) => button.querySelector('[data-label]') !== null).length;

  it('step 1: with room every label shows', () => {
    widths.client = 2000;
    setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('1');
    expect(labelled()).toBe(6);
  });

  it('step 2: the inactive items become icon-only with their name for assistive technology, the active one keeps its label', () => {
    widths.client = 6 * 120 - 1;
    setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('2');
    expect(labelled()).toBe(1);
    expect(item('Select').querySelector('[data-label]')).not.toBeNull();
    expect(item('Hand').getAttribute('aria-label')).toBe('Hand');
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('Kommentieren keeps all eight tools icon-only at step 2, without Mehr (DESIGN 3.7 C2, AC 2)', () => {
    act(() => switchMode('comment'));
    widths.client = 8 * 36 + 120;
    setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('2');
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(item('Cite').getAttribute('aria-label')).toBe('Cite');
  });

  it('step 3: items leave from the right into Mehr, never the active tool, and Mehr lists them', async () => {
    widths.client = 120 + 36 * 3;
    const { user } = setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('3');
    expect(item('Select')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    await user.click(item('More'));
    const menu = await screen.findByRole('menu');
    const listed = within(menu)
      .getAllByRole('menuitem')
      .map((entry) => entry.textContent);
    expect(listed).toContain('Search');
    expect(listed).not.toContain('Select');
    await user.click(within(menu).getByRole('menuitem', { name: 'Search' }));
    expect(useUi.getState().leftPanelTab).toBe('search');
    // Mehr is the last slot.
    const buttons = within(screen.getByRole('toolbar')).getAllByRole('button');
    expect(buttons[buttons.length - 1]).toBe(item('More'));
  });

  it('the active tool never leaves, even when it is the last item', () => {
    widths.client = 120 + 36 * 2;
    act(() => useUi.getState().selectTool('textSelect'));
    setup(<Rows />);
    expect(item('Select text').querySelector('[data-label]')).not.toBeNull();
  });

  it('starts over when the room grows (the width is read again)', () => {
    widths.client = 120 + 36 * 3;
    const first = setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('3');
    first.unmount();
    widths.client = 2000;
    setup(<Rows />);
    expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('1');
  });
});

describe('the active tool and the labels (DESIGN Q2, Q6)', () => {
  it('one rule for all modes: the active tool carries the Solar fill, the Ink label and the hairline, split or not', () => {
    for (const mode of ['read', 'comment'] as const) {
      act(() => switchMode(mode));
      act(() => useUi.getState().selectTool(mode === 'read' ? 'hand' : 'draw'));
      const { container, unmount } = setup(<Rows />);
      const on = container.querySelector('[data-slot="tool-row"] [data-on="true"]');
      expect(on).not.toBeNull();
      expect(on?.className).toContain('data-[on=true]:bg-accent');
      expect(on?.className).toContain('shadow-(--tool-active-edge)');
      unmount();
    }
    act(() => switchMode('read'));
    act(() => useUi.getState().releaseTool());
    setup(<Rows />);
    expect(item('Select').className).toContain('data-[on=true]:bg-accent');
    expect(item('Select').getAttribute('aria-pressed')).toBe('true');
  });

  it('tool labels never truncate or use an ellipsis, in every mode', () => {
    const labels: Element[] = [];
    for (const mode of ['read', 'comment', 'fill', 'pages', 'edit'] as const) {
      act(() => switchMode(mode));
      const { container, unmount } = setup(<Rows />);
      labels.push(
        ...Array.from(container.querySelectorAll('[data-label]')).map((label) => label.cloneNode(true) as Element),
      );
      unmount();
    }
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) {
      expect(label.className).not.toMatch(/truncate|text-ellipsis|overflow-hidden/);
      expect(label.textContent).not.toMatch(/…|\.\.\./);
    }
  });

  it('no tool label of the catalogs ends in an ellipsis (only variant items that open a dialog may)', () => {
    for (const [locale, catalog] of Object.entries({ en, de }) as [string, Record<string, string>][]) {
      const keys = Object.keys(catalog).filter((key) => key.startsWith('modes.tool.') && key !== 'modes.tool.fromFile');
      expect(keys.length).toBeGreaterThan(20);
      for (const key of keys) expect(catalog[key], `${locale} ${key}`).not.toMatch(/(…|\.\.\.)\s*$/);
    }
  });
});

describe('the segmented mode tabs (DESIGN 3.5 B3)', () => {
  it('the selected segment is White with a Stone border and Ink 500, the others are not; the bar is Sand', () => {
    const { container } = setup(<Rows />);
    // The White fill and the Stone border are the shared glide pill (spell 21), not the segment.
    const pill = container.querySelector('[data-glide-pill="mode"]');
    expect(pill?.className).toContain('bg-panel');
    expect(pill?.className).toContain('border-control-border');
    expect(tab('Read').className).toContain('aria-selected:font-medium');
    expect(tab('Read').getAttribute('aria-selected')).toBe('true');
    expect(tab('Edit').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('[data-slot="mode-row"]')?.className).toContain('bg-subtle');
    expect(container.querySelector('[data-slot="tool-row"]')?.className).toContain('bg-subtle');
    expect(tab('Read').getAttribute('aria-controls')).toBe('mode-tool-row');
  });
});

describe('focusToolItem', () => {
  it('focuses the item once it mounts, and gives up when it never does', async () => {
    vi.useFakeTimers();
    try {
      const found = focusToolItem('later');
      const button = document.createElement('button');
      button.dataset.toolbarItem = 'later';
      setTimeout(() => document.body.append(button), 100);
      await vi.advanceTimersByTimeAsync(200);
      expect(await found).toBe(true);
      expect(document.activeElement).toBe(button);
      button.remove();
      const missing = focusToolItem('never');
      await vi.advanceTimersByTimeAsync(TOOL_ITEM_WAIT_MS + 100);
      expect(await missing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
