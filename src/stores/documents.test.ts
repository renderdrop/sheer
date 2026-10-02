import { beforeEach, describe, expect, it } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { selectActiveDocument, selectActiveId, useDocuments } from './documents';
import { resetDocuments } from './documents.testutil';

const A: DocumentInfo = { id: 1, pageCount: 3, displayName: 'A.pdf' };
const B: DocumentInfo = { id: 2, pageCount: 5, displayName: 'B.pdf' };
const C: DocumentInfo = { id: 7, pageCount: 1, displayName: 'C.pdf' };

const state = () => useDocuments.getState();

beforeEach(resetDocuments);

describe('the documents store', () => {
  it('starts with nothing open', () => {
    expect(state()).toMatchObject({ byId: {}, order: [], activeId: null });
    expect(selectActiveId(state())).toBeNull();
    expect(selectActiveDocument(state())).toBeNull();
  });

  it('keeps documents by the id the backend gave them, in the order they were opened, and the last one is active', () => {
    state().add(A);
    state().add(C);
    state().add(B);
    expect(state().byId).toEqual({ 1: A, 7: C, 2: B });
    // Ids are the backend's, not positions: 7 stays 7 and the order is the order of opening.
    expect(state().order).toEqual([1, 7, 2]);
    expect(selectActiveId(state())).toBe(2);
    expect(selectActiveDocument(state())).toEqual(B);
  });

  it('adds a document it knows already once: it keeps its place, takes the new info and becomes active', () => {
    state().add(A);
    state().add(B);
    state().add({ ...A, displayName: 'A (renamed).pdf' });
    expect(state().order).toEqual([1, 2]);
    expect(state().byId[1]?.displayName).toBe('A (renamed).pdf');
    expect(selectActiveId(state())).toBe(1);
  });

  it('makes an open document active, and ignores an id that is not open', () => {
    state().add(A);
    state().add(B);
    state().setActive(1);
    expect(selectActiveId(state())).toBe(1);
    const before = state();
    state().setActive(99);
    state().setActive(1);
    expect(state()).toBe(before);
  });

  it('removing the active document makes the next one active, else the one before it, else none', () => {
    state().add(A);
    state().add(B);
    state().add(C);
    state().setActive(2);
    state().remove(2);
    expect(state().order).toEqual([1, 7]);
    expect(selectActiveId(state())).toBe(7);
    state().remove(7);
    expect(selectActiveId(state())).toBe(1);
    state().remove(1);
    expect(state()).toMatchObject({ byId: {}, order: [], activeId: null });
  });

  it('removing a document that is not the active one leaves the active one alone', () => {
    state().add(A);
    state().add(B);
    state().setActive(1);
    state().remove(2);
    expect(selectActiveId(state())).toBe(1);
    expect(state().order).toEqual([1]);
    expect(state().byId).toEqual({ 1: A });
  });

  it('forgets an id it never had without a change', () => {
    state().add(A);
    const before = state();
    state().remove(42);
    expect(state()).toBe(before);
  });

  it('an id that was closed can come back: the backend gives a new document a new id, and a store does not care', () => {
    state().add(A);
    state().remove(1);
    state().add(A);
    expect(state().order).toEqual([1]);
    expect(selectActiveId(state())).toBe(1);
  });
});
