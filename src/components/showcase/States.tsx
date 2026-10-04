import { Check, Info, Plus, Star, TriangleAlert, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  BrandSurface,
  Button,
  Checkbox,
  Dropzone,
  Field,
  IconButton,
  Radio,
  Segmented,
  Skeleton,
  SolarGlow,
  Swatch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Toggle,
  Tooltip,
  type SolarGlowVariant,
} from '..';

/*
 * Dev-only specimens of every primitive in every state (DESIGN v2 section 4), shown at /dev/components. Hover, pressed and
 * focus are forced with data-force on a wrapper (showcase.css paints the token values the primitive uses on the real state).
 * English and hard-coded on purpose; the folder is excluded from the app's class scan and from the string lint.
 */

type Force = 'rest' | 'hover' | 'pressed' | 'focus';
const FORCES: readonly Force[] = ['rest', 'hover', 'pressed', 'focus'];

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2 className="font-display text-xl">{title}</h2>
      {hint !== undefined && <p className="showcase-hint text-sm text-text-muted">{hint}</p>}
      <div className="showcase-rows flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function Forced({ force, variant, children }: { force: Force; variant: string; children: ReactNode }) {
  return (
    <span className="showcase-force" data-force={force} data-variant={variant}>
      {children}
    </span>
  );
}

export function ButtonStates() {
  const variants = ['primary', 'secondary', 'ghost'] as const;
  return (
    <Group title="Button states" hint="Static forced states: rest, hover, pressed, keyboard focus, disabled.">
      {variants.map((variant) => (
        <div key={variant} className="showcase-states-grid">
          {FORCES.map((force) => (
            <Labelled key={force} label={`${variant} ${force}`}>
              <Forced force={force} variant={variant}>
                <Button variant={variant}>Label</Button>
              </Forced>
            </Labelled>
          ))}
          <Labelled label={`${variant} disabled`}>
            <Button variant={variant} disabled>
              Label
            </Button>
          </Labelled>
          <Labelled label={`${variant} large`}>
            <Button variant={variant} size="lg" icon={Plus}>
              Large
            </Button>
          </Labelled>
        </div>
      ))}
      <div className="showcase-states-grid">
        {FORCES.map((force) => (
          <Labelled key={force} label={`icon button ${force}`}>
            <Forced force={force} variant="icon">
              <IconButton label={`Star ${force}`} icon={Star} />
            </Forced>
          </Labelled>
        ))}
        <Labelled label="toggled">
          <IconButton label="Starred" icon={Star} variant="toggle" pressed />
        </Labelled>
        <Labelled label="tool active">
          <IconButton label="Tool" icon={Plus} variant="tool" pressed />
        </Labelled>
        <Labelled label="disabled">
          <IconButton label="Disabled" icon={Plus} disabled />
        </Labelled>
      </div>
    </Group>
  );
}

const SWATCHES = [
  ['ink', 'Ink', 'var(--stroke-ink)'],
  ['solar', 'Solar', 'var(--stroke-solar)'],
  ['mint', 'Mint', 'var(--stroke-mint)'],
  ['sky', 'Sky', 'var(--stroke-sky)'],
] as const;

export function FormControls() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState('b');
  const [color, setColor] = useState('solar');
  return (
    <Group title="Field, Toggle, Checkbox, Radio, Segmented, Swatch" hint="Off, on, hover (forced), disabled, error.">
      <div className="showcase-states-grid">
        <Labelled label="field">
          <Field defaultValue="Value" aria-label="Field" />
        </Labelled>
        <Labelled label="field placeholder">
          <Field placeholder="Placeholder" aria-label="Placeholder field" />
        </Labelled>
        <Labelled label="field error">
          <Field aria-invalid="true" defaultValue="999" aria-label="Field with error" />
        </Labelled>
        <Labelled label="field disabled">
          <Field disabled defaultValue="42" aria-label="Disabled field" />
        </Labelled>
      </div>
      <div className="showcase-states-grid">
        <Labelled label="toggle off">
          <Toggle checked={false} onCheckedChange={() => undefined} aria-label="Off" />
        </Labelled>
        <Labelled label="toggle on">
          <Toggle checked={on} onCheckedChange={setOn} aria-label="On" />
        </Labelled>
        <Labelled label="toggle disabled">
          <Toggle checked={false} onCheckedChange={() => undefined} disabled aria-label="Disabled" />
        </Labelled>
        <Labelled label="checkbox">
          <Checkbox aria-label="Unchecked" />
        </Labelled>
        <Labelled label="checkbox hover">
          <Forced force="hover" variant="check">
            <Checkbox aria-label="Hover" />
          </Forced>
        </Labelled>
        <Labelled label="checkbox checked">
          <Checkbox aria-label="Checked" defaultChecked />
        </Labelled>
        <Labelled label="checkbox disabled">
          <Checkbox aria-label="Disabled" disabled />
        </Labelled>
        <Labelled label="radio">
          <Radio aria-label="Radio off" name="demo-radio" />
        </Labelled>
        <Labelled label="radio checked">
          <Radio aria-label="Radio on" name="demo-radio" defaultChecked />
        </Labelled>
        <Labelled label="radio disabled">
          <Radio aria-label="Radio disabled" name="demo-radio-2" disabled />
        </Labelled>
      </div>
      <div className="showcase-states-grid">
        <Labelled label="segmented">
          <Segmented
            label="Demo"
            value={seg}
            onValueChange={setSeg}
            options={[
              { value: 'a', label: 'One' },
              { value: 'b', label: 'Two' },
              { value: 'c', label: 'Three' },
            ]}
          />
        </Labelled>
        <Labelled label="segmented disabled">
          <Segmented
            label="Disabled"
            value="a"
            onValueChange={() => undefined}
            disabled
            options={[
              { value: 'a', label: 'One' },
              { value: 'b', label: 'Two' },
            ]}
          />
        </Labelled>
        <Labelled label="swatches: Stone ring, selected = Ink ring + check">
          <div role="radiogroup" aria-label="Colour" className="flex gap-2">
            {SWATCHES.map(([id, name, fill]) => (
              <Swatch
                key={id}
                label={name}
                style={{ backgroundColor: fill }}
                checked={color === id}
                checkClass={id === 'ink' ? 'text-white' : undefined}
                onClick={() => setColor(id)}
              />
            ))}
            <Swatch label="Disabled" checked={false} disabled />
          </div>
        </Labelled>
      </div>
    </Group>
  );
}

export function TabsDemo() {
  const [tab, setTab] = useState('a');
  return (
    <Group title="Tabs" hint="Active: Ink 500 + Solar underline; inactive Text-secondary.">
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Demo tabs">
          <Tab value="a" label="Pages" icon={Check} />
          <Tab value="b" label="Outline" icon={Info} />
          <Tab value="c" label="Comments" icon={X} />
        </TabList>
        <TabPanel value="a">Pages</TabPanel>
        <TabPanel value="b">Outline</TabPanel>
        <TabPanel value="c">Comments</TabPanel>
      </Tabs>
    </Group>
  );
}

export function Surfaces() {
  return (
    <Group
      title="Tooltip, kbd, Popover, Menu, Dialog, Toast, Banner"
      hint="Open (static) specimens of the floating surfaces."
    >
      <div className="showcase-states-grid">
        <Labelled label="tooltip + kbd (live: hover)">
          <Tooltip label="Highlight" shortcut="H">
            <Button variant="secondary">Hover me</Button>
          </Tooltip>
        </Labelled>
        <Labelled label="tooltip, open">
          <span className="showcase-tooltip">
            Highlight <kbd className="showcase-kbd">H</kbd>
          </span>
        </Labelled>
        <Labelled label="popover, open">
          <div className="showcase-popover-static">
            <p className="text-md">Popover content</p>
          </div>
        </Labelled>
        <Labelled label="menu, open">
          <div className="showcase-menu-static" role="presentation">
            <div className="showcase-menu-item">Item</div>
            <div className="showcase-menu-item" data-hover="">
              Hovered
            </div>
            <div className="showcase-menu-item">
              <span>Checked</span>
              <Check aria-hidden="true" size={16} />
            </div>
            <div className="showcase-menu-item" data-disabled="">
              Disabled
            </div>
          </div>
        </Labelled>
      </div>
      <Labelled label="dialog on scrim">
        <div className="showcase-scrim">
          <div className="showcase-dialog" role="presentation">
            <h3 className="text-lg">Dialog title</h3>
            <p className="text-md">One Primary, one Secondary, footer right.</p>
            <div className="showcase-dialog-footer">
              <Button variant="secondary">Cancel</Button>
              <Button variant="primary">Confirm</Button>
            </div>
          </div>
        </div>
      </Labelled>
      <Labelled label="toast">
        <div className="showcase-toast" role="presentation">
          <Check aria-hidden="true" size={16} />
          <span className="text-md">Saved</span>
          <Button variant="ghost" size="sm">
            Undo
          </Button>
        </div>
      </Labelled>
      <Labelled label="banner">
        <div className="showcase-banner" role="presentation">
          <Info aria-hidden="true" size={16} />
          <span className="text-md">Form detected, 12 fields</span>
          <IconButton label="Close banner" icon={X} size="sm" />
        </div>
      </Labelled>
      <Labelled label="banner, danger (redact, errors)">
        <div className="showcase-banner" data-danger="" role="presentation">
          <TriangleAlert aria-hidden="true" size={16} />
          <span className="text-md">Redaction is permanent</span>
        </div>
      </Labelled>
    </Group>
  );
}

export function Placeholders() {
  const variants: SolarGlowVariant[] = ['hero', 'empty', 'card', 'drop', 'splash'];
  return (
    <Group title="Skeleton, Dropzone, SolarGlow" hint="Glows live inside a BrandSurface only; the parent clips them.">
      <div className="showcase-skeletons">
        <Skeleton shape="block" className="showcase-skeleton-block" />
        <Skeleton shape="line" className="showcase-skeleton-line" />
        <Skeleton shape="circle" className="size-swatch" />
      </div>
      <div className="showcase-states-grid">
        <Labelled label="dropzone">
          <Dropzone className="showcase-dropzone">Drop a PDF here</Dropzone>
        </Labelled>
        <Labelled label="dropzone, drag over (drag a file onto it)">
          <Dropzone className="showcase-dropzone">Drag over me</Dropzone>
        </Labelled>
      </div>
      <div className="showcase-states-grid">
        {variants.map((variant) => (
          <Labelled key={variant} label={`glow ${variant}`}>
            <BrandSurface className="showcase-brand">
              <SolarGlow variant={variant} />
              <p className="text-lg">Ink on glow</p>
            </BrandSurface>
          </Labelled>
        ))}
      </div>
    </Group>
  );
}
