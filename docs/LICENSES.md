# Third-party licenses

Every dependency is checked **before** it is added. Allowed: MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, Zlib
(plus the permissive extras listed in ADR-000). Forbidden: GPL, AGPL, LGPL (any version).
Own code: AGPL-3.0-or-later (`LICENSE`).

State: Phase 2 spike (`Cargo.lock` / `package-lock.json` as of 2026-10-02). Compound expressions such as
`MIT OR Apache-2.0` are used under the permissive alternative. Every new direct dependency needs a row in the tables
below, with a one-line reason why it is not written in-house (ORCHESTRATOR_PROMPT 13.5).

## Direct dependencies

| Name | Ecosystem | Version | SPDX license | Purpose | Added in |
|---|---|---|---|---|---|
| tauri | Rust | 2.12.1 | Apache-2.0 OR MIT | Desktop shell, IPC, bundler. The product's foundation (ADR-001). | v0.2.0 |
| tauri-build | Rust (build) | 2.7.1 | Apache-2.0 OR MIT | Build script: capability and permission generation, resource copy. | v0.2.0 |
| tauri-plugin-dialog | Rust | 2.8.1 | Apache-2.0 OR MIT | Native open dialog, called from Rust only; no capability grants it to the webview. Native dialogs are not writable in-house across two OSes. | v0.2.0 |
| tauri-plugin-opener | Rust | 2.7.0 | Apache-2.0 OR MIT | Opens the one link in a PDF that the user confirmed (`commands/links.rs`), with the system's handler for `http`, `https` and `mailto`. Only its `open_url` function is called, from Rust, with a URL that `security::links` classified; the plugin is not registered with the builder and no capability names it, so the webview has no opener command (SECURITY P3). Starting the default handler is `ShellExecuteExW` on Windows and Launch Services on macOS: Win32 and Objective-C FFI, which our own code forbids (`unsafe_code = "forbid"`) and which is not sensible in-house. Brings one new crate into the Windows and macOS builds, `open` 5 (MIT; with `dunce` and `glob`, which are in the build already), beside the `windows` and `objc2` crates that are there too. Its Linux-only crates (`is-docker`, `is-wsl`, `zbus`) are in `Cargo.lock` but not built for Windows or macOS. | v0.4.0 (M1) |
| zeroize | Rust | 1.9.0 | Apache-2.0 OR MIT | Wipes the password of an encrypted PDF from memory when it is dropped (`Zeroizing<String>`, SECURITY D3). Needs volatile writes, which our own code forbids (`unsafe_code = "forbid"`). No further dependencies. | v0.4.0 (M1) |
| skrifa | Rust | 0.48.0 | MIT OR Apache-2.0 | Glyph outlines of the bundled signature fonts as path commands (quadratics raised exactly to cubics, cubics kept, nothing flattened) (`signatures/typed.rs`, ADR-041 section 6) and, in the tests only, of Inter for the word mark and icon assets (`src-tauri/tests/brand_assets.rs`, with its GPOS pair table reader). googlefonts/fontations, `forbid(unsafe_code)`, active; brings `read-fonts` 0.45 and `font-types` 0.12 (same license). `ttf-parser` was rejected as unmaintained. | v0.7.0 (M4) |
| image (feature `png`) | Rust | 0.25.10 | MIT OR Apache-2.0 | PNG decoder for signature pictures (`signatures/raster.rs`), next to the `jpeg` feature; decodes with `Limits`. The `png` crate is already a dependency. | v0.7.0 (M4) |
| @resvg/resvg-js | npm (dev) | 2.6.2 | MPL-2.0 | Dev-only rasteriser for `scripts/gen-installer-art.mjs` (installer and DMG artwork from `wordmark-secondary.svg`, DESIGN 3.51). Never shipped or bundled; MPL-2.0 file-level copyleft is not triggered by use. | v1.0.0 (M7) |
| axe-core | npm (dev) | 4.11.0 | MPL-2.0 | Dev-only accessibility rule engine for `src/test/a11y.test.tsx` (DESIGN 3.52). Never shipped or bundled; used unmodified. | v1.0.0 (M7) |
| Ms Madi (font) | Asset | Regular | OFL-1.1 | Typed signatures, default (DESIGN 3.60/3.5, ADR-059/108). The Ms Madi Project Authors, no Reserved Font Name. Unmodified `src-tauri/resources/fonts/MsMadi-Regular.ttf` with `OFL-MsMadi.txt`; source https://github.com/google/fonts/tree/main/ofl/msmadi. Compiled in (`include_bytes!`), turned into outlines, never embedded in a PDF. | v1.2.0 (F15 B7) |
| Hurricane (font) | Asset | Regular | OFL-1.1 | Typed signatures (ADR-108). The Hurricane Project Authors, no Reserved Font Name. Unmodified `Hurricane-Regular.ttf` with `OFL-Hurricane.txt`; source https://github.com/google/fonts/tree/main/ofl/hurricane. Same use. | v1.2.0 (F15 B7) |
| Birthstone (font) | Asset | Regular | OFL-1.1 | Typed signatures (ADR-108). The Birthstone Project Authors, no Reserved Font Name. Unmodified `Birthstone-Regular.ttf` with `OFL-Birthstone.txt`; source https://github.com/google/fonts/tree/main/ofl/birthstone. Same use. | v1.2.0 (F15 B7) |
| Inter (font) | Asset (tooling only) | 4.1, `InterVariable.ttf` (variable `wght`/`opsz`), SHA256 `4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf` | OFL-1.1 | Source of the glyph outlines of the word mark and the app icon (`src-tauri/tests/brand_assets.rs`, wght 500; BRAND 7/8, ADR-059/ADR-100 font-only allowance). The Inter Project Authors, https://github.com/rsms/inter (release v4.1). Unmodified `assets/brand/fonts/InterVariable.ttf` with `OFL.txt`; never shipped or embedded, only its outlines (as paths) appear in the SVG/PNG assets. | v1.2.0 |
| sys-locale | Rust | 0.3.2 | MIT OR Apache-2.0 | The OS locale name (`en-US`) for the paper default A4 or Letter (`platform::paper_default`, ADR-049 §3). Windows `GetUserDefaultLocaleName` and macOS `CFLocale` need `unsafe`, which our own code forbids (`unsafe_code = "forbid"`); the `windows` crate's `GetLocaleInfoEx` is `unsafe` too. Only dependency: `libc` (already in the build). | v0.9.0 (M6) |
| same-file | Rust (Windows) | 1.0.6 | Unlicense OR MIT | The identity of an open file (volume serial number and file index) for intake's "is this still the file I opened" check (`documents/intake.rs`, ADR-028); `std` offers it on Unix only and our code forbids `unsafe`. Already in the build through walkdir. | v0.3.0 |
| windows | Rust (Windows) | 0.62.2 | MIT OR Apache-2.0 | Windows.Media.Ocr and its bitmap types through the safe WinRT projections (`ocr/win.rs`, only in the OCR child process; ADR-134). Direct dependency now; the same version Tauri already builds, so no duplicate. | v1.7 (phase 1 spike) |
| pdfium-render | Rust | 0.9.4 | MIT OR Apache-2.0 | Safe bindings to PDFium, bound dynamically (features: `pdfium_7881` only). Writing FFI bindings for PDFium in-house is not sensible. | v0.2.0 |
| png | Rust | 0.18.1 | MIT OR Apache-2.0 | PNG encoding of rendered pages, streamed row by row. Chosen over `image` to avoid its codec tree. | v0.2.0 |
| serde | Rust | 1.0.229 | MIT OR Apache-2.0 | Typed IPC arguments and results (already required by Tauri). | v0.2.0 |
| serde_json | Rust | 1.0.151 | MIT OR Apache-2.0 | Settings file and `update_settings` patch validation (already required by Tauri). Was a dev dependency before the settings store. | v0.2.0 (dev), v0.3.0 |
| objc2-app-kit | Rust (macOS only) | 0.3.2 | Zlib OR Apache-2.0 OR MIT | Transitive only, through Tauri/wry/muda/rfd (not a direct dependency since the light-only redesign removed the "Reduce transparency" read, ADR-100; v0.3.0 declared it for `NSWorkspace.accessibilityDisplayShouldReduceTransparency`). Safe bindings; writing Objective-C FFI in-house is not sensible. | v0.3.0 |
| libc | Rust (Unix only) | 0.2.189 | MIT OR Apache-2.0 | `O_NONBLOCK` and `O_NOCTTY`, to open the settings file and a PDF the user points at without ever waiting on a FIFO (`storage::open`, used by `storage::settings` (SECURITY D7) and `documents::intake` (I3)). Already in the lockfile through Tauri and its dependencies; now declared directly for `cfg(unix)`, no features. The constants differ per Unix, so they are taken from the platform bindings rather than hard-coded. | v0.3.0 |
| tauri-plugin-single-instance | Rust (Windows only) | 2.5.2 | Apache-2.0 OR MIT | Opening another PDF from the file manager starts another process; this hands its command line to the running window and ends the new process (`sources::on_second_instance`). Local only: a named mutex and a window message, no listener, no network; registered first; no command, no permission. Built on Windows only (`cfg(windows)`): macOS passes files to the running app itself (`RunEvent::Opened`). Forwarding a command line between processes takes Win32 calls (`unsafe`, which our own code forbids) and a window-message loop; not sensible in-house. Its Linux-only dependencies (zbus and its async stack) are in `Cargo.lock` but not built for Windows or macOS. | v0.4.0 (M1) |
| react | npm | 19.3.0 | MIT | UI library (ADR-001). | v0.2.0 |
| react-dom | npm | 19.3.0 | MIT | React renderer for the DOM. | v0.2.0 |
| @tauri-apps/api | npm | 2.12.1 | Apache-2.0 OR MIT | Typed `invoke` for the frontend. | v0.2.0 |
| @tauri-apps/cli | npm (dev) | 2.12.1 | Apache-2.0 OR MIT | `tauri dev`, `tauri build`, `tauri icon`. | v0.2.0 |
| typescript | npm (dev) | 7.0.2 | Apache-2.0 | Type checking (`tsc --noEmit`), strict mode. | v0.2.0 |
| vite | npm (dev) | 8.3.2 | MIT | Dev server and bundler (ADR-001). | v0.2.0 |
| @vitejs/plugin-react | npm (dev) | 6.1.1 | MIT | JSX transform and fast refresh for Vite. | v0.2.0 |
| vitest | npm (dev) | 5.0.3 | MIT | Unit tests, shares the Vite config. | v0.2.0 |
| @types/react | npm (dev) | 19.3.0 | MIT | React type definitions. | v0.2.0 |
| @types/react-dom | npm (dev) | 19.3.0 | MIT | React DOM type definitions. | v0.2.0 |
| @types/node | npm (dev) | 26.6.4 | MIT | Types for `vite.config.ts` (`node` globals). | v0.2.0 |
| zustand | npm | 5.0.15 | MIT | Frontend stores (ADR-001, ARCHITECTURE 8); the settings store applies `data-theme` and `data-transparency`. Tiny, no provider needed; a store library is not worth writing in-house. | v0.3.0 |
| tailwindcss | npm (dev) | 4.3.3 | MIT | Utility CSS compiled at build time from the role tokens (DESIGN 1.9). Nothing of it ships at runtime except the generated CSS. | v0.3.0 |
| @tailwindcss/vite | npm (dev) | 4.3.3 | MIT | Tailwind 4 plugin for Vite. | v0.3.0 |
| lucide-react | npm | 1.50.0 | ISC | The icon set of DESIGN 1.8 (Lucide), one React component per icon with tree shaking. Drawing and maintaining the icons in-house is not sensible. | v0.3.0 |
| motion | npm | 14.0.0 | MIT | Springs, exit animations and shared-layout motion for popover, tooltip and tab indicator (DESIGN 1.6). Spring physics and presence animation are not worth writing in-house; CSS cannot animate an unmounting element. | v0.3.0 |
| jsdom | npm (dev) | 30.1.1 | MIT | DOM for component tests in Vitest (`// @vitest-environment jsdom`). A DOM implementation is not writable in-house. | v0.3.0 |
| @testing-library/react | npm (dev) | 16.3.3 | MIT | Renders components in tests and cleans up between them. | v0.3.0 |
| @testing-library/dom | npm (dev) | 10.4.2 | MIT | Queries by role and name; the peer dependency of @testing-library/react and @testing-library/user-event. | v0.3.0 |
| @testing-library/user-event | npm (dev) | 14.6.7 | MIT | Realistic keyboard and pointer input (Tab, arrows, type-ahead) for the keyboard tests of toolbar, tabs, slider, splitter and popover. | v0.3.0 |
| prettier | npm (dev) | 3.9.9 | MIT | Formatter, enforced by `npm run check` (`prettier --check`). A formatter is not worth writing in-house. | v0.2.0 |
| eslint | npm (dev, `tools/lint`) | 10.11.0 | MIT | Linter for the TypeScript/React frontend (flat config). | v0.2.0 |
| @eslint/js | npm (dev, `tools/lint`) | 10.0.1 | MIT | ESLint core recommended rule set. | v0.2.0 |
| typescript-eslint | npm (dev, `tools/lint`) | 8.71.0 | MIT | TypeScript parser and rules for ESLint. Its peer range stops at TypeScript 6.0, so the ESLint workspace carries its own TypeScript 6. | v0.2.0 |
| eslint-plugin-react-hooks | npm (dev, `tools/lint`) | 7.1.1 | MIT | Rules of Hooks and exhaustive-deps checks for React 19. | v0.2.0 |
| typescript (lint only) | npm (dev, `tools/lint`) | 6.0.3 | Apache-2.0 | Classic TypeScript JS API for typescript-eslint, which cannot use the TypeScript 7 compiler at the root. Not used for type checking. | v0.2.0 |

## Build and CI tooling

Run on developer machines and in CI only. Not part of the app and not linked into it.

| Name | Kind | Version | SPDX license | Purpose |
|---|---|---|---|---|
| cargo-deny | cargo tool | 0.20.2 | MIT OR Apache-2.0 | `cargo deny check` in `npm run check`: licenses, advisories, bans, sources (`deny.toml`). |
| cargo-audit | cargo tool | 0.22.2 | Apache-2.0 OR MIT | `cargo audit` in `npm run check`: RustSec advisories for `Cargo.lock`. |
| actions/checkout | GitHub Action | v7.0.1 | MIT | CI: fetch the repository. Pinned by commit SHA. |
| actions/setup-node | GitHub Action | v7.0.0 | MIT | CI: Node from `.nvmrc`, npm cache. Pinned by commit SHA. |
| actions/cache | GitHub Action | v6.1.0 | MIT | CI: cargo registry and `target/` cache. Pinned by commit SHA. |
| actions/upload-artifact | GitHub Action | v7.0.1 | MIT | CI: unsigned debug bundles. Pinned by commit SHA. |
| taiki-e/install-action | GitHub Action | v2.87.22 | Apache-2.0 OR MIT | CI: prebuilt, checksum-verified cargo-deny and cargo-audit. Pinned by commit SHA. |

Dependabot (`.github/dependabot.yml`) bumps these weekly together with the npm and cargo dependencies.

## Bundled binaries

PDFium is downloaded by `scripts/fetch-pdfium.sh` at build time only (never at runtime), checked against the SHA256 pinned in
the script, unpacked to `src-tauri/pdfium/<platform>/` (gitignored) and bundled as a Tauri resource. The script also refuses
an archive whose `args.gn` does not say `pdf_enable_v8 = false` and `pdf_enable_xfa = false` (plain build: no JavaScript, no XFA).

| Name | Source | Version / tag | SPDX license | SHA256 verified by |
|---|---|---|---|---|
| PDFium `win-x64` | github.com/bblanchon/pdfium-binaries, `pdfium-win-x64.tgz` | `chromium/7881` (PDFium 151.0.7881.0) | BSD-3-Clause (PDFium), MIT (binary packaging) | `scripts/fetch-pdfium.sh`: `73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08` |
| PDFium `win-arm64` | same, `pdfium-win-arm64.tgz` | `chromium/7881` | same | `scripts/fetch-pdfium.sh`: `d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84` |
| PDFium `mac-x64` | same, `pdfium-mac-x64.tgz` | `chromium/7881` | same | `scripts/fetch-pdfium.sh`: `6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b` |
| PDFium `mac-arm64` | same, `pdfium-mac-arm64.tgz` | `chromium/7881` | same | `scripts/fetch-pdfium.sh`: `52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40` |

The digests are the release asset digests that GitHub reports for tag `chromium/7881`. Only the `win-x64` build has been
run so far; the other three are pinned but untested.

Third-party code inside the PDFium binary (notices ship with the app, copied from the archive's `licenses/` directory;
accepted in ADR-010 §8):

| Component | SPDX license | Note |
|---|---|---|
| PDFium | BSD-3-Clause | |
| Abseil | Apache-2.0 | |
| Anti-Grain Geometry 2.3 | LicenseRef-AGG-2.3 | Permissive custom notice ("permission to copy, use, modify, sell and distribute"). |
| fast_float | MIT | Dual-licensed upstream; the archive carries the MIT text. |
| FreeType | FTL | Taken under the FreeType License, not the GPL-2.0 alternative (ADR-010 §8). |
| ICU | Unicode-3.0 | |
| Little CMS (lcms) | MIT | |
| libjpeg-turbo | IJG AND BSD-3-Clause AND Zlib | |
| OpenJPEG | BSD-2-Clause | |
| libpng | libpng-2.0 | |
| libtiff | libtiff | BSD-style permissive. |
| LLVM libc | Apache-2.0 WITH LLVM-exception | |
| simdutf | MIT | |
| zlib | Zlib | |

Build tools that the Tauri CLI downloads on Windows to create installers. They run at build time and are not part of the
shipped app or linked into it:

| Name | Version | License | Note |
|---|---|---|---|
| WiX Toolset | 3.14.1 | MS-RL | Produces the `.msi`. Tool only. MS-RL is not on the allowlist because it never becomes a dependency of the app. |
| NSIS | 3.11 | zlib/libpng-style (NSIS license) | Produces the `-setup.exe`; its stub is embedded in the installer. |
| nsis_tauri_utils | 0.5.3 | Apache-2.0 OR MIT | NSIS plugin DLL embedded in the installer (Tauri project). |

The WebView2 runtime (Windows) and WKWebView (macOS) are operating-system components, not bundled.

## Transitive dependencies

Everything below comes in through the direct dependencies above and was read from `cargo metadata --locked` and
`package-lock.json`. No GPL, AGPL or LGPL license applies to any of them:

- Both versions of `r-efi` (5.3.0, 6.0.0) offer `LGPL-2.1-or-later` only as a third alternative next to MIT and Apache-2.0. They are used under MIT.
- Crates offering `Unlicense OR MIT` are used under MIT.
- `gtk`, `webkit2gtk`, `soup3` and related crates appear in the lockfile for the Linux target only (MIT). They are not built for macOS or Windows.
- MPL-2.0 crates (file-level copyleft) are allowed by rule 2 and are used unmodified.

### Added with the tokens work (v0.3.0)

No new Rust crate: `objc2-app-kit` was already in the 433 below. New npm packages from `tailwindcss`, `@tailwindcss/vite` and `zustand`, all
dev-only except `zustand` (read from `package-lock.json`). None is GPL, AGPL or LGPL.

- **MIT**: @tailwindcss/node 4.3.3, @tailwindcss/oxide 4.3.3 (and its optional per-platform binaries `@tailwindcss/oxide-*`, only the host's is installed), enhanced-resolve 5.26.0, jiti 2.7.0, magic-string 0.30.21, tapable 2.3.3, tailwindcss 4.3.3, @tailwindcss/vite 4.3.3, zustand 5.0.15
- **MPL-2.0**: lightningcss 1.32.0 and its optional `lightningcss-*` binaries (a second copy next to 1.33.0, pinned by @tailwindcss/node; unmodified, dev-only)
- **ISC**: graceful-fs 4.2.11
- Not installed on macOS or Windows: `@tailwindcss/oxide-wasm32-wasi` (optional, WebAssembly hosts only) bundles @napi-rs/wasm-runtime, @emnapi/core, @emnapi/runtime, @emnapi/wasi-threads, @tybys/wasm-util (all MIT) and tslib (0BSD).

### Added with the component primitives (v0.3.0)

No new Rust crate. New npm packages from `lucide-react`, `motion`, `jsdom` and the Testing Library packages (read from `package-lock.json`;
`npm audit` reports 0 vulnerabilities). `lucide-react` (ISC) and `motion` with its runtime packages ship in the app; everything else is dev-only.
None is GPL, AGPL or LGPL.

- **Runtime (shipped)**: lucide-react 1.50.0 (ISC); motion 14.0.0, framer-motion 14.0.0, motion-dom 14.0.0, motion-utils 14.0.0 (MIT); tslib 2.8.1 (0BSD, a public-domain-equivalent permissive license).
- **Dev only, MIT**: jsdom 30.1.1, @testing-library/react 16.3.3, @testing-library/dom 10.4.2, @testing-library/user-event 14.6.7, @asamuzakjp/css-color 7.1.3, @asamuzakjp/dom-selector 9.2.3, @babel/runtime 7.29.7, @bramus/specificity 2.4.2, @csstools/css-calc 3.4.3, @csstools/css-color-parser 4.2.6, @csstools/css-parser-algorithms 4.0.2, @csstools/css-tokenizer 4.0.2, @exodus/bytes 1.16.0, @types/aria-query 5.0.4, ansi-regex 5.0.1, ansi-styles 5.2.0, bidi-js 1.1.0, css-tree 3.2.1, data-urls 7.0.0, decimal.js 10.6.0, dequal 2.0.3, dom-accessibility-api 0.5.16, html-encoding-sniffer 7.0.0, is-potential-custom-element-name 1.0.1, lz-string 1.5.0, parse5 8.0.1, pretty-format 27.5.1, react-is 17.0.2, require-from-string 2.0.2, tldts 7.4.16, tldts-core 7.4.16, tr46 6.0.0, undici 8.11.2, w3c-xmlserializer 6.0.0, whatwg-mimetype 5.0.0, whatwg-url 16.0.1 and 17.1.2, xmlchars 2.2.0
- **Dev only, other permissive**: aria-query 5.3.0 and xml-name-validator 5.0.0 (Apache-2.0); entities 8.1.0 and webidl-conversions 8.0.1 (BSD-2-Clause); tough-cookie 6.0.2 (BSD-3-Clause); saxes 6.0.0 (ISC); lru-cache 11.5.3 (BlueOak-1.0.0, a permissive license in the MIT/ISC family); @csstools/color-helpers 6.1.2 and @csstools/css-syntax-patches-for-csstree 1.1.15 (MIT-0); mdn-data 2.27.1 (CC0-1.0, data only).

### Added with the link opener

New Rust crates from `tauri-plugin-opener` (read from `Cargo.lock` and the crates' `Cargo.toml`). None is GPL, AGPL or LGPL.

- **MIT**: open 5.4.4, is-docker 0.2.0, is-wsl 0.4.0
- `tauri-plugin-opener` 2.7.0 is `Apache-2.0 OR MIT` (direct dependency, listed above).

### Rust crates (433)

**MIT OR Apache-2.0** (209): android_system_properties 0.1.6, anyhow 1.0.104, base64 0.21.7, base64 0.22.1, base64 0.23.1, bitflags 2.13.2, block-buffer 0.10.4, bumpalo 3.20.3, camino 1.2.6, cargo-platform 0.1.9, cc 1.5.1, cfg-expr 0.15.8, cfg-if 1.0.5, chrono 0.4.45, cookie 0.18.2, core-foundation 0.10.1, core-foundation-sys 0.8.7, core-graphics 0.25.0, core-graphics-types 0.2.0, cpufeatures 0.2.17, crc32fast 1.5.2, crossbeam-channel 0.5.17, crossbeam-utils 0.8.23, crypto-common 0.1.7, defmt 1.1.1, defmt-macros 1.1.1, defmt-parser 1.0.0, deranged 0.5.8, digest 0.10.7, dirs 7.0.0, dirs-sys 0.5.0, displaydoc 0.2.7, dtoa 1.0.11, dyn-clone 1.0.20, either 1.18.0, embed_plist 1.2.2, erased-serde 0.4.10, fdeflate 0.3.7, field-offset 0.3.6, find-msvc-tools 0.1.14, flate2 1.1.10, form_urlencoded 1.2.2, futures-channel 0.3.34, futures-core 0.3.34, futures-executor 0.3.34, futures-io 0.3.34, futures-macro 0.3.34, futures-sink 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.3.4, getrandom 0.4.3, glob 0.3.4, hashbrown 0.12.3, hashbrown 0.17.1, heck 0.4.1, heck 0.5.0, hex 0.4.3, html5ever 0.39.0, http 1.5.0, httparse 1.10.1, iana-time-zone 0.1.65, iana-time-zone-haiku 0.1.2, idna 1.1.0, ipnet 2.12.2, itertools 0.15.0, itoa 1.0.18, jni-sys 0.3.1, jni-sys 0.4.1, jni-sys-macros 0.4.1, js-sys 0.3.106, jsonptr 0.7.1, keyboard-types 0.8.3, libc 0.2.189, lock_api 0.4.14, log 0.4.34, markup5ever 0.39.0, maybe-owned 0.3.4, mime 0.3.17, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, num-conv 0.2.2, num-traits 0.2.19, once_cell 1.21.4, parking_lot 0.12.5, parking_lot_core 0.9.12, percent-encoding 2.3.2, pkg-config 0.3.34, png 0.17.16, powerfmt 0.2.0, proc-macro-crate 1.3.1, proc-macro-crate 2.0.2, proc-macro-crate 3.5.0, proc-macro-error 1.0.4, proc-macro-error-attr 1.0.4, proc-macro2 1.0.107, quote 1.0.47, ref-cast 1.0.27, ref-cast-impl 1.0.27, regex 1.13.1, regex-automata 0.4.18, regex-syntax 0.8.11, reqwest 0.13.5, rustc_version 0.4.1, rustversion 1.0.23, scopeguard 1.2.0, semver 1.0.28, serde-untagged 0.1.9, serde_core 1.0.229, serde_derive 1.0.229, serde_derive_internals 0.29.1, serde_repr 0.1.21, serde_spanned 0.6.9, serde_spanned 1.1.1, serde_with 3.24.0, serde_with_macros 3.24.0, serialize-to-javascript 0.1.2, serialize-to-javascript-impl 0.1.2, servo_arc 0.4.3, sha2 0.10.9, shlex 2.0.1, siphasher 1.0.4, smallvec 1.16.2, socket2 0.6.5, softbuffer 0.4.8, stable_deref_trait 1.2.1, string_cache 0.9.0, string_cache_codegen 0.6.1, swift-rs 1.0.8, syn 1.0.109, syn 2.0.119, syn 3.0.6, system-deps 6.2.2, tao-macros 0.1.4, tendril 0.5.1, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, time 0.3.55, time-core 0.1.9, time-macros 0.2.32, toml 0.8.2, toml 1.1.6+spec-1.1.0, toml_datetime 0.6.3, toml_datetime 1.1.1+spec-1.1.0, toml_edit 0.19.15, toml_edit 0.20.2, toml_edit 0.25.15+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0, toml_writer 1.1.2+spec-1.1.0, tray-icon 0.25.1, typeid 1.0.3, typenum 1.20.1, unicode-segmentation 1.13.3, url 2.5.8, utf16string 0.2.0, wasm-bindgen 0.2.129, wasm-bindgen-futures 0.4.79, wasm-bindgen-macro 0.2.129, wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129, wasm-streams 0.5.0, web-sys 0.3.106, web-time 1.1.0, web_atoms 0.2.6, windows 0.62.2, windows-collections 0.3.2, windows-core 0.62.2, windows-future 0.3.2, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.2.1, windows-numerics 0.3.1, windows-result 0.4.1, windows-strings 0.5.1, windows-sys 0.45.0, windows-sys 0.59.0, windows-sys 0.60.2, windows-sys 0.61.2, windows-targets 0.42.2, windows-targets 0.52.6, windows-targets 0.53.5, windows-threading 0.2.1, windows-version 0.1.7, windows_aarch64_gnullvm 0.42.2, windows_aarch64_gnullvm 0.52.6, windows_aarch64_gnullvm 0.53.1, windows_aarch64_msvc 0.42.2, windows_aarch64_msvc 0.52.6, windows_aarch64_msvc 0.53.1, windows_i686_gnu 0.42.2, windows_i686_gnu 0.52.6, windows_i686_gnu 0.53.1, windows_i686_gnullvm 0.52.6, windows_i686_gnullvm 0.53.1, windows_i686_msvc 0.42.2, windows_i686_msvc 0.52.6, windows_i686_msvc 0.53.1, windows_x86_64_gnu 0.42.2, windows_x86_64_gnu 0.52.6, windows_x86_64_gnu 0.53.1, windows_x86_64_gnullvm 0.42.2, windows_x86_64_gnullvm 0.52.6, windows_x86_64_gnullvm 0.53.1, windows_x86_64_msvc 0.42.2, windows_x86_64_msvc 0.52.6, windows_x86_64_msvc 0.53.1

**MIT** (101): atk 0.18.2, atk-sys 0.18.2, block2 0.6.2, bytes 1.12.1, cairo-rs 0.18.5, cairo-sys-rs 0.18.2, cargo_metadata 0.19.2, cfb 0.14.0, combine 4.6.8, darling 0.24.1, darling_core 0.24.1, darling_macro 0.24.1, derive_more 2.1.1, derive_more-impl 2.1.1, dlopen2 0.8.2, dlopen2_derive 0.4.3, dom_query 0.28.0, embed-resource 3.0.11, gdk 0.18.2, gdk-pixbuf 0.18.5, gdk-pixbuf-sys 0.18.0, gdk-sys 0.18.2, gdkwayland-sys 0.18.2, gdkx11 0.18.2, gdkx11-sys 0.18.2, generic-array 0.14.7, gio 0.18.4, gio-sys 0.18.1, glib 0.18.5, glib-macros 0.18.5, glib-sys 0.18.1, gobject-sys 0.18.0, gtk 0.18.2, gtk-sys 0.18.2, gtk3-macros 0.18.2, http-body 1.1.0, http-body-util 0.1.5, hyper 1.11.1, hyper-util 0.1.21, ico 0.5.0, infer 0.22.0, javascriptcore-rs 1.1.2, javascriptcore-rs-sys 1.1.1, libredox 0.1.25, memoffset 0.9.1, mio 1.2.3, new_debug_unreachable 1.0.6, objc2 0.6.4, objc2-encode 4.1.0, objc2-foundation 0.3.2, pango 0.18.3, pango-sys 0.18.0, phf 0.13.1, phf_codegen 0.13.1, phf_generator 0.13.1, phf_macros 0.13.1, phf_shared 0.13.1, piston-float 1.0.1, plist 1.10.1, precomputed-hash 0.1.1, quick-xml 0.42.0, redox_syscall 0.5.18, redox_users 0.5.3, rfd 0.16.0, schemars 0.8.22, schemars 0.9.0, schemars 1.2.2, schemars_derive 0.8.22, simd-adler32 0.3.10, slab 0.4.12, soup3 0.5.0, soup3-sys 0.5.0, strsim 0.11.1, synstructure 0.14.0, tauri-winres 0.3.6, tokio 1.53.1, tokio-util 0.7.19, tower 0.5.3, tower-http 0.6.11, tower-layer 0.3.3, tower-service 0.3.3, tracing 0.1.44, tracing-core 0.1.36, try-lock 0.2.5, urlpattern 0.6.0, vecmath 1.0.0, version-compare 0.2.1, vswhom 0.1.0, vswhom-sys 0.1.3, want 0.3.1, webkit2gtk 2.0.2, webkit2gtk-sys 2.0.2, webview2-com 0.39.1, webview2-com-macros 0.8.1, webview2-com-sys 0.39.1, winnow 0.5.40, winnow 1.0.4, winreg 0.55.0, x11 2.21.0, x11-dl 2.21.0, zmij 1.0.23

**Apache-2.0 OR MIT** (29): atomic-waker 1.1.2, autocfg 1.5.1, bit-set 0.8.0, bit-vec 0.8.0, cargo_toml 1.0.1, ctor 1.0.13, equivalent 1.0.2, fastrand 2.5.0, idna_adapter 1.2.2, indexmap 1.9.3, indexmap 2.14.2, libappindicator 0.9.0, libappindicator-sys 0.9.0, muda 0.20.0, pin-project-lite 0.2.17, portable-atomic 1.15.0, portable-atomic-util 0.2.8, rustc-hash 2.1.3, tauri-codegen 2.7.1, tauri-macros 2.7.1, tauri-plugin 2.7.1, tauri-plugin-fs 2.6.0, tauri-runtime 2.12.1, tauri-runtime-wry 2.12.1, tauri-utils 2.10.1, utf8_iter 1.0.4, uuid 1.26.1, window-vibrancy 0.8.1, wry 0.57.0

**Unicode-3.0** (18): icu_collections 2.3.0, icu_locale_core 2.3.0, icu_normalizer 2.3.0, icu_normalizer_data 2.3.0, icu_properties 2.3.0, icu_properties_data 2.3.0, icu_provider 2.3.1, litemap 0.8.3, potential_utf 0.1.6, tinystr 0.8.4, writeable 0.6.4, yoke 0.8.3, yoke-derive 0.8.4, zerofrom 0.1.8, zerofrom-derive 0.1.8, zerotrie 0.2.5, zerovec 0.11.8, zerovec-derive 0.11.6

**Zlib OR Apache-2.0 OR MIT** (17): bytemuck 1.25.2, dispatch2 0.3.1, objc2-app-kit 0.3.2, objc2-cloud-kit 0.3.2, objc2-core-data 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-core-image 0.3.2, objc2-core-location 0.3.2, objc2-core-text 0.3.2, objc2-exception-helper 0.1.1, objc2-io-surface 0.3.2, objc2-quartz-core 0.3.2, objc2-ui-kit 0.3.2, objc2-user-notifications 0.3.2, objc2-web-kit 0.3.2, tinyvec 1.13.3

**MIT/Apache-2.0** (13): bitflags 1.3.2, bs58 0.5.1, console_log 1.1.0, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, ident_case 1.0.1, jni 0.21.1, json-patch 4.2.0, version_check 0.9.5, winapi 0.3.9, winapi-i686-pc-windows-gnu 0.4.0, winapi-x86_64-pc-windows-gnu 0.4.0

**Unlicense OR MIT** (9): aho-corasick 1.1.5, byteorder 1.5.0, jiff 0.2.37, jiff-core 0.1.1, jiff-static 0.2.37, jiff-tzdb 0.1.8, jiff-tzdb-platform 0.1.3, memchr 2.8.3, winapi-util 0.1.11

**MPL-2.0** (5): cssparser 0.37.0, cssparser-macros 0.7.1, dtoa-short 0.3.5, option-ext 0.2.0, selectors 0.38.0

**Apache-2.0/MIT** (4): cesu8 1.1.0, console_error_panic_hook 0.1.7, dbus 0.9.12, libdbus-sys 0.2.7

**Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT** (3): wasi 0.11.1+wasi-snapshot-preview1, wasip2 1.0.4+wasi-0.2.12, wit-bindgen 0.57.1

**BSD-3-Clause** (2): alloc-no-stdlib 3.0.0, alloc-stdlib 0.3.0

**Zlib** (2): foldhash 0.2.0, zlib-rs 0.6.8

**ISC** (2): libloading 0.7.4, libloading 0.9.0

**MIT OR Zlib OR Apache-2.0** (2): miniz_oxide 0.8.9, miniz_oxide 0.9.1

**BSD-3-Clause OR MIT OR Apache-2.0** (2): num_enum 0.7.6, num_enum_derive 0.7.6

**MIT OR Apache-2.0 OR LGPL-2.1-or-later** (2): r-efi 5.3.0, r-efi 6.0.0

**Unlicense/MIT** (2): same-file 1.0.6, walkdir 2.5.0

**Apache-2.0** (2): sync_wrapper 1.0.2, tao 0.37.1

**0BSD OR MIT OR Apache-2.0** (1): adler2 2.0.1

**BSD-3-Clause AND MIT** (1): brotli 9.0.0

**BSD-3-Clause/MIT** (1): brotli-decompressor 6.0.1

**Apache-2.0 AND MIT** (1): dpi 0.1.2

**CC0-1.0 OR MIT-0 OR Apache-2.0** (1): dunce 1.0.5

**Apache-2.0 / MIT** (1): fnv 1.0.7

**MIT OR Apache-2.0 OR Zlib** (1): raw-window-handle 0.6.2

**Apache-2.0 WITH LLVM-exception** (1): target-lexicon 0.12.16

**(MIT OR Apache-2.0) AND Unicode-3.0** (1): unicode-ident 1.0.26

### npm packages (218)

Only `react`, `react-dom`, `scheduler` and `@tauri-apps/api` end up in the shipped frontend bundle. Everything else is
build, lint or test tooling. The per-platform native packages (`@rolldown/binding-*`, `@tauri-apps/cli-*`,
`@typescript/typescript-*`, `lightningcss-*`) are optional and only the one for the host platform is installed.

Two licenses outside the usual list appear, both dev-only and never shipped: `BlueOak-1.0.0` (`minimatch`; a permissive
license in the MIT/ISC family) and `CC-BY-4.0` (`caniuse-lite`, browser-support data pulled in by `@babel/core` through
eslint-plugin-react-hooks; attribution only, no copyleft). Neither is a GPL/AGPL/LGPL license.

**MIT** (140): @babel/code-frame 7.29.7, @babel/compat-data 7.29.7, @babel/core 7.29.7, @babel/generator 7.29.8, @babel/helper-compilation-targets 7.29.7, @babel/helper-globals 7.29.7, @babel/helper-module-imports 7.29.7, @babel/helper-module-transforms 7.29.7, @babel/helper-string-parser 7.29.7, @babel/helper-validator-identifier 7.29.7, @babel/helper-validator-option 7.29.7, @babel/helpers 7.29.7, @babel/parser 7.29.9, @babel/template 7.29.7, @babel/traverse 7.29.8, @babel/types 7.29.8, @cacheable/memory 2.2.0, @cacheable/utils 2.5.0, @eslint-community/eslint-utils 4.10.1, @eslint-community/regexpp 4.12.2, @jridgewell/gen-mapping 0.3.13, @jridgewell/remapping 2.3.5, @jridgewell/resolve-uri 3.1.2, @jridgewell/sourcemap-codec 1.6.0, @jridgewell/trace-mapping 0.3.31, @keyv/bigmap 1.3.1, @keyv/serialize 1.1.1, @oxc-project/types 0.152.0, @rolldown/binding-android-arm-eabi 1.2.12, @rolldown/binding-android-arm64 1.2.12, @rolldown/binding-darwin-arm64 1.2.12, @rolldown/binding-darwin-x64 1.2.12, @rolldown/binding-freebsd-x64 1.2.12, @rolldown/binding-linux-arm-gnueabihf 1.2.12, @rolldown/binding-linux-arm64-gnu 1.2.12, @rolldown/binding-linux-arm64-musl 1.2.12, @rolldown/binding-linux-ppc64-gnu 1.2.12, @rolldown/binding-linux-s390x-gnu 1.2.12, @rolldown/binding-linux-x64-gnu 1.2.12, @rolldown/binding-linux-x64-musl 1.2.12, @rolldown/binding-openharmony-arm64 1.2.12, @rolldown/binding-win32-arm64-msvc 1.2.12, @rolldown/binding-win32-x64-msvc 1.2.12, @rolldown/pluginutils 1.0.1, @types/chai 5.2.3, @types/deep-eql 4.0.2, @types/esrecurse 4.3.1, @types/estree 1.0.9, @types/json-schema 7.0.15, @typescript-eslint/eslint-plugin 8.71.0, @typescript-eslint/parser 8.71.0, @typescript-eslint/project-service 8.71.0, @typescript-eslint/scope-manager 8.71.0, @typescript-eslint/tsconfig-utils 8.71.0, @typescript-eslint/type-utils 8.71.0, @typescript-eslint/types 8.71.0, @typescript-eslint/typescript-estree 8.71.0, @typescript-eslint/utils 8.71.0, @typescript-eslint/visitor-keys 8.71.0, @vitest/mocker 5.0.3, @vitest/spy 5.0.3, acorn 8.18.0, acorn-jsx 5.3.2, ajv 6.15.0, assertion-error 2.0.1, balanced-match 4.0.4, brace-expansion 5.0.12, browserslist 4.29.3, cacheable 2.5.0, chai 6.3.0, convert-source-map 2.0.0, cross-spawn 7.0.6, csstype 3.2.3, debug 4.4.3, deep-is 0.1.4, es-module-lexer 2.3.2, escalade 3.2.0, escape-string-regexp 4.0.0, estree-walker 3.0.3, fast-deep-equal 3.1.3, fast-json-stable-stringify 2.1.0, fast-levenshtein 2.0.6, fdir 6.5.0, file-entry-cache 11.1.5, find-up 5.0.0, flat-cache 6.1.23, fsevents 2.3.3, gensync 1.0.0-beta.2, hashery 1.5.1, hermes-estree 0.25.1, hermes-parser 0.25.1, hookified 1.15.1, hookified 2.2.0, ignore 5.3.2, ignore 7.0.12, imurmurhash 0.1.4, is-extglob 2.1.1, is-glob 4.0.3, js-tokens 4.0.0, jsesc 3.1.0, json-schema-traverse 0.4.1, json-stable-stringify-without-jsonify 1.0.1, json5 2.2.3, keyv 5.6.0, levn 0.4.1, locate-path 6.0.0, magic-string 1.4.2, ms 2.1.3, nanoid 3.3.19, natural-compare 1.4.0, node-releases 2.0.57, obug 2.2.1, optionator 0.9.4, p-limit 3.1.0, p-locate 5.0.0, path-exists 4.0.0, path-key 3.1.1, picomatch 4.0.7, postcss 8.5.28, prelude-ls 1.2.1, punycode 2.3.1, qified 0.10.1, rolldown 1.2.12, scheduler 0.28.0, shebang-command 2.0.0, shebang-regex 3.0.0, std-env 4.3.0, tinybench 6.2.0, tinyexec 1.3.1, tinyglobby 0.2.17, ts-api-utils 2.5.0, type-check 0.4.0, typescript-eslint 8.71.0, undici-types 8.9.0, update-browserslist-db 1.3.3, why-is-node-running 3.2.1, word-wrap 1.2.5, yocto-queue 0.1.0, zod 4.6.5, zod-validation-error 4.0.2

**Apache-2.0** (35): @eslint/config-array 0.23.5, @eslint/config-helpers 0.7.0, @eslint/core 1.2.1, @eslint/object-schema 3.0.5, @eslint/plugin-kit 0.7.3, @humanfs/core 0.19.2, @humanfs/node 0.16.8, @humanfs/types 0.15.0, @humanwhocodes/module-importer 1.0.1, @humanwhocodes/retry 0.4.3, @typescript/typescript-aix-ppc64 7.0.2, @typescript/typescript-darwin-arm64 7.0.2, @typescript/typescript-darwin-x64 7.0.2, @typescript/typescript-freebsd-arm64 7.0.2, @typescript/typescript-freebsd-x64 7.0.2, @typescript/typescript-linux-arm 7.0.2, @typescript/typescript-linux-arm64 7.0.2, @typescript/typescript-linux-loong64 7.0.2, @typescript/typescript-linux-mips64el 7.0.2, @typescript/typescript-linux-ppc64 7.0.2, @typescript/typescript-linux-riscv64 7.0.2, @typescript/typescript-linux-s390x 7.0.2, @typescript/typescript-linux-x64 7.0.2, @typescript/typescript-netbsd-arm64 7.0.2, @typescript/typescript-netbsd-x64 7.0.2, @typescript/typescript-openbsd-arm64 7.0.2, @typescript/typescript-openbsd-x64 7.0.2, @typescript/typescript-sunos-x64 7.0.2, @typescript/typescript-win32-arm64 7.0.2, @typescript/typescript-win32-x64 7.0.2, baseline-browser-mapping 2.11.27, detect-libc 2.1.2, eslint-visitor-keys 3.4.3, eslint-visitor-keys 5.0.1, expect-type 1.4.0

**MPL-2.0** (12): lightningcss 1.33.0, lightningcss-android-arm64 1.33.0, lightningcss-darwin-arm64 1.33.0, lightningcss-darwin-x64 1.33.0, lightningcss-freebsd-x64 1.33.0, lightningcss-linux-arm-gnueabihf 1.33.0, lightningcss-linux-arm64-gnu 1.33.0, lightningcss-linux-arm64-musl 1.33.0, lightningcss-linux-x64-gnu 1.33.0, lightningcss-linux-x64-musl 1.33.0, lightningcss-win32-arm64-msvc 1.33.0, lightningcss-win32-x64-msvc 1.33.0

**Apache-2.0 OR MIT** (11): @tauri-apps/cli-darwin-arm64 2.12.1, @tauri-apps/cli-darwin-x64 2.12.1, @tauri-apps/cli-linux-arm-gnueabihf 2.12.1, @tauri-apps/cli-linux-arm64-gnu 2.12.1, @tauri-apps/cli-linux-arm64-musl 2.12.1, @tauri-apps/cli-linux-riscv64-gnu 2.12.1, @tauri-apps/cli-linux-x64-gnu 2.12.1, @tauri-apps/cli-linux-x64-musl 2.12.1, @tauri-apps/cli-win32-arm64-msvc 2.12.1, @tauri-apps/cli-win32-ia32-msvc 2.12.1, @tauri-apps/cli-win32-x64-msvc 2.12.1

**ISC** (10): electron-to-chromium 1.5.444, flatted 3.4.4, glob-parent 6.0.2, isexe 2.0.0, lru-cache 5.1.1, picocolors 1.1.1, semver 6.3.1, semver 7.8.5, which 2.0.2, yallist 3.1.1

**BSD-2-Clause** (6): eslint-scope 9.1.2, espree 11.2.0, esrecurse 4.3.0, estraverse 5.3.0, esutils 2.0.3, uri-js 4.4.1

**BSD-3-Clause** (2): esquery 1.7.0, source-map-js 1.2.2

**BlueOak-1.0.0** (1): minimatch 10.2.6

**CC-BY-4.0** (1): caniuse-lite 1.0.30001814

## M3 package R3 (new-file jobs, ADR-036 §6)

- `image` 0.25.10 (MIT OR Apache-2.0), `default-features = false, features = ["jpeg"]`: JPEG decode/encode and resize for compress. Pulls `zune-jpeg` 0.5.15 and `zune-core` 0.5.3 (MIT OR Apache-2.0 OR Zlib), `moxcms` 0.8.1 and `pxfm` 0.1.30 (BSD-3-Clause OR Apache-2.0), `byteorder-lite` 0.1.0 (Unlicense OR MIT), `bytemuck` (MIT OR Apache-2.0 OR Zlib).
- `flate2` 1.1 (MIT OR Apache-2.0): direct dependency now (already in the build via `png` and `lopdf`), used for the bounded Flate decode.

## M4 package S4 (signature library, ADR-041 §7)

All checked with `cargo deny` per shipped target (x86_64-pc-windows-msvc, aarch64-apple-darwin, x86_64-apple-darwin): advisories, bans, licenses and sources ok.

- `chacha20poly1305` 0.11.0 (Apache-2.0 OR MIT, RustCrypto, NCC-audited), `default-features = false, features = ["alloc", "zeroize"]`: XChaCha20-Poly1305 for the library file. Pulls `aead` 0.6.1, `poly1305` 0.9.1, `universal-hash` 0.6.1 (MIT OR Apache-2.0), `cmov` 0.5.4 and `ctutils` 0.4.2 (Apache-2.0 OR MIT); `chacha20` 0.10.2 was already in the build.
- `getrandom` 0.3 (MIT OR Apache-2.0): the key, the nonces and the entry ids (already in the build at 0.3.4).
- `keyring-core` 1.0.0 (MIT OR Apache-2.0, open-source-cooperative/keyring-rs): the credential-store API; used per store, never through its global default store.
- `apple-native-keyring-store` 1.0.2 (MIT OR Apache-2.0), macOS only, feature `keychain`: the login keychain. Pulls `security-framework` 3.7.0 and `security-framework-sys` 2.17.0 (MIT OR Apache-2.0).
- `windows-native-keyring-store` 1.1.0 (MIT OR Apache-2.0), Windows only: Credential Manager.

## M5 package D (protection, ADR-047 §4)

- `stringprep` 0.1.5 (MIT OR Apache-2.0): direct dependency now (already in the build through `lopdf`, same version): SASLprep (RFC 4013) of the passwords of AES-256 R6, in `security/secret.rs`.
- lopdf's own crypto dependencies, in the build already with `default-features = false`: `aes`, `cbc`, `ecb` (MIT OR Apache-2.0, RustCrypto), `sha2` (MIT OR Apache-2.0), `md-5` (MIT OR Apache-2.0), `rand` (MIT OR Apache-2.0). `cargo deny` covers them; no new crate.

## M7 package B3 (signed opt-in updater, ADR-053 section 3)

- `tauri-plugin-updater` 2.13.1 (Apache-2.0 OR MIT, tauri-apps/plugins-workspace), `default-features = false`, features `native-tls` and `zip`: the only network module; used from Rust only, never granted to the webview. Update packages, installer launch and bundle swap are not sensible in-house. Windows uses SChannel and macOS Security.framework (`native-tls` 0.2.18, `schannel`, `security-framework`; MIT OR Apache-2.0), not rustls with webpki roots. Pulls `reqwest` 0.13, `hyper`, `hyper-util`, `hyper-tls`, `tokio-native-tls`, `http`, `infer`, `semver`, `tempfile`, `zip` 4, `tar`, `flate2`, `xattr`, `filetime` (all MIT or Apache-2.0 or both; `cargo deny` passes for the three desktop targets). The Linux-only `openssl` family is in `Cargo.lock` but not built for Windows or macOS. `check.sh` allows these crates only under the updater plugin (`cargo tree --prune`) and only `src/update/` may name them.
- `minisign-verify` 0.2.5 (MIT), direct: the second signature check on the bytes we keep (the plugin uses the same crate). No dependencies.
- `base64` 0.22 (MIT OR Apache-2.0), direct: the key and signature files are base64 of the minisign text (already in the build).
- `minisign` 0.10.0 (MIT), dev only: makes a throwaway key pair and signature in the tests; brings `scrypt`, `pbkdf2`, `salsa20`, `hmac`, `cipher`, `subtle`, `ct-codecs`, `rpassword` (MIT or Apache-2.0). Never in the shipped build.

## v1.2 R0.2 (Inter, ADR-059, ADR-100)

- Inter variable 5.3.0 (OFL-1.1, The Inter Project Authors), files `inter-latin-wght-normal.woff2` and `inter-latin-ext-wght-normal.woff2` taken from the npm package `@fontsource-variable/inter` (`npm pack`, not a dependency), in `src/assets/fonts/` with `Inter-OFL.txt`. Font file only, never a crate; `font-src 'self'` covers it.

## v1.3 package C2 (bibliography, ADR-119 item 5)

- `quick-xml` 0.42.0 (MIT, tafia/quick-xml), `default-features = false`: direct dependency now (already in the build at the same version through `plist`, no new crate). Pull parser for the XMP packet of `pdfwrite/bibliography.rs`, read only; a DocType event, depth over 32, over 200 000 events and a packet over 4 MiB abort the read.

## v1.4 package W0 (certificate signatures, ADR-121)

Pure-Rust RustCrypto on the stable line (ADR-121 addendum); named in `src-tauri/src/pdfsig/` only. `cargo deny` passes on the three desktop targets; `ring`, `aws-lc-rs` and `openssl` are not in the desktop graph. `deny.toml` and `.cargo/audit.toml` ignore RUSTSEC-2023-0071 (`rsa`, SECURITY R14).

- `der` 0.7 (Apache-2.0 OR MIT, RustCrypto/formats), features `alloc`, `derive`, `oid`, `std`: ASN.1 DER types for the ESS attribute and typed CMS decoding.
- `spki` 0.7 (Apache-2.0 OR MIT, RustCrypto/formats): SubjectPublicKeyInfo.
- `pkcs8` 0.10 (Apache-2.0 OR MIT, RustCrypto/formats), features `alloc`, `std`, `pkcs5`: private keys inside the identity envelope.
- `x509-cert` 0.2 (Apache-2.0 OR MIT, RustCrypto/formats), feature `builder`: reads certificates and builds the self-signed one.
- `cms` 0.2 (Apache-2.0 OR MIT, RustCrypto/formats), features `builder`, `std`: SignedData types and builder. Pulls `aes`, `cbc`, `cipher`, `sha3`, `keccak`, `signature`.
- `rsa` 0.9 (Apache-2.0 OR MIT, RustCrypto): verifies RSA signatures and signs with imported RSA identities. RUSTSEC-2023-0071 accepted.
- `p256` 0.13, `p384` 0.13 (Apache-2.0 OR MIT, RustCrypto), features `arithmetic`, `ecdsa`, `pkcs8`, `std`: ECDSA. Pull `ecdsa`, `elliptic-curve`, `primeorder`, `sec1`, `rfc6979`, `ff`, `group`, `crypto-bigint` 0.5.
- `sha1` 0.10 (MIT OR Apache-2.0, RustCrypto/hashes): verifies legacy signatures (reported weak). `sha2` 0.10: SHA-256/384/512 for the stable line, next to the 0.11 lopdf uses.
- `jiff` 0.2 (Unlicense OR MIT, BurntSushi), direct now (already in the build): local UTC offset and ISO 8601 times.
- `p12-keystore` 0.2 (MIT OR Apache-2.0, ancwrd1), default `pbes1`: decodes PKCS#12 (PBES2 AES, legacy 3DES/RC2). Pulls `pkcs12` 0.1, `pkcs5` 0.7, `des`, `rc2`, `x509-parser` 0.18, `asn1-rs`, `der-parser`, `oid-registry`, `nom`, `rusticata-macros`, `hex`.

## v1.5.1 package B2 (text editing fonts, ADR-125 addendum 2)

- Arimo, Tinos, Cousine 1.31.0, Regular, Bold, Italic, BoldItalic (12 static TTF; Apache-2.0, Steve Matteson / Ascender Corp., ChromeOS core fonts), in `src-tauri/resources/fonts/` with `LICENSE-Apache-2.0.txt` (the license text from <https://www.apache.org/licenses/LICENSE-2.0.txt>). Font files only, never a crate; `include_bytes!` in `fontprog/fallback.rs`; system fonts are never read. Source: `https://commondatastorage.googleapis.com/chromeos-localmirror/distfiles/croscorefonts-1.31.0.tar.bz2`, SHA-256 of the tarball `672c3487883ec1ef83d9254240d4327b014212abc823d06d15816095867315e1`. SHA-256 of the files:
  - Arimo-Regular `a5cb71302ce735698dfc756943c5bbcfbcc734e117ad452ccb3cb036e07dbd36`, Arimo-Bold `3251104cea71aee741bb5ce63370b1e84b5f4326ecf4259db8889935eb01219b`, Arimo-Italic `eb8498900d06aa4fbde30e1a539d1a04334fe9d380765f1dba01d5670d3cb2b0`, Arimo-BoldItalic `e78a9c639a5e4210d799acae0757ed8e8e6479ba1464682476a9873f71463244`
  - Tinos-Regular `57c72d7e8aacdbbbb47a49e8005760cf1bdc82f6f5500c4c3fc72fdae67c7591`, Tinos-Bold `f28af65ead96dfa99af139e0d4932fde6c602154116c49dd4db9057e4cf1f1f0`, Tinos-Italic `e6a5bc3aa15fdcc9b8111be15f67d04e9834f415898fc1a85ef489a39eb75d03`, Tinos-BoldItalic `c7ddcea49e5b84fb50df15b512a6422a4868bed5724312b3421749188cecdc2b`
  - Cousine-Regular `42184656557104572298db92c12f31ed5055304facd9af229125219f2f3e65ac`, Cousine-Bold `d2a3e25eca9ffc368d8e86fbcf9986bf00bee3f8d7aeb86233fb1a9fde7a9b58`, Cousine-Italic `4338d67dc364f6655ae530294efc7e9a93adcec3a2f9524b219adb199c7c2f47`, Cousine-BoldItalic `d2803caf15358e14144aa95ca9b364669cd6c6a9b4d5447926e7cd4b6be5d5b4`
  - The advance widths of Arimo and Tinos (metric-compatible with Helvetica/Arial and Times) are also the source of the standard-14 tables in `content/std14.rs` (five codes set to the AFM values).
- `subsetter` 0.2.6 (MIT OR Apache-2.0, typst/subsetter), `default-features = false` (no `skrifa`, `write-fonts`, `kurbo`): subsets the substitute faces; only new crate (its one dependency `rustc-hash` was already in the build). Output is re-parsed with `skrifa` before it is written.
- `read-fonts` 0.45 (MIT OR Apache-2.0, googlefonts/fontations), direct now with feature `agl` (the Adobe glyph list, glyph name to Unicode); already in the build through `skrifa` at the same version, no new crate.
