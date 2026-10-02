# Sheer: PDF engines, helpers and licensing

Research date: 2026-10-02. Versions come from crates.io, npm and GitHub APIs fetched that day. Unchecked details are marked (unverified). Hard rule: MIT, Apache-2.0, BSD, ISC, MPL-2.0, Zlib only.

## 1. PDFium via `pdfium-render`

| Item | Finding |
|---|---|
| Crate | `pdfium-render` 0.9.4 (2026-09-06), MIT OR Apache-2.0. One maintainer; roughly monthly releases in 2026. |
| API target | Default `pdfium_latest` = `pdfium_7881`; supports PDFium 5961-7881. |
| Default features | `pdfium_latest`, `image_latest` (image 0.25), `thread_safe`. Also `static`, `paragraph`, `flatten`, `pdfium_enable_xfa`, `pdfium_enable_v8`, `pdfium_use_skia`. |
| Thread safety | PDFium is not thread-safe. `thread_safe` wraps every call in one global mutex: crash-free, no parallel speed-up. Use one dedicated PDFium worker thread (design inference). |
| Binding | Dynamic (`Pdfium::bind_to_library`, late-bound) or `static` feature with `PDFIUM_STATIC_LIB_PATH`. No prebuilt static libs exist; you must run `build.sh -s`. |
| Rendering | `PdfRenderConfig`: size, rotation, matrix, clip, annotations and form data, LCD/grayscale/print quality. Output feeds `image`. |
| Text | `PdfPageText::chars()`: per-char `tight_bounds()`, `loose_bounds()`, origin, angle, font. Also `inside_rect`, segments. |
| Search | `PdfPageText::search()` returns a per-page `PdfPageTextSearch` cursor. |
| Annotations | Create highlight, underline, strikeout, squiggly, ink, square, stamp, text, free-text, link, popup; delete. PDFium itself creates only circle, fileattachment, freetext, highlight, ink, link, popup, square, squiggly, stamp, strikeout, text, underline. No line, arrow, polygon. |
| Forms | AcroForm read/fill via widget annotations; `form_type()` reports XFA. Signatures: read only. |
| Page ops | Create/delete, copy ranges between documents, `append`, rotation, boxes, flatten, tile, watermark. No reorder wrapper (raw `FPDF_MovePages` possible, unverified). |
| Save | `save_to_file/writer/bytes`, `set_version`. Flags hard-coded to 0. |

### Binaries: `bblanchon/pdfium-binaries`

| Item | Finding |
|---|---|
| Latest | Tag `chromium/8076` = PDFium 156.0.8076.0, 2026-09-29. Weekly builds since 2017. |
| Version gap | Crate targets 7881; newest binaries are 8076. Missing symbols fail only when called. Pin and test one tag. |
| Variants | Plain: `pdf_enable_v8=false`, `pdf_enable_xfa=false`. V8: both true (`steps/05-configure.sh`). No Skia builds. |
| Assets | `pdfium-win-x64.tgz` (3.7 MB), `pdfium-win-arm64.tgz` (3.4 MB), `pdfium-mac-arm64.tgz` (3.3 MB), `pdfium-mac-x64.tgz` (3.5 MB), `pdfium-mac-univ.tgz` (6.7 MB). `pdfium-v8-*` variants are 11-26 MB. |
| Checksums | No SHA256SUMS file; README documents none. GitHub shows a per-asset sha256 digest. Releases carry `pdfium-attestation.json` and SLSA provenance, checkable with `gh attestation verify --signer-workflow` (per pdfium-bundled PR). Immutability confirmed for `chromium/7881` only. Pin digests in our build. |
| License | Repo MIT. PDFium `LICENSE` holds BSD-3-Clause and Apache-2.0 texts. Tarballs include an aggregated LICENSE (`08-licenses.sh`): Abseil, FreeType, ICU, lcms, libjpeg-turbo, OpenJPEG, libpng, libtiff, zlib, Highway; V8 builds add V8, fdlibm, Strongtalk. Issue #197: this list can lag new upstream dependencies. |

## 2. Other libraries

| Library | License | Latest | Role | Cannot do |
|---|---|---|---|---|
| PDF.js (`pdfjs-dist`) | Apache-2.0 | 6.3.289, 2026-08-29 | Text layer, annotation editor, experimental XFA (unverified) | Webview only |
| lopdf | MIT | 0.45.0, 2026-09-08 | Object edit, `IncrementalDocument`, `encrypt`/`decrypt` (RC4, AES), content streams | No rendering, no signing |
| pdf-writer | MIT OR Apache-2.0 | 0.15.0, 2026-05-27 | Low-level writing | Cannot read |
| krilla | MIT OR Apache-2.0 | 0.8.2, 2026-06-04 | Creation, PDF/A, PDF/UA | Cannot read or edit |
| printpdf | MIT | 0.12.8, 2026-09-05 | Generation | Weak editing (unverified) |
| pdf_oxide | MIT OR Apache-2.0 | 0.3.78, 2026-09-08 | Extraction, editing; speed claims vendor-reported (unverified) | Unproven |
| rustpdf | MIT | young (2 stars) | Claims PAdES, redaction, AES-256 | Maturity |
| hayro | MIT OR Apache-2.0 | 0.7.1, 2026-06-05 | Pure-Rust renderer | "Experimental"; no text selection, search, forms; no non-embedded CID fonts |
| pdf-lib (JS) | MIT | 1.17.1, 2021-11-06 | JS editing | Unmaintained; fork `@cantoo/pdf-lib` 2.11.1 |
| qpdf | Apache-2.0 (Artistic-2.0 before v7) | 12.4.2, 2026-09-27 | Merge/split, linearize, AES-256; Rust binding `qpdf` 0.3.7 (MIT/Apache-2.0) | No rendering or text; C++ build or sidecar; incremental write undocumented |

## 3. PDFium gaps and how others cope

| Gap | Evidence | How others solve it | Plan |
|---|---|---|---|
| XFA | Needs V8+XFA build; segfault on drop (pdfium-render #130); larger attack surface | Detect and warn; PDF.js | Plain build; show "XFA unsupported" |
| Annotation appearance | PDFium builds an AP only if `/AP /N` is absent, for common markup types. `FPDFAnnot_SetAP` writes into the dictionary, not an XObject; Acrobat may ignore it. Free-text AP and font embedding are weak. | EmbedPDF forks PDFium; others write AP themselves | Write AP XObjects via lopdf for line, arrow, free-text |
| Text editing | Object-level only (`FPDFText_SetText`); no reflow | Cover and overlay new text | Overlay only; state limit |
| True redaction | No redaction API; a box is not removal | EmbedPDF forked engine; lopdf region removal (self-declared not forensic) | Rasterize affected pages; operator removal later |
| Create signatures | PDFium only reads (Collabora APIs) | Incremental update, fixed-width `/ByteRange`, CMS blob (ramanacr/pdf-viewer) | lopdf incremental + RustCrypto `cms` |
| Encryption on save | No API to set or change a password; `FPDF_REMOVE_SECURITY` strips; flag 0 re-encrypts only R2/R3 (unverified) | qpdf or lopdf after save | lopdf `encrypt` |
| Incremental save | `fpdf_save.h` has `FPDF_INCREMENTAL` (1<<0), `FPDF_NO_INCREMENTAL` (1<<1), `FPDF_REMOVE_SECURITY` (1<<2); the crate passes 0. Full rewrite broke 33 of 33 signed files (MegaPDF #476). | Custom `PdfIncrementalWriter`; lopdf `IncrementalDocument` (encrypted incremental since 0.44.0, per search result) | Edits on signed files go through lopdf incremental; warn before rewrite |

Signing crates: `pdf_signer` 0.3.2 is GPL-3.0-or-later (excluded). `pdf_signing` 0.3.0 is MIT OR Apache-2.0 but last updated 2024-11. RustCrypto `cms` is Apache-2.0 OR MIT, 0.3.0-pre.2.

## 4. OCR

| Option | License | Version | Notes |
|---|---|---|---|
| Tesseract | Apache-2.0 | 5.5.3, 2026-07-24 | Leptonica is BSD-2-Clause. `tessdata_fast` repo is Apache-2.0. Native build needed (cmake); bundle language data. |
| `tesseract-rs` | MIT | 0.4.0, 2026-07-31 | Optional built-in compile. `leptess` 0.14.0 is stale (2023-02). |
| `ocrs` | MIT OR Apache-2.0 | 0.13.1, 2026-09-13 | Pure Rust (rten); Latin only, "early preview". Model weights have no stated license; training data includes HierText (CC-BY-SA 4.0). Legal check needed. |
| `oar-ocr` | Apache-2.0 | 0.9.2, 2026-08-18 | ONNX via `ort` 2.0.0-rc.13 (MIT OR Apache-2.0). Model licenses unchecked. |
| Apple Vision | OS API | macOS 10.15+ | `VNRecognizeTextRequest`, on-device. `objc2-vision` 0.3.2 (Zlib OR Apache-2.0 OR MIT). |
| Windows.Media.Ocr | OS API | Windows 10+ | Needs installed OCR language packs; lines then words with positions; `MaxImageDimension` limit. `windows` 0.62.2 (MIT OR Apache-2.0). |

## 5. Helpers

| Need | Crate | License | Version |
|---|---|---|---|
| Image codec | `image` | MIT OR Apache-2.0 | 0.25.10 (matches `image_025`) |
| Resampling | `fast_image_resize` | MIT OR Apache-2.0 | 6.1.0 |
| Deflate | `flate2` | MIT OR Apache-2.0 | 1.1.10 |
| Secrets | `keyring` | MIT OR Apache-2.0 | 4.2.0 |
| Updater | `tauri-plugin-updater` | Apache-2.0 OR MIT | 2.13.1 (3.0.0-alpha.2 pre) |
| Signature check | `minisign-verify` | MIT | 0.3.0 |

Updater signing is mandatory. Run `tauri signer generate`, set `TAURI_SIGNING_PRIVATE_KEY` at build, put the public key in `plugins.updater.pubkey`. Builds emit `.sig` files whose content goes inline in the update JSON. It is separate from Apple notarization and Windows Authenticode. A lost key blocks future updates.

## 6. License watch-list

- FreeType in PDFium is FTL / GPL-2.0 dual: take FTL. FTL, ICU, libpng, libtiff, fdlibm, Strongtalk are permissive but not on your named list; decide.
- `pdf_signer` is GPL-3.0: excluded.
- `ocrs` weights: unknown license.

## 7. Recommendation

| Need | Library | License |
|---|---|---|
| Render, text boxes, search, forms | PDFium plain build (pinned tag) via `pdfium-render` | Apache-2.0 / BSD-3-Clause; MIT OR Apache-2.0 |
| Structural edits, incremental, AP streams | `lopdf` | MIT |
| New pages, exports | `pdf-writer` or `krilla` | MIT OR Apache-2.0 |
| Encryption on save | `lopdf`; optional qpdf | MIT; Apache-2.0 |
| Signatures | lopdf incremental + `cms` | MIT; Apache-2.0 OR MIT |
| Redaction | Rasterize via PDFium + `image` | MIT OR Apache-2.0 |
| OCR | Apple Vision, Windows.Media.Ocr; Tesseract optional | OS; Apache-2.0 |
| Fallback viewer, XFA | PDF.js | Apache-2.0 |
| Images, deflate | `image`, `fast_image_resize`, `flate2` | MIT OR Apache-2.0 |
| Secrets, updates | `keyring`, `tauri-plugin-updater`, `minisign-verify` | MIT OR Apache-2.0; Apache-2.0 OR MIT; MIT |

## Sources

- https://crates.io/api/v1/crates/pdfium-render
- https://raw.githubusercontent.com/ajrcarey/pdfium-render/master/Cargo.toml
- https://raw.githubusercontent.com/ajrcarey/pdfium-render/master/src/pdf/document.rs
- https://docs.rs/pdfium-render/latest/pdfium_render/prelude/struct.PdfPageText.html
- https://api.github.com/repos/bblanchon/pdfium-binaries/releases/latest
- https://raw.githubusercontent.com/bblanchon/pdfium-binaries/master/steps/05-configure.sh
- https://raw.githubusercontent.com/bblanchon/pdfium-binaries/master/steps/08-licenses.sh
- https://github.com/ceejbot/pdfium-bundled/pull/1
- https://github.com/TheHalfMoon/Signthos/pull/102
- https://raw.githubusercontent.com/chromium/pdfium/main/LICENSE
- https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_save.h
- https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_annot.h
- https://github.com/SlyWombat/MegaPDF/issues/476
- https://github.com/ramanacr/pdf-viewer/pull/6
- https://speakerdeck.com/vmiklos/handling-pdf-digital-signatures-with-pdfium
- https://raw.githubusercontent.com/embedpdf/embed-pdf-viewer/main/README.md
- https://groups.google.com/g/pdfium-bugs/c/Rm5Kp7yU3rc
- https://docs.rs/lopdf/latest/lopdf/struct.Document.html
- https://crates.io/api/v1/crates/pdf_signer
- https://raw.githubusercontent.com/LaurenzV/hayro/main/README.md
- https://api.github.com/repos/qpdf/qpdf/releases/latest
- https://registry.npmjs.org/pdfjs-dist/latest
- https://github.com/robertknight/ocrs-models
- https://api.github.com/repos/tesseract-ocr/tesseract/releases/latest
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine
- https://v2.tauri.app/plugin/updater/
- https://crates.io/api/v1/crates/keyring
