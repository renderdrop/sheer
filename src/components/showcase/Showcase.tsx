import {
  Check,
  FileText,
  GalleryVertical,
  Highlighter,
  LayoutGrid,
  ListTree,
  MessageSquare,
  MessagesSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  PenLine,
  Plus,
  Search,
  Signature,
  Stamp,
  TextCursorInput,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import {
  Button,
  Field,
  IconButton,
  Menu,
  Panel,
  PanelSection,
  Popover,
  Slider,
  Splitter,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Toolbar,
  Tooltip,
  type MenuEntry,
  type ToolbarEntry,
} from '..';
import './showcase.css';

/*
 * Dev-only showcase of the primitives (DESIGN section 3), reached at #showcase in `npm run dev`. App.tsx loads it only
 * when import.meta.env.DEV is true, so it is not part of a production build. Everything here is English, hard-coded
 * and throwaway on purpose: it is a test bench, not a screen.
 */

type Tool = 'select' | 'highlight' | 'comment' | 'draw' | 'form' | 'signature';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2 className="font-display text-xl">{title}</h2>
      {hint !== undefined && <p className="showcase-hint text-sm text-text-muted">{hint}</p>}
      <div className="showcase-rows flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="showcase-label shrink-0 text-sm text-text-muted">{label}</span>
      {children}
    </div>
  );
}

/** Theme and glass switches for looking at every state in every mode. They set the same attributes the settings store sets. */
function ModeSwitches() {
  const set = (name: 'theme' | 'transparency', value: string | null) => {
    if (value === null) delete document.documentElement.dataset[name];
    else document.documentElement.dataset[name] = value;
  };
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Row label="Theme">
        <Button size="sm" onClick={() => set('theme', null)}>
          Auto
        </Button>
        <Button size="sm" onClick={() => set('theme', 'light')}>
          Light
        </Button>
        <Button size="sm" onClick={() => set('theme', 'dark')}>
          Dark
        </Button>
      </Row>
      <Row label="Glass">
        <Button size="sm" onClick={() => set('transparency', null)}>
          Auto
        </Button>
        <Button size="sm" onClick={() => set('transparency', 'reduced')}>
          Solid
        </Button>
      </Row>
    </div>
  );
}

function Buttons() {
  const variants = ['primary', 'secondary', 'ghost'] as const;
  const sizes = ['sm', 'md', 'lg'] as const;
  return (
    <Section title="Button" hint="One primary per view. Hover, press and focus (Tab) show on every row.">
      {variants.map((variant) => (
        <Row key={variant} label={variant}>
          {sizes.map((size) => (
            <Button key={size} variant={variant} size={size}>
              {size === 'lg' ? 'Open…' : `Label ${size}`}
            </Button>
          ))}
          <Button variant={variant} icon={Plus}>
            With icon
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} disabled focusableWhenDisabled>
            aria-disabled
          </Button>
        </Row>
      ))}
    </Section>
  );
}

function IconButtons() {
  const [toggled, setToggled] = useState(true);
  const [tool, setTool] = useState(false);
  return (
    <Section title="IconButton" hint="Name = tooltip = aria-label. Toggle and tool states, the lock badge, sizes.">
      <Row label="plain">
        <IconButton label="Add" icon={Plus} shortcut="Ctrl+N" />
        <IconButton label="Add (small)" icon={Plus} size="sm" />
        <IconButton label="Disabled" icon={Plus} disabled />
        <IconButton label="Disabled but focusable" icon={Plus} disabled focusableWhenDisabled />
      </Row>
      <Row label="toggle">
        <IconButton
          label="Left panel"
          icon={PanelLeft}
          variant="toggle"
          pressed={toggled}
          onClick={() => setToggled(!toggled)}
          shortcut="Ctrl+B"
        />
        <IconButton label="Right panel" icon={PanelRight} variant="toggle" pressed={false} />
      </Row>
      <Row label="tool">
        <IconButton
          label="Highlight"
          icon={Highlighter}
          variant="tool"
          iconSize={20}
          pressed={tool}
          onClick={() => setTool(!tool)}
          shortcut="H"
        />
        <IconButton label="Draw" icon={PenLine} variant="tool" iconSize={20} pressed locked shortcut="D" />
        <IconButton label="Comment" icon={MessageSquare} variant="tool" iconSize={20} pressed={false} />
      </Row>
    </Section>
  );
}

const ZOOM_PRESETS = ['Fit width', 'Fit page', 'Actual size', '200 %'];

function ToolbarDemo() {
  const [tool, setTool] = useState<Tool>('select');
  const [locked, setLocked] = useState(false);
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(false);
  const [zoom, setZoom] = useState('Fit width');
  const [width, setWidth] = useState(960);

  // Esc releases a locked tool, then drops back to Select (DESIGN 3.3). Open tooltips and popovers see Esc first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTool('select');
      setLocked(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toolItem = (id: Tool, label: string, icon: typeof Highlighter, shortcut: string, collapse?: number) => ({
    id,
    label,
    icon,
    kind: 'tool' as const,
    pressed: tool === id,
    locked: tool === id && locked,
    shortcut,
    keyShortcuts: shortcut,
    collapse,
    onActivate: () => {
      setTool(id);
      setLocked(false);
    },
    onLock:
      id === 'select'
        ? undefined
        : () => {
            setTool(id);
            setLocked(true);
          },
  });

  const zoomMenu: MenuEntry[] = ZOOM_PRESETS.map((preset) => ({
    id: preset,
    label: preset,
    checked: zoom === preset,
    onSelect: () => setZoom(preset),
  }));

  const entries: ToolbarEntry[] = [
    {
      id: 'sidebar',
      label: 'Panels',
      items: [
        {
          id: 'left',
          label: 'Left panel',
          icon: PanelLeft,
          kind: 'toggle',
          pressed: left,
          shortcut: 'Ctrl+B',
          onActivate: () => setLeft(!left),
        },
      ],
    },
    { id: 'select', label: 'Select', items: [toolItem('select', 'Select', MousePointer2, 'V')] },
    {
      id: 'markup',
      label: 'Markup',
      items: [
        toolItem('highlight', 'Highlight', Highlighter, 'H'),
        toolItem('comment', 'Comment', MessageSquare, 'C'),
        toolItem('draw', 'Draw', PenLine, 'D'),
      ],
    },
    {
      id: 'fill',
      label: 'Fill and sign',
      items: [toolItem('form', 'Form', TextCursorInput, 'F', 2), toolItem('signature', 'Signature', Signature, 'S', 2)],
    },
    {
      id: 'pages',
      label: 'Pages',
      items: [
        {
          id: 'pages',
          label: 'Pages',
          icon: LayoutGrid,
          kind: 'toggle',
          pressed: false,
          shortcut: 'P',
          collapse: 1,
          onActivate: () => undefined,
        },
      ],
    },
    { type: 'more', id: 'more' },
    { type: 'spacer', id: 'spacer' },
    {
      id: 'zoom',
      label: 'Zoom',
      items: [
        {
          id: 'zoom-out',
          label: 'Zoom out',
          icon: ZoomOut,
          shortcut: 'Ctrl+−',
          collapse: 3,
          onActivate: () => setZoom('Zoom out'),
        },
        { id: 'readout', label: 'Zoom level', text: zoom === '200 %' ? '200 %' : '125 %', menu: zoomMenu },
        {
          id: 'zoom-in',
          label: 'Zoom in',
          icon: ZoomIn,
          shortcut: 'Ctrl++',
          collapse: 4,
          onActivate: () => setZoom('Zoom in'),
        },
      ],
    },
    {
      id: 'inspector',
      label: 'Inspector',
      items: [
        {
          id: 'right',
          label: 'Right panel',
          icon: PanelRight,
          kind: 'toggle',
          pressed: right,
          onActivate: () => setRight(!right),
        },
      ],
    },
  ];

  const moreItems: MenuEntry[] = [
    { id: 'stamp', label: 'Stamp', icon: Stamp, onSelect: () => undefined },
    { id: 'rotate', label: 'Rotate view', shortcut: 'Ctrl+R', onSelect: () => undefined },
    { id: 'goto', label: 'Go to page…', shortcut: 'Ctrl+G', onSelect: () => undefined },
  ];

  return (
    <Section
      title="Toolbar"
      hint="Left and Right move, Home and End jump, ArrowDown opens menus. Click selects once; double click or Shift+Enter locks; Esc releases. Narrow it with the slider: Pages, then Fill and sign, then zoom move into More."
    >
      <Slider
        label="Toolbar width"
        unit="px"
        min={320}
        max={960}
        step={8}
        value={width}
        onValueChange={setWidth}
        className="showcase-slider-wide"
      />
      <div style={{ width }} className="showcase-fit">
        <Toolbar label="Tools" entries={entries} moreItems={moreItems} />
      </div>
      <p className="text-sm text-text-muted">
        Tool: {tool}
        {locked ? ' (locked)' : ''} · Zoom menu: {zoom}
      </p>
    </Section>
  );
}

function Tooltips() {
  return (
    <Section
      title="Tooltip"
      hint="Hover 500 ms, keyboard focus 300 ms, next one at once. Esc closes it; it stays while the pointer is on it."
    >
      <Row label="below">
        <IconButton label="Highlight" icon={Highlighter} shortcut="H" />
        <IconButton label="Draw" icon={PenLine} shortcut="D" />
        <IconButton label="Locked tool" icon={PenLine} variant="tool" pressed locked shortcut="D" />
      </Row>
      <Row label="right">
        <Tooltip label="Thumbnails" shortcut="Ctrl+1" side="right">
          <Button variant="ghost" size="sm">
            Anchor on a panel
          </Button>
        </Tooltip>
      </Row>
    </Section>
  );
}

function Popovers() {
  const [opacity, setOpacity] = useState(70);
  const [color, setColor] = useState('Yellow');
  const colors = ['Yellow', 'Green', 'Blue', 'Pink'];
  const entries: MenuEntry[] = [
    ...colors.map((name) => ({ id: name, label: name, checked: color === name, onSelect: () => setColor(name) })),
    { type: 'separator', id: 'sep' },
    { id: 'more', label: 'More colors…', icon: Check, shortcut: 'Ctrl+K', onSelect: () => undefined },
    {
      id: 'recent',
      label: 'Recent colors',
      onSelect: () => undefined,
      submenu: colors.map((name) => ({ id: `recent-${name}`, label: name, onSelect: () => setColor(name) })),
    },
    { id: 'off', label: 'Not available', disabled: true, onSelect: () => undefined },
  ];
  return (
    <Section
      title="Popover and Menu"
      hint="G2 surface. Esc or an outside click closes it and returns focus. Menus: arrows, type-ahead, Enter, Right and Left for the solid submenu (or rest the pointer on its item). Place one near an edge to see it flip."
    >
      <Row label="dialog">
        <Popover label="Highlight options" trigger={(trigger) => <Button {...trigger}>Options…</Button>}>
          {({ close }) => (
            <div className="flex flex-col gap-2 p-2">
              <Slider label="Opacity" unit="%" value={opacity} onValueChange={setOpacity} />
              <div className="showcase-end flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => close('select')}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </Popover>
      </Row>
      <Row label="menu">
        <Menu
          label="Highlight color"
          entries={entries}
          trigger={(trigger) => <Button {...trigger}>Color: {color}</Button>}
        />
        <IconButton label="Close" icon={X} size="sm" />
      </Row>
      <div className="showcase-end flex">
        <Menu
          label="Edge menu"
          align="end"
          entries={entries}
          trigger={(trigger) => <Button {...trigger}>Menu at the right edge</Button>}
        />
      </div>
    </Section>
  );
}

function LeftPanelDemo() {
  const [tab, setTab] = useState('thumbnails');
  const [width, setWidth] = useState(248);
  const [collapsed, setCollapsed] = useState(false);
  const [inspector, setInspector] = useState(true);
  const [opacity, setOpacity] = useState(100);

  return (
    <Section
      title="Tabs, Panel and Splitter"
      hint="Splitter: Left and Right resize by 8 (Shift 40), Home and End, Enter collapses and restores, double click resets, drag below 144 collapses. Tab F6-style: splitter is a tab stop."
    >
      <div>
        <Button size="sm" onClick={() => setInspector(!inspector)}>
          {inspector ? 'Hide' : 'Show'} inspector (fade)
        </Button>
      </div>
      <div
        className="showcase-stage grid"
        style={{ gridTemplateColumns: `${collapsed ? 0 : width}px auto minmax(0, 1fr) auto` }}
      >
        <Tabs value={tab} onValueChange={setTab} className="contents">
          <Panel
            id="demo-left-panel"
            label="Left panel"
            visible={!collapsed}
            header={
              <TabList label="Left panel views">
                <Tab value="thumbnails" label="Thumbnails" icon={GalleryVertical} shortcut="Ctrl+1" />
                <Tab value="outline" label="Outline" icon={ListTree} shortcut="Ctrl+2" />
                <Tab value="comments" label="Comments" icon={MessagesSquare} shortcut="Ctrl+3" />
                <Tab value="search" label="Search" icon={Search} shortcut="Ctrl+F" />
              </TabList>
            }
          >
            <TabPanel value="thumbnails">Thumbnails view</TabPanel>
            <TabPanel value="outline">Outline view</TabPanel>
            <TabPanel value="comments">Comments view</TabPanel>
            <TabPanel value="search">Search view</TabPanel>
          </Panel>
        </Tabs>
        <Splitter
          label="Resize left panel"
          controls="demo-left-panel"
          value={width}
          collapsed={collapsed}
          onValueChange={setWidth}
          onCollapsedChange={setCollapsed}
        />
        <div className="flex min-w-0 items-center justify-center rounded-panel bg-page-area p-6 text-text-muted">
          <FileText aria-hidden="true" className="showcase-icon-gap size-icon-24" />
          Canvas
        </div>
        <div
          className={`showcase-inspector-slot grid transition-opacity duration-slow ${inspector ? '' : 'showcase-inspector-slot-hidden'}`}
        >
          <Panel
            label="Inspector"
            title="Highlight"
            visible={inspector}
            className="showcase-inspector"
            actions={<IconButton label="Close inspector" icon={X} size="sm" onClick={() => setInspector(false)} />}
          >
            <PanelSection label="Appearance">
              <Slider label="Opacity" unit="%" value={opacity} onValueChange={setOpacity} />
            </PanelSection>
            <PanelSection label="Comment">
              <p className="text-sm text-text-muted">Sections are split by a divider.</p>
            </PanelSection>
          </Panel>
        </div>
      </div>
    </Section>
  );
}

function Sliders() {
  const [a, setA] = useState(40);
  const [b, setB] = useState(1.5);
  return (
    <Section
      title="Slider"
      hint="Arrows step, Shift x10, PageUp/PageDown 10 %, Home/End. The field: Enter commits, Esc reverts."
    >
      <Slider
        label="Zoom"
        unit="%"
        min={10}
        max={400}
        step={5}
        value={a}
        onValueChange={setA}
        className="showcase-slider"
      />
      <Slider
        label="Stroke width"
        unit="pt"
        min={0.5}
        max={12}
        step={0.25}
        value={b}
        onValueChange={setB}
        className="showcase-slider"
      />
      <Slider
        label="Disabled"
        unit="%"
        value={30}
        onValueChange={() => undefined}
        disabled
        className="showcase-slider"
      />
    </Section>
  );
}

function Fields() {
  return (
    <Section
      title="Field"
      hint="The number field of the slider and of the forms in popovers: 56 wide, 24 or 32 high. Focus it with Tab; the invalid one has the error border."
    >
      <label className="flex items-center gap-3 text-sm font-semibold">
        md (32)
        <Field type="number" min={1} max={120} defaultValue={3} />
      </label>
      <label className="flex items-center gap-3 text-sm font-semibold">
        sm (24), text at the end
        <Field size="sm" align="end" defaultValue="125 %" />
      </label>
      <label className="flex items-center gap-3 text-sm font-semibold">
        Disabled
        <Field disabled defaultValue="42" />
      </label>
      <label className="flex items-center gap-3 text-sm font-semibold">
        Invalid
        <Field aria-invalid="true" defaultValue="999" />
      </label>
    </Section>
  );
}

export default function Showcase() {
  return (
    <div className="h-full overflow-auto p-6">
      <header className="showcase-header flex flex-wrap items-center gap-4">
        <div>
          <h1 className="showcase-title font-display">Components</h1>
          <p className="text-text-muted">
            Dev only. Tab through everything; try reduced motion and reduced transparency in DevTools.
          </p>
        </div>
        <ModeSwitches />
      </header>
      <ToolbarDemo />
      <Buttons />
      <IconButtons />
      <Tooltips />
      <Popovers />
      <LeftPanelDemo />
      <Sliders />
      <Fields />
    </div>
  );
}
