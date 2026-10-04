import { CircleCheck } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';

import type { SignatureArt, TypedFont } from '../../../api/signatures';
import { Icon } from '../../../components';
import { SIGNATURE_FONTS, stepFont } from './fonts';
import type { SigColour } from './model';
import { INK_CLASS, VectorPreview } from './Previews';
import { isVector } from './model';

export interface FontPickerProps {
  label: string;
  value: TypedFont;
  onChange: (font: TypedFont) => void;
  /** The outlines of the name (or the placeholder) in each font; `null` while they are made. */
  arts: Readonly<Record<TypedFont, SignatureArt | null>>;
  colour: SigColour;
  /** The name is empty: the previews show the placeholder in the faint ink. */
  empty: boolean;
}

const CARD =
  'relative flex h-sig-font-card-h w-sig-font-card shrink-0 cursor-pointer flex-col rounded-button border border-divider bg-page p-1 ' +
  'transition-colors duration-fast hover:border-control-border forced-colors:border-text forced-colors:bg-[Canvas] ' +
  'aria-checked:border-2 aria-checked:border-accent aria-checked:forced-colors:border-[Highlight]';

/** The style cards of the Type tab (DESIGN 3.60): a radiogroup of three previews of the name; Left and Right move and select. */
export function FontPicker({ label, value, onChange, arts, colour, empty }: FontPickerProps) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const next = stepFont(value, direction);
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-font="${next}"]`)?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex shrink-0 justify-between"
    >
      {SIGNATURE_FONTS.map(({ id, name }) => {
        const art = arts[id];
        const checked = id === value;
        return (
          <div
            key={id}
            role="radio"
            aria-checked={checked}
            aria-label={name}
            tabIndex={checked ? 0 : -1}
            data-font={id}
            onClick={() => onChange(id)}
            className={CARD}
          >
            {checked && (
              <span className="absolute end-1 top-1 text-text-accent">
                <Icon icon={CircleCheck} />
              </span>
            )}
            <div aria-hidden="true" className="flex min-h-0 flex-auto items-center justify-center px-2">
              {art !== null && isVector(art) && (
                <div className={`size-full ${empty ? 'text-divider' : INK_CLASS[colour]}`}>
                  <VectorPreview art={art} colour={colour} inherit />
                </div>
              )}
            </div>
            <span className="h-3 text-center text-sm text-text-muted">{name}</span>
          </div>
        );
      })}
    </div>
  );
}
