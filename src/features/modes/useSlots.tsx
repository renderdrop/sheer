import {
  Calendar,
  Check,
  Circle,
  Combine,
  Crop,
  FileArchive,
  FileOutput,
  FilePlus,
  FileSignature,
  FileUp,
  Hand,
  Highlighter,
  ImagePlus,
  Info,
  LayoutGrid,
  Lock,
  StickyNote,
  MessageSquareText,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Scissors,
  Search,
  Shapes,
  Signature,
  Square,
  SquareSlash,
  Stamp,
  Quote,
  Strikethrough,
  TextCursor,
  TextSelect,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  Dot,
  type LucideIcon,
} from 'lucide-react';
import { createElement, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';

import { runAction } from '../../actions/dispatch';
import type { ActionId } from '../../actions/registry';
import { listSignatures, type LibraryItem, type SignatureRole } from '../../api/library';
import { useT, type Translate } from '../../i18n';
import type { SigningIdentityInfo, StoreStatus } from '../../api/signing';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useTools, type MarkupVariant, type ShapeVariant } from '../../stores/tools';
import { useUi, type Mode, type ToolId } from '../../stores/ui';
import { deletePages, insertBlank, insertFromFile, rotatePages } from '../organize/commands';
import { useSlots as usePageSlots } from '../organize/source';
import { selectionOf, useOrganize } from '../organize/store';
import { runCompress, runExtract, runMerge, runSplit } from '../jobs/actions';
import { useSignatureLock } from '../lock/useSignatureLock';
import { openCertificateManager } from '../signatures/certs/open';
import { armItem, createAndArm } from '../signatures/place/menu';
import { canSign, useSigningIdentities } from '../signatures/sign/identities';
import { useCertSign } from '../signatures/sign/store';
import { usePlacement, type PlaceItem } from '../signatures/place/store';
import { CropOptions, InsertOptions, RedactOptions } from './Options';
import { SignaturePreview } from '../signatures/library/SignaturePreview';
import type { SlotDef, VariantDef } from './model';

/** The variant each split slot last ran (its main part shows and repeats it); the order of the variants decides the first. */
const useLastVariant = create<{
  last: Readonly<Record<string, string>>;
  remember: (slot: string, id: string) => void;
}>()((set) => ({
  last: {},
  remember: (slot, id) => set((state) => (state.last[slot] === id ? state : { last: { ...state.last, [slot]: id } })),
}));

/** The saved signatures and initials, read once when `enabled` first holds (Ausfüllen & Signieren is on). */
function useLibraryItems(enabled: boolean): readonly LibraryItem[] {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listSignatures().then(
      (library) => {
        if (!cancelled) setItems(library.status === 'locked' ? [] : library.items);
      },
      () => undefined, // the slots still work without the saved items; the library screen reports a failed read
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return items;
}

/** Makes a tool the active one. Unlike a toolbar click it never toggles the tool off: it stays until Esc or Auswahl (ADR-056). */
function choose(tool: ToolId): void {
  const ui = useUi.getState();
  if (ui.activeTool !== tool) ui.selectTool(tool);
}

/** The markup tools are one tool with three variants of the `tools` store. */
function chooseMarkup(variant: MarkupVariant): void {
  useTools.getState().setMarkup(variant);
  choose('highlight');
}

function chooseShape(variant: ShapeVariant): void {
  useTools.getState().setShapes(variant);
  choose('shapes');
}

/** The variant a split slot's main part runs: the last one used, else the first. */
function lastOf(slot: string, variants: readonly VariantDef[], last: Readonly<Record<string, string>>): VariantDef {
  // A family always has variants.
  return variants.find((variant) => variant.id === last[slot]) ?? (variants[0] as VariantDef);
}

interface Inputs {
  t: Translate;
  activeTool: ToolId;
  redactMode: boolean;
  markup: MarkupVariant;
  shapes: ShapeVariant;
  armed: PlaceItem | null;
  docId: number | null;
  readOnly: boolean;
  selectedPages: number;
  pageCount: number;
  last: Readonly<Record<string, string>>;
  library: readonly LibraryItem[];
  /** Certificate signing (DESIGN 3.8 S1): the identities, the store's state, the chosen identity and whether the tool is on. */
  identities: readonly SigningIdentityInfo[];
  certStatus: StoreStatus | 'unknown';
  certId: string | null;
  certActive: boolean;
  /** The document has changes that are not saved: signing needs a saved file. */
  dirty: boolean;
}

type Maker = (inputs: Inputs) => SlotDef[];

const remember = (slot: string, id: string) => useLastVariant.getState().remember(slot, id);

/** A split slot: its variants, and a main part that repeats the last one run. */
function family(
  inputs: Inputs,
  base: Omit<SlotDef, 'icon' | 'label' | 'run' | 'variants'>,
  label: string,
  variants: readonly VariantDef[],
): SlotDef {
  const current = lastOf(base.id, variants, inputs.last);
  const wrapped = variants.map((variant) => ({
    ...variant,
    run: () => {
      remember(base.id, variant.id);
      variant.run();
    },
  }));
  return {
    ...base,
    label,
    icon: current.icon,
    variants: wrapped,
    run: () => {
      remember(base.id, current.id);
      current.run();
    },
  };
}

const lesen: Maker = (inputs) => {
  const { t, activeTool } = inputs;
  const rotate: VariantDef[] = [
    { id: 'right', label: t('modes.tool.rotateRight'), icon: RotateCw, run: () => void runAction('rotate-view-right') },
    { id: 'left', label: t('modes.tool.rotateLeft'), icon: RotateCcw, run: () => void runAction('rotate-view-left') },
    { id: 'reset', label: t('modes.tool.rotateReset'), icon: Undo2, run: () => void runAction('rotate-view-reset') },
  ];
  const tool = (id: ToolId, label: string, icon: LucideIcon, extra: Partial<SlotDef> = {}): SlotDef => ({
    id,
    label,
    icon,
    kind: 'tool',
    on: activeTool === id,
    run: () => choose(id),
    ...extra,
  });
  return [
    tool('select', t('modes.tool.select'), MousePointer2, {
      actionId: 'tool-select',
      run: () => useUi.getState().releaseTool(),
    }),
    tool('hand', t('modes.tool.hand'), Hand),
    tool('textSelect', t('modes.tool.textSelect'), TextSelect),
    tool('magnifier', t('modes.tool.magnifier'), ScanSearch, { hint: t('modes.tool.magnifierHint') }),
    family(
      inputs,
      { id: 'rotate', kind: 'action', on: false, actionId: 'rotate-view-right' },
      t('modes.tool.rotate'),
      rotate,
    ),
    {
      id: 'search',
      label: t('modes.tool.search'),
      icon: Search,
      kind: 'action',
      on: false,
      actionId: 'find',
      run: () => void runAction('find'),
    },
  ];
};

const kommentieren: Maker = (inputs) => {
  const { t, activeTool, markup, shapes, readOnly } = inputs;
  const markupSlot = (variant: MarkupVariant, label: string, icon: LucideIcon): SlotDef => ({
    id: variant === 'strikeout' ? 'strikeout' : variant,
    label,
    icon,
    kind: 'tool',
    on: activeTool === 'highlight' && markup === variant,
    actionId: variant === 'highlight' ? 'tool-highlight' : undefined,
    colour: { kinds: [variant] },
    run: () => chooseMarkup(variant),
  });
  const plain = (id: ToolId, slot: string, label: string, icon: LucideIcon, actionId?: ActionId): SlotDef => ({
    id: slot,
    label,
    icon,
    kind: 'tool',
    on: activeTool === id,
    actionId,
    colour: { kinds: [id === 'note' ? 'note' : id === 'text' ? 'freeText' : 'ink'] },
    run: () => choose(id),
  });
  const shapeVariants: VariantDef[] = [
    { id: 'rect', label: t('modes.tool.rect'), icon: Square, on: shapes === 'rect', run: () => chooseShape('rect') },
    {
      id: 'ellipse',
      label: t('modes.tool.ellipse'),
      icon: Circle,
      on: shapes === 'ellipse',
      run: () => chooseShape('ellipse'),
    },
    { id: 'line', label: t('modes.tool.line'), icon: Minus, on: shapes === 'line', run: () => chooseShape('line') },
    {
      id: 'arrow',
      label: t('modes.tool.arrow'),
      icon: MoveUpRight,
      on: shapes === 'arrow',
      run: () => chooseShape('arrow'),
    },
  ];
  const shapeIcon = shapeVariants.find((variant) => variant.on)?.icon ?? Shapes;
  return [
    markupSlot('highlight', t('modes.tool.highlight'), Highlighter),
    markupSlot('underline', t('modes.tool.underline'), Underline),
    markupSlot('strikeout', t('modes.tool.strike'), Strikethrough),
    // Slot 4 (DESIGN 3.7 C2): a colour tool (swatch row in the chevron menu), key Q. Not on a read-only document (AC 22).
    {
      id: 'cite',
      label: t('citation.cite'),
      icon: Quote,
      kind: 'tool',
      on: activeTool === 'cite',
      actionId: 'tool-cite',
      disabledReason: readOnly ? t('tool.readOnly') : undefined,
      colour: { kinds: ['citation'] },
      run: () => choose('cite'),
    },
    plain('note', 'note', t('modes.tool.note'), StickyNote, 'tool-note'),
    plain('text', 'freeText', t('modes.tool.freeText'), MessageSquareText, 'tool-text'),
    { ...plain('draw', 'draw', t('modes.tool.draw'), PenLine, 'tool-draw'), recogniseSwitch: true },
    {
      id: 'shapes',
      label: t('modes.tool.shapes'),
      icon: shapeIcon,
      kind: 'tool',
      on: activeTool === 'shapes',
      actionId: 'tool-shapes',
      variants: shapeVariants,
      colour: { kinds: ['rect', 'ellipse', 'line', 'arrow'] },
      run: () => choose('shapes'),
    },
  ];
};

const ausfuellen: Maker = (inputs) => {
  const { t, armed, library } = inputs;
  // Fill and Sign stays usable on the welcome document (ADR-117): it is the tour document, and Save becomes Save As.
  const item = (id: string, label: string, icon: LucideIcon, place: PlaceItem, on: boolean): SlotDef => ({
    id,
    label,
    icon,
    kind: 'tool',
    on,
    run: () => armItem(place),
  });
  const mark = (glyph: 'check' | 'cross' | 'dot', label: string, icon: LucideIcon): SlotDef =>
    item(glyph, label, icon, { type: 'mark', glyph }, armed?.type === 'mark' && armed.glyph === glyph);
  const roleSlot = (role: SignatureRole, icon: LucideIcon, label: string, newLabel: string): SlotDef => {
    const saved = library.filter((entry) => entry.role === role);
    const variants: VariantDef[] = [
      ...saved.map((entry): VariantDef => ({
        id: `lib-${entry.id}`,
        label: entry.name,
        icon,
        leading: createElement(SignaturePreview, { item: entry }),
        run: () => armItem({ type: 'signature', role, ref: { type: 'library', id: entry.id }, aspect: entry.aspect }),
      })),
      { id: `new-${role}`, label: newLabel, icon, run: () => void createAndArm(role) },
    ];
    const first = saved[0];
    return {
      id: role,
      label,
      icon,
      kind: 'tool',
      on: armed?.type === 'signature' && armed.role === role,
      variants,
      // The main part places the first saved item, or starts a new one when there is none.
      run: () =>
        first === undefined
          ? void createAndArm(role)
          : armItem({ type: 'signature', role, ref: { type: 'library', id: first.id }, aspect: first.aspect }),
    };
  };
  return [
    item('text', t('modes.tool.text'), Type, { type: 'text' }, armed?.type === 'text'),
    mark('check', t('modes.tool.check'), Check),
    mark('cross', t('modes.tool.cross'), X),
    mark('dot', t('modes.tool.dot'), Dot),
    item('date', t('modes.tool.date'), Calendar, { type: 'date' }, armed?.type === 'date'),
    roleSlot('signature', Signature, t('modes.tool.signature'), t('modes.tool.newSignature')),
    roleSlot('initials', FileSignature, t('modes.tool.initials'), t('modes.tool.newInitials')),
    zertifikat(inputs),
  ];
};

/**
 * The eighth slot of Ausfüllen & Signieren (DESIGN 3.8 S1): a certificate signature, kept apart from the visual ones because it is
 * irreversible. No tool letter. The main part activates with the last used certificate; with none it opens the manager.
 */
function zertifikat(inputs: Inputs): SlotDef {
  const { t, identities, certStatus, certId, certActive, dirty, readOnly } = inputs;
  const usable = identities.filter(canSign);
  const chosen = usable.find((identity) => identity.id === certId) ?? usable[0];
  const manage = () => openCertificateManager('certificates');
  const variants: VariantDef[] = [
    ...identities.map((identity): VariantDef => ({
      id: `cert-${identity.id}`,
      label: identity.subject.commonName,
      icon: Stamp,
      on: certActive && chosen?.id === identity.id,
      disabled: !canSign(identity),
      run: () => useCertSign.getState().activate(identity.id),
    })),
    { id: 'cert-new', label: t('cert.menu.new'), icon: Stamp, run: manage },
    ...(identities.length === 0 ? [] : [{ id: 'cert-manage', label: t('cert.menu.manage'), icon: Stamp, run: manage }]),
  ];
  let disabledReason: string | undefined;
  if (readOnly) disabledReason = t('tool.readOnly');
  else if (certStatus === 'unavailable') disabledReason = t('cert.keychainMissing');
  else if (dirty && chosen !== undefined) disabledReason = t('error.unsaved_changes');
  return {
    id: 'certificate',
    label: t('cert.tool'),
    icon: Stamp,
    kind: 'tool',
    on: certActive,
    hint: t('cert.tool.tooltip'),
    disabledReason,
    variants,
    run: () => (chosen === undefined ? manage() : useCertSign.getState().activate(chosen.id)),
  };
}

const seiten: Maker = (inputs) => {
  const { t, docId, readOnly, selectedPages, pageCount, activeTool } = inputs;
  const noPages = selectedPages === 0 ? t('modes.needPages') : undefined;
  const reason = readOnly ? t('modes.readOnly') : noPages;
  const rotate: VariantDef[] = [
    {
      id: 'left',
      label: t('modes.tool.rotateLeft'),
      icon: RotateCcw,
      run: () => docId !== null && void rotatePages(docId, -1),
    },
    {
      id: 'right',
      label: t('modes.tool.rotateRight'),
      icon: RotateCw,
      run: () => docId !== null && void rotatePages(docId, 1),
    },
  ];
  const insert: VariantDef[] = [
    {
      id: 'blank',
      label: t('modes.tool.blank'),
      icon: FilePlus,
      disabled: readOnly,
      run: () => docId !== null && void insertBlank(docId),
    },
    {
      id: 'file',
      label: t('modes.tool.fromFile'),
      icon: FileUp,
      disabled: readOnly,
      run: () => docId !== null && void insertFromFile(docId),
    },
  ];
  const action = (id: string, label: string, icon: LucideIcon, run: () => void, disabledReason?: string): SlotDef => ({
    id,
    label,
    icon,
    kind: 'action',
    on: false,
    disabledReason,
    run,
  });
  return [
    {
      id: 'organize',
      label: t('modes.tool.organize'),
      icon: LayoutGrid,
      kind: 'tool',
      on: activeTool === 'pages',
      actionId: 'tool-pages',
      run: () => choose('pages'),
    },
    family(
      inputs,
      { id: 'rotatePages', kind: 'action', on: false, disabledReason: reason },
      t('modes.tool.rotate'),
      rotate,
    ),
    action(
      'delete',
      t('modes.tool.delete'),
      Trash2,
      () => docId !== null && void deletePages(docId),
      reason ?? (selectedPages >= pageCount ? t('modes.lastPage') : undefined),
    ),
    family(
      inputs,
      { id: 'insert', kind: 'action', on: false, disabledReason: readOnly ? t('modes.readOnly') : undefined },
      t('modes.tool.insert'),
      insert,
    ),
    action('extract', t('modes.tool.extract'), FileOutput, runExtract, readOnly ? undefined : noPages),
    action('split', t('modes.tool.split'), Scissors, runSplit),
    action('merge', t('modes.tool.merge'), Combine, runMerge),
    action('compress', t('modes.tool.compress'), FileArchive, runCompress),
  ];
};

const bearbeiten: Maker = (inputs) => {
  const { t, activeTool, redactMode } = inputs;
  const tool = (
    id: ToolId,
    slot: string,
    label: string,
    icon: LucideIcon,
    actionId: ActionId,
    Options: SlotDef['Options'],
  ): SlotDef => ({
    id: slot,
    Options,
    label,
    icon,
    kind: 'tool',
    on: activeTool === id && !redactMode,
    actionId,
    run: () => choose(id),
  });
  return [
    tool('textBox', 'textBox', t('modes.tool.addText'), TextCursor, 'tool-textBox', InsertOptions),
    tool('image', 'image', t('modes.tool.addImage'), ImagePlus, 'tool-image', InsertOptions),
    tool('crop', 'crop', t('modes.tool.crop'), Crop, 'tool-crop', CropOptions),
    {
      id: 'redact',
      label: t('modes.tool.redact'),
      icon: SquareSlash,
      kind: 'tool',
      on: redactMode,
      actionId: 'tool-redact',
      Options: RedactOptions,
      // The mode stays on until Anwenden or Abbrechen (the band) or Esc: the item never toggles it off.
      run: () => {
        if (!useUi.getState().redactMode) runAction('tool-redact');
      },
    },
    {
      id: 'protect',
      label: t('modes.tool.protect'),
      icon: Lock,
      kind: 'action',
      on: false,
      run: () => void runAction('protect'),
    },
    {
      id: 'properties',
      label: t('modes.tool.properties'),
      icon: Info,
      kind: 'action',
      on: false,
      run: () => void runAction('document-properties'),
    },
  ];
};

const MAKERS: Readonly<Record<Mode, Maker>> = {
  read: lesen,
  comment: kommentieren,
  fill: ausfuellen,
  pages: seiten,
  edit: bearbeiten,
};

/** The tool-row slots of a mode (FEEDBACK F14, in its order), followed live from the stores. */
export function useModeSlots(mode: Mode): readonly SlotDef[] {
  const t = useT();
  const activeTool = useUi((state) => state.activeTool);
  const redactMode = useUi((state) => state.redactMode);
  const markup = useTools((state) => state.markup);
  const shapes = useTools((state) => state.shapes);
  const armed = usePlacement((state) => state.item);
  const docId = useDocuments(selectActiveId);
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  const selectedPages = useOrganize((state) => selectionOf(state, docId).selected.length);
  const pageCount = usePageSlots(docId).length;
  const last = useLastVariant((state) => state.last);
  const library = useLibraryItems(mode === 'fill');
  const { status: certStatus, items: identities } = useSigningIdentities(mode === 'fill');
  const certId = useCertSign((state) => state.identityId);
  const certActive = useCertSign((state) => state.active);
  const dirty = useAnnotations((state) => isDirty(state, docId));
  const locked = useSignatureLock(docId ?? undefined).locked;
  return useMemo(() => {
    const slots = MAKERS[mode]({
      t,
      activeTool,
      redactMode,
      markup,
      shapes,
      armed,
      docId,
      readOnly,
      selectedPages,
      pageCount,
      last,
      library,
      identities,
      certStatus,
      certId,
      certActive,
      dirty,
    });
    // A certifying signature locks every tool but Lesen (DESIGN 3.8 S5): each slot says why with the same tooltip.
    return locked && mode !== 'read'
      ? slots.map((slot) => ({ ...slot, disabledReason: t('cert.locked.tool') }))
      : slots;
  }, [
    mode,
    t,
    activeTool,
    redactMode,
    markup,
    shapes,
    armed,
    docId,
    readOnly,
    selectedPages,
    pageCount,
    last,
    library,
    identities,
    certStatus,
    certId,
    certActive,
    dirty,
    locked,
  ]);
}

/** For tests: the slots of a mode from explicit inputs. */
export const slotsFor = (mode: Mode, inputs: Inputs): SlotDef[] => MAKERS[mode](inputs);
