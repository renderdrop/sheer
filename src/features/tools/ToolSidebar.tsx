import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { actionOf } from '../../actions/registry';
import { IconButton, Icon, Popover } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useActionState } from '../shell/useActionState';
import { ToolPanel } from './panels';
import { chooseRow, ROWS, rowOfState, WRITE_ROWS, type RowDef, type RowId } from './rows';

/** Row of DESIGN v2 3.2: 36 high, radius md, icon 18 + `.t-label`; the active one is Solar with Ink 600 (2.3). */
const ROW =
  'group flex h-control-md w-full cursor-pointer items-center gap-2 rounded-md px-3 text-start t-label text-text ' +
  'transition-colors duration-fast aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-control-hover not-aria-disabled:active:bg-control-pressed ' +
  'data-[on=true]:bg-accent data-[on=true]:font-semibold not-aria-disabled:data-[on=true]:hover:bg-accent-hover';

/** Padding of the disclosure: 12 0 16 38, the 38 being the row's padding, icon and gap, so the controls align with the label. */
const DISCLOSURE = 'flex flex-col gap-3 pt-3 pb-4 pe-0 ps-[calc(var(--space-3)+var(--icon-18)+var(--space-2))]';

/** What the rows show: which tool is active, whether a document is open and can change. */
function useRowState() {
  const activeTool = useUi((state) => state.activeTool);
  const redactMode = useUi((state) => state.redactMode);
  const docId = useDocuments(selectActiveId);
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  const action = useActionState();
  const activeRow = rowOfState(activeTool, redactMode);
  const disabled = (row: RowDef): boolean => {
    if (row.tool === null) return !action.hasDocument;
    return !actionOf(`tool-${row.tool}`).enabled(action) || (readOnly && WRITE_ROWS.has(row.id));
  };
  return { activeTool, redactMode, activeRow, disabled };
}

/**
 * The tool sidebar (DESIGN v2 3.2): the header "Werkzeuge" and the rows, with the options of the active tool opening right under
 * its row. One panel is open at a time: the active tool's, or the one of Export or More that the user opened. The list scrolls and
 * the open panel is scrolled into view. A tool stays active until Esc or Select (ADR-056).
 */
export const ToolSidebar = memo(function ToolSidebar() {
  const t = useT();
  const { activeTool, redactMode, activeRow, disabled } = useRowState();
  // The action rows the user opened (Export, More); they close when the tool changes.
  const [opened, setOpened] = useState<{ row: RowId; tool: string; redact: boolean } | null>(null);
  const extra = opened !== null && opened.tool === activeTool && opened.redact === redactMode ? opened.row : null;
  const open = extra ?? activeRow;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const onRow = (row: RowDef) => {
    if (disabled(row)) return;
    if (row.tool === null) {
      // Export and More: expand, or collapse again; More stays open while Crop or Redact is on.
      if (open === row.id) {
        if (extra === row.id) setOpened(null);
      } else {
        setOpened({ row: row.id, tool: activeTool, redact: redactMode });
      }
      return;
    }
    setOpened(null);
    chooseRow(row);
  };

  return (
    <aside
      data-region="inspector"
      aria-label={t('inspector.label')}
      className="bg-panel flex min-h-0 flex-col p-4 text-text"
    >
      <h2 className="t-caption m-0 flex h-8 shrink-0 items-center">{t('tools.title')}</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-half overflow-y-auto">
        {ROWS.map((row) => {
          const isOpen = open === row.id;
          const on = activeRow === row.id && (row.tool !== null || isOpen);
          const off = disabled(row);
          return (
            <div key={row.id} className="flex flex-col gap-half">
              <button
                type="button"
                data-toolbar-item={row.id}
                data-on={on}
                aria-pressed={row.tool === null ? undefined : on}
                aria-expanded={row.tool === null ? isOpen : undefined}
                aria-disabled={off ? true : undefined}
                onClick={() => onRow(row)}
                className={ROW}
              >
                <Icon icon={row.icon} size={18} />
                <span className="min-w-0 flex-1 truncate">{t(row.labelKey)}</span>
                <Icon
                  icon={isOpen ? ChevronDown : ChevronRight}
                  className={cx('opacity-0 group-hover:opacity-100', on || isOpen ? 'opacity-100' : undefined)}
                />
              </button>
              {isOpen && !off && (
                <div ref={panelRef} data-tool-panel={row.id} className={DISCLOSURE}>
                  <ToolPanel row={row.id} active={activeRow === row.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
});

/**
 * The 56 rail (below 1100 wide, or closed by the user): icons only, each with its tooltip. A click makes the tool active and
 * opens its panel in a 280 popover beside the rail; Export and More only open their panel.
 */
export const ToolRail = memo(function ToolRail() {
  const t = useT();
  const { activeRow, disabled } = useRowState();
  return (
    <div
      role="group"
      data-region="inspector"
      aria-label={t('inspector.label')}
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto py-2"
    >
      {ROWS.map((row) => {
        const off = disabled(row);
        const on = activeRow === row.id && row.tool !== null;
        return (
          <Popover
            key={row.id}
            label={t('tools.options', { tool: t(row.labelKey) })}
            side="left"
            align="start"
            disabled={off}
            trigger={(trigger) => (
              <IconButton
                {...trigger}
                data-toolbar-item={row.id}
                variant="tool"
                icon={row.icon}
                label={t(row.labelKey)}
                pressed={row.tool === null ? undefined : on}
                active={row.tool === null && activeRow === row.id}
                disabled={off}
                focusableWhenDisabled
                onClick={(event) => {
                  trigger.onClick(event);
                  if (!off) chooseRow(row);
                }}
              />
            )}
          >
            <div className="flex w-tool-sidebar flex-col gap-3">
              <ToolPanel row={row.id} active={activeRow === row.id} />
            </div>
          </Popover>
        );
      })}
    </div>
  );
});
