# Publish check

Date: 2026-10-03 · State checked: `main` at `cc79d64` (v0.7.0) plus the commit that adds this file · Repository today: **private**
(`renderdrop/sheer`). Nothing was published and no history was rewritten.

## Verdict

**Not cleared yet: one blocker, and it is an owner decision, not a code fix.**

| # | Blocker | What clears it |
|---|---|---|
| P-1 | The personal e-mail address `h…@gmail.com` (the owner's personal Gmail address, redacted here) is in the author and committer of all 79 own commits, in 23 `Signed-off-by` trailers and in the tagger of all 8 annotated tags (`v0.0.1`–`v0.7.0`). Together with the Windows user name in the tests (H-1) it points to a real name. It cannot be removed without rewriting history. | Either **(a)** the owner accepts that this address becomes public (write "P-1 accepted" below), or **(b)** before going public the owner rewrites history once (e.g. `git filter-repo --mailmap`) to the GitHub no-reply address `<id>+renderdrop@users.noreply.github.com`, re-creates the tags, force-pushes, and re-runs this check. |

Owner decision on P-1: _open_

Everything else passed or is a recommendation (below). Once P-1 is decided, the repository is cleared for publication, followed by the
steps under "After switching to public".

## 1. Secrets (whole history, all refs)

| Tool | Scope | Result |
|---|---|---|
| gitleaks 8.30.1 | `gitleaks git --log-opts=--all`, 81 commits, 6.4 MB | 1 finding, **false positive**: `generic-api-key` at `src/features/organize/store.ts:6`, `STORAGE_KEY = 'sheer.organizeThumb2'` (a localStorage key name). |
| trufflehog 3.97.9 | `trufflehog git file://.`, 4 517 chunks, verification on | 0 verified, 1 unverified, **false positive**: URI detector on `https://user:password@example.com/` in `src-tauri/src/security/links.rs:469` (first in `1be0c14`), the test input for refusing links with embedded credentials. |

No keys, tokens, certificates or `.env` files in any revision. `.gitignore` covers `.env*`, `*.local*`, `.claude/settings.local.json`,
`.claude/state/`, build output and the fetched PDFium binary. The six files deleted in history are source files and were scanned too.

## 2. Personal data in files and commit messages

Searched every revision (`git grep` over all 81 commits, binaries included with `-a`) and all commit messages for: Windows/Unix home
paths, the user and machine names, `AppData`/`OneDrive`/scratchpad paths, `DESKTOP-`/`LAPTOP-` host names, private IPv4 ranges
(10/8, 172.16/12, 192.168/16), e-mail addresses, and real names.

| Kind | Result |
|---|---|
| Absolute paths of the development machine | none (no project path, no `AppData`, no temp/scratchpad path) |
| Windows user name | **the owner's first name as user name in 26 test fixture strings in 13 files** (H-1), e.g. `C:\Users\<name>\secret.pdf` and `authorSuggestion: '<name>'`; same strings in history |
| Machine names | none |
| Local IP addresses | none |
| E-mail addresses in files | only test and placeholder addresses (`*@example.com`, `*@evil.example`, `a@b.example`); the two `*.invalid` placeholders in `SECURITY.md` / `TRADEMARK.md` are replaced by this commit |
| E-mail addresses in commit messages | the personal address, in 23 `Signed-off-by` trailers (P-1) |
| Real names | no full name in any file; first name only as the user name above |
| File metadata | PDFs (fixtures, welcome documents): no `/Author`, `/Creator`, `/Producer`; PNG icons: no text chunks; `Sheer — Logo & Farbe.html`: clean |

## 3. Commit author e-mails

| Identity | Where |
|---|---|
| `renderdrop <h…@gmail.com>` | author + committer of 79 commits, 23 `Signed-off-by`, tagger of 8 tags (P-1) |
| `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` | 2 commits on the Dependabot branches (committer `GitHub <noreply@github.com>`, sign-off `support@github.com`) |
| `Claude Opus 5.5 <noreply@anthropic.com>` | `Co-Authored-By` trailer in 79 commits |

## 4. Required files

| File | State |
|---|---|
| `LICENSE` | complete: full AGPL-3.0 text (661 lines); `package.json` and `Cargo.toml` say `AGPL-3.0-or-later`, Cargo authors "Sheer contributors" |
| `TRADEMARK.md` | complete: name and logo not licensed, forks must rename, how to rename; contact placeholder replaced by "open an issue" (ADR-045) |
| `SECURITY.md` | complete: pre-release status, private reporting via GitHub private vulnerability reporting (ADR-045), response times, scope; placeholder address removed |
| `README.md` | complete: status notice "pre-release, unsigned, not for productive use", feature table by milestone (M1–M4 done, M5–M7 planned), build, privacy, license, DCO, releases |

## 5. CI

`ci.yml`: manual runs (`workflow_dispatch`) now have their own concurrency group (`ci-<workflow>-manual-<ref>`), so a push to `main`
no longer cancels a running manual release-candidate run and the other way round (ADR-045).

## After switching to public

1. Settings → Code security → enable **Private vulnerability reporting** (not available while the repository is private; `SECURITY.md`
   points there).
2. Settings → Emails (account): enable "Keep my email address private" and "Block command line pushes that expose my email", and set
   `git config user.email <id>+renderdrop@users.noreply.github.com` in this clone, so new commits stop adding the address (whatever P-1 decides).
3. Update the repository description (today "pdf editor").

## Recommendations (not blocking)

- **H-1** Replace that user name in the 13 test files with a neutral name (`alice`, `/home/user`). It stays in history unless P-1 (b) is chosen.
- **H-2** Internal AI orchestration files are tracked and will be public: `ORCHESTRATOR_PROMPT.md` (German), `CLAUDE.md`, `STATE.md`,
  `.claude/agents/*`, `.claude/hooks/*`, `.claude/settings.json`, `.claude/launch.json`. No secrets or personal data in them; keep for
  transparency, or mention them in the README.
- **H-3** `Sheer — Logo & Farbe.html` (139 KB design scratch in the root, German name, loads React from jsdelivr): move to `assets/brand/` or remove.
- **H-4** `docs/research/*.md` name Adobe/Acrobat often (feature research, paraphrased, no logos or screenshots). Fine as nominative use;
  a one-line note "Adobe and Acrobat are trademarks of Adobe Inc." at the top would be cleaner.
- **H-5** No copyright line besides the license text. If wanted: "Copyright (C) 2026 The Sheer contributors" in the README, no real name.
- **H-6** Open blockers B-001 (UI never seen on a Mac, keychain untested) and B-002 (code signing) remain; the README notice covers them.
