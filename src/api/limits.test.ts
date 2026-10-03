import { describe, expect, it } from 'vitest';

import { MAX_PAGE_LINKS, MAX_URL_LEN } from './links';
import { rustConstants } from './limits.testutil';
import { MAX_OUTLINE_DEPTH, MAX_OUTLINE_NODES, MAX_OUTLINE_TITLE_CHARS } from './outline';
import { MAX_QUADS_PER_HIT, MAX_SEARCH_HITS, MAX_SEARCH_QUERY_CHARS } from './search';
import { MAX_TEXT_CHARS } from './text';
import { MAX_COORDINATE_PT } from './wire';

describe('the bounds of the read commands mirror the backend (src-tauri/src/limits.rs)', () => {
  const rust = rustConstants();

  it('has every limit the parsers check, with the same value', () => {
    expect(rust.get('MAX_OUTLINE_NODES')).toBe(MAX_OUTLINE_NODES);
    expect(rust.get('MAX_OUTLINE_DEPTH')).toBe(MAX_OUTLINE_DEPTH);
    expect(rust.get('MAX_OUTLINE_TITLE_CHARS')).toBe(MAX_OUTLINE_TITLE_CHARS);
    expect(rust.get('MAX_TEXT_CHARS')).toBe(MAX_TEXT_CHARS);
    expect(rust.get('MAX_SEARCH_QUERY_CHARS')).toBe(MAX_SEARCH_QUERY_CHARS);
    expect(rust.get('MAX_SEARCH_HITS')).toBe(MAX_SEARCH_HITS);
    expect(rust.get('MAX_QUADS_PER_HIT')).toBe(MAX_QUADS_PER_HIT);
    expect(rust.get('MAX_PAGE_LINKS')).toBe(MAX_PAGE_LINKS);
    expect(rust.get('MAX_URL_LEN')).toBe(MAX_URL_LEN);
    // A coordinate may be as large as a page side may be (ADR-003).
    expect(rust.get('MAX_PAGE_SIDE_PT')).toBe(MAX_COORDINATE_PT);
  });
});
