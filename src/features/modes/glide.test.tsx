// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useTools } from '../../stores/tools';
import { MODES, useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ToolRow } from '.';

/**
 * Spell 1: the shared pill glides by FLIP (the mode tabs are file-tab registers since DESIGN 3.18 and no longer glide). jsdom has no layout and no Web Animations, so both are stood in for:
 * rects follow the order of the items, and `animate` records what it was asked to do.
 */
interface Recorded {
  keyframes: Keyframe[];
  duration: number;
  cancel: ReturnType<typeof vi.fn>;
}
let recorded: Recorded[] = [];
let live: Recorded[] = [];
let reduced = false;

const rectOf = (left: number, width: number): DOMRect =>
  ({ left, top: 0, width, height: 30, right: left + width, bottom: 30, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  recorded = [];
  live = [];
  reduced = false;
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    if (el.dataset.glidePill !== undefined) {
      // As drawn: the final box (the recorded transform is not applied by jsdom).
      const [x] = (el.style.translate || '0px 0px').split(' ');
      return rectOf(Number.parseFloat(x ?? '0'), Number.parseFloat(el.style.width || '0'));
    }
    const mode = el.dataset.mode;
    if (mode !== undefined) return rectOf(MODES.indexOf(mode as (typeof MODES)[number]) * 100, 90);
    const parent = el.parentElement;
    return rectOf((parent === null ? 0 : [...parent.children].indexOf(el)) * 100, 90);
  });
  HTMLElement.prototype.getAnimations = () => live as unknown as Animation[];
  HTMLElement.prototype.animate = function (
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: KeyframeAnimationOptions | number,
  ) {
    const entry: Recorded = {
      keyframes: keyframes as Keyframe[],
      duration: typeof options === 'number' ? options : Number(options?.duration ?? 0),
      cancel: vi.fn(() => {
        live = live.filter((other) => other !== entry);
      }),
    };
    recorded.push(entry);
    live.push(entry);
    return entry as unknown as Animation;
  } as HTMLElement['animate'];
  useUi.setState({ mode: 'read', activeTool: 'select', toolLocked: false });
  act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDocuments();
  useTools.setState(useTools.getInitialState(), true);
  useAnnotations.setState(useAnnotations.getInitialState(), true);
});

const toolPill = () => document.querySelector<HTMLElement>('[data-glide-pill="tool"]');
const translateOf = (el: HTMLElement | null) => el?.style.translate ?? '';

describe('tool pill (MOTION spell 1)', () => {
  const openTools = () => {
    useUi.setState({ mode: 'comment', activeTool: 'select', toolLocked: false });
    return setup(<ToolRow />);
  };

  it('is one Solar element with the Ink hairline, behind the items', () => {
    openTools();
    expect(toolPill()?.className).toContain('bg-accent');
    expect(toolPill()?.className).toContain('shadow-(--tool-active-edge)');
    expect(toolPill()?.className).toContain('-z-10');
  });

  it('glides to another active tool over --motion-base with transform only; reduced motion places it at once', async () => {
    const { user } = openTools();
    const [one, two] = screen.getAllByRole('button', { name: /^(Highlight|Underline|Note)$/ });
    await user.click(one as HTMLElement);
    const before = translateOf(toolPill());
    recorded = [];
    await user.click(two as HTMLElement);
    expect(translateOf(toolPill())).not.toBe(before);
    expect(recorded.at(-1)?.duration).toBe(160);
    expect(Object.keys(recorded.at(-1)?.keyframes[0] ?? {})).toEqual(['transform']);
  });

  it('reduced motion: no animation', async () => {
    reduced = true;
    const { user } = openTools();
    const [one, two] = screen.getAllByRole('button', { name: /^(Highlight|Underline|Note)$/ });
    await user.click(one as HTMLElement);
    await user.click(two as HTMLElement);
    expect(recorded).toHaveLength(0);
  });
});
