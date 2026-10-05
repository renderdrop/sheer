import { beforeEach, describe, expect, it } from 'vitest';

import { resetNotices, useNotices } from './notices';

const { request, release } = useNotices.getState();
const visible = () => useNotices.getState().visible?.id;

describe('notice queue', () => {
  beforeEach(resetNotices);

  it('shows one notice at a time and queues the rest in order of priority, first in first out', () => {
    request({ id: 'tip', kind: 'tip' });
    request({ id: 'info1', kind: 'info' });
    request({ id: 'coach', kind: 'coach' });
    request({ id: 'info2', kind: 'info' });
    expect(visible()).toBe('tip');
    release('tip');
    expect(visible()).toBe('coach');
    release('coach');
    expect(visible()).toBe('info1');
    release('info1');
    expect(visible()).toBe('info2');
    release('info2');
    expect(visible()).toBeUndefined();
  });

  it('lets only an error preempt, and the preempted notice returns to the head', () => {
    request({ id: 'coach', kind: 'coach' });
    request({ id: 'tip', kind: 'tip' });
    request({ id: 'info', kind: 'info' });
    expect(visible()).toBe('coach');
    request({ id: 'err', kind: 'error' });
    expect(visible()).toBe('err');
    expect(useNotices.getState().queue.map((n) => n.id)).toEqual(['coach', 'info', 'tip']);
    request({ id: 'err2', kind: 'error' });
    expect(visible()).toBe('err');
    release('err');
    expect(visible()).toBe('err2');
    release('err2');
    expect(visible()).toBe('coach');
  });

  it('drops a queued notice whose context is gone', () => {
    request({ id: 'info', kind: 'info' });
    request({ id: 'tip', kind: 'tip', gone: () => true });
    request({ id: 'tip2', kind: 'tip' });
    release('info');
    expect(visible()).toBe('tip2');
  });

  it('ignores a duplicate request and a release of an unknown id', () => {
    request({ id: 'a', kind: 'info' });
    request({ id: 'a', kind: 'info' });
    release('zzz');
    expect(useNotices.getState().queue).toEqual([]);
    expect(visible()).toBe('a');
  });
});
