import { Calendar } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { StampTone } from '../../../api/annotations';
import { Checkbox, Field, Icon, Segmented, announce, type PopoverCloseReason } from '../../../components';
import { cx } from '../../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget } from '../../../components/roving';
import { useLocale, useT } from '../../../i18n';
import { useAnnotations } from '../../../stores/annotations';
import { selectActiveId, useDocuments } from '../../../stores/documents';
import { readSlots } from '../../../stores/pages';
import { focusCanvas } from '../../modes/switch';
import { replaceStamp } from './actions';
import { StampArt } from './StampArt';
import {
  OWN_TEXT_MAX,
  PRESETS,
  cleanOwn,
  defaultSize,
  faceOf,
  gridTarget,
  tileGeometry,
  type Preset,
  type RecentText,
  type StampChoice,
  type StampFace,
} from './model';
import { useStamp } from './store';

const SWATCH = 'size-4 shrink-0 rounded-pill border border-border-subtle';
/** The own-text field fills the picker's width (the Field default is the 56 px number slot). */
export const OWN_FIELD_CLASS = 'w-full!';
const LABEL = 't-caption text-text-muted';

/** A stamp drawn small, in its own aspect (the tiles of the picker). */
export function MiniStamp({ face, tone }: { face: StampFace; tone: StampTone }) {
  const tile = tileGeometry(face);
  const { w, h } = tile ?? defaultSize(face);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${w} ${h}`} className="max-h-full max-w-full" width="100%" height="100%">
      <StampArt w={w} h={h} text={face.text} date={face.date} tone={tone} layout={tile?.layout} />
    </svg>
  );
}

export interface StampPickerBodyProps {
  close: (reason?: PopoverCloseReason) => void;
}

/**
 * The stamp picker (DESIGN 3.14 ST2): colour, the four predefined stamps, an own text with an optional date, and the recent own texts.
 * Choosing closes it and arms placement (or, from the mini bar, replaces the selected stamp). Tab order: colour, tiles (arrows within),
 * field, checkbox, recent (arrows).
 */
export function StampPickerBody({ close }: StampPickerBodyProps) {
  const t = useT();
  const locale = useLocale();
  const choice = useStamp((state) => state.choice);
  const recent = useStamp((state) => state.recent);
  const choose = useStamp((state) => state.choose);
  const [text, setText] = useState(choice.custom);
  const today = useMemo(() => new Date(), []);
  const labelIds = { predefined: useId(), own: useId(), recent: useId() };
  const tiles = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const label = (preset: Preset): string => t(`stamp.${preset}`);
  const faceFor = (change: Partial<StampChoice>): StampFace | null =>
    faceOf({ ...choice, ...change }, label, locale, today);

  /** The choice is made: the picker closes, and placement is armed (or the stamp that is being changed is replaced). */
  const finish = (change: Partial<StampChoice>, viaKey: boolean): void => {
    const next = { ...choice, ...change };
    const face = faceOf(next, label, locale, today);
    if (face === null) return;
    choose(change);
    const target = useStamp.getState().changing;
    close('select');
    if (target !== null) {
      const docId = selectActiveId(useDocuments.getState());
      const old = docId === null ? undefined : findStamp(docId, target);
      if (docId !== null && old !== undefined)
        void replaceStamp(docId, old, face, next.tone, pageSpace(docId, old.pageId));
      return;
    }
    useStamp.getState().setKeyboard(viaKey);
    announce(t('stamp.announce.armed', { text: face.text }));
    if (viaKey) focusCanvas();
  };

  const onTileKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const group = event.currentTarget;
    if (!isOwnEvent(group, event)) return;
    const items = itemsOf(group, '[role="radio"]');
    const at = items.findIndex((item) => item === event.target);
    if (at < 0) return;
    const target = gridTarget(event.key, at, items.length, 2);
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  const onRecentKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const group = event.currentTarget;
    if (!isOwnEvent(group, event)) return;
    const items = itemsOf(group, '[role="option"]');
    const at = items.findIndex((item) => item === event.target);
    const target = rovingTarget(event.key, at, items.length, { orientation: 'vertical', wrap: false });
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  const own = cleanOwn(text);
  const checkedPreset = choice.stamp === 'custom' ? null : choice.stamp;

  return (
    <div data-surface="stamp-picker" className="flex flex-col gap-3">
      <Segmented<StampTone>
        label={t('modes.colour')}
        value={choice.tone}
        onValueChange={(tone) => choose({ tone })}
        className="flex! w-full"
        options={[
          {
            value: 'solar',
            label: t('stamp.colour.solar'),
            leading: <span aria-hidden="true" className={cx(SWATCH, 'bg-hl-solar')} />,
          },
          {
            value: 'ink',
            label: t('stamp.colour.ink'),
            leading: <span aria-hidden="true" className={cx(SWATCH, 'bg-stroke-ink')} />,
          },
        ]}
      />

      <div className="flex flex-col gap-2">
        <span id={labelIds.predefined} className={LABEL}>
          {t('stamp.predefined')}
        </span>
        <div
          ref={tiles}
          role="radiogroup"
          aria-labelledby={labelIds.predefined}
          onKeyDown={onTileKey}
          className="grid grid-cols-2 gap-2"
        >
          {PRESETS.map((preset, index) => {
            const face = faceFor({ stamp: preset });
            const checked = checkedPreset === preset;
            const stop = checkedPreset === null ? index === 0 : checked;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={
                  face === null ? label(preset) : [face.text, face.date].filter((part) => part !== null).join(', ')
                }
                tabIndex={stop ? 0 : -1}
                data-stamp-tile={preset}
                onClick={(event) => finish({ stamp: preset }, event.detail === 0)}
                className={cx(
                  'flex h-(--stamp-tile-height) w-full min-w-0 cursor-pointer items-center justify-center rounded-md border bg-surface p-1',
                  'transition-colors duration-fast hover:bg-subtle',
                  checked ? 'border-text' : 'border-border-subtle',
                )}
              >
                {face !== null && <MiniStamp face={face} tone={choice.tone} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={labelIds.own} className={LABEL}>
          {t('stamp.own')}
        </label>
        <Field
          id={labelIds.own}
          value={text}
          className={OWN_FIELD_CLASS}
          maxLength={OWN_TEXT_MAX}
          placeholder={t('stamp.ownPlaceholder')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || own === '') return;
            event.preventDefault();
            finish({ stamp: 'custom', custom: own }, true);
          }}
        />
        <label className="flex cursor-pointer items-center gap-2 text-md text-text">
          <Checkbox checked={choice.withDate} onChange={(event) => choose({ withDate: event.target.checked })} />
          {t('stamp.addDate')}
        </label>
      </div>

      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <span id={labelIds.recent} className={LABEL}>
            {t('stamp.recent')}
          </span>
          <div
            ref={list}
            role="listbox"
            aria-labelledby={labelIds.recent}
            onKeyDown={onRecentKey}
            className="flex flex-col"
          >
            {recent.map((item, index) => (
              <RecentRow
                key={`${item.text}:${item.date}`}
                item={item}
                stop={index === 0}
                selected={
                  choice.stamp === 'custom' && cleanOwn(choice.custom) === item.text && choice.withDate === item.date
                }
                onChoose={(viaKey) => finish({ stamp: 'custom', custom: item.text, withDate: item.date }, viaKey)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecentRow({
  item,
  stop,
  selected,
  onChoose,
}: {
  item: RecentText;
  stop: boolean;
  selected: boolean;
  onChoose: (viaKey: boolean) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={stop ? 0 : -1}
      data-stamp-recent=""
      onClick={(event) => onChoose(event.detail === 0)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onChoose(true);
        }
      }}
      className="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-md text-text hover:bg-subtle aria-selected:font-semibold"
    >
      <span className="truncate">{item.text}</span>
      {item.date && <Icon icon={Calendar} />}
    </div>
  );
}

/** The size of a page in page space (before its `/Rotate`), where the stamp boxes are; `null` when the page is not known. */
function pageSpace(docId: number, pageId: number): readonly [number, number] | null {
  const slot = readSlots(docId).find((candidate) => candidate.id === pageId);
  return slot === undefined ? null : [slot.width, slot.height];
}

/** The stamp `id` of the document's replica, when it has one. */
function findStamp(docId: number, id: number) {
  const found = useAnnotations.getState().byDoc[docId]?.byId[id];
  return found?.kind === 'stamp' ? found : undefined;
}
