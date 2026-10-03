import { create } from 'zustand';

/** A document that waits for its password: the id the backend gave it and the name to show. Never the password (ADR-026, DESIGN 3.19). */
export interface PasswordRequest {
  id: number;
  name: string;
}

/**
 * The prompts for encrypted files, oldest first; the dialog shows the first. Several arrive together when a drop holds more than
 * one encrypted file, and they are asked one after the other. The password itself is never here: it lives in the dialog's field
 * for the length of one attempt.
 */
export interface PasswordState {
  queue: readonly PasswordRequest[];
  /** Adds a document that needs a password; one that is queued already (the same file asked again) keeps its place. */
  request: (id: number, name: string) => void;
  /** Removes a prompt: it was answered, or cancelled, or the document is gone. */
  finish: (id: number) => void;
}

export const usePassword = create<PasswordState>()((set) => ({
  queue: [],
  request: (id, name) =>
    set((state) => (state.queue.some((item) => item.id === id) ? state : { queue: [...state.queue, { id, name }] })),
  finish: (id) =>
    set((state) =>
      state.queue.some((item) => item.id === id) ? { queue: state.queue.filter((item) => item.id !== id) } : state,
    ),
}));

/** Asks for the password of a document the backend holds back (`needsPassword`). */
export function requestPassword(id: number, name: string): void {
  usePassword.getState().request(id, name);
}
