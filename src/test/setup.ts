import { afterEach, beforeEach } from 'vitest';

import { useLocaleStore } from '../i18n/store';

/**
 * Runs before every test file. Node tests (stores, api, tokens) need nothing. Component tests run in jsdom (docblock
 * `// @vitest-environment jsdom`), which lacks a few browser APIs the components use; they are stubbed here.
 */
// The UI renders in English unless a test switches it: `navigator.language` is the machine's language under node.
beforeEach(() => {
  useLocaleStore.setState({ locale: 'en' });
});

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  const { MotionGlobalConfig } = await import('motion/react');

  // Exit animations finish at once, so a closed popover is gone after one tick instead of 150 ms.
  MotionGlobalConfig.skipAnimations = true;
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  }

  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  // jsdom does not track keyboard modality: `:focus-visible` never matches. Treat it as `:focus`, which is what a keyboard
  // user gets. (Mouse clicks hide tooltips on pointerdown, so a click does not leave one behind either.)
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return matches.call(this, selector === ':focus-visible' ? ':focus' : selector);
  } as Element['matches'];

  // Pointer capture is not implemented by jsdom; the slider and splitter use it while dragging.
  const proto = HTMLElement.prototype;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
}
