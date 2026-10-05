import { ShieldCheck } from 'lucide-react';

import { useT } from '../../../i18n';

export interface SealPreviewProps {
  name: string;
  /** "2026-10-05 14:05 +02:00": the ISO form, readable in every locale. */
  date: string;
  reason: string;
}

/** The date of the seal (DESIGN 3.8 S4) in ISO form, local time with the offset. */
export function sealDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** A picture of the seal as it will look (S4): shield, name, "Digitally signed", date, optional reason. Decorative (`aria-hidden`). */
export function SealPreview({ name, date, reason }: SealPreviewProps) {
  const t = useT();
  return (
    <div
      aria-hidden="true"
      data-seal-preview=""
      className="flex items-center gap-2 rounded-sm border border-border-subtle bg-card p-2 text-text"
    >
      <ShieldCheck className="size-5 shrink-0" strokeWidth={1.75} />
      <div className="flex min-w-0 flex-col">
        <span className="t-label truncate">{name}</span>
        <span className="t-caption">{t('seal.signed')}</span>
        <span className="t-caption tabular-nums text-text-muted">{date}</span>
        {reason.trim() !== '' && (
          <span className="t-caption truncate text-text-muted">{t('seal.reason', { reason: reason.trim() })}</span>
        )}
      </div>
    </div>
  );
}
