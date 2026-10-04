import {
  Calendar,
  Check,
  Circle,
  Combine,
  Crop,
  Dot,
  FileOutput,
  FilePlus,
  FileText,
  FileUp,
  Minus,
  MoveUpRight,
  Plus,
  RotateCcw,
  RotateCw,
  Scissors,
  Settings2,
  Signature,
  Square,
  SquareSlash,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { actionOf, type ActionId } from '../../actions/registry';
import { IconButton, Segmented, Toggle } from '../../components';
import { useT, type PlainKey } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { MARKUP_VARIANTS, useTools, type MarkupVariant, type ShapeVariant } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { useForms } from '../forms/store';
import { useInspector } from '../inspector/InspectorBody';
import { deletePages, insertBlank, insertFromFile, rotatePages } from '../organize/commands';
import { useSlots } from '../organize/source';
import { selectionOf, useOrganize } from '../organize/store';
import { openSignatureLibrary } from '../signatures/library';
import { armItem, createAndArm, useSignMenuEntries } from '../signatures/place/menu';
import { usePlacement } from '../signatures/place/store';
import { useActionState } from '../shell/useActionState';
import { ActionRow, Group, Hint } from './parts';
import type { RowId } from './rows';

const MARKUP_KEYS: Readonly<Record<MarkupVariant, PlainKey>> = {
  highlight: 'tool.highlight',
  underline: 'tool.underline',
  strikeout: 'tool.strike',
};
const SHAPES: readonly { value: ShapeVariant; icon: LucideIcon; key: PlainKey }[] = [
  { value: 'rect', icon: Square, key: 'tool.rect' },
  { value: 'ellipse', icon: Circle, key: 'tool.ellipse' },
  { value: 'line', icon: Minus, key: 'tool.line' },
  { value: 'arrow', icon: MoveUpRight, key: 'tool.arrow' },
];

function SelectionHint() {
  const t = useT();
  return <Hint>{t('tools.selectionHint')}</Hint>;
}

/** The options of the active tool, or the selection's properties: swatches, sliders, segmented controls, stacked 12 apart. */
function Options({ selection = false }: { selection?: boolean }) {
  const { title, body, quiet } = useInspector();
  if (body === null) return selection ? <SelectionHint /> : null;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className={quiet ? 'sr-only' : 't-caption m-0'}>{title}</h3>
      {body}
    </section>
  );
}

function MarkupPanel() {
  const t = useT();
  const markup = useTools((state) => state.markup);
  return (
    <>
      <Segmented
        label={t('tools.markupStyle')}
        value={markup}
        options={MARKUP_VARIANTS.map((value) => ({ value, label: t(MARKUP_KEYS[value]) }))}
        onValueChange={(value) => useTools.getState().setMarkup(value)}
      />
      <Options />
    </>
  );
}

function TextPanel() {
  const t = useT();
  const tool = useUi((state) => state.activeTool);
  const choose = (next: 'text' | 'textBox') => {
    const ui = useUi.getState();
    if (ui.activeTool !== next) ui.selectTool(next);
  };
  return (
    <>
      <Group label={t('tools.textKind')}>
        <ActionRow
          icon={Type}
          label={t('tools.textComment')}
          hint={t('toolbar.tool.text.hint')}
          pressed={tool === 'text'}
          onActivate={() => choose('text')}
        />
        <ActionRow
          icon={FileText}
          label={t('insert.text')}
          hint={t('insert.text.hint')}
          pressed={tool === 'textBox'}
          onActivate={() => choose('textBox')}
        />
      </Group>
      <Options />
    </>
  );
}

function ShapesPanel() {
  const t = useT();
  const shapes = useTools((state) => state.shapes);
  return (
    <>
      <div role="radiogroup" aria-label={t('tools.shapeKind')} className="flex gap-2">
        {SHAPES.map(({ value, icon, key }) => (
          <IconButton
            key={value}
            role="radio"
            aria-checked={shapes === value}
            variant="toggle"
            icon={icon}
            label={t(key)}
            onClick={() => useTools.getState().setShapes(value)}
          />
        ))}
      </div>
      <Options />
    </>
  );
}

function ImagesPanel() {
  const t = useT();
  return (
    <>
      <Hint>{t('tools.imageHint')}</Hint>
      <Options />
    </>
  );
}

function SignaturePanel() {
  const t = useT();
  const entries = useSignMenuEntries();
  const armed = usePlacement((state) => state.item);
  const library = entries.filter((entry) => entry.type !== 'separator' && entry.id.startsWith('lib-'));
  const mark = (glyph: 'check' | 'cross' | 'dot') => () => armItem({ type: 'mark', glyph });
  const isMark = (glyph: string) => armed?.type === 'mark' && armed.glyph === glyph;
  const fill: { id: string; icon: LucideIcon; label: string; run: () => void; on: boolean }[] = [
    { id: 'check', icon: Check, label: t('sign.check'), run: mark('check'), on: isMark('check') },
    { id: 'cross', icon: X, label: t('sign.cross'), run: mark('cross'), on: isMark('cross') },
    { id: 'dot', icon: Dot, label: t('sign.dot'), run: mark('dot'), on: isMark('dot') },
    { id: 'text', icon: Type, label: t('sign.text'), run: () => armItem({ type: 'text' }), on: armed?.type === 'text' },
    {
      id: 'date',
      icon: Calendar,
      label: t('sign.date'),
      run: () => armItem({ type: 'date' }),
      on: armed?.type === 'date',
    },
  ];
  return (
    <>
      <Group label={t('tools.library')}>
        {library.map((entry) =>
          entry.type === 'separator' ? null : (
            <ActionRow
              key={entry.id}
              icon={Signature}
              label={entry.label}
              onActivate={entry.onSelect}
              trailing={entry.leading}
            />
          ),
        )}
        {library.length === 0 && <Hint className="px-2">{t('tools.noSignatures')}</Hint>}
        <ActionRow icon={Plus} label={t('tools.newSignature')} onActivate={() => void createAndArm('signature')} />
        <ActionRow icon={Plus} label={t('tools.newInitials')} onActivate={() => void createAndArm('initials')} />
      </Group>
      <Group label={t('tools.fill')}>
        <div className="flex gap-2 px-2">
          {fill.map((item) => (
            <IconButton
              key={item.id}
              variant="toggle"
              icon={item.icon}
              label={item.label}
              pressed={item.on}
              onClick={item.run}
            />
          ))}
        </div>
      </Group>
      <Options />
    </>
  );
}

function PagesPanel() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const slots = useSlots(docId);
  const selection = useOrganize((state) => selectionOf(state, docId));
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  if (docId === null) return null;
  const targets = selection.selected.length > 0 ? selection.selected.length : selection.focus === null ? 0 : 1;
  const none = targets === 0 || readOnly;
  const cannotDelete = none || targets >= slots.length;
  return (
    <>
      <Hint>{t('tools.pagesHint')}</Hint>
      <Group label={t('tools.pageActions')}>
        <ActionRow
          icon={FilePlus}
          label={t('organize.blank')}
          disabled={readOnly}
          onActivate={() => void insertBlank(docId)}
        />
        <ActionRow
          icon={FileUp}
          label={t('organize.fromFile')}
          disabled={readOnly}
          onActivate={() => void insertFromFile(docId)}
        />
        <ActionRow
          icon={FileOutput}
          label={t('action.extractPages')}
          disabled={none}
          onActivate={() => runAction('extract-pages')}
        />
        <ActionRow icon={Scissors} label={t('action.split')} onActivate={() => runAction('split-document')} />
        <ActionRow icon={Combine} label={t('action.merge')} onActivate={() => runAction('merge-files')} />
        <ActionRow
          icon={RotateCcw}
          label={t('tools.rotateLeft')}
          disabled={none}
          onActivate={() => void rotatePages(docId, -1)}
        />
        <ActionRow
          icon={RotateCw}
          label={t('tools.rotateRight')}
          disabled={none}
          onActivate={() => void rotatePages(docId, 1)}
        />
        <ActionRow
          icon={Trash2}
          label={t('organize.delete')}
          disabled={cannotDelete}
          onActivate={() => void deletePages(docId)}
        />
      </Group>
    </>
  );
}

/** An action row of the registry: its name, icon and `enabled`; a click runs it. */
function RegistryRow({ id, icon }: { id: ActionId; icon: LucideIcon }) {
  const t = useT();
  const state = useActionState();
  const action = actionOf(id);
  return (
    <ActionRow
      icon={action.icon ?? icon}
      label={t(action.labelKey)}
      disabled={!action.enabled(state)}
      onActivate={() => runAction(id)}
    />
  );
}

const EXPORT_ACTIONS: readonly { id: ActionId; icon: LucideIcon }[] = [
  { id: 'export-copy', icon: FileOutput },
  { id: 'export-images', icon: FileOutput },
  { id: 'compress-document', icon: FileOutput },
  { id: 'print', icon: FileOutput },
];

function ExportPanel() {
  const t = useT();
  return (
    <div role="group" aria-label={t('tools.export')} className="flex flex-col gap-half">
      {EXPORT_ACTIONS.map(({ id, icon }) => (
        <RegistryRow key={id} id={id} icon={icon} />
      ))}
    </div>
  );
}

function MorePanel({ active }: { active: boolean }) {
  const t = useT();
  const state = useActionState();
  const tool = useUi((s) => s.activeTool);
  const redactMode = useUi((s) => s.redactMode);
  const highlight = useForms((s) => s.highlight);
  return (
    <>
      <div role="group" aria-label={t('tools.more')} className="flex flex-col gap-half">
        <ActionRow
          icon={Crop}
          label={t('crop.tool')}
          pressed={tool === 'crop' && !redactMode}
          disabled={!actionOf('tool-crop').enabled(state)}
          onActivate={() => {
            const ui = useUi.getState();
            if (ui.redactMode) ui.setRedactMode(false);
            if (ui.activeTool === 'crop') ui.releaseTool();
            else runAction('tool-crop');
          }}
        />
        <ActionRow
          icon={SquareSlash}
          label={t('toolbar.tool.redact')}
          pressed={redactMode}
          disabled={!actionOf('tool-redact').enabled(state)}
          onActivate={() => runAction('tool-redact')}
        />
        <ActionRow
          icon={Square}
          label={t('menu.tools.formHighlight')}
          disabled={!state.hasDocument}
          onActivate={() => runAction('form-highlight')}
          trailing={
            <Toggle
              tabIndex={-1}
              aria-hidden="true"
              aria-label={t('menu.tools.formHighlight')}
              checked={highlight}
              onCheckedChange={() => undefined}
              className="pointer-events-none"
            />
          }
        />
        <ActionRow icon={Settings2} label={t('menu.tools.manageSignatures')} onActivate={openSignatureLibrary} />
      </div>
      {active && <Options />}
    </>
  );
}

/**
 * The options that open under a row (DESIGN v2 3.2). `active` is whether the row's tool is the active one, which is when More
 * shows the options of Crop and Redact. Export and More are action rows; the others hold their tool's variants and options.
 */
export function ToolPanel({ row, active }: { row: RowId; active: boolean }) {
  switch (row) {
    case 'select':
      return <Options selection />;
    case 'highlight':
      return <MarkupPanel />;
    case 'text':
      return <TextPanel />;
    case 'draw':
    case 'note':
      return <Options />;
    case 'signature':
      return <SignaturePanel />;
    case 'shapes':
      return <ShapesPanel />;
    case 'image':
      return <ImagesPanel />;
    case 'pages':
      return <PagesPanel />;
    case 'export':
      return <ExportPanel />;
    case 'more':
      return <MorePanel active={active} />;
  }
}
