import { useOcr } from '../ocr/store';
import { openOcrDialog } from '../ocr/runtime';
import { useHeaderFooter } from '../headerFooter/store';
import { openHeaderFooterDialog } from '../headerFooter/runtime';
import { armStamp, useStamp } from '../annotations/stamps/store';
import { cancelCrop } from '../crop/actions';
import { closeReferenceInspector, useReferenceInspector } from '../properties/openReference';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useToolInspector, type ToolInspectorId } from './toolInspector';

/**
 * Which tool state belongs to which inspector (DESIGN §3.18 E5). The inspector follows the state of its tool: while `isOn` holds,
 * the column is open on `id`; when the tool state ends, the column closes. The other way round, when the column goes away or
 * another one takes its place while the tool state is still on (Esc, Close, a mode switch), `end` lets the tool go and drops
 * what was not applied.
 */
interface Binding {
  id: ToolInspectorId;
  isOn: () => boolean;
  /** Called when the inspector leaves `id` while `isOn` still holds. */
  end: () => void;
  /** Called when the column was opened on `id` without the tool state (`openToolInspector('crop')` and the like): starts it. */
  begin: () => void;
  /** The stores `isOn` reads. */
  watch: ((listener: () => void) => () => void)[];
}

const BINDINGS: readonly Binding[] = [
  {
    id: 'crop',
    isOn: () => useUi.getState().activeTool === 'crop',
    end: cancelCrop,
    begin: () => useUi.getState().selectTool('crop'),
    watch: [useUi.subscribe],
  },
  {
    id: 'stamp',
    // The picker also opens from the mini bar to change a placed stamp; that one is a popover of its own.
    isOn: () => useStamp.getState().pickerOpen && useStamp.getState().changing === null,
    end: () => {
      useStamp.getState().setPicker(false);
      if (useUi.getState().activeTool === 'stamp') useUi.getState().releaseTool();
    },
    begin: armStamp,
    watch: [useStamp.subscribe],
  },
  {
    id: 'headerFooter',
    isOn: () => useHeaderFooter.getState().dialog !== null,
    end: () => useHeaderFooter.getState().openDialog(null),
    // The backend is asked first; a refusal shows its toast and nothing opens, so the column closes again.
    begin: () =>
      void openHeaderFooterDialog().then(() => {
        if (useHeaderFooter.getState().dialog === null) useToolInspector.getState().closeToolInspector('headerFooter');
      }),
    watch: [useHeaderFooter.subscribe],
  },
  {
    id: 'ocr',
    isOn: () => useOcr.getState().dialog !== null,
    end: () => useOcr.getState().openDialog(null),
    begin: () => {
      openOcrDialog();
      if (useOcr.getState().dialog === null) useToolInspector.getState().closeToolInspector('ocr');
    },
    watch: [useOcr.subscribe],
  },
  {
    id: 'reference',
    isOn: () => useReferenceInspector.getState().docId !== null,
    end: closeReferenceInspector,
    begin: () => {
      const docId = selectActiveId(useDocuments.getState());
      if (docId === null) useToolInspector.getState().closeToolInspector('reference');
      else useReferenceInspector.setState({ docId });
    },
    watch: [useReferenceInspector.subscribe],
  },
];

/** The inspectors whose tool is a tool of the mode card; a mode change they cause themselves does not close them. */
const TOOL_DRIVEN: ReadonlySet<ToolInspectorId> = new Set(['crop', 'stamp']);

function follow(binding: Binding): void {
  const { open, openToolInspector, closeToolInspector } = useToolInspector.getState();
  const on = binding.isOn();
  if (on && open !== binding.id) openToolInspector(binding.id);
  else if (!on && open === binding.id) closeToolInspector(binding.id);
}

let installed = false;

/** Wires the stores of the five tools to the inspector column; idempotent. Returns the undo for tests. */
export function installToolInspectorBindings(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const stops: (() => void)[] = [];
  for (const binding of BINDINGS) {
    for (const watch of binding.watch) stops.push(watch(() => follow(binding)));
  }
  // The column left `id` (or changed to another) while the tool state was still on: the tool lets go.
  stops.push(
    useToolInspector.subscribe((state, previous) => {
      if (state.open === previous.open) return;
      for (const binding of BINDINGS) {
        if (previous.open === binding.id && state.open !== binding.id && binding.isOn()) binding.end();
        if (state.open === binding.id && !binding.isOn()) binding.begin();
      }
    }),
  );
  // A mode switch closes the column (the mode card owns the tools); a tab switch drops what belonged to the old tab.
  stops.push(
    useUi.subscribe((state, previous) => {
      if (state.mode === previous.mode) return;
      // Choosing a tool of another mode switches the mode too; the inspector of that very tool stays.
      const open = useToolInspector.getState().open;
      const own = BINDINGS.find((binding) => binding.id === open);
      if (own !== undefined && TOOL_DRIVEN.has(own.id) && own.isOn()) return;
      useToolInspector.getState().closeToolInspector();
    }),
  );
  stops.push(
    useDocuments.subscribe((state, previous) => {
      if (state.activeId === previous.activeId) return;
      useHeaderFooter.getState().openDialog(null);
      useOcr.getState().openDialog(null);
      closeReferenceInspector();
    }),
  );
  return () => {
    for (const stop of stops) stop();
    installed = false;
  };
}
