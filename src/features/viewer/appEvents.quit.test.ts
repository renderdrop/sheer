import { describe, expect, it, vi } from 'vitest';

import { parseAppEvent } from '../../api/app';
import { handleAppEvent } from './appEvents';

const quit = vi.hoisted(() => ({ requestQuit: vi.fn() }));
vi.mock('../save/quit', () => quit);

describe('a close request from the backend', () => {
  it('is a bare type on the wire', () => {
    expect(parseAppEvent({ type: 'closeRequested' })).toEqual({ type: 'closeRequested' });
  });

  it('starts the quit walk', () => {
    handleAppEvent({ type: 'closeRequested' });
    expect(quit.requestQuit).toHaveBeenCalledTimes(1);
  });
});
