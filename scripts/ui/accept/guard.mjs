// Dialog guard (ADR-131). Watches the foreground window and all top-level windows of the acceptance process every 250 ms.
// A foreign foreground window or an unexpected dialog: Esc to that window, abort the script, report. Never clicks.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from './pure.mjs';

const PS1 = fileURLToPath(new URL('./guard.ps1', import.meta.url));
const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1];

/** All pids of the acceptance process tree (exe + its WebView2 children). */
export function processTree(rootPid) {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { encoding: 'utf8' },
  );
  const kids = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [p, pp] = line.trim().split(' ').map(Number);
    if (!p) continue;
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const all = [rootPid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  return all;
}

function sendEsc(hwnd) {
  try {
    execFileSync('powershell', [...PS, '-Esc', String(hwnd)], { stdio: 'ignore', timeout: 5000 });
  } catch {
    /* best effort */
  }
}

/**
 * Start the watcher. Returns { aborted: Promise (rejects with the report), step(name), stop() }.
 * A foreign foreground needs two consecutive snapshots (focus handover); an unexpected window aborts at once.
 */
export function startGuard(rootPid, { intervalMs = 250, onAbort } = {}) {
  const pids = processTree(rootPid);
  const child = spawn('powershell', [...PS, '-Pids', pids.join(','), '-IntervalMs', String(intervalMs)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let lastStep = '(start)';
  let foreignStreak = 0;
  let done = false;
  let buf = '';
  let reject;
  const aborted = new Promise((_, rej) => (reject = rej));
  aborted.catch(() => {});
  const abort = (d) => {
    if (done) return;
    done = true;
    sendEsc(d.hwnd);
    child.kill();
    const report = { ...d, lastStep };
    const msg = `GUARD ABORT: ${d.reason}; window "${d.title}" class=${d.class} pid=${d.pid}; last step: ${lastStep}`;
    console.error(msg);
    onAbort?.(report);
    reject(Object.assign(new Error(msg), { report }));
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || done) continue;
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        continue;
      }
      const d = guardDecision(snap, pids);
      if (!d) foreignStreak = 0;
      else if (d.reason === 'foreign-foreground' && ++foreignStreak < 2) continue;
      else abort(d);
    }
  });
  return {
    aborted,
    step: (name) => {
      lastStep = name;
    },
    stop: () => {
      done = true;
      child.kill();
    },
  };
}

/** Run fn(guard) with the guard active; an abort wins the race and rejects. */
export async function guarded(rootPid, fn) {
  const g = startGuard(rootPid);
  try {
    return await Promise.race([fn(g), g.aborted]);
  } finally {
    g.stop();
  }
}
