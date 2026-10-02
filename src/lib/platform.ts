import type { Platform } from '../api/app';

/**
 * The desktop platform from the user agent, for the first paint only: the window chrome (Windows caption row, macOS
 * traffic-light inset) must be in place before the backend has answered `app_ready`, or the layout would jump. The
 * backend's answer (`settings.platform`) replaces it as soon as it arrives. `null` when it cannot tell (a test, an
 * unknown shell).
 */
export function detectPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): Platform | null {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}

/** What the window chrome needs to know about the platform (DESIGN 2.2). */
export interface Chrome {
  /** Windows draws its own 32 px caption row with minimize, maximize and close (the window has no native decorations). */
  caption: boolean;
  /** macOS: the traffic lights float over the toolbar row, which keeps an 80 px leading inset (8 in full screen). */
  trafficLights: boolean;
}

export function chromeFor(platform: Platform | null): Chrome {
  return { caption: platform === 'windows', trafficLights: platform === 'macos' };
}
