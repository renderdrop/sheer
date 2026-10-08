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
  Image,
  CirclePlus,
  Rows2,
  AlignLeft,
  LayoutGrid,
  Lock,
  StickyNote,
  MessageSquareText,
  Minus,
  MousePointer2,
  MoveUpRight,
  Plus,
  Settings2,
  PenLine,
  Spline,
  Lasso,
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
  TextSelect,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  Dot,
  Wand,
  type LucideIcon,
} from 'lucide-react';
import { createElement, useEffect, useMemo, useState } from 'react';

import { runAction } from '../../actions/dispatch';
import { headerFooterReason } from '../../actions/state';
import { useActionState } from '../shell/useActionState';
import type { ActionId } from '../../actions/registry';
import { listSignatures, type LibraryItem, type SignatureRole } from '../../api/library';
import { useT, type PlainKey, type Translate } from '../../i18n';
import type { SigningIdentityInfo, StoreStatus } from '../../api/signing';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useTools, type DrawVariant, type MarkupVariant, type ShapeVariant } from '../../stores/tools';
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
import { toggleSmartLinksForActive } from '../smartlinks/actions';
import { smartLinksOn, useSmartLinks } from '../smartlinks/store';
import { armStamp } from '../annotations/stamps/store';
import { useToolInspector, type ToolInspectorId } from '../inspector/toolInspector';
import { useLastVariant } from './lastVariant';
import { InsertOptions, RedactOptions } from './Options';
import { SignaturePreview } from '../signatures/library/SignaturePreview';
import { grouped, type SlotDef, type VariantDef } from './model';

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

function chooseDraw(variant: DrawVariant): void {
  useTools.getState().setDraw(variant);
  choose('draw');
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
  draw?: DrawVariant;
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
  /** Smart links are on for this tab (DESIGN 3.11 L8): the state of Lesen's seventh slot. */
  smartLinks?: boolean;
  /** Why Kopf- und Fußzeile cannot open (a catalog key, DESIGN 3.15 HF6); absent: it can. */
  headerFooterReason?: PlainKey | null;
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
    icon: current.icon ?? Dot,
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
  return grouped(
    [
      tool('select', t('modes.tool.select'), MousePointer2, {
        actionId: 'tool-select',
        run: () => useUi.getState().releaseTool(),
      }),
      tool('hand', t('modes.tool.hand'), Hand),
      tool('textSelect', t('modes.tool.textSelect'), TextSelect),
    ],
    [
      tool('magnifier', t('modes.tool.magnifier'), ScanSearch, { hint: t('modes.tool.magnifierHint') }),
      family(
        inputs,
        { id: 'rotate', kind: 'action', on: false, actionId: 'rotate-view-right' },
        t('modes.tool.rotate'),
        rotate,
      ),
    ],
    [
      {
        id: 'search',
        label: t('modes.tool.search'),
        icon: Search,
        kind: 'action',
        on: false,
        actionId: 'find',
        run: () => void runAction('find'),
      },
      // A toggle for this tab (DESIGN 3.11 L8), not a tool; it stays pressed while a tool is chosen.
      {
        id: 'smartLinks',
        label: t('smartlinks.toggle'),
        icon: Wand,
        kind: 'toggle',
        on: inputs.smartLinks ?? true,
        hint: t('smartlinks.toggleHelp'),
        run: toggleSmartLinksForActive,
      },
    ],
  );
};

const kommentieren: Maker = (inputs) => {
  const { t, activeTool, markup, shapes, readOnly } = inputs;
  const draw = inputs.draw ?? 'free';
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
  const drawVariants: VariantDef[] = [
    { id: 'free', label: t('modes.tool.drawFree'), icon: PenLine, on: draw === 'free', run: () => chooseDraw('free') },
    {
      id: 'arrow',
      label: t('modes.tool.drawArrow'),
      icon: Spline,
      on: draw === 'arrow',
      run: () => chooseDraw('arrow'),
    },
    {
      id: 'shape',
      label: t('modes.tool.drawShape'),
      icon: Lasso,
      on: draw === 'shape',
      run: () => chooseDraw('shape'),
    },
  ];
  const drawIcon = drawVariants.find((variant) => variant.on)?.icon ?? PenLine;
  const shapeIcon = shapeVariants.find((variant) => variant.on)?.icon ?? Shapes;
  return grouped(
    [
      markupSlot('highlight', t('modes.tool.highlight'), Highlighter),
      markupSlot('underline', t('modes.tool.underline'), Underline),
      markupSlot('strikeout', t('modes.tool.strike'), Strikethrough),
      // A colour tool (swatch row in the chevron menu), key Q (DESIGN 3.7 C2). Not on a read-only document (AC 22).
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
    ],
    [
      plain('note', 'note', t('modes.tool.note'), StickyNote, 'tool-note'),
      plain('text', 'freeText', t('modes.tool.freeText'), MessageSquareText, 'tool-text'),
    ],
    [
      { ...plain('draw', 'draw', t('modes.tool.draw'), drawIcon, 'tool-draw'), variants: drawVariants },
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
    ],
  );
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
  return grouped(
    [
      item('text', t('modes.tool.text'), Type, { type: 'text' }, armed?.type === 'text'),
      mark('check', t('modes.tool.check'), Check),
      mark('cross', t('modes.tool.cross'), X),
      mark('dot', t('modes.tool.dot'), Dot),
      item('date', t('modes.tool.date'), Calendar, { type: 'date' }, armed?.type === 'date'),
    ],
    [
      roleSlot('signature', Signature, t('modes.tool.signature'), t('modes.tool.newSignature')),
      roleSlot('initials', FileSignature, t('modes.tool.initials'), t('modes.tool.newInitials')),
    ],
    [zertifikat(inputs)],
  );
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
      // The check column marks the active identity (DESIGN 3.8 L2); the email is the second line.
      radio: true,
      on: chosen?.id === identity.id,
      ...(identity.subject.email === null || identity.subject.email === '' ? {} : { caption: identity.subject.email }),
      disabled: !canSign(identity),
      run: () => useCertSign.getState().activate(identity.id),
    })),
    { id: 'cert-new', label: t('cert.menu.new'), icon: Plus, run: manage },
    ...(identities.length === 0
      ? []
      : [{ id: 'cert-manage', label: t('cert.menu.manage'), icon: Settings2, run: manage }]),
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
  return grouped(
    [
      {
        id: 'organize',
        label: t('modes.tool.organize'),
        icon: LayoutGrid,
        kind: 'tool',
        on: activeTool === 'pages',
        actionId: 'tool-pages',
        run: () => choose('pages'),
      },
    ],
    [
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
    ],
    [
      action('extract', t('modes.tool.extract'), FileOutput, runExtract, readOnly ? undefined : noPages),
      action('split', t('modes.tool.split'), Scissors, runSplit),
      action('merge', t('modes.tool.merge'), Combine, runMerge),
    ],
    [action('compress', t('modes.tool.compress'), FileArchive, runCompress)],
  );
};

const bearbeiten: Maker = (inputs) => {
  const { t, activeTool, redactMode, readOnly } = inputs;
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
  // Tools with settings (DESIGN 3.18 E5) open the inspector column instead of a popover or dialog.
  const withInspector = (id: ToolInspectorId, run: () => void) => () => {
    run();
    useToolInspector.getState().openToolInspector(id);
  };
  const stamp: SlotDef = {
    id: 'stamp',
    label: t('stamp.tool'),
    icon: CirclePlus,
    kind: 'tool',
    on: activeTool === 'stamp',
    hint: t('stamp.tooltip'),
    disabledReason: readOnly ? t('tool.readOnly') : undefined,
    run: withInspector('stamp', armStamp),
  };
  const crop: SlotDef = {
    ...tool('crop', 'crop', t('modes.tool.crop'), Crop, 'tool-crop', undefined),
    run: withInspector('crop', () => choose('crop')),
  };
  return grouped(
    [
      {
        ...tool('editText', 'editText', t('editText.tool'), Type, 'tool-editText', undefined),
        hint: t('editText.tooltip'),
        testId: 'tool-editText',
        disabledReason: readOnly ? t('tool.readOnly') : undefined,
      },
      tool('textBox', 'textBox', t('modes.tool.addText'), Plus, 'tool-textBox', InsertOptions),
      tool('image', 'image', t('modes.tool.addImage'), Image, 'tool-image', InsertOptions),
    ],
    [
      crop,
      {
        id: 'headerFooter',
        label: t('modes.tool.headerFooter'),
        icon: Rows2,
        kind: 'action',
        on: false,
        // HF6: signed, locked, no permission or a text recognition run; the item is disabled with the reason as its tooltip.
        disabledReason: inputs.headerFooterReason ? t(inputs.headerFooterReason) : undefined,
        run: () => useToolInspector.getState().openToolInspector('headerFooter'),
      },
      stamp,
    ],
    [
      {
        id: 'redact',
        label: t('modes.tool.redact'),
        icon: SquareSlash,
        kind: 'tool',
        on: redactMode,
        actionId: 'tool-redact',
        Options: RedactOptions,
        // Entering the mode shows the band only; the marks list opens with a click on the item while the mode is on (F19.8).
        optionsWhenOn: true,
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
        icon: AlignLeft,
        kind: 'action',
        on: false,
        run: () => void runAction('document-properties'),
      },
    ],
  );
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
  const draw = useTools((state) => state.draw);
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
  const smartLinks = useSmartLinks((state) => (docId === null ? state.enabled : smartLinksOn(state, docId)));
  const locked = useSignatureLock(docId ?? undefined).locked;
  const hfReason = headerFooterReason(useActionState());
  return useMemo(() => {
    const slots = MAKERS[mode]({
      t,
      activeTool,
      redactMode,
      markup,
      shapes,
      draw,
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
      smartLinks,
      headerFooterReason: hfReason,
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
    draw,
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
    smartLinks,
    locked,
    hfReason,
  ]);
}

/** For tests: the slots of a mode from explicit inputs. */
export const slotsFor = (mode: Mode, inputs: Inputs): SlotDef[] => MAKERS[mode](inputs);
