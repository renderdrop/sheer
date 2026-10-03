import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyRedactions, markRedactions, MAX_REDACT_MARKS_PER_COMMAND, MAX_REDACT_QUADS_PER_MARK } from './redaction';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const P = { x: 1, y: 2 };
const QUAD = [P, P, P, P] as const;
const mark = (quads = 1) => ({ pageId: 0, quads: Array.from({ length: quads }, () => QUAD), source: 'text' as const });

describe('markRedactions', () => {
  it('refuses what the backend would refuse, without calling it', async () => {
    await expect(markRedactions(1, [])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      markRedactions(
        1,
        Array.from({ length: MAX_REDACT_MARKS_PER_COMMAND + 1 }, () => mark()),
      ),
    ).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await expect(markRedactions(1, [mark(0)])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(markRedactions(1, [mark(MAX_REDACT_QUADS_PER_MARK + 1)])).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('sends up to 10 000 marks as one command', async () => {
    invokeMock.mockResolvedValue(null);
    const marks = Array.from({ length: MAX_REDACT_MARKS_PER_COMMAND }, () => mark(MAX_REDACT_QUADS_PER_MARK));
    await expect(markRedactions(1, marks)).rejects.toMatchObject({ code: 'internal' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyRedactions', () => {
  it('starts the job and returns its id; a bad answer is an error', async () => {
    invokeMock.mockResolvedValueOnce(7);
    await expect(applyRedactions(1, { pages: null, removeMetadata: true }, () => undefined)).resolves.toBe(7);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('apply_redactions');
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ docId: 1, opts: { pages: null, removeMetadata: true } });
    invokeMock.mockResolvedValueOnce('x');
    await expect(applyRedactions(1, { pages: [0], removeMetadata: false }, () => undefined)).rejects.toBeDefined();
  });
});
