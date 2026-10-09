// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useSettings } from '../../stores/settings';
import { useRecentColours } from '../../stores/recentColours';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { openTooltip, setup } from '../../test/render';
import { styleFor, useStyleStore } from '../inspector/style';
import { useOrganize } from '../organize/store';
import { usePages } from '../../stores/pages';
import { usePlacement } from '../signatures/place/store';
import { useSmartLinks } from '../smartlinks/store';
import { ModeCard, ToolRow, switchMode } from '.';
import { useToolInspector } from '../inspector/toolInspector';
import { focusToolItem, TOOL_ITEM_WAIT_MS } from './switch';

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
  // Wide enough for the labelled tool area (DESIGN 3.18 E4: icon-only below 1100).
  window.innerWidth = 1440;
  // These tests cover the labelled layout; icons only is the default and has its own file (toolLabels.test.tsx).
  useSettings.setState({ showToolLabels: true });
  useToolInspector.setState({ open: null });
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
  useSettings.setState({ showToolLabels: false });
  resetDocuments();
  useUi.setState({ ...uiInitial }, true);
});

const Rows = () => <ToolRow />;

/** The caption of a mode group (F21.9): the text button that switches to its mode. */
const tab = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[data-mode-caption]')].find(
    (entry) => entry.textContent === name,
  );
  if (found === undefined) throw new Error(`no caption ${name}`);
  return found;
};
/** The tools of the current mode's group. */
const tools = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-mode-group][data-active="true"] [data-tools]');
  if (found === null) throw new Error('no active group');
  return found;
};
const item = (name: string | RegExp) => within(tools()).getByRole('button', { name });
const names = () =>
  within(tools())
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);
/** The slots, without the chevron parts of the split items. */
const slotNames = () => names().filter((name) => !name?.startsWith('Options'));

describe('the mode groups (F21.9)', () => {
  const captions = () => [...document.querySelectorAll<HTMLElement>('[data-mode-caption]')];
  const groups = () => [...document.querySelectorAll<HTMLElement>('[data-mode-group]')];

  it('one strip of the five groups in mode order, each with its caption below, Lesen current by default', () => {
    setup(<Rows />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(groups().map((group) => group.dataset.modeGroup)).toEqual(['read', 'comment', 'fill', 'pages', 'edit']);
    expect(captions().map((entry) => entry.textContent)).toEqual(['Read', 'Comment', 'Fill & Sign', 'Pages', 'Edit']);
    // The caption follows the tools: below them.
    for (const group of groups()) {
      const caption = group.querySelector('[data-mode-caption]');
      const row = group.querySelector('[data-tools]');
      expect(
        caption !== null && row !== null && row.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(groups().filter((group) => group.dataset.active === 'true')).toEqual([groups()[0]]);
    // Every tool of every mode is in the strip.
    for (const id of ['select', 'highlight', 'signature', 'organize', 'redact']) {
      expect(document.querySelector(`[data-toolbar-item="${id}"]`), id).not.toBeNull();
    }
  });

  it('the captions are static text: no button, not focusable, no state, no key hint, no tooltip (F22.2)', async () => {
    const { user } = setup(<Rows />);
    for (const caption of captions()) {
      expect(caption.tagName).toBe('SPAN');
      expect(caption.hasAttribute('tabindex')).toBe(false);
      expect(caption.hasAttribute('aria-pressed')).toBe(false);
      expect(caption.hasAttribute('aria-keyshortcuts')).toBe(false);
    }
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    await user.click(tab('Comment'));
    expect(useUi.getState().mode).toBe('read');
    // The whole strip is one tab stop.
    expect(document.querySelectorAll('[data-roving][tabindex="0"]')).toHaveLength(1);
  });

  it('the keys 1 to 5 do nothing (F22.2)', async () => {
    const { user } = setup(<Rows />);
    await user.keyboard('2');
    await user.keyboard('5');
    expect(useUi.getState().mode).toBe('read');
  });

  it('a tool of another group enters its mode', async () => {
    const { user } = setup(<Rows />);
    await user.click(document.querySelector<HTMLElement>('[data-toolbar-item="note"]') as HTMLElement);
    expect(useUi.getState()).toMatchObject({ mode: 'comment', activeTool: 'note' });
    expect(item('Note').getAttribute('aria-pressed')).toBe('true');
    // Only the current group shows an active tool.
    expect(
      document.querySelectorAll('[data-mode-group]:not([data-active]) [aria-pressed="true"][data-on]'),
    ).toHaveLength(0);
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

describe('Lesen', () => {
  it('has Auswahl, Hand, Textauswahl, Lupe, Drehen, Suche and Smarte Links in this order, each with icon and label', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual(['Select', 'Hand', 'Select text', 'Magnifier', 'Rotate', 'Search', 'Smart links']);
    for (const button of within(tools()).getAllByRole('button')) {
      expect(button.querySelector('svg')).not.toBeNull();
    }
  });

  it('marks the active tool with aria-pressed, and Auswahl is on by default', () => {
    setup(<Rows />);
    expect(item('Select').getAttribute('aria-pressed')).toBe('true');
    expect(item('Hand').getAttribute('aria-pressed')).toBe('false');
    expect(item('Search').hasAttribute('aria-pressed')).toBe(false);
  });

  it('Smarte Links is a toggle for this tab (aria-pressed, on by default), not a tool', async () => {
    const { user } = setup(<Rows />);
    useDocuments.setState({ byId: { 7: { id: 7 } as never }, order: [7], activeId: 7 });
    useSmartLinks.setState({ enabled: true, overrides: {} });
    const button = item('Smart links');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-toolbar-item')).toBe('smartLinks');
    await user.click(button);
    expect(item('Smart links').getAttribute('aria-pressed')).toBe('false');
    expect(useSmartLinks.getState().overrides).toEqual({ 7: false });
    expect(useUi.getState().activeTool).toBe('select');
    expect(item('Select').getAttribute('aria-pressed')).toBe('true');
    await user.click(item('Smart links'));
    expect(useSmartLinks.getState().overrides).toEqual({});
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

  it('a split item is one clipped square: the chevron is a badge inside it, no extra width, no scale on press (F21.9)', () => {
    setup(<Rows />);
    const chevron = item('Options for Rotate');
    const outer = chevron.closest('[data-split]');
    expect(outer).not.toBeNull();
    expect(outer?.className).toContain('overflow-hidden');
    expect(outer?.className).toContain('rounded-(--tool-item-radius)');
    expect(outer?.className).toContain('h-tool-item w-tool-labelled');
    expect(outer?.querySelectorAll('button')).toHaveLength(2);
    expect(chevron.className).toContain('absolute');
    expect(chevron.className).toContain('size-tool-badge');
    const main = outer?.querySelector('[data-toolbar-item]');
    expect(main?.className).toContain('size-full!');
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
    const stops = [...screen.getByRole('toolbar').querySelectorAll<HTMLElement>('[data-roving]')].filter(
      (button) => button.tabIndex === 0,
    );
    expect(stops).toEqual([item('Select')]);
    item('Select').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('Hand'));
    // One toolbar over all five groups: End is the strip's last item, and the arrows cross from group to group.
    const all = [...screen.getByRole('toolbar').querySelectorAll<HTMLElement>('[data-roving]')];
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(all.at(-1));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(all.at(-1));
    item('Smart links').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(document.querySelector('[data-toolbar-item="highlight"]'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Smart links'));
    await user.keyboard('{ArrowLeft}');
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
    expect(swatches[3]?.getAttribute('aria-checked')).toBe('true');
    await user.click(within(group).getByRole('radio', { name: 'Colour 3' }));
    expect(styleFor('highlight').color).toEqual([110, 242, 48]);
    expect(within(group).getByRole('radio', { name: 'Colour 3' }).getAttribute('aria-checked')).toBe('true');
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
    expect(within(group).getAllByRole('radio')).toHaveLength(7);
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

  it('Zeichnen is a split item with Freihand, Freihand-Pfeil and Freihand-Form, and no straightening switch (F19.26)', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Options for Draw'));
    expect(screen.queryByRole('switch', { name: 'Straighten shapes automatically' })).toBeNull();
    await user.click(await screen.findByRole('radio', { name: 'Freehand arrow' }));
    expect(useTools.getState().draw).toBe('arrow');
    expect(useUi.getState().activeTool).toBe('draw');
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

  it('Ordnen cannot be released by Esc: the grid stays until a tool of another group is chosen', async () => {
    const { user } = setup(<Rows />);
    item('Arrange').focus();
    await user.keyboard('{Escape}');
    expect(useUi.getState()).toMatchObject({ mode: 'pages', activeTool: 'pages' });
    await user.click(document.querySelector<HTMLElement>('[data-toolbar-item="select"]') as HTMLElement);
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

  it('has the nine slots of the mode table, Stempel and Kopf-/Fußzeile among them', () => {
    setup(<Rows />);
    expect(slotNames()).toEqual([
      'Edit text',
      'Add text',
      'Image',
      'Crop',
      'Header/footer',
      'Stamp',
      'Redact',
      'Protect',
      'Metadata',
    ]);
  });

  it('the tools select their tool ids, Schwärzen turns the mode on and stays on', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Add text'));
    expect(useUi.getState().activeTool).toBe('textBox');
    await user.click(item('Image'));
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

  it('Zuschneiden, Kopf-/Fußzeile and Stempel open the tool inspector, not a popover', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Crop'));
    expect(useUi.getState().activeTool).toBe('crop');
    expect(useToolInspector.getState().open).toBe('crop');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(item('Header/footer'));
    expect(useToolInspector.getState().open).toBe('headerFooter');
    await user.click(item('Stamp'));
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useToolInspector.getState().open).toBe('stamp');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('choosing a tool of another group closes the tool inspector', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Crop'));
    expect(useToolInspector.getState().open).toBe('crop');
    await user.click(document.querySelector<HTMLElement>('[data-toolbar-item="select"]') as HTMLElement);
    expect(useToolInspector.getState().open).toBeNull();
  });

  it('Schwärzen opens no options over the page when it turns on; a click while it is on opens them (F19.8)', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Redact'));
    expect(useUi.getState().redactMode).toBe(true);
    // The popover would take the focus and cover the top of the page, where the marks are drawn by dragging.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(item('Redact').getAttribute('aria-expanded')).toBe('false');
    await user.click(item('Redact'));
    expect(screen.queryByRole('dialog', { name: /Redact/ })).not.toBeNull();
    expect(useUi.getState().redactMode).toBe(true);
    await user.click(item('Redact'));
    expect(screen.queryByRole('dialog', { name: /Redact/ })).toBeNull();
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
    await user.click(document.querySelector<HTMLElement>('[data-toolbar-item="select"]') as HTMLElement);
    expect(useUi.getState().redactMode).toBe(true);
  });
});

describe('the fit (F22.3)', () => {
  const widths = { client: 0 };
  let scroll: PropertyDescriptor | undefined;
  let client: PropertyDescriptor | undefined;

  /** jsdom has no layout: a labelled item is 64 wide, a square 36, a compact square 32; the strip is `widths.client` wide. */
  const itemWidth = (element: Element) => {
    if (element.querySelector('[data-label]') !== null) return 64;
    return (element.closest('[data-split]') ?? element).className.includes('size-tool-square-compact') ? 32 : 36;
  };

  beforeEach(() => {
    scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute('role') !== 'toolbar') return 0;
        return Array.from(this.querySelectorAll('[data-toolbar-item]')).reduce(
          (sum, entry) => sum + itemWidth(entry),
          0,
        );
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

  const fit = () => screen.getByRole('toolbar').getAttribute('data-fit');
  const labelled = () => screen.getByRole('toolbar').querySelectorAll('[data-label]').length;
  const count = () => document.querySelectorAll('[data-toolbar-item]').length;
  /** All tools of the five modes. */
  let total = 0;
  beforeEach(() => {
    widths.client = 100_000;
    const { unmount } = setup(<Rows />);
    total = count();
    unmount();
  });

  it('step 1: with room every label shows, on every tool of every group', () => {
    widths.client = 100_000;
    setup(<Rows />);
    expect(fit()).toBe('1');
    expect(total).toBeGreaterThan(30);
    expect(labelled()).toBe(total);
  });

  it('step 2: every item becomes a compact square with its name for assistive technology', () => {
    widths.client = total * 36;
    setup(<Rows />);
    expect(fit()).toBe('2');
    expect(labelled()).toBe(0);
    expect(item('Hand').getAttribute('aria-label')).toBe('Hand');
    expect(document.querySelector('[data-toolbar-item^="overflow-"]')).toBeNull();
  });

  it('without labels, step 1 is the 36 square, one size for tools, toggles and splits', () => {
    useSettings.setState({ showToolLabels: false });
    widths.client = total * 36;
    setup(<Rows />);
    expect(fit()).toBe('1');
    expect(item('Hand').className).toContain('size-tool-square');
    expect(item('Smart links').className).toContain('size-tool-square');
    expect(item('Rotate').closest('[data-split]')?.className).toContain('size-tool-square');
  });

  it('step 3: whole groups wrap, no tool leaves and there is no overflow button or menu', () => {
    widths.client = total * 32 - 1;
    setup(<Rows />);
    expect(fit()).toBe('3');
    expect(count()).toBe(total);
    expect(screen.getByRole('toolbar').className).toContain('flex-wrap');
    expect(document.querySelector('[data-toolbar-item^="overflow-"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^More .* tools$/ })).toBeNull();
  });

  it('the card grows by the second line, and a separator at the end of a line is hidden', () => {
    const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        const units = [...(this.closest('[role="toolbar"]')?.querySelectorAll('[data-unit]') ?? [])];
        return units.indexOf(this) >= 3 ? 70 : 0;
      },
    });
    try {
      widths.client = total * 32 - 1;
      const { unmount } = setup(<Rows />);
      expect(document.documentElement.dataset.toolLines).toBe('2');
      const boxes = [...document.querySelectorAll('[data-separator-box]')];
      expect(boxes.map((box) => box.hasAttribute('data-line-end'))).toEqual([false, false, true, false]);
      unmount();
      expect(document.documentElement.dataset.toolLines).toBeUndefined();
    } finally {
      if (top !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetTop', top);
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
    }
  });

  it('a window under 1100 wide shows no labels, whatever the room', () => {
    window.innerWidth = 1000;
    widths.client = 100_000;
    setup(<Rows />);
    expect(labelled()).toBe(0);
    expect(item('Hand').getAttribute('aria-label')).toBe('Hand');
  });

  it('starts over when the room grows (the width is read again)', () => {
    widths.client = total * 32 - 1;
    const first = setup(<Rows />);
    expect(fit()).toBe('3');
    first.unmount();
    widths.client = 100_000;
    setup(<Rows />);
    expect(fit()).toBe('1');
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

  it('tool labels share one width: a long one is truncated, the full name is in the tooltip and the catalog', () => {
    const { container } = setup(<Rows />);
    const labels = Array.from(container.querySelectorAll('[data-label]'));
    expect(labels.length).toBeGreaterThan(30);
    for (const label of labels) {
      expect(label.className).toContain('truncate');
      expect(label.textContent).not.toMatch(/…|\.\.\./);
      expect(label.closest('[data-toolbar-item]')?.className).toContain('w-tool-labelled');
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

describe('the tool card (DESIGN 3.18 E4, F21.9)', () => {
  it('the captions are small static secondary text; the strip is Sand', () => {
    const { container } = setup(<Rows />);
    expect(container.querySelector('[data-glide-pill="mode"]')).toBeNull();
    expect(tab('Read').className).toContain('text-xs');
    expect(tab('Read').className).toContain('text-text-muted');
    expect(tab('Read').className).not.toContain('cursor-pointer');
    expect(container.querySelector('[data-slot="tool-row"]')?.className).toContain('bg-subtle');
    expect(container.querySelector('[data-mode-group="read"]')?.getAttribute('aria-labelledby')).toBe(tab('Read').id);
  });

  it('the caption has no tooltip', async () => {
    const { user } = setup(<Rows />);
    await user.hover(tab('Pages'));
    await new Promise((done) => setTimeout(done, 700));
    expect(openTooltip()).toBeNull();
  });

  it('is one framed card with no tab header: border all round, radius md, the strip inside', () => {
    const { container } = setup(<ModeCard />);
    const card = container.querySelector('[data-slot="mode-card"]');
    expect(card?.className).toContain('h-mode-card');
    expect(card?.className).toContain('bg-chrome');
    expect(container.querySelector('[data-slot="mode-row"]')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    const frame = container.querySelector('[data-slot="mode-tool-frame"]');
    expect(frame?.className).toContain('rounded-md');
    expect(frame?.className).toMatch(/(^|\s)border(\s|$)/);
    expect(frame?.className).not.toContain('border-t-0');
    const strip = container.querySelector('[data-slot="tool-row"]');
    expect(strip?.className).toContain('h-tool-area');
    // The first group starts exactly at the strip's padding: no offset before it.
    expect(strip?.className).toContain('px-2');
    expect(strip?.querySelector('[data-glide-pill]')?.nextElementSibling?.hasAttribute('data-unit')).toBe(true);
    expect(item('Select').className).toContain('h-tool-item');
    expect(screen.getByRole('region', { name: 'Modes and tools' })).not.toBeNull();
  });

  it('each group keeps the mode table order of its slots', () => {
    const table: Record<'read' | 'comment' | 'fill' | 'pages' | 'edit', string[]> = {
      read: ['select', 'hand', 'textSelect', 'magnifier', 'rotate', 'search', 'smartLinks'],
      comment: ['highlight', 'underline', 'strikeout', 'cite', 'note', 'freeText', 'draw', 'shapes'],
      fill: ['text', 'check', 'cross', 'dot', 'date', 'signature', 'initials', 'certificate'],
      pages: ['organize', 'rotatePages', 'delete', 'insert', 'extract', 'split', 'merge', 'compress'],
      edit: ['editText', 'textBox', 'image', 'crop', 'headerFooter', 'stamp', 'redact', 'protect', 'properties'],
    };
    setup(<Rows />);
    for (const [mode, expected] of Object.entries(table)) {
      const group = document.querySelector(`[data-mode-group="${mode}"]`);
      const ids = Array.from(group?.querySelectorAll('[data-toolbar-item]') ?? []).map((node) =>
        node.getAttribute('data-toolbar-item'),
      );
      expect(ids, mode).toEqual(expected);
    }
  });

  it('a thin separator stands between every two groups and none inside a group', () => {
    setup(<Rows />);
    const separators = screen.getAllByRole('separator', { hidden: true });
    expect(separators).toHaveLength(4);
    // 20 apart, the 1 px line centred in the gap, never stretched over the card (F22.2).
    for (const separator of separators) {
      expect(separator.className).toContain('w-px');
      expect(separator.className).toContain('bg-border');
      expect(separator.parentElement?.className).toContain('w-tool-group-gap');
      expect(separator.parentElement?.className).toContain('justify-center');
      expect(separator.parentElement?.className).not.toContain('flex-1');
    }
    for (const separator of separators) {
      expect(separator.getAttribute('aria-orientation')).toBe('vertical');
      expect(separator.closest('[data-mode-group]')).toBeNull();
    }
  });

  it('no inline hints: the strip holds the labels and the captions only, hints are in the tooltip', async () => {
    const { user } = setup(<Rows />);
    const strip = screen.getByRole('toolbar');
    const texts = Array.from(strip.querySelectorAll('[data-label], [data-mode-caption]')).map((l) => l.textContent);
    expect(strip.textContent).toBe(texts.join(''));
    expect(screen.queryByText(/Or hold Z/)).toBeNull();
    await user.hover(item('Magnifier'));
    expect(await screen.findByText(/Or hold Z/)).not.toBeNull();
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

describe('toggle style (v2.0.0 designer round)', () => {
  it('a pressed toggle is White with the Stone border, not Solar, and has no data-on', () => {
    setup(<Rows />);
    useSmartLinks.setState({ enabled: true, overrides: {} });
    const button = item('Smart links');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.hasAttribute('data-on')).toBe(false);
    expect(button.className).toContain('aria-pressed:bg-card');
    expect(button.className).toContain('aria-pressed:border-border-control');
  });
});
