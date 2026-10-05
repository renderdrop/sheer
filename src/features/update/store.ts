import { create } from 'zustand';

import { toAppError } from '../../api/errors';
import {
  checkForUpdate,
  downloadUpdate,
  installUpdateOnQuit,
  isUpdaterUnconfigured,
  skipUpdateVersion,
  updaterConfigured,
  type UpdateInfo,
} from '../../api/update';
import { useSettings } from '../../stores/settings';
import { requestQuit } from '../save/quit';

/** The offer's progress: the banner shows what the phase says (DESIGN 3.49). */
export type UpdatePhase = 'available' | 'downloading' | 'verifying' | 'ready' | 'downloadFailed' | 'unverified';

/** The result of the last explicit check (Settings "Check now", About "Check for updates"). */
export type CheckStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'failed' | 'unconfigured';

export interface UpdateState {
  info: UpdateInfo | null;
  phase: UpdatePhase;
  /** Bytes so far and the total, `null` total while unknown. */
  progress: { downloaded: number; total: number | null };
  /** "Later" hides the banner until the next launch. */
  hidden: boolean;
  check: CheckStatus;
  /** The embedded signing key is real (a local probe, no network); `null` until the probe answered. Settings shows Updates only when `true`. */
  configured: boolean | null;
  /** Asks the backend once per session whether the updater can run; a failed probe counts as not configured. */
  probe: () => Promise<void>;
  /** Versions whose signature check failed: not offered again this session. */
  rejected: readonly string[];
  /** An automatic check (a push) found a newer version. Ignores a skipped or rejected version. */
  offer: (info: UpdateInfo) => void;
  /** An explicit check: the user asked, so this is the one-time consent in About. Never rejects. */
  checkNow: () => Promise<void>;
  download: () => Promise<void>;
  /** Install on quit, then the normal quit flow (unsaved documents are dealt with first; Cancel stops it). */
  restart: () => Promise<void>;
  skip: () => Promise<void>;
  later: () => void;
}

const initial = {
  info: null,
  phase: 'available' as UpdatePhase,
  progress: { downloaded: 0, total: null },
  hidden: false,
  check: 'idle' as CheckStatus,
  configured: null as boolean | null,
};

let latestCheck = 0;

export const useUpdate = create<UpdateState>()((set, get) => ({
  ...initial,
  rejected: [],

  probe: async () => {
    if (get().configured !== null) return;
    let configured = false;
    try {
      configured = await updaterConfigured();
    } catch {
      // Not configured as far as the UI can tell: the group stays hidden.
    }
    set({ configured, ...(configured ? {} : { check: 'unconfigured' as CheckStatus }) });
  },

  offer: (info) => {
    const state = get();
    if (state.rejected.includes(info.version) || useSettings.getState().skippedVersion === info.version) return;
    if (state.info?.version === info.version && state.phase !== 'available') return;
    set({ info, phase: 'available', hidden: false });
  },

  checkNow: async () => {
    const ticket = ++latestCheck;
    set({ check: 'checking' });
    try {
      const info = await checkForUpdate();
      if (ticket !== latestCheck) return;
      if (info === null) {
        set({ check: 'upToDate' });
      } else {
        // An explicit check shows the version even when it was skipped before: the user asked.
        const same = get().info?.version === info.version && get().phase !== 'available';
        set({
          check: 'available',
          ...(same || get().rejected.includes(info.version) ? {} : { info, phase: 'available', hidden: false }),
        });
      }
    } catch (caught) {
      if (ticket !== latestCheck) return;
      set({ check: isUpdaterUnconfigured(toAppError(caught)) ? 'unconfigured' : 'failed' });
    }
  },

  download: async () => {
    const { info, phase } = get();
    if (info === null || (phase !== 'available' && phase !== 'downloadFailed')) return;
    set({ phase: 'downloading', progress: { downloaded: 0, total: null } });
    let outcome: 'verified' | 'unverified' | 'failed' | null = null;
    try {
      await downloadUpdate((event) => {
        if (event.kind === 'progress') {
          set({ progress: { downloaded: event.downloaded, total: event.total } });
        } else if (event.kind === 'verified') {
          outcome = 'verified';
          set({ phase: 'ready' });
        } else {
          // A bad signature deletes the download; any other failure may be tried again.
          outcome = event.code === 'damaged_file' ? 'unverified' : 'failed';
          if (outcome === 'unverified') {
            set({ phase: 'unverified', rejected: [...get().rejected, info.version] });
          } else {
            set({ phase: 'downloadFailed' });
          }
        }
      });
    } catch (caught) {
      if (outcome === null) {
        const code = toAppError(caught).code;
        if (code === 'damaged_file') {
          set({ phase: 'unverified', rejected: [...get().rejected, info.version] });
        } else {
          set({ phase: 'downloadFailed' });
        }
      }
      return;
    }
    // The call ended without a verdict (the verdict is the last message): treat it as a failed download.
    if (outcome === null) set({ phase: 'downloadFailed' });
  },

  restart: async () => {
    if (get().phase !== 'ready') return;
    try {
      await installUpdateOnQuit();
    } catch {
      set({ phase: 'downloadFailed' });
      return;
    }
    await requestQuit();
  },

  skip: async () => {
    const info = get().info;
    if (info === null) return;
    set({ hidden: true });
    try {
      await skipUpdateVersion(info.version);
      useSettings.setState({ skippedVersion: info.version });
    } catch {
      // Hidden for this launch at least.
    }
  },

  later: () => set({ hidden: true }),
}));

/** For tests. */
export function resetUpdate(): void {
  latestCheck = 0;
  useUpdate.setState({ ...initial, rejected: [] });
}
