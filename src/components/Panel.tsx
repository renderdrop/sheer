import type { ComponentProps, ReactNode } from 'react';

import { cx } from './cx';

export interface PanelProps extends Omit<ComponentProps<'aside'>, 'title'> {
  /** Names the `<aside>` landmark. */
  label: string;
  /** Header text, `--text-lg`. */
  title?: ReactNode;
  /** Controls at the end of the header, small (24) buttons. */
  actions?: ReactNode;
  /** A custom header instead of `title` and `actions` (the left panel's tablist). Padding 8 is added around it. */
  header?: ReactNode;
  /**
   * `false` fades the panel out (opacity 250 ms) and makes it inert, so it cannot take focus. The inspector uses it
   * to appear without moving the canvas (DESIGN 3.9). Default `true`.
   */
  visible?: boolean;
}

/**
 * Left panel and inspector surface (DESIGN 3.9): G1, radius 16, header 48 high with padding 8, a body that scrolls
 * (padding 8; 4 px or more around focusable rows so focus rings are not clipped). An `<aside>` landmark.
 */
export function Panel({ label, title, actions, header, visible = true, className, children, ...rest }: PanelProps) {
  const hasHeader = header !== undefined || title !== undefined || actions !== undefined;
  return (
    <aside
      {...rest}
      aria-label={label}
      inert={!visible}
      className={cx(
        'glass-1 flex min-h-0 flex-col overflow-hidden rounded-panel transition-opacity duration-slow',
        visible ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      {hasHeader && (
        // h-6 is 48 px (--space-6): the header height of the spec; padding 8 leaves 32 for controls.
        <div className="flex min-h-6 shrink-0 items-center gap-1 p-1">
          {header ?? (
            <>
              <h2 className="min-w-0 flex-auto truncate text-lg">{title}</h2>
              {actions}
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-auto overflow-auto p-1">{children}</div>
    </aside>
  );
}

export interface PanelSectionProps extends ComponentProps<'section'> {
  /** Names the section when it has no visible heading. */
  label?: string;
}

/** A part of a panel body; sections are split by a divider (the inspector). */
export function PanelSection({ label, className, children, ...rest }: PanelSectionProps) {
  return (
    <section
      {...rest}
      aria-label={label}
      className={cx('not-first:mt-1 not-first:border-t not-first:border-divider not-first:pt-1', className)}
    >
      {children}
    </section>
  );
}
