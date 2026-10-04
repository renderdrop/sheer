import { ArrowDownUp, ListFilter } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { Button, Checkbox, Field, IconButton, Menu, Popover, Radio, Segmented, type MenuEntry } from '../../components';
import type { AnnotationSummary } from '../../api/annotations';
import { Icon } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { useDocView } from '../../stores/view';
import {
  NO_FILTER,
  SORT_ORDERS,
  activeFilterCount,
  facets,
  type Filter,
  type SortOrder,
  type Status,
  type TypeGroup,
} from './model';
import { DEFAULT_VIEW, useComments } from './store';
import { groupInfo } from './typeInfo';

const SORT_LABELS: Record<SortOrder, PlainKey> = {
  page: 'comments.byPage',
  newest: 'comments.sortDate',
  oldest: 'comments.oldest',
  author: 'comments.sortAuthor',
};

type StatusChoice = 'all' | 'open' | 'resolved';
type PageChoice = 'all' | 'current' | 'range';

const toggle = <T,>(chosen: readonly T[], value: T): T[] =>
  chosen.includes(value) ? chosen.filter((other) => other !== value) : [...chosen, value];

const statusChoice = (filter: Filter): StatusChoice => {
  if (filter.statuses.length === 1 && filter.statuses[0] === 'open') return 'open';
  if (filter.statuses.length === 1 && filter.statuses[0] === 'resolved') return 'resolved';
  return 'all';
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="t-caption mb-1 p-0 font-semibold text-text">{title}</legend>
      {children}
    </fieldset>
  );
}

/** The page of the filter: all, the page the reader is on, or a range of two fields. */
function pageChoice(filter: Filter, current: number): PageChoice {
  const range = filter.pages ?? null;
  if (range === null) return 'all';
  return range.from === current && range.to === current ? 'current' : 'range';
}

/**
 * The filter row (DESIGN 3.5 B10), 36 high: a "Filter" ghost button that opens the filter popover (type, author, page, status;
 * a count chip when it filters) and a sort icon button with its menu (page, date, author).
 */
export function CommentsFilter({ docId, summaries }: { docId: number; summaries: readonly AnnotationSummary[] }) {
  const t = useT();
  const view = useComments((state) => state.views[docId]) ?? DEFAULT_VIEW;
  const current = useDocView(docId).pageIndex + 1;
  const pageCount = useDocView(docId).pageCount;
  const options = useMemo(() => facets(summaries), [summaries]);
  const { filter } = view;
  const set = (next: Partial<Filter>) => useComments.getState().setFilter(docId, { ...filter, ...next });
  const count = activeFilterCount(filter);
  const groups = filter.groups ?? [];
  const choice = pageChoice(filter, current);
  const range = filter.pages ?? { from: current, to: current };

  const sortEntries: MenuEntry[] = SORT_ORDERS.map((order) => ({
    id: `sort-${order}`,
    label: t(SORT_LABELS[order]),
    checked: view.order === order,
    onSelect: () => useComments.getState().setOrder(docId, order),
  }));

  const statusOptions: { value: StatusChoice; label: string }[] = [
    { value: 'all', label: t('comments.status.all') },
    { value: 'open', label: t('comments.status.open') },
    { value: 'resolved', label: t('comments.status.resolved') },
  ];
  const pageOptions: { value: PageChoice; label: string }[] = [
    { value: 'all', label: t('comments.pageAll') },
    { value: 'current', label: t('comments.pageCurrent') },
    { value: 'range', label: t('comments.pageRange') },
  ];
  const setPage = (choose: PageChoice) =>
    set({
      pages: choose === 'all' ? null : choose === 'current' ? { from: current, to: current } : { ...range },
    });
  const clamp = (value: string, fallback: number) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, Math.max(1, pageCount)) : fallback;
  };

  return (
    <div className="flex h-control-md shrink-0 items-center gap-1 px-3">
      <Popover
        label={t('comments.filterPanel')}
        side="bottom"
        align="start"
        trigger={(trigger) => (
          <Button
            {...trigger}
            size="sm"
            variant="ghost"
            icon={ListFilter}
            className="min-w-0 flex-1 justify-start"
            aria-label={count > 0 ? `${t('comments.filter')}, ${t('comments.filterActive', { n: count })}` : undefined}
          >
            <span className="flex min-w-0 items-center gap-1">
              <span>{t('comments.filter')}</span>
              {count > 0 && (
                <span
                  aria-hidden="true"
                  className="t-caption inline-flex min-w-5 items-center justify-center rounded-pill bg-accent px-1 font-semibold text-text"
                >
                  {count}
                </span>
              )}
            </span>
          </Button>
        )}
      >
        {({ close }) => (
          <div className="flex min-w-0 flex-col gap-3">
            <Group title={t('comments.type')}>
              {options.groups.map((group: TypeGroup) => {
                const info = groupInfo(group);
                return (
                  <label key={group} className="flex cursor-pointer items-center gap-2 text-md">
                    <Checkbox
                      checked={groups.includes(group)}
                      onChange={() => set({ groups: toggle(groups, group) })}
                    />
                    <Icon icon={info.icon} size={16} className="text-text-muted" />
                    <span className="min-w-0 truncate">{t(info.key)}</span>
                  </label>
                );
              })}
            </Group>
            {options.authors.length > 1 && (
              <Group title={t('comments.author')}>
                {options.authors.map((author) => (
                  <label key={author} className="flex cursor-pointer items-center gap-2 text-md">
                    <Checkbox
                      checked={filter.authors.includes(author)}
                      onChange={() => set({ authors: toggle(filter.authors, author) })}
                    />
                    <span className="min-w-0 truncate">{author === '' ? t('comments.noAuthor') : author}</span>
                  </label>
                ))}
              </Group>
            )}
            <Group title={t('comments.pageFilter')}>
              {pageOptions.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-center gap-2 text-md">
                  <Radio
                    name={`comments-page-${docId}`}
                    checked={choice === option.value}
                    onChange={() => setPage(option.value)}
                  />
                  <span>{option.label}</span>
                  {option.value === 'range' && (
                    <span className="ms-auto flex items-center gap-1">
                      <Field
                        size="sm"
                        type="number"
                        min={1}
                        max={pageCount}
                        aria-label={t('comments.pageFrom')}
                        disabled={choice !== 'range'}
                        value={range.from}
                        className="w-12"
                        onChange={(event) => set({ pages: { ...range, from: clamp(event.target.value, range.from) } })}
                      />
                      <span aria-hidden="true">–</span>
                      <Field
                        size="sm"
                        type="number"
                        min={1}
                        max={pageCount}
                        aria-label={t('comments.pageTo')}
                        disabled={choice !== 'range'}
                        value={range.to}
                        className="w-12"
                        onChange={(event) => set({ pages: { ...range, to: clamp(event.target.value, range.to) } })}
                      />
                    </span>
                  )}
                </label>
              ))}
            </Group>
            <Group title={t('comments.status')}>
              <Segmented<StatusChoice>
                label={t('comments.status')}
                value={statusChoice(filter)}
                options={statusOptions}
                onValueChange={(value) => set({ statuses: value === 'all' ? [] : [value as Status] })}
              />
            </Group>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={count === 0}
                focusableWhenDisabled
                onClick={() => {
                  useComments.getState().setFilter(docId, NO_FILTER);
                  close('select');
                }}
              >
                {t('comments.resetShort')}
              </Button>
            </div>
          </div>
        )}
      </Popover>
      <Menu
        label={t('comments.sortMenu')}
        side="bottom"
        align="end"
        entries={sortEntries}
        trigger={(trigger) => (
          <IconButton {...trigger} size="sm" icon={ArrowDownUp} label={t('comments.sortMenu')} tooltipSide="bottom" />
        )}
      />
    </div>
  );
}
