# Blockers

Things only a human can resolve. Each entry: ID · what is blocked · why · exactly what the human must do.
Work continues around them; they are revisited before every milestone tag.

| ID | Blocks | Why | Human action |
|---|---|---|---|
| B-001 | Seeing the app run on macOS (window, vibrancy/transparency flag live, menu bar, file association) | **Resolved 2026-10-04 (FEEDBACK F15):** the owner installed the v1.2.0-beta.1 DMG on a Mac and tested it; the app runs. The two macOS defects found there (signature library does not persist, blank print pages) are F15 A9/A10. History: **partly resolved 2026-10-03 (FEEDBACK F6):** `origin` exists; CI on `macos-latest` (arm64) builds, runs `npm run check` (clippy, cargo test incl. Unix file modes/FIFO tests, vitest) and `tauri build --debug` green (run 37120538629, 03d357b). The first macOS runs failed only on test-side issues (APFS refuses non-UTF-8 names; a timing-sensitive respawn test), fixed. **Still unverified:** the running UI on a Mac (nobody has seen the window), the universal DMG, the engine child process on macOS outside CI tests, and Keychain behavior of the saved-signatures store. Do this before the first signed release (guide step 0). | Run the debug build on a Mac once (`npm run fetch-pdfium && npm run tauri dev`), open a PDF, check the menu bar and the transparency setting; then install a CI-built DMG and repeat. |
| B-008 | Text recognition on a real Mac (v1.7.0, ADR-137 §2): the Swift Vision helper is built and tested only in macOS CI (swift test, Vision round trip de/en, saved layer found by search, helper restart) | **Open (human-only):** nobody has run Recognize text on a Mac; the DMG bundles the helper ad-hoc signed until B-002. | Install the v1.7.0 DMG, open a scanned PDF, Werkzeuge → Text erkennen…, search a word, save and reopen; once in German and once in English UI. |
| B-002 | Signed installers (no SmartScreen / Gatekeeper warning) | **Open.** Release builds (`.github/workflows/release.yml`, ADR-031) are unsigned: no Windows certificate or signing service, no Apple Developer account, no signing secrets in CI. The release notes say so. Nothing in the repo is wired for signing yet (no `signCommand`, no entitlements file, no `APPLE_*` or `AZURE_*` variables in the workflow). | Follow "Signing and notarization guide" below (parts A, B, C and the order of operations). Needs a paid Apple Developer Program membership and a Windows certificate or Azure signing account. |
| B-005 | Auto-update (ADR-053 section 3): the updater refuses to run (`unsupported_feature`, `what: "updater_unconfigured"`) and the Updates setting stays hidden | The minisign key pair that signs update packages can only be made and kept by the owner: the private key and its password must never be in the repo or CI (SECURITY T6), so every release also needs a local signing step. `src-tauri/updater/minisign.pub` holds a placeholder. | **Once:** run `npx tauri signer generate -w ~/.sheer/updater.key` (set a password; back up both the key file and the password offline). Replace the last line of `src-tauri/updater/minisign.pub` with the content of the `.pub` file it writes (one base64 line; keep the `#` comment lines or delete them) and commit it. **Per release, option A (CI):** add the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `release.yml` then builds the updater artifacts, uploads the `.sig` files and writes `latest.json` by itself (no secret: unsigned installers only). **Option B (local):** download the installers of an unsigned release into one folder, then run `SHEER_UPDATER_KEY=~/.sheer/updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... bash scripts/sign-update.sh <artifact-dir> <version>`, and upload the `.sig` files and the `latest.json` it writes to the GitHub release. Losing the private key means users must reinstall by hand once. |
| B-006 | Session v1.5.1 pre-task: recovery data older than 30 days discarded automatically, banner collapsing from three entries | **Resolved 2026-10-06:** the owner confirmed the change in chat (ADR-128); built in v1.5.1 wave 2. Former note: The Claude Code auto-mode classifier denied reading `storage/autosave.rs` / `RecoveryBanner.tsx` for this change ("Irreversible Local Destruction") right after the twelve test entries were moved to the Recycle Bin; the denial forbids pursuing it through sub-agents. | Confirm the change in chat or add a Bash permission rule for this repo; the package is small (purge age 14 → 30 days, banner summary at ≥ 3 entries). |
| B-007 | v1.5.1 gate: ≥ 30 corpus PDFs including self-generated Word, LaTeX and Ghostscript files | **Resolved 2026-10-06:** the owner put 32 PDFs into `review/owner/corpus/`; nothing is generated (ADR-128). Former note: ADR-126 forbids searching the machine for tools; whether Word, a LaTeX engine and Ghostscript are installed and on PATH is unknown (a PATH probe was denied by the classifier). `review/owner/corpus/` holds 17 PDFs. | Tell the orchestrator which producers are installed (or add PDFs to `review/owner/corpus/`). |

## Signing and notarization guide (B-001, B-002, B-005)

Status of this guide: written from the repo state at v0.9.0 and from the documented behavior of Tauri 2, Apple and Microsoft tooling.
**Nothing here has been run** (no certificate or Apple account exists), so every command, variable name and service rule marked
*unverified* must be checked against the current official documentation before you rely on it. Rules that hold regardless:
signing keys, certificates and passwords are never committed (SECURITY C3, `guard_secrets` in `scripts/check.sh`), and signing
secrets reach only the build step of `release.yml`, never `ci.yml` or any pull-request workflow.

What the repo has today: `release.yml` builds an NSIS installer (Windows) and a universal DMG (macOS) per `v*` tag. Its "Build installer"
step already reads `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (updater only, B-005).
`src-tauri/tauri.conf.json` has no `signingIdentity` and no `entitlements`; `tauri.windows.conf.json` has no `signCommand`.

### Order of operations for the first signed release

0. **B-001:** run the macOS build once by hand. It is cheaper to find a broken window now than after notarization.
1. **B-005, once:** create the updater key and commit the public key (part C). Do this first: the public key is embedded in the
   binary, so a release built before it ships an updater that can never verify a later one.
2. **Windows:** choose a signing option (part A), add its secrets, add the signing config, test with a scratch tag (see "Dry run").
3. **macOS:** enroll, create the certificate, add the secrets, add the entitlements file and signing config (part B), test the same way.
4. Edit the "Unsigned installers ..." block in the publish job of `release.yml` and the "Releases" section of `README.md`, so they stop claiming the builds are unsigned.
5. Confirm the `.sig` files and `latest.json` appear (the `HAS_UPDATER_KEY` path of the workflow, already there).
6. Tag the release (`scripts/bump-version.sh`, changelog, then the `v*` tag as today). Automation never pushes tags.
7. Verify on clean machines (see "Verification"), then mark B-001 and B-002 resolved here and in `STATE.md`.

### Dry run

Use `workflow_dispatch` with a scratch tag (for example `v0.0.0-signtest`; the tag regex in the publish job allows a `-suffix`) and delete
the draft release and tag afterwards. Do not test signing on a real version tag.

### A. Windows code signing

**Facts to know first (unverified, check current policy):**
- Since mid 2023 the CA/Browser Forum requires the private key of a new OV or EV code-signing certificate to live on a hardware token or
  an HSM. A downloadable `.pfx` is generally no longer issued, so the old recipe "base64 the `.pfx` into a GitHub secret and run
  `signtool`" works only for older certificates. GitHub-hosted runners cannot use a USB token.
- Since 2024 an EV certificate no longer gives instant SmartScreen trust; OV and EV both build reputation. Expect warnings for the
  first downloads with either.

| Option | What it is | Fits CI | Notes |
|---|---|---|---|
| A1. Azure Trusted Signing (Microsoft; the product may have been renamed Artifact Signing) | Cloud signing with short-lived certificates after identity validation | Yes | Monthly fee. Availability depends on country and legal form (unverified). No hardware token. First choice if you qualify. |
| A2. OV or EV certificate with a cloud HSM (DigiCert KeyLocker, SSL.com eSigner, Azure Key Vault with an HSM-backed key) | Certificate from a CA, key in the vendor's HSM, signing through the vendor's CLI | Yes, with that CLI | Roughly one to a few hundred EUR per year (unverified). The Tauri `signCommand` below calls the vendor CLI. |
| A3. OV or EV certificate on a USB token | Classic | No | Sign on your own PC: take the unsigned installer from CI, run `signtool sign` locally, then run `scripts/sign-update.sh` (part C) on the signed file and upload. |

**A1, Azure Trusted Signing, step by step (unverified details):**
1. In the Azure portal create a Trusted Signing account, complete identity validation and create a certificate profile (Public Trust).
2. Create an app registration (service principal) and give it the role "Trusted Signing Certificate Profile Signer" on the profile.
3. Add GitHub repository secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and (secrets or variables) `AZURE_SIGNING_ENDPOINT`,
   `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`. Prefer a GitHub Environment named `release` (required reviewers, tags only) that holds them.
4. Install a signing CLI on the Windows runner in a new step before "Build installer" with `if: runner.os == 'Windows'`, for example
   `cargo install trusted-signing-cli --locked` (installed in CI only; it is not a dependency of the repo, so no `docs/LICENSES.md` entry
   unless it is ever vendored; check its license anyway).
5. Tell Tauri how to sign. In `src-tauri/tauri.windows.conf.json`, under `bundle.windows`, add (`%1` is the file to sign):

   ```json
   "signCommand": "trusted-signing-cli -e %AZURE_SIGNING_ENDPOINT% -a %AZURE_SIGNING_ACCOUNT% -c %AZURE_SIGNING_PROFILE% -d Sheer %1"
   ```

   (The shell used for `signCommand` and the variable syntax are unverified; if in doubt, pass the whole object with
   `--config '<json>'` in the workflow, as the workflow already does for `createUpdaterArtifacts`.) Setting `signCommand` in the committed
   file also makes local `tauri build` try to sign, so the config-through-workflow variant is safer for contributors.
6. In `release.yml`, job `build`, step "Build installer", add to `env:`:
   `AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}`, `AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}`,
   `AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}`, and the three `AZURE_SIGNING_*` values. Add `environment: release` to the job
   if you use the protected environment. Update the header comment "Installer signing secrets: none."
7. The signature needs an RFC 3161 timestamp (the CLI adds one; with `signtool` use `/tr http://timestamp.digicert.com /td sha256 /fd sha256`),
   otherwise it stops being valid when the certificate expires.

**A2 with `signtool`** (certificate in the Windows store, or an HSM client that exposes one): in `tauri.windows.conf.json` set
`bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"` and `timestampUrl`; or use `signCommand` with the vendor CLI.
By hand: `signtool sign /sha1 <thumbprint> /fd sha256 /tr <rfc3161-url> /td sha256 /d Sheer <file>`.

**Specific to this repo:** the NSIS installer is per-user (no admin), the WebView2 bootstrapper is downloaded at install time, and the PDF
engine runs as a second process of the same `sheer.exe` (ADR-053 section 1), so one signed executable covers both.

### B. macOS: Developer ID, hardened runtime, notarization

1. Enroll in the Apple Developer Program (paid, yearly) and note the Team ID.
2. Create a **Developer ID Application** certificate (not "Apple Development", not "Mac App Store"): Xcode, Settings, Accounts, Manage
   Certificates, "+". Export it from Keychain Access as a `.p12` with a strong password.
3. Notarization credentials, one of:
   - Apple ID plus an app-specific password (appleid.apple.com): `APPLE_ID`, `APPLE_PASSWORD` (the app-specific one), `APPLE_TEAM_ID`.
   - An App Store Connect API key: `APPLE_API_ISSUER`, `APPLE_API_KEY` (key id), `APPLE_API_KEY_PATH` (path to the `.p8`; the workflow
     must write the secret to a temp file first). Preferred for CI.
4. Repository secrets (on the same `release` environment): `APPLE_CERTIFICATE` (`base64 -i cert.p12`), `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY` (full name, for example `Developer ID Application: Your Name (TEAMID)`), plus the notarization values from step 3.
5. `release.yml`, job `build`, step "Build installer", add to `env:` (on Windows they are empty and ignored):
   `APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}`, `APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}`,
   `APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}`, `APPLE_ID: ${{ secrets.APPLE_ID }}`,
   `APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}`, `APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}`.
   With these set the Tauri bundler imports the certificate into a temporary keychain, signs with the hardened runtime
   (`codesign --options runtime`), submits to `notarytool`, waits, and staples (unverified: read the Tauri "macOS Code Signing" page for your
   Tauri version, in particular whether the DMG itself is signed and stapled). Notarization can take minutes to hours; the job has `timeout-minutes: 60`.
6. **Entitlements.** The repo has no entitlements file. Create `src-tauri/entitlements.plist` and set `bundle.macOS.entitlements` to
   `"entitlements.plist"` in `tauri.macos.conf.json`. Sheer is not sandboxed, runs no JIT of its own (WKWebView's JIT lives in Apple's
   WebContent process) and loads only the PDFium library inside the bundle. Start with an **empty** `<dict/>`: hardened runtime, no
   exceptions. Add an entitlement only when a notarized build fails for a concrete reason, and record each in `docs/DECISIONS.md`. Do not add
   `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` or
   `com.apple.security.cs.allow-dyld-environment-variables` unless PDFium demonstrably cannot load without them. Unverified: that the bundled
   `libpdfium.dylib` is signed by the bundler with the same Developer ID (library validation requires it; if not, sign it explicitly before
   the bundle) and that the Keychain use of saved signatures (SECURITY D2) needs no entitlement outside the sandbox.
7. **Universal binary.** The workflow builds `--target universal-apple-darwin`; `scripts/fetch-pdfium.sh mac-universal` supplies both slices.
8. **Manual fallback and checks** (on a Mac):
   `codesign --verify --deep --strict --verbose=2 Sheer.app`; `codesign -d --entitlements - Sheer.app`;
   `xcrun notarytool submit Sheer.dmg --apple-id ... --team-id ... --password ... --wait`; `xcrun stapler staple Sheer.dmg`;
   `xcrun stapler validate Sheer.dmg`; `spctl --assess --type open --context context:primary-signature -v Sheer.dmg`.
   On failure `xcrun notarytool log <submission-id> ...` lists the files and reasons.
9. **Updater on macOS.** The `.app.tar.gz` the updater downloads must be made from the signed and notarized app. Confirm the stapled ticket is
   in the archive (unverified).

### C. Updater key (B-005)

Independent of Authenticode and Apple signing: a minisign signature over each update package, checked by the app against
`src-tauri/updater/minisign.pub`. Do the **Once** steps of the B-005 row first (generate with `npx tauri signer generate`, commit the public
key, back up key and password offline), then per release use option A (the two `TAURI_SIGNING_*` secrets, already read by `release.yml`) or
option B (`scripts/sign-update.sh`). Order matters: **Authenticode and notarization first, minisign last**, because the `.sig` covers the final
bytes of the package. With option B download the already signed installers and sign those; never re-sign or repack a file afterwards, or
the app refuses the update (`damaged_file`, SECURITY T6). The updater is the only network path of the app and is off until the user opts in.

### Secrets summary (names only; values never in the repo)

| Secret | Used for | Read by |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater minisign key (C) | "Build installer" step (exists) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (+ `AZURE_SIGNING_*`) | Windows option A1 | "Build installer" step (to add) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | macOS signing | "Build installer" step (to add) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` or `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` | notarization | "Build installer" step (to add) |

Hygiene: protected Environment with required reviewers, rotate the Apple app-specific password and the Azure client secret yearly, keep
`permissions: contents: read` on the build job as it is, and never print a secret (the `HAS_UPDATER_KEY` pattern prints a boolean).

### Verification on clean machines

- Windows 11, fresh user, installer downloaded with a browser: SmartScreen may still warn while reputation builds (that is not a failed
  signature). The file's Properties, Digital Signatures tab shows the publisher and a timestamp; `Get-AuthenticodeSignature` reports `Valid`.
- macOS, one Apple silicon and one Intel Mac, DMG downloaded with a browser (quarantine flag set): opens without a Gatekeeper block,
  `spctl --assess` accepts the app.
- Install the older signed version, enable updates, and confirm the update installs (B-005 end to end; possible only with two signed releases).
