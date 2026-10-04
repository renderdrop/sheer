<p align="center">
  <img src="assets/brand/logo.svg" width="96" height="96" alt="Sheer logo">
</p>

<h1 align="center">Sheer</h1>

<p align="center"><em>Sheer clarity for your documents.</em></p>

Sheer is a simple, fast and beautiful desktop PDF app for **macOS and Windows**.
It is open source and runs **entirely on your device**: no account, no login, no cloud, no telemetry.

> [!WARNING]
> **Status: 1.0, unsigned installers.** All planned features are in. The installers are not code-signed or notarized yet, so
> Windows SmartScreen and macOS Gatekeeper warn on first start ([docs/BLOCKERS.md](docs/BLOCKERS.md), B-002); the opt-in updater
> needs the release key (B-005). The macOS build has not been tried on a Mac by a person yet (B-001). Keep a copy of important PDFs.

## Features by milestone

| Milestone | Version | State | What it brings |
|---|---|---|---|
| M1 Viewer | 0.4.0 | done | Tabs, zoom and fit, scroll modes, thumbnails, outline, full-text search, text selection and copy, rotation, password-protected PDFs, recent files, welcome tour |
| M2 Comment and markup | 0.5.0 | done | Highlight, underline, strikethrough, sticky notes, free text, freehand ink, shapes, comments panel with threads, undo/redo, save with a backup of the original |
| M3 Organize pages | 0.6.0 | done | Page grid with drag and keyboard reorder, rotate, delete, insert, extract, merge, split, compress |
| M4 Forms and signature | 0.7.0 | done | Fill AcroForms, flatten, signatures (draw, type, image) with initials and date, Fill & Sign for flat forms, signature library encrypted at rest |
| M5 Edit and protect | 0.8.0 | done | Text boxes and images, crop, true redaction, password protection (AES-256), metadata |
| M6 Convert and output | 0.9.0 | done | PDF to PNG/JPG, images to PDF, print, export with or without annotations |
| M7 Polish and ship | 1.0.0 | done | Performance, accessibility, crash-safe autosave, installers (unsigned, B-002), opt-in signed updater |

Everything runs offline. Digital (certificate) signatures are not part of 1.0; signatures are visual.

## Tech stack

Tauri 2 (Rust) · React 19 + TypeScript + Vite · Tailwind 4 · PDFium (via `pdfium-render`).

## Development

Requirements: Node (see `.nvmrc`), Rust (see `rust-toolchain.toml`), and the platform prerequisites for Tauri 2
(macOS: Xcode Command Line Tools; Windows: Visual Studio C++ Build Tools and WebView2).

```bash
npm install
npm run tauri dev     # run the app
npm run check         # full quality gate (types, lint, tests, clippy, cargo-deny, audit)
```

## Privacy

Sheer never opens a network connection on its own. The only exception is the optional, opt-in update check.

## License

The source code is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
The name "Sheer" and the Sheer logo are trademarks and are **not** covered by that license; see [TRADEMARK.md](TRADEMARK.md).
Contributions require a [DCO](https://developercertificate.org/) sign-off (`git commit -s`).

Security issues: please follow [SECURITY.md](SECURITY.md).

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`: it builds an unsigned Windows installer (NSIS `.exe`) and a macOS DMG
(arm64, the runner architecture) and attaches them, plus `SHA256SUMS.txt`, to a GitHub Release whose notes are that version's
`CHANGELOG.md` section. Versions before 1.0 are marked pre-release. To build an existing tag later (the workflow never creates or
moves tags): `gh workflow run release.yml -f tag=v0.4.0`. See ADR-031 in `docs/DECISIONS.md`.
The builds are unsigned until a human sets up certificates: see the [signing and notarization guide](docs/BLOCKERS.md#signing-and-notarization-guide-b-001-b-002-b-005). What is and is not protected: [docs/SECURITY.md](docs/SECURITY.md) (checklist and residual risks).
