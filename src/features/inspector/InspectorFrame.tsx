import { X, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Button, Icon, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { DURATION, EASE_OUT, tween } from '../../lib/motion';

export interface InspectorFooter {
  apply: {
    label: string;
    disabled: boolean;
    busy?: boolean;
    onApply: () => void;
  };
  /** `null`: no Reset button (the footer keeps its place). */
  reset: { disabled: boolean; onReset: () => void } | null;
}

export interface InspectorFrameProps {
  icon: LucideIcon;
  title: string;
  /** Esc and the close button: discards what was not applied and lets go of the tool. */
  onDismiss: () => void;
  /** `null`: no footer (Stempel, History). */
  footer: InspectorFooter | null;
  /** Marks the panel for tests and the smoke script. */
  surface: string;
  children: ReactNode;
}

/** The slide of the content from the right (DESIGN §3.18 E5); reduced motion keeps only the fade. */
const SLIDE_PX = 8;

const FOCUSABLE =
  '[data-autofocus], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]';

/** Whether Enter on this element means "Apply" (a text input or a radio; a button keeps its own Enter). */
function enterApplies(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return target.type !== 'checkbox' && target.type !== 'button';
  return false;
}

/**
 * The frame of the tool inspector (DESIGN §3.18 E5): header 48 (icon, title, close), a scrolling body, footer 72 (Reset, Apply).
 * Keyboard: Esc or Close discards (`onDismiss`), Enter in a field applies, the first field takes focus on open and focus goes back
 * to what had it (the tool item) when the panel goes away.
 */
export function InspectorFrame({ icon, title, onDismiss, footer, surface, children }: InspectorFrameProps) {
  const t = useT();
  const titleId = useId();
  const reduce = useReducedMotion() === true;
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  // What had focus before the panel opened (the tool item); read before the first field takes it.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && root.current?.contains(active) !== true) {
      opener.current = active;
    }
  }, []);

  useEffect(() => {
    const first = body.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    const element = root.current;
    return () => {
      const active = document.activeElement;
      const lost = active === null || active === document.body || element?.contains(active) === true;
      const back = opener.current;
      if (lost && back !== null && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // The footer's top border shows only while the body scrolls.
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.hasAttribute('data-keep-escape') === true) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key === 'Enter' && footer !== null && enterApplies(event.target)) {
      event.preventDefault();
      if (!footer.apply.disabled && footer.apply.busy !== true) footer.apply.onApply();
    }
  };

  const enter = reduce ? { opacity: 0 } : { opacity: 0, x: SLIDE_PX };
  const exit = reduce ? { opacity: 0 } : { opacity: 0, x: SLIDE_PX };
  return (
    <aside
      ref={root}
      aria-labelledby={titleId}
      data-region="inspector"
      data-surface={surface}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-s border-border bg-chrome"
    >
      <motion.div
        initial={enter}
        animate={{ opacity: 1, x: 0, transition: tween(DURATION.base) }}
        exit={{ ...exit, transition: { duration: DURATION.fast, ease: EASE_OUT } }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex h-(--inspector-header-height) shrink-0 items-center gap-3 border-b border-border px-4">
          <Icon icon={icon} />
          <h2 id={titleId} className="t-title m-0 min-w-0 flex-1 truncate">
            {title}
          </h2>
          <IconButton
            size="sm"
            icon={X}
            label={t('inspector.close')}
            iconSize={16}
            onClick={onDismiss}
            data-inspector="close"
          />
        </header>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          {children}
        </div>
        {footer !== null && (
          <footer
            data-inspector="footer"
            className={cx(
              'flex h-(--inspector-footer-height) shrink-0 items-center gap-2 border-border p-4',
              overflows && 'border-t',
            )}
          >
            <Button
              size="lg"
              className="flex-1"
              disabled={footer.reset?.disabled ?? true}
              focusableWhenDisabled
              onClick={footer.reset?.onReset}
              data-inspector="reset"
            >
              {t('inspector.reset')}
            </Button>
            <Button
              size="lg"
              variant="primary"
              className="flex-1"
              disabled={footer.apply.disabled || footer.apply.busy === true}
              focusableWhenDisabled
              aria-busy={footer.apply.busy === true || undefined}
              onClick={footer.apply.onApply}
              data-inspector="apply"
            >
              {footer.apply.label}
            </Button>
          </footer>
        )}
      </motion.div>
    </aside>
  );
}

/** A caption of a section (`.t-section`) with its fields below, gap 8; sections are 24 apart. */
export function InspectorSection({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {caption !== undefined && <h3 className="t-section m-0 text-text-muted">{caption}</h3>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** The body: sections 24 apart. */
export function InspectorSections({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}
