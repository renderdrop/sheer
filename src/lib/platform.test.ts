import { describe, expect, it } from 'vitest';

import { chromeFor, detectPlatform } from './platform';

describe('detectPlatform', () => {
  it('reads the WebView2, WKWebView and WebKitGTK user agents', () => {
    expect(
      detectPlatform(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      ),
    ).toBe('windows');
    expect(
      detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    ).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('linux');
  });

  it('is null when it cannot tell', () => {
    expect(detectPlatform('')).toBeNull();
    expect(detectPlatform('curl/8.0')).toBeNull();
  });
});

describe('chromeFor', () => {
  it('Windows has its own caption row, macOS has traffic lights, nothing else has either', () => {
    expect(chromeFor('windows')).toEqual({ caption: true, trafficLights: false });
    expect(chromeFor('macos')).toEqual({ caption: false, trafficLights: true });
    expect(chromeFor('linux')).toEqual({ caption: false, trafficLights: false });
    expect(chromeFor(null)).toEqual({ caption: false, trafficLights: false });
  });
});
