// Dialog queue helpers for the acceptance build (ADR-131). The backend seam answers native dialogs from this queue;
// an empty queue is an error there, never a native dialog. IPC exists only in the build with the `automation` feature.
import { resolve } from 'node:path';

const call = (session, cmd, args = {}) =>
  session.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

export function createDialogs(session, input) {
  const queue = (entry) => call(session, 'automation_queue_dialog', { entry });
  return {
    queue,
    answerOpen: (path) => queue({ kind: 'open', paths: [resolve(path)] }),
    answerOpenMany: (paths) => queue({ kind: 'openMany', paths: paths.map((p) => resolve(p)) }),
    answerFolder: (path) => queue({ kind: 'folder', paths: [resolve(path)] }),
    answerSave: (path) => queue({ kind: 'save', paths: [resolve(path)] }),
    answerMessage: (button) => queue({ kind: 'message', button }),
    answerPrint: () => queue({ kind: 'print' }),
    /** The next dialog reports "cancelled" instead of a path. */
    cancelNext: (kind = 'open') => queue({ kind, cancel: true }),
    state: () => call(session, 'automation_state'),
    lastPrint: async () => (await call(session, 'automation_state')).lastPrint,
    lastError: async () => (await call(session, 'automation_state')).lastError,
    /** Queue an Open answer and trigger Open with the app shortcut (Ctrl+O). */
    async openFile(path) {
      await queue({ kind: 'open', paths: [resolve(path)] });
      await input.press('o', { ctrl: true });
    },
  };
}
