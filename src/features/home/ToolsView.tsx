import { Icon } from '../../components';
import { useT } from '../../i18n';
import { catalogueByMode, type CatalogueEntry } from '../hub/catalogue';
import { useHub } from '../hub/intent';
import { launchTool } from '../hub/run';
import { useViewer } from '../viewer/useViewer';
import { ROVING_ATTR, useRovingGroup } from './roving';

const MODE_KEY = {
  read: 'modes.read',
  comment: 'modes.comment',
  fill: 'modes.fill',
  pages: 'modes.pages',
  edit: 'modes.edit',
} as const;

function Tile({
  entry,
  tabIndex,
  locked,
  busy,
}: {
  entry: CatalogueEntry;
  tabIndex: 0 | -1;
  locked: boolean;
  busy: boolean;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        {...{ [ROVING_ATTR]: entry.id }}
        data-tool-tile={entry.id}
        tabIndex={tabIndex}
        aria-disabled={locked || undefined}
        aria-busy={busy || undefined}
        aria-describedby={`tools-tile-${entry.id}-sub`}
        onClick={() => {
          if (!locked) void launchTool(entry.id);
        }}
        className="home-tile group/tool flex size-full cursor-pointer items-center rounded-md border border-border-subtle bg-surface text-start transition-colors [transition-duration:var(--motion-fast)] not-aria-disabled:hover:bg-subtle not-aria-disabled:active:scale-(--scale-press) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)"
      >
        <Icon icon={entry.icon} size={24} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="home-tile-title">{t(entry.titleKey)}</span>
          <span id={`tools-tile-${entry.id}-sub`} className="home-tile-sub text-text-muted">
            {t(entry.subtitleKey)}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The Tools view (F21.3): every tool of the five mode cards and the hub dialogs, grouped by mode under its heading, one tab stop with
 * arrows. A tile launches the tool (`launchTool`); while one runs, or a document is being opened, the others are `aria-disabled`.
 */
export function ToolsView() {
  const t = useT();
  const busy = useHub((state) => state.busy);
  const opening = useViewer((state) => state.opening);
  const groups = catalogueByMode();
  const roving = useRovingGroup(groups.flatMap((group) => group.entries.map((entry) => entry.id)));
  const locked = busy !== null || opening;
  return (
    <div {...roving.groupProps} data-home-catalogue="" className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.mode} aria-labelledby={`tools-group-${group.mode}`} className="flex flex-col gap-4">
          <h2 id={`tools-group-${group.mode}`} className="t-h3 m-0">
            {t(MODE_KEY[group.mode])}
          </h2>
          <ul className="home-catalogue-grid m-0 list-none p-0">
            {group.entries.map((entry) => (
              <Tile
                key={entry.id}
                entry={entry}
                tabIndex={roving.tabIndexOf(entry.id)}
                locked={locked}
                busy={busy === entry.id}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
