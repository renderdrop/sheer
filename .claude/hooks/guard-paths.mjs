// PreToolUse guard (ADR-127, rule 14): writes, deletes and moves only inside the repo and the Claude temp folder; reads outside the repo
// are blocked too (test material lives in review/owner/, ADR-126). Input: the hook JSON on stdin. Exit 2 = blocked (stderr is the reason).
// Path tokens are recognised by shape (drive letters, /c/, ~, $HOME/$APPDATA/$TMP…, %VAR%, $env:VAR, /tmp, ..); heredoc bodies are text.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const norm = (p) => {
  let s = p.replace(/\\/g, '/');
  if (/^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`; // Git Bash /c/x → c:/x
  s = (win ? path.win32 : path.posix).resolve(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return win ? s.toLowerCase() : s;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

const WRITE_VERBS = new Set(
  (
    'rm rmdir del erase rd remove-item ri mv move move-item mi cp copy copy-item cpi ren rename rename-item new-item ni ' +
    'set-content add-content clear-content out-file tee tee-object touch mkdir md ln install dd truncate shred unlink'
  ).split(' '),
);
const VARS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'CLAUDE_PROJECT_DIR', 'PWD', 'PROGRAMFILES'];

/** Split a shell command into segments of tokens; redirect targets are flagged. Quotes group, operators split. */
function tokenize(cmd) {
  const segs = [[]];
  let cur = '';
  let had = false;
  let redirect = false;
  const push = () => {
    if (had) segs[segs.length - 1].push({ text: cur, redirect });
    if (had) redirect = false;
    cur = '';
    had = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, i + 1);
      cur += cmd.slice(i + 1, j === -1 ? cmd.length : j);
      had = true;
      i = j === -1 ? cmd.length : j;
    } else if (/\s/.test(c)) push();
    else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      if (c === '&' && cmd[i + 1] === '>') continue; // &> is a redirect
      push();
      segs.push([]);
    } else if (c === '>') {
      if (/^\d?$/.test(cur)) {
        cur = '';
        had = false;
      } else push();
      if (cmd[i + 1] === '>') i++;
      if (cmd[i + 1] === '&') {
        i++; // >&2, >&1
        while (/\d/.test(cmd[i + 1] ?? '')) i++;
        continue;
      }
      redirect = true;
    } else {
      cur += c;
      had = true;
    }
  }
  push();
  return segs.filter((s) => s.length > 0);
}

/** Drop heredoc bodies (`<<'EOF'` … `EOF`): they are text written somewhere, not paths. */
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let end = null;
  for (const line of lines) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (m) end = m[1];
  }
  return out.join('\n');
}

function expand(tok, env, cwd) {
  let t = tok.replace(/^~(?=\/|\\|$)/, env.USERPROFILE ?? env.HOME ?? '~');
  let unknown = false;
  t = t.replace(/^(?:\$env:|%|\$\{?)([A-Za-z_][A-Za-z0-9_]*)(?:%|\})?/i, (all, name) => {
    const key = VARS.find((v) => v.toLowerCase() === name.toLowerCase());
    const val = key === 'PWD' ? cwd : key ? env[key] : undefined;
    if (val === undefined) unknown = true;
    return val ?? all;
  });
  return { t, unknown };
}

const PATHLIKE = /^(?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/|\/(?:tmp|usr|etc|home|var|mnt|opt|bin|Users|Volumes|private)(?:\/|$)|~(?:[\\/]|$)|\\\\|\.\.(?:[\\/]|$)|(?:\$env:|%|\$\{?)[A-Za-z_])/i;

/** @returns {string | null} the reason to block, or null. */
export function check(input, env = process.env) {
  const repo = norm(env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
  // The Claude temp folder (scratchpad, task output): <tmp>/claude. Git Bash may hand over TEMP as /tmp, so every spelling is listed.
  const temps = [os.tmpdir(), env.TEMP, env.TMP, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Temp')]
    .filter((d) => typeof d === 'string' && d !== '' && !(win && d.startsWith('/')))
    .map((d) => norm(path.join(d, 'claude')));
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const toolchain = [path.join(home, '.cargo'), path.join(home, '.rustup')].map(norm);
  const cwd = input.cwd ?? repo;
  const writable = (p) => inside(p, repo) || temps.some((t) => inside(p, t));
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f !== 'string') return null;
    const p = norm(path.isAbsolute(f) || /^[A-Za-z]:/.test(f) ? f : path.join(cwd, f));
    return writable(p) ? null : `write outside the repo and the Claude temp folder: ${f}`;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const cmd = typeof ti.command === 'string' ? ti.command : '';
  for (const seg of tokenize(stripHeredocs(cmd))) {
    // The verb is the first word that is not a shell keyword, a wrapper or an env assignment (`do rm`, `sudo rm`, `X=1 rm`).
    const at = seg.findIndex((t) => !/^(do|then|else|elif|time|sudo|env|command|exec|nohup|xargs|!|\{)$/i.test(t.text) && !/^\w+=/.test(t.text));
    const verb = (seg[at]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
    const writeSeg = WRITE_VERBS.has(verb) || (verb === 'sed' && seg.some((t) => /^-i/.test(t.text)));
    for (const [k, tok] of seg.entries()) {
      const raw = tok.text.includes('=') && !PATHLIKE.test(tok.text) ? tok.text.slice(tok.text.indexOf('=') + 1) : tok.text;
      if (/^(\/dev\/|nul$|\$null$)/i.test(raw)) continue;
      const write = tok.redirect || (writeSeg && k > at);
      // A relative write target is resolved against the cwd; a `cd` elsewhere is caught by its own path token.
      if (!PATHLIKE.test(raw) && (!write || raw.startsWith('-'))) continue;
      const { t, unknown } = expand(raw, env, cwd);
      if (unknown) {
        if (write) return `cannot verify the write target ${raw} (unknown variable)`;
        continue;
      }
      const p = norm(path.isAbsolute(t) || /^[A-Za-z]:|^\/[a-zA-Z]\//.test(t) ? t : path.join(cwd, t));
      if (writable(p)) continue;
      if (write) return `${tok.redirect ? 'redirect' : verb} outside the repo and the Claude temp folder: ${raw}`;
      if (toolchain.some((r) => inside(p, r))) continue;
      return `read outside the repo (test material only from review/owner/, ADR-126): ${raw}`;
    }
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let data = '';
  process.stdin.on('data', (d) => (data += d));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(data);
    } catch {
      process.exit(0);
    }
    const why = check(input);
    if (why) {
      process.stderr.write(`BLOCKED by guard-paths (ADR-127): ${why}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}
