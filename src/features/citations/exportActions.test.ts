// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyBibRecord, type CitationInfo } from '../../api/citations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { invalidateBibliography } from './bibliography';
import { copyCitation, copyCitationList, copyReference, saveCitationList } from './exportActions';
import { setCitationFormat, useCitationPrefs } from './style';

const api = vi.hoisted(() => ({ getBibliography: vi.fn(), listCitations: vi.fn(), saveCitationList: vi.fn() }));
vi.mock('../../api/citations', async (original) => ({
  ...(await original<typeof import('../../api/citations')>()),
  getBibliography: api.getBibliography,
  listCitations: api.listCitations,
  saveCitationList: api.saveCitationList,
}));

const citation = (over: Partial<CitationInfo> = {}): CitationInfo => ({
  id: 5,
  pageId: 1,
  locator: '12',
  quote: 'A <quote>',
  contents: '',
  tags: [],
  group: null,
  color: [220, 207, 255],
  ...over,
});

const write = vi.fn();
class FakeItem {
  constructor(public readonly items: Record<string, Blob>) {}
}
const toast = () => useUi.getState().toast;
const REFERENCE = 'Müller, A. (2020). On quotations.';

beforeEach(() => {
  invalidateBibliography(1);
  localStorage.clear();
  useCitationPrefs.setState({ style: 'apa7', format: 'txt' });
  useDocuments.setState({
    byId: { 1: { id: 1, pageCount: 3, displayName: 'a.pdf', kind: 'user' } },
    order: [1],
    activeId: 1,
  });
  useUi.setState({ toast: null });
  write.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ClipboardItem', FakeItem);
  Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
  api.getBibliography.mockReset().mockResolvedValue({
    record: {
      ...emptyBibRecord(),
      title: 'On quotations',
      year: '2020',
      authors: [{ family: 'Müller', given: 'Anna' }],
    },
    sources: {},
    pending: false,
    droppedByStrip: false,
  });
  api.listCitations.mockReset().mockResolvedValue([citation()]);
  api.saveCitationList.mockReset().mockResolvedValue(true);
});

async function written(): Promise<{ text: string; html: string }> {
  const item = (write.mock.calls[0] as [FakeItem[]])[0][0] as FakeItem;
  return {
    text: await (item.items['text/plain'] as Blob).text(),
    html: await (item.items['text/html'] as Blob).text(),
  };
}

describe('copy actions', () => {
  it('copies the reference as text and escaped HTML with a toast', async () => {
    await copyReference(1);
    const { text, html } = await written();
    expect(text).toBe(REFERENCE);
    expect(html).toBe(`<p>${REFERENCE}</p>`);
    expect(toast()?.message).toBe('Reference copied');
  });

  it('copies one citation as quote and short citation', async () => {
    await copyCitation(1, 5);
    const { text, html } = await written();
    expect(text).toBe('“A <quote>” (Müller, 2020, p. 12)');
    expect(html).toContain('&lt;quote&gt;');
    expect(toast()?.message).toBe('Citation copied');
  });

  it('copies the list, or says it is empty', async () => {
    await copyCitationList(1);
    expect((await written()).text).toContain('\n\n“A <quote>”');
    expect(toast()?.message).toBe('Citation list copied');
    api.listCitations.mockResolvedValue([]);
    await copyCitationList(1);
    expect(toast()?.message).toContain('No citations yet');
  });

  it('leaves quotes out of a file that forbids copying', async () => {
    useDocuments.setState({
      byId: {
        1: {
          id: 1,
          pageCount: 3,
          displayName: 'a.pdf',
          kind: 'user',
          flags: { encrypted: true, xfa: false, hasForms: false, signed: false, permissions: ['print'] },
        },
      },
    });
    await copyCitation(1, 5);
    expect((await written()).text).toBe('(Müller, 2020, p. 12)');
    expect(toast()?.message).toContain('does not allow copying');
  });

  it('falls back to plain text and then reports a failure with Try again', async () => {
    write.mockRejectedValue(new Error('denied'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText }, configurable: true });
    await copyReference(1);
    expect(writeText).toHaveBeenCalledWith(REFERENCE);
    writeText.mockRejectedValue(new Error('denied'));
    await copyReference(1);
    expect(toast()?.message).toBe('Could not copy to the clipboard.');
    expect(toast()?.action?.label).toBe('Try again');
  });
});

describe('save', () => {
  it('saves the blocks in the last format and confirms', async () => {
    await saveCitationList(1);
    const [docId, format, blocks, style] = api.saveCitationList.mock.calls[0] as [number, string, unknown[], string];
    expect([docId, format, style]).toEqual([1, 'txt', 'apa7']);
    expect(blocks).toHaveLength(2);
    expect(toast()?.message).toBe('Citation list saved');
  });

  it('sends no blocks for RIS and BibTeX', async () => {
    setCitationFormat('ris');
    api.listCitations.mockResolvedValue([]);
    await saveCitationList(1);
    expect(api.saveCitationList.mock.calls[0]?.[2]).toEqual([]);
  });

  it('is silent when the dialog is cancelled', async () => {
    api.saveCitationList.mockResolvedValue(false);
    await saveCitationList(1);
    expect(toast()).toBeNull();
  });

  it('shows the failure with Try again, which saves again', async () => {
    api.saveCitationList.mockRejectedValueOnce({ code: 'io' });
    await saveCitationList(1);
    expect(toast()?.message).toBe('The citation list could not be saved.');
    toast()?.action?.run();
    await vi.waitFor(() => expect(toast()?.message).toBe('Citation list saved'));
  });
});
