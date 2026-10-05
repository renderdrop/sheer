import { useT } from '../../i18n';
import { TagDot } from './palette';
import { tagColor, useTags } from './store';

/** Chips shown before the "+n" chip. */
export const CHIPS_SHOWN = 3;

const CHIP =
  'inline-flex h-[var(--chip-height,var(--space-5))] max-w-full min-w-0 items-center gap-1 rounded-pill border border-border-subtle bg-surface px-2 ' +
  't-caption text-text forced-colors:bg-[Canvas]';

/**
 * The chips of an annotation's tags (DESIGN 3.7 C6): white pill, a colour dot with a Stone ring and the name. Up to three, then a "+n" chip whose
 * tooltip lists the rest. A name without a definition shows a neutral dot. Nothing is rendered without names.
 */
export function TagChips({ names }: { names: string[] }) {
  const t = useT();
  const tags = useTags();
  if (names.length === 0) return null;
  const shown = names.slice(0, CHIPS_SHOWN);
  const rest = names.slice(CHIPS_SHOWN);
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-1 p-0" aria-label={t('tags.title')}>
      {shown.map((name) => (
        <li key={name} className={CHIP} title={name}>
          <TagDot color={tagColor(tags, name)} />
          <span className="max-w-[calc(var(--space-20)*1.5)] truncate">{name}</span>
        </li>
      ))}
      {rest.length > 0 && (
        <li className={CHIP} title={rest.join(', ')} aria-label={rest.join(', ')}>
          {t('tags.more', { n: rest.length })}
        </li>
      )}
    </ul>
  );
}
