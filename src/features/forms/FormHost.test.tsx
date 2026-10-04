// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FormField } from '../../api/forms';
import type { JobEvent } from '../../api/jobs';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { runFlatten } from './actions';
import { FormHost } from './FormHost';
import { FormLayer } from './FormLayer';
import { FormOptions } from './FormOptions';
import { FormPill } from './FormPill';
import { useForms } from './store';

const jobs = vi.hoisted(() => ({ flattenDocument: vi.fn(), cancelJob: vi.fn() }));
const forms = vi.hoisted(() => ({ getFormFields: vi.fn() }));
const adopt = vi.hoisted(() => vi.fn());
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), ...jobs }));
vi.mock('../../api/forms', async (importOriginal) => ({ ...(await importOriginal<object>()), ...forms }));
vi.mock('../viewer/useViewer', () => ({
  adoptOpenOutcomes: adopt,
  useViewer: { getState: () => ({ goToPage: vi.fn() }) },
}));

MotionGlobalConfig.skipAnimations = true;

const textField = (id: number, text: string, y: number): FormField => ({
  id,
  name: `field${id}`,
  tooltip: null,
  kind: { type: 'text', multiline: false, maxLen: null, comb: false, password: false, align: 'left', fontSize: 0 },
  readOnly: false,
  required: false,
  value: { type: 'text', text },
  defaultValue: null,
  widgets: [
    {
      pageId: 0,
      rect: { x: 0, y, w: 100, h: 20 },
      tabOrder: y,
      state: null,
      fill: null,
      border: null,
      textColor: [0, 0, 0],
    },
  ],
  sync: 'clean',
});

const FIELDS = [textField(1, 'filled', 0), textField(2, '', 30), textField(3, '', 60)];
const layer = {
  docId: 1,
  pageIndex: 0,
  boxWidth: 200,
  boxHeight: 400,
  widthPt: 200,
  heightPt: 400,
  rotation: 0,
  ready: true,
};

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({
    id: 1,
    pageCount: 1,
    displayName: 'a.pdf',
    flags: { encrypted: false, xfa: false, hasForms: true, signed: false },
  });
  useForms.setState({ byDoc: {}, bannerDismissed: {}, flattenOpen: false, focusRequest: null, highlight: true });
  useUi.setState({ activeTool: 'select', toolLocked: false, toast: null });
  forms.getFormFields
    .mockReset()
    .mockResolvedValue({ fields: FIELDS, hasScripts: false, xfa: 'none', needAppearances: false });
  jobs.flattenDocument.mockReset();
  jobs.cancelJob.mockReset().mockResolvedValue(undefined);
  adopt.mockReset();
});

describe('the form host', () => {
  it.each([90, 180, 270])('keeps the fields on a page turned by %i degrees', async (rotation) => {
    const quarter = rotation !== 180;
    render(
      <>
        <FormHost />
        <FormLayer {...layer} rotation={rotation} boxWidth={quarter ? 400 : 200} boxHeight={quarter ? 200 : 400} />
      </>,
    );
    expect(await screen.findAllByRole('textbox')).toHaveLength(3);
    expect(screen.getByRole('group').style.transform).toBe(`rotate(${rotation}deg) scale(1)`);
  });

  it('reads the form of the active document and shows the banner and the Form pill', async () => {
    render(
      <>
        <FormHost />
        <FormPill />
      </>,
    );
    expect(await screen.findByText(/Form detected – 3 fields/)).toBeTruthy();
    expect(screen.getByText('Form')).toBeTruthy();
    expect(forms.getFormFields).toHaveBeenCalledWith(1);
  });

  it('does not read a document whose flags say it has no form, and shows no pill', () => {
    useDocuments.setState({
      byId: {
        1: {
          id: 1,
          pageCount: 1,
          displayName: 'a.pdf',
          flags: { encrypted: false, xfa: false, hasForms: false, signed: false },
        },
      },
    });
    render(
      <>
        <FormHost />
        <FormPill />
      </>,
    );
    expect(forms.getFormFields).not.toHaveBeenCalled();
    expect(screen.queryByText('Form')).toBeNull();
  });

  it('the banner closes for the session', async () => {
    const { user } = setup(<FormHost />);
    await screen.findByText(/Form detected/);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Form detected/)).toBeNull());
    expect(useForms.getState().bannerDismissed[1]).toBe(true);
  });

  it('Go to first field focuses the first one', async () => {
    const { user } = setup(
      <>
        <FormHost />
        <FormLayer {...layer} />
      </>,
    );
    await screen.findByRole('textbox', { name: 'field2' });
    await user.click(screen.getByRole('button', { name: 'Go to first field' }));
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('field1'));
  });

  it('the banner shows again for another document, not twice for the same one', async () => {
    render(<FormHost />);
    await screen.findByText(/Form detected/);
    act(() => useForms.getState().dismissBanner(1));
    await waitFor(() => expect(screen.queryByText(/Form detected/)).toBeNull());
    expect(useForms.getState().bannerDismissed[2]).toBeUndefined();
  });
});

describe('Flatten', () => {
  const doneEvent: JobEvent = {
    type: 'done',
    outputs: 1,
    bytesBefore: 10,
    bytesAfter: 9,
    warnings: [],
    opened: { id: 2, pageCount: 1, displayName: 'flat.pdf' },
  };

  it('asks first, with Cancel focused, then runs the flatten job and opens the result', async () => {
    jobs.flattenDocument.mockImplementation((_doc: number, _opts: object, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent(doneEvent));
      return Promise.resolve(7);
    });
    const { user } = setup(<FormHost />);
    await waitFor(() => expect(useForms.getState().byDoc[1]?.status).toBe('ready'));
    runFlatten();
    const dialog = await screen.findByRole('dialog', { name: 'Flatten form' });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Flatten' }));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith([{ type: 'opened', document: doneEvent.opened }]));
    expect(jobs.flattenDocument).toHaveBeenCalledWith(1, { scope: 'forms' }, expect.any(Function));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUi.getState().toast?.message).toBe('Form flattened. The new file is open.');
  });

  it('Cancel closes without running anything', async () => {
    const { user } = setup(<FormHost />);
    await waitFor(() => expect(useForms.getState().byDoc[1]?.status).toBe('ready'));
    runFlatten();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(jobs.flattenDocument).not.toHaveBeenCalled();
  });

  it('shows a progress bar while it runs', async () => {
    jobs.flattenDocument.mockImplementation((_doc: number, _opts: object, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent({ type: 'progress', phase: 'write', done: 1, total: 4 }));
      return Promise.resolve(7);
    });
    const { user } = setup(<FormHost />);
    await waitFor(() => expect(useForms.getState().byDoc[1]?.status).toBe('ready'));
    runFlatten();
    await user.click(await screen.findByRole('button', { name: 'Flatten' }));
    expect(await screen.findByRole('progressbar', { name: 'Flattening…' })).toBeTruthy();
  });

  it('says so when the document has no fields', async () => {
    forms.getFormFields.mockResolvedValue({ fields: [], hasScripts: false, xfa: 'none', needAppearances: false });
    render(<FormHost />);
    runFlatten();
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('This document has no fields.'));
    expect(useForms.getState().flattenOpen).toBe(false);
  });
});

describe('Form tool options', () => {
  it('has the highlight toggle and Flatten', async () => {
    useForms.setState({ byDoc: { 1: { status: 'ready', fields: FIELDS, hasForms: true } as never } });
    const { user } = setup(<FormOptions />);
    const toggle = screen.getByRole('button', { name: 'Highlight fields' });
    await user.click(toggle);
    expect(useForms.getState().highlight).toBe(false);
    expect(screen.getByRole('button', { name: 'Flatten form…' })).toBeTruthy();
  });
});
