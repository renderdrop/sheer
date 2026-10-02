import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { closeWindow, isWindowFullscreen, isWindowMaximized, minimizeWindow, toggleMaximizeWindow } from './window';

const current = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
  isFullscreen: vi.fn(),
}));
const getCurrentWindow = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }));

beforeEach(() => {
  for (const mock of Object.values(current)) mock.mockReset().mockResolvedValue(undefined);
  getCurrentWindow.mockReset().mockReturnValue(current);
});

describe('the window API wrappers', () => {
  it('each control calls its one method on the current window', async () => {
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    expect(current.minimize).toHaveBeenCalledTimes(1);
    expect(current.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(current.isMaximized).not.toHaveBeenCalled();
  });

  it('the state reads return what the window says', async () => {
    current.isMaximized.mockResolvedValue(true);
    current.isFullscreen.mockResolvedValue(false);
    await expect(isWindowMaximized()).resolves.toBe(true);
    await expect(isWindowFullscreen()).resolves.toBe(false);
  });

  it('a refusal becomes an AppError', async () => {
    current.minimize.mockRejectedValue(
      new Error('window.minimize not allowed. Permissions associated with this command: ...'),
    );
    await expect(minimizeWindow()).rejects.toMatchObject({ code: 'internal', key: 'error.internal' });
  });

  it('outside Tauri, where there is no current window, every call rejects with an AppError instead of throwing', async () => {
    getCurrentWindow.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'metadata')");
    });
    for (const call of [minimizeWindow, toggleMaximizeWindow, closeWindow, isWindowMaximized, isWindowFullscreen]) {
      await expect(call()).rejects.toMatchObject({ code: 'internal' });
    }
  });
});

describe('the permissions behind the wrappers (SECURITY T3, ADR-014)', () => {
  const capability = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../src-tauri/capabilities/default.json', import.meta.url)), 'utf8'),
  ) as { permissions: string[] };
  const windowPermissions = capability.permissions.filter((permission) => permission.startsWith('core:'));

  it('the capability grants exactly the window permissions the wrappers and the drag region need, and no others', () => {
    expect([...windowPermissions].sort()).toEqual(
      [
        'core:window:allow-minimize',
        'core:window:allow-toggle-maximize',
        'core:window:allow-close',
        'core:window:allow-is-maximized',
        'core:window:allow-is-fullscreen',
        // What Tauri's data-tauri-drag-region script calls: dragging and the double click.
        'core:window:allow-start-dragging',
        'core:window:allow-internal-toggle-maximize',
      ].sort(),
    );
  });

  it('the wrappers use only methods whose permissions are granted: no other window method is called', () => {
    const source = readFileSync(fileURLToPath(new URL('./window.ts', import.meta.url)), 'utf8');
    const methods = [...source.matchAll(/window\.(\w+)\(/g)].map((match) => match[1]).sort();
    expect(methods).toEqual(['close', 'isFullscreen', 'isMaximized', 'minimize', 'toggleMaximize']);
  });
});
