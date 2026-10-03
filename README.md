<p align="center">
  <img src="assets/brand/logo.svg" width="96" height="96" alt="Sheer logo">
</p>

<h1 align="center">Sheer</h1>

<p align="center"><em>Sheer clarity for your documents.</em></p>

Sheer is a simple, fast and beautiful desktop PDF app for **macOS and Windows**.
It is open source and runs **entirely on your device**: no account, no login, no cloud, no telemetry.

> Status: early development. See [ROADMAP.md](ROADMAP.md) for progress.

## Planned features

View, search, annotate and highlight, fill and sign forms, organize pages (reorder, rotate, merge, split),
edit text and images, redact, protect, and convert, all offline.

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
