/**
 * ADR-056: a change of the canvas size that is not the window's (a panel sliding, once more) must not refit a fit mode: zoom and
 * scroll stay where they are. The hold has an explicit reason, not a timer: it is armed by the caller while the window size is
 * unchanged, spent by the next canvas size report, and dropped by a window resize (so it can never swallow a real resize). Since
 * ADR-102 the properties are an overlay (the mini bar), so nothing arms it by itself any more.
 */
interface Hold {
  windowWidth: number;
  windowHeight: number;
}

let hold: Hold | null = null;

export function armFitHold(windowWidth = window.innerWidth, windowHeight = window.innerHeight): void {
  hold = { windowWidth, windowHeight };
}

export function dropFitHold(): void {
  hold = null;
}

/** Whether the size report that is arriving is the result of an inspector change (spends the hold). */
export function consumeFitHold(windowWidth = window.innerWidth, windowHeight = window.innerHeight): boolean {
  const held = hold !== null && hold.windowWidth === windowWidth && hold.windowHeight === windowHeight;
  hold = null;
  return held;
}
