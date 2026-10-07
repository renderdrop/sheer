// Dev only: `tauri dev` with the WebView2 DevTools protocol on 127.0.0.1:9222 (ADR-021). Same as dev.sh, without needing
// a POSIX shell, so `.claude/launch.json` can start it on Windows (where `bash` may resolve to WSL).
import { execFileSync, spawn } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { buildEnv } from '../build-env.mjs';

// ~/.cargo/bin on PATH, six jobs, below-normal priority, sccache (rule 17, ADR-136).
const base = buildEnv();
const front = [];
if (process.platform === 'win32') {
  // The npm scripts call `bash`; put Git Bash before System32's WSL launcher. git --exec-path is <git>/mingw64/libexec/git-core.
  const root = resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..');
  front.push(join(root, 'bin'), join(root, 'usr', 'bin'));
}
// Windows spells it `Path`; a second `PATH` key would make the child's lookup ambiguous.
const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const env = {
  ...base,
  [pathKey]: [...front, base[pathKey] ?? ''].join(delimiter),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
};
const child = spawn('npm', ['run', 'tauri', 'dev'], { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
