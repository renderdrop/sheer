import { ChevronRight } from 'lucide-react';

import { Icon } from '../../components';
import { useT } from '../../i18n';
import { HUB_CARDS, type HubCardId } from '../hub/cards';
import { runHubCard } from '../hub/run';
import { useHub } from '../hub/intent';
import { useViewer } from '../viewer/useViewer';
import { ROVING_ATTR, useRovingGroup } from './roving';

/** The tools Home lists (DESIGN v2 3.1), in the order of the spec; Open is the "+" of the hero. */
const TOOL_IDS: readonly HubCardId[] = ['merge', 'split', 'compress', 'images', 'sign', 'redact', 'fill', 'export'];
const TOOLS = TOOL_IDS.flatMap((id) => HUB_CARDS.filter((card) => card.id === id));

/**
 * The Werkzeuge rows (DESIGN v2 3.1): 56 high, icon 20, the name in `.t-label` over its description in `.t-caption`, a chevron at
 * the end; three columns from 1200 wide (F19.6). Hover Sand. No cards, no dividers. A row runs the hub card: the file dialog, then the editor in the
 * matching mode. While one runs (or a document is being opened) the others are `aria-disabled`; arrows move through the rows.
 */
export function ToolRows() {
  const t = useT();
  const busy = useHub((state) => state.busy);
  const opening = useViewer((state) => state.opening);
  const roving = useRovingGroup(TOOLS.map((card) => card.id));
  const locked = busy !== null || opening;
  return (
    <ul
      {...roving.groupProps}
      aria-label={t('home.nav.tools')}
      data-home-tools=""
      className="home-tool-rows m-0 list-none p-0"
    >
      {TOOLS.map((card) => (
        <li key={card.id}>
          <button
            type="button"
            {...{ [ROVING_ATTR]: card.id }}
            tabIndex={roving.tabIndexOf(card.id)}
            aria-disabled={locked || undefined}
            aria-busy={busy === card.id || undefined}
            onClick={() => {
              if (!locked) void runHubCard(card.id);
            }}
            className="group/tool flex h-(--home-row-height) w-full cursor-pointer items-center gap-3 rounded-md px-3 text-start transition-colors [transition-duration:var(--motion-fast)] not-aria-disabled:hover:bg-subtle not-aria-disabled:active:bg-pressed aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)"
          >
            <Icon icon={card.icon} size={20} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="t-label truncate">{t(card.titleKey)}</span>
              <span className="t-caption truncate">{t(card.hintKey)}</span>
            </span>
            <Icon icon={ChevronRight} size={16} className="text-text-muted" />
          </button>
        </li>
      ))}
    </ul>
  );
}
