import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types
import * as p from './accept/pure.mjs';

const win = (over: Record<string, unknown> = {}) => ({
  hwnd: 1,
  pid: 10,
  title: 'Sheer Acceptance',
  class: 'Tauri Window',
  visible: true,
  ...over,
});

describe('acceptance coords', () => {
  it('computes the centre and clickability', () => {
    const r = { left: 10, top: 20, width: 100, height: 40 };
    expect(p.rectCenter(r)).toEqual({ x: 60, y: 40 });
    expect(p.isClickable(r, { w: 1280, h: 800 })).toBe(true);
    expect(p.isClickable({ ...r, width: 0 }, { w: 1280, h: 800 })).toBe(false);
    expect(p.isClickable({ left: 2000, top: 0, width: 10, height: 10 }, { w: 1280, h: 800 })).toBe(false);
  });

  it('maps fractions and offsets in a rect', () => {
    const r = { left: 100, top: 100, width: 200, height: 100 };
    expect(p.pointInRect(r, { fx: 0.5, fy: 0.25 })).toEqual({ x: 200, y: 125 });
    expect(p.pointInRect(r, { x: 5, y: 6 })).toEqual({ x: 105, y: 106 });
  });

  it('builds a drag path with both endpoints', () => {
    const path = p.dragPath({ x: 0, y: 0 }, { x: 80, y: 40 }, 4);
    expect(path).toHaveLength(5);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[4]).toEqual({ x: 80, y: 40 });
  });

  it('builds key events; ctrl suppresses text', () => {
    expect(p.keyEvent('a')).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 0 });
    expect(p.keyEvent('o', { ctrl: true })).toMatchObject({ modifiers: 2, text: undefined });
    expect(p.keyEvent('Enter').text).toBe('\r');
    expect(p.modifiers({ alt: true, shift: true })).toBe(9);
  });
});

describe('acceptance launch guard', () => {
  it('accepts only the acceptance exe, never an install path', () => {
    expect(p.isAcceptanceExe('C:\\repo\\src-tauri\\target-acceptance\\release\\sheer-acceptance.exe')).toBe(true);
    expect(p.isAcceptanceExe('C:/repo/src-tauri/target/release/sheer.exe')).toBe(false);
    expect(p.isAcceptanceExe('C:\\Program Files\\Sheer\\target-acceptance\\sheer-acceptance.exe')).toBe(false);
    expect(p.isOwnerInstallPath('C:\\Users\\x\\AppData\\Local\\Sheer\\sheer.exe')).toBe(true);
    expect(p.isOwnerInstallPath('C:\\repo\\src-tauri\\target\\release\\sheer.exe')).toBe(false);
  });
});

describe('guard decision', () => {
  const own = [10, 11];
  it('is quiet for the main window in the foreground', () => {
    expect(p.guardDecision({ foreground: win(), windows: [win()] }, own)).toBeNull();
    expect(p.guardDecision({ foreground: null, windows: [win(), win({ class: 'IME', title: '' })] }, own)).toBeNull();
  });
  it('flags a dialog of the acceptance process', () => {
    const d = win({ hwnd: 7, class: '#32770', title: 'Open' });
    expect(p.guardDecision({ foreground: d, windows: [win(), d] }, own)).toMatchObject({
      reason: 'unexpected-window',
      hwnd: 7,
      class: '#32770',
    });
    expect(
      p.guardDecision({ foreground: win(), windows: [win(), win({ visible: false, class: '#32770' })] }, own),
    ).toBeNull();
  });
  it('flags a foreign foreground window', () => {
    const f = win({ hwnd: 9, pid: 99, class: 'Notepad', title: 'x' });
    expect(p.guardDecision({ foreground: f, windows: [win()] }, own)).toMatchObject({
      reason: 'foreign-foreground',
      pid: 99,
    });
  });
});

describe('languagePatch', () => {
  it('sets the UI language and nothing else', () => {
    expect(p.languagePatch('de')).toEqual({ language: 'de' });
    expect(p.languagePatch('en')).toEqual({ language: 'en' });
    expect(() => p.languagePatch('fr')).toThrow();
  });
});
