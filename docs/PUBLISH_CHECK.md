# Publish check

Second run, 2026-10-03, after the local history rewrite (owner chose option (b) for P-1). State checked: local `main` including the
commit that updates this file. The rewritten history is **not pushed yet**; the owner pushes it. The repository `renderdrop/sheer` is
still **private**. Nothing was published.

## Verdict

**The local repository is cleared. The existing GitHub repository is not: publish the rewritten history into a new repository
(P-2), not by force-pushing and switching `renderdrop/sheer` to public.**

| # | Item | State |
|---|---|---|
| P-1 | Personal e-mail address in commit metadata | **Resolved locally.** `git filter-repo` replaced it everywhere: author and committer of all own commits, 23 `Signed-off-by` trailers, tagger of all 8 tags. Dependabot entries and `Co-Authored-By` trailers are unchanged. The Windows user name in test paths is replaced by `user` in every revision. No old object is left in the local object store. |
| P-2 | **GitHub still holds the old history** of `renderdrop/sheer` | **Blocker for that repository.** A force-push does not remove it: (1) 52 of the 54 Actions runs carry the old address in their `head_commit` metadata (public through the API once the repository is public); (2) the closed Dependabot pull requests #1 and #2 keep `refs/pull/1/head` and `refs/pull/2/head`, whose parents are the old commits, and these refs cannot be deleted by the owner; (3) old commits stay reachable by SHA until GitHub garbage-collects them; (4) the releases 0.4.0–0.7.0 are attached to the old tags. **Clears with:** publish into a fresh repository (see "Publishing" below). Keep the old one private (rename it, e.g. `sheer-archive`) or delete it. |

## 1. Secrets (whole history, all refs, after the rewrite)

| Tool | Scope | Result |
|---|---|---|
| gitleaks 8.30.1 | `gitleaks git --log-opts=--all`, 83 commits | 2 findings, both **false positives** of the `generic-api-key` rule: the localStorage key name in `src/features/organize/store.ts:6`, and the first version of this file, which quoted that line. |
| trufflehog 3.97.9 | `trufflehog git file://.`, 4 527 chunks, verification on | 0 verified, 2 unverified, both **false positives** of the URI detector: the test link with embedded example credentials in `src-tauri/src/security/links.rs` (the refusal test), and the first version of this file, which quoted it. |

No keys, tokens, certificates or `.env` files in any revision. `.gitignore` covers `.env*`, `*.local*`, `.claude/settings.local.json`,
`.claude/state/`, build output and the fetched PDFium binary.

## 2. Personal data in files and commit messages

Searched every revision (`git grep -a` over all commits, binaries included), all commit and tag messages, and all identities for:
home paths with a user name, the owner's names and e-mail, machine names (`DESKTOP-`/`LAPTOP-`), `AppData`/`OneDrive`/temp paths,
private IPv4 ranges (10/8, 172.16/12, 192.168/16), e-mail addresses and real names.

| Kind | Result |
|---|---|
| Owner's e-mail address | **none** (files, messages, identities, tags) |
| Owner's name / Windows user name | **none**; test paths now read `C:\Users\user\…` and `/home/user/…` |
| Absolute paths of the development machine | none |
| Machine names, local IP addresses | none |
| E-mail addresses in files | test and placeholder addresses only (`*@example.com`, `*@evil.example`, `a@b.example`), the no-reply addresses of GitHub, Dependabot and Anthropic |
| File metadata | PDFs: no `/Author`, `/Creator`, `/Producer`; PNG icons: no text chunks; the brand reference HTML: clean |
| Residue | the first version of this file (in history) names the old address only as the initial `h…` plus the mail provider. Accepted. |

## 3. Commit author e-mails (after the rewrite)

| Identity | Where |
|---|---|
| `renderdrop <266359566+renderdrop@users.noreply.github.com>` | author + committer of all own commits, 23 `Signed-off-by`, tagger of 8 tags |
| `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` | 2 commits on the local `dependabot/*` branches (committer `GitHub <noreply@github.com>`, sign-off `support@github.com`) |
| `Claude Opus 5.5 <noreply@anthropic.com>` | `Co-Authored-By` trailer in the own commits |

This clone has `user.email` set to the no-reply address. The **global** Git e-mail on the development machine is still the personal
address; any other clone without a local setting would still use it.

## 4. Required files

| File | State |
|---|---|
| `LICENSE` | complete: full AGPL-3.0 text; `package.json` and `Cargo.toml` say `AGPL-3.0-or-later`, Cargo authors "Sheer contributors" |
| `TRADEMARK.md` | complete: name and logo not licensed, forks must rename, how to rename, contact via issue |
| `SECURITY.md` | complete: pre-release status, GitHub private vulnerability reporting, response times, scope |
| `README.md` | complete: "pre-release, unsigned, not for productive use" notice, feature table by milestone, build, privacy, license, DCO |

## 5. Repository content

- The brand reference `Sheer — Logo & Farbe.html` moved from the root to `assets/brand/` (ADR-000 item 7 updated).
- CI: manual runs have their own concurrency group (ADR-045).
- `npm run check` after the rewrite: all 15 steps passed.

## Publishing (owner)

The rewrite removed the `origin` remote (filter-repo does that on purpose); it was added back with the same URL. A backup of the
repository before the rewrite exists outside the project (Git bundle and a copy of `.git` in the session scratchpad).

1. Rename the old repository (Settings → General, e.g. `sheer-archive`) and keep it private, or delete it.
2. Create a new, empty, private repository `renderdrop/sheer` (no README, no license, so the first push is a fast-forward).
3. Push only `main` and the tags: `git push -u origin main` and `git push origin --tags`. Do not push the two local
   `dependabot/*` branches (Dependabot recreates its pull requests). Pushing the tags runs `release.yml` for every tag; to save macOS
   minutes, push only `v0.7.0` (`git push origin v0.7.0`) and add the others later, or accept the runs.
4. Check once on GitHub: `gh api repos/renderdrop/sheer/commits --jq '.[].commit.author.email' | sort -u` shows only no-reply addresses.
5. Switch to public. Then: Settings → Code security → enable **Private vulnerability reporting**; account Settings → Emails → enable
   "Keep my email address private" and "Block command line pushes that expose my email" (set the global Git e-mail to the no-reply
   address first, or pushes from other clones are refused); set the repository description.

If the owner force-pushes to the existing repository instead, it must stay private (P-2).

## Recommendations (not blocking)

- **H-1** Internal AI orchestration files are tracked and will be public: `ORCHESTRATOR_PROMPT.md` (German), `CLAUDE.md`, `STATE.md`,
  `.claude/agents/*`, `.claude/hooks/*`, `.claude/settings.json`, `.claude/launch.json`. No secrets or personal data in them.
- **H-2** `docs/research/*.md` name Adobe/Acrobat often (paraphrased feature research, no logos or screenshots). A one-line note
  "Adobe and Acrobat are trademarks of Adobe Inc." at the top would be cleaner.
- **H-3** No copyright line besides the license text. If wanted: "Copyright (C) 2026 The Sheer contributors" in the README.
- **H-4** Dependabot alert `glib` 0.18.5 (GHSA-wrw7-89jp-8q8g, moderate): Linux-only GTK dependency of Tauri, not compiled for the
  macOS and Windows targets; dismiss as "vulnerable code is not actually used". It reappears in the new repository.
- **H-5** Open blockers B-001 (UI never seen on a Mac, keychain untested) and B-002 (code signing) remain; the README notice covers them.
