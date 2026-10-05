import { MotionGlobalConfig, animate, type AnimationPlaybackControls } from 'motion/react';

import {
  DURATION,
  EASE_OUT,
  ZOOM_INERTIA_CAP,
  ZOOM_INERTIA_S,
  ZOOM_SAMPLE_WINDOWS,
  ZOOM_SNAP_BAND,
} from '../../lib/motion';
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEPS, clampZoom } from '../../lib/zoom';
import type { FitMode } from '../../stores/view';
import type { ScrollPosition } from './layout';

/**
 * Zoom as motion (MOTION 4.4). While a zoom runs, the canvas content is only transform-scaled around the anchor (compositor, no
 * layout, no render); the real zoom commits once, at rest, and the render pipeline then fades in the sharp frames. This module
 * owns that transform. It knows the DOM element it scales and nothing about documents: the viewer hands it the committed zoom, the
 * fit zooms and a `commit`.
 */

/** Animations are off globally (Motion's own switch, used by tests): a zoom then commits at once, like with reduced motion. */
export function animationsOff(): boolean {
  return MotionGlobalConfig.skipAnimations === true;
}

/** A pointer or the viewport's centre, in the viewport's px (the scroll region's content box). */
export interface ZoomPoint {
  x: number;
  y: number;
}

export interface ZoomMotionHost {
  /** The zoom the layout was made for. */
  zoom: () => number;
  /** The zooms of the fit steps (`null` while nothing is measured). */
  fitStops: () => { width: number | null; page: number | null };
  /** Makes the zoom real: layout, anchor, render. `focus` is the point of the viewport that keeps its place. */
  commit: (zoom: number, fit: FitMode, focus?: ZoomPoint) => void;
  /** The element that is scaled, `null` where there is no canvas (then every zoom commits at once). */
  content: () => HTMLElement | null;
  scroll: () => ScrollPosition;
  /** The middle of the viewport. */
  center: () => ZoomPoint;
  reduced: () => boolean;
}

/** After this long without a pinch or wheel event the gesture is over and the inertia starts. */
export const GESTURE_IDLE_MS = 90;
/** The velocity is measured over the events of this long before the end. */
const VELOCITY_WINDOW_MS = 100;
const MIN_DISTANCE = 1e-4;
const STOP_EPSILON = 1e-6;
/** Float slack on the edge of the snap band (1.03 / 1 - 1 is 0.030000000000000027). */
const SNAP_EPSILON = 1e-9;

/** The next stop in `direction`: the presets and the fit zooms, in one list. */
export function nextStop(from: number, direction: 1 | -1, extra: readonly number[]): number {
  const stops = [...ZOOM_STEPS, ...extra.filter((zoom) => zoom >= MIN_ZOOM && zoom <= MAX_ZOOM)].sort((a, b) => a - b);
  if (direction === 1) return stops.find((stop) => stop > from + STOP_EPSILON) ?? MAX_ZOOM;
  return [...stops].reverse().find((stop) => stop < from - STOP_EPSILON) ?? MIN_ZOOM;
}

interface Stop {
  zoom: number;
  fit: FitMode;
}

/**
 * Where a zoom gesture that would end at `target` ends (MOTION spell 17): on a fit step (fit width, fit page, 100 %) if it lies
 * within the snap band (+-3 %), else at `target` itself, exactly.
 */
export function snapZoom(target: number, stops: readonly Stop[]): Stop {
  let best: Stop | null = null;
  let bestDistance = ZOOM_SNAP_BAND;
  for (const stop of stops) {
    const distance = Math.abs(target / stop.zoom - 1);
    if (distance <= bestDistance + SNAP_EPSILON) {
      best = stop;
      bestDistance = distance;
    }
  }
  return best ?? { zoom: target, fit: 'none' };
}

/** The log-zoom velocity (per second) of samples of `[ms, log scale]`, over the window that ends at the last one. */
export function velocityOf(samples: readonly (readonly [number, number])[]): number {
  const last = samples.at(-1);
  if (last === undefined) return 0;
  const first = samples.find(([at]) => last[0] - at <= VELOCITY_WINDOW_MS);
  if (first === undefined || last[0] - first[0] <= 0) return 0;
  return ((last[1] - first[1]) / (last[0] - first[0])) * 1000;
}

export interface ZoomMotion {
  /** A pinch or Ctrl+wheel event: follows the fingers 1:1; the inertia starts when the events stop. */
  gesture: (factor: number, focus: ZoomPoint) => void;
  /** One step of the stops in `direction`, around `focus` (the pointer, or the middle of the viewport). */
  step: (direction: 1 | -1, focus?: ZoomPoint) => void;
  /** To a zoom (a fit, 100 %, the menu) around `focus` or the middle of the viewport. */
  animateTo: (zoom: number, fit: FitMode, duration: 'base' | 'slow', focus?: ZoomPoint) => void;
  /** A zoom from the slider or the zoom field, at gesture end: snaps to 100 %, fit width or fit page within +-3 % (spell 17). */
  snapTo: (zoom: number, focus?: ZoomPoint) => void;
  /** The layout of the committed zoom is in the DOM: the transform goes. Safe to call at any time. */
  settle: () => void;
  /** Drops a zoom in flight without committing it (another document is shown, the canvas goes): no commit, no transform. */
  cancel: () => void;
  /** Whether a zoom is running (a transform is on the content). */
  active: () => boolean;
}

export function createZoomMotion(host: ZoomMotionHost): ZoomMotion {
  /** The committed zoom the transform is relative to, and the scale on top of it. */
  let base = 1;
  let scale = 1;
  let running = false;
  let committing = false;
  /** Where the zoom is centred, as a point of the content (so a scroll in between does not move it). */
  let origin: { x: number; y: number } | null = null;
  /** Where the zoom is heading (a step retargets from here). */
  let wanted: Stop | null = null;
  let controls: AnimationPlaybackControls | null = null;
  let idle: number | undefined;
  let samples: [number, number][] = [];

  const fitStops = (): Stop[] => {
    const { width, page } = host.fitStops();
    const stops: Stop[] = [{ zoom: 1, fit: 'none' }];
    if (width !== null) stops.push({ zoom: width, fit: 'width' });
    if (page !== null) stops.push({ zoom: page, fit: 'page' });
    return stops;
  };

  const apply = () => {
    const content = host.content();
    if (content === null || origin === null) return;
    content.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    content.style.transform = `scale(${scale})`;
    content.style.willChange = 'transform';
  };

  const clear = () => {
    const content = host.content();
    if (content !== null) {
      content.style.transform = '';
      content.style.transformOrigin = '';
      content.style.willChange = '';
    }
  };

  const stop = () => {
    controls?.stop();
    controls = null;
    window.clearTimeout(idle);
  };

  const settle = () => {
    // Only a commit ends the transform: a layout that changes while the zoom runs (pages arriving) must not cut it short.
    if (!running || !committing) return;
    stop();
    clear();
    running = false;
    committing = false;
    scale = 1;
    origin = null;
    wanted = null;
    samples = [];
  };

  const cancel = () => {
    stop();
    clear();
    running = false;
    committing = false;
    scale = 1;
    origin = null;
    wanted = null;
    samples = [];
  };

  const begin = (focus: ZoomPoint) => {
    if (committing) settle();
    if (running) return;
    running = true;
    base = host.zoom();
    scale = 1;
    const scroll = host.scroll();
    origin = { x: focus.x + scroll.left, y: focus.y + scroll.top };
    samples = [];
  };

  /** The viewport point of the origin now (it follows the scroll position, the point of the content stays). */
  const focusNow = (): ZoomPoint => {
    const scroll = host.scroll();
    return origin === null ? host.center() : { x: origin.x - scroll.left, y: origin.y - scroll.top };
  };

  const commit = (target: Stop) => {
    stop();
    committing = true;
    const focus = focusNow();
    host.commit(target.zoom, target.fit, focus);
    // A commit that changes nothing in the layout never reaches the canvas's layout effect, which is what normally ends this.
    window.requestAnimationFrame(settle);
  };

  /** Carries the scale from where it is to `target` (ease-out, MOTION 1.1); a new target retargets from the present scale. */
  const run = (target: Stop, duration: 'base' | 'slow') => {
    stop();
    wanted = target;
    const to = Math.log(clampZoom(target.zoom) / base);
    const from = Math.log(scale);
    if (host.reduced() || Math.abs(to - from) < MIN_DISTANCE) {
      scale = Math.exp(to);
      apply();
      commit(target);
      return;
    }
    controls = animate(from, to, {
      duration: DURATION[duration],
      ease: EASE_OUT,
      onUpdate: (u: number) => {
        scale = Math.exp(u);
        apply();
      },
      onComplete: () => commit(target),
    });
  };

  const focusOr = (focus?: ZoomPoint): ZoomPoint => focus ?? host.center();

  const endGesture = () => {
    const logNow = Math.log(scale);
    const delta = Math.max(
      -Math.log(ZOOM_INERTIA_CAP),
      Math.min(Math.log(ZOOM_INERTIA_CAP), velocityOf(samples) * ZOOM_INERTIA_S),
    );
    const projected = clampZoom(base * Math.exp(logNow + delta));
    const target = snapZoom(projected, fitStops());
    // Reduced motion commits the snapped value at once; so does a spring that has nowhere to go.
    run({ zoom: clampZoom(target.zoom), fit: target.fit }, 'base');
  };

  return {
    gesture: (factor, focus) => {
      if (host.content() === null) {
        host.commit(clampZoom(host.zoom() * factor), 'none', focus);
        return;
      }
      begin(focus);
      if (committing) return;
      stop();
      scale = clampZoom(base * scale * factor) / base;
      samples.push([performance.now(), Math.log(scale)]);
      samples = samples.filter(([at]) => performance.now() - at <= ZOOM_SAMPLE_WINDOWS * VELOCITY_WINDOW_MS);
      apply();
      idle = window.setTimeout(endGesture, GESTURE_IDLE_MS);
    },
    step: (direction, focus) => {
      const extra = fitStops().map((entry) => entry.zoom);
      if (host.content() === null) {
        host.commit(nextStop(host.zoom(), direction, extra), 'none', focus);
        return;
      }
      begin(focusOr(focus));
      const from = wanted?.zoom ?? base * scale;
      const zoom = nextStop(from, direction, extra);
      const fit = fitStops().find((entry) => Math.abs(entry.zoom - zoom) < STOP_EPSILON && entry.fit !== 'none');
      run({ zoom, fit: fit?.fit ?? 'none' }, 'base');
    },
    animateTo: (zoom, fit, duration, focus) => {
      if (host.content() === null) {
        host.commit(clampZoom(zoom), fit, focus);
        return;
      }
      begin(focusOr(focus));
      run({ zoom: clampZoom(zoom), fit }, duration);
    },
    snapTo: (zoom, focus) => {
      const target = snapZoom(clampZoom(zoom), fitStops());
      if (host.content() === null) {
        host.commit(clampZoom(target.zoom), target.fit, focus);
        return;
      }
      begin(focusOr(focus));
      run({ zoom: clampZoom(target.zoom), fit: target.fit }, 'base');
    },
    settle,
    cancel,
    active: () => running,
  };
}

/**
 * The canvas registers how to find the element that is scaled while it is mounted; where there is none (a test, the empty state)
 * the zoom commits at once.
 */
let surface: (() => HTMLElement | null) | null = null;

export function registerZoomSurface(find: () => HTMLElement | null): () => void {
  surface = find;
  return () => {
    if (surface === find) surface = null;
  };
}

export function zoomContent(): HTMLElement | null {
  return surface?.() ?? null;
}
