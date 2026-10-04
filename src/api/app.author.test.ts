import { describe, expect, it } from 'vitest';

import { AUTHOR_NAME_MAX, isAuthorName, parseSettings } from './app';

const base = {
  language: 'system',
  leftPanelWidth: 248,
  welcomeTour: 'pending',
  authorPrompt: 'pending',
};

describe('the author name', () => {
  it('is empty or up to 128 characters without control characters', () => {
    expect(isAuthorName('Ada')).toBe(true);
    expect(isAuthorName('李雷')).toBe(true);
    expect(isAuthorName('a'.repeat(AUTHOR_NAME_MAX))).toBe(true);
    expect(isAuthorName('a'.repeat(AUTHOR_NAME_MAX + 1))).toBe(false);
    expect(isAuthorName('')).toBe(true);
    expect(isAuthorName('a\nb')).toBe(false);
    expect(isAuthorName('a\u0000')).toBe(false);
    expect(isAuthorName(3)).toBe(false);
    expect(isAuthorName(null)).toBe(false);
  });

  it('is part of the settings the backend answers with', () => {
    expect(parseSettings({ ...base, authorName: 'Ada' })).toMatchObject({ authorName: 'Ada' });
    expect(parseSettings(base)).toBeNull();
    expect(parseSettings({ ...base, authorName: '' })).toMatchObject({ authorName: '', authorPrompt: 'pending' });
    expect(parseSettings({ ...base, authorName: 'x'.repeat(200) })).toBeNull();
  });
});
