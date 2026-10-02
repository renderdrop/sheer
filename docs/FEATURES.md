# Feature catalog

Synthesis of `docs/research/` (Phase 1, 2026-10-02). Scope decisions: ADR-010 and ADR-011 in `docs/DECISIONS.md`.
MoSCoW applies to **v1.0**. Complexity is relative effort for Sheer. "Engine" names what provides the capability:
`PDFium` (plain build via `pdfium-render`), `lopdf` (MIT, structural writes), `own` (our code), `OS` (platform API), `✗` (no permissive option).

Ranking basis: top tasks across Acrobat and online tools are convert (images ↔ PDF), compress, merge, fill & sign,
page operations, annotate, protect. Signing is the most-used interactive task (Smallpdf: 19 %).

## Shell and design system (Phase 3)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Glass app shell (toolbar, left panel, canvas, inspector, status bar) | Calm, modern, predictable layout | Must | M | P3 | own |
| Light/dark, reduced motion/transparency fallbacks | Comfort and accessibility | Must | S | P3 | own + OS flag |
| Empty state with drop zone + recents | Instant start, no learning | Must | S | P3/M1 | own |
| Command registry, shortcuts, native menu bar | Fast keyboard work, platform-native feel | Must | M | P3 | own |
| i18n en/de | Usable in both target languages | Must | S | P3/M7 | own |

## Viewing and navigation (M1)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Open via dialog, drag and drop, file association | Open documents the usual ways | Must | S | M1 | own |
| Fast rendering with cache + virtualization | Smooth on 500+ page files | Must | L | M1 | PDFium |
| Zoom, fit width/page, pinch, Ctrl/Cmd+scroll | Read comfortably | Must | S | M1 | own |
| Scroll modes (continuous, single, two-page) | Fit reading style | Should | S | M1 | own |
| Thumbnails panel | Overview, quick jumps | Must | M | M1 | PDFium |
| Outline (bookmarks) panel | Navigate long documents | Must | S | M1 | PDFium |
| Full-text search with hit highlight | Find anything | Must | M | M1 | PDFium |
| Text selection and copy | Reuse content | Must | M | M1 | PDFium (char boxes) |
| View rotation, go to page | Basic navigation | Must | S | M1 | own |
| Password-protected PDFs (session-only password) | Open protected files safely | Must | S | M1 | PDFium |
| Multiple documents in tabs | Work across files | Should | M | M1 | own |
| Recent files | Resume work | Must | S | M1 | own |
| Safe links (confirm dialog, http/https/mailto only) | No surprise navigation | Must | S | M1 | PDFium + own |
| XFA detect-and-warn | Honest about unsupported forms | Must | S | M1 | PDFium |
| Read mode / full screen | Distraction-free reading | Could | S | M7 | own |

## Comment and markup (M2)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Highlight, underline, strikethrough | Mark text | Must | M | M2 | PDFium + lopdf AP |
| Sticky notes, free text | Leave comments | Must | M | M2 | PDFium + lopdf AP |
| Freehand ink (smoothing, pressure) | Sketch and sign-off marks | Must | M | M2 | PDFium |
| Shapes: rectangle, ellipse, line, arrow | Point at things | Must | M | M2 | PDFium (rect/ellipse), lopdf (line/arrow) |
| Palette + stroke presets, properties inspector | Consistent, quick styling | Must | S | M2 | own |
| Undo/redo command stack | Fearless editing | Must | M | M2 | own |
| Comments panel: threads, filter, sort, jump | Review workflow | Should | M | M2 | own (`/IRT`) |
| Correct appearance streams, incremental save | Annotations look right in every viewer | Must | L | M2 | lopdf |
| Import/export comments (XFDF) | Merge offline reviews | Could | M | later | lopdf |

## Organize pages (M3)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Page grid with drag reorder (+ keyboard move) | Rearrange visually | Must | M | M3 | PDFium/lopdf |
| Rotate, delete pages | Fix scans and order | Must | S | M3 | PDFium |
| Insert blank page / pages from file | Assemble documents | Must | S | M3 | PDFium |
| Extract pages to new file | Share parts | Must | S | M3 | PDFium |
| Merge files (multi-drop suggests merge) | Top-3 task, one step | Must | S | M3 | PDFium |
| Split (every N pages, ranges) | Break up files | Must | S | M3 | PDFium |
| Compress with 3 named presets + estimated size | Top-2 task, fit email limits | Must | M | M3 | PDFium + image + lopdf |

## Forms and signature (M4)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Fill AcroForms (text, check, radio, choice) | Complete forms | Must | M | M4 | PDFium |
| Save filled forms, flatten | Send finished forms | Must | M | M4 | PDFium |
| Signature: draw, type, image | Top interactive task | Must | M | M4 | own |
| Place, move, scale signature; initials, date | Sign in three clicks | Must | M | M4 | own + PDFium stamp |
| Fill & Sign on flat forms (text, check, cross, dot) | Fill non-interactive forms | Must | S | M4 | own |
| Stamps (Approved, Draft, …) | Workflow marks | Should | S | M4 | PDFium stamp |
| Signature library, encrypted, key in OS keychain | Create once, reuse safely | Must | M | M4 | own + keyring |
| Form authoring ("prepare a form") | Create fillable forms | Won't (v1) | L | later | lopdf |
| Self-signed digital signature | Tamper evidence | Could | L | later (v1.1) | lopdf + cms |

## Edit and protect (M5)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Add text box, add image | Fill gaps, add logos | Must | M | M5 | PDFium page objects |
| Edit existing text (single line/paragraph, same font) | Fix typos | Should | L | M5 | PDFium text objects |
| Replace image | Swap pictures | Should | M | M5 | PDFium |
| Crop pages | Trim margins | Must | S | M5 | PDFium boxes |
| True redaction (affected pages flattened) | Remove secrets for real | Must | L | M5 | PDFium raster + lopdf |
| Password and permissions (AES-256), remove password | Protect files | Must | M | M5 | lopdf |
| Metadata view/edit/remove | Privacy, tidy files | Must | S | M5 | lopdf |
| Header/footer, page numbers, watermark | Common stamping tasks | Should | M | M5 | PDFium |

## Convert and output (M6)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| PDF → PNG/JPG (ranges, DPI) | Top convert task | Must | S | M6 | PDFium + image |
| Images → PDF | Top convert task (jpg to pdf) | Must | S | M6 | pdf-writer/PDFium |
| Print (native dialog) | Paper output | Must | M | M6 | OS |
| Export with/without annotations, strip metadata | Clean sharing | Must | S | M6 | PDFium flatten + lopdf |
| Reveal in Finder/Explorer | Hand off files | Should | S | M6 | OS (opener) |
| OCR via OS APIs (invisible text layer) | Searchable scans | Should | L | M6 | OS (Vision / Windows.Media.Ocr) |
| PDF ↔ Word/Excel/PowerPoint | Editable Office output | Won't (v1) | L | — | ✗ |

## Ship (M7)

| Feature | User benefit | MoSCoW | Cx | Milestone | Engine |
|---|---|---|---|---|---|
| Performance budget (500 pages < 1 s open, 60 fps) | Feels instant | Must | M | M7 | own |
| Accessibility pass (WCAG 2.2 AA analog) | Usable by everyone | Must | M | M7 | own |
| Onboarding (3 skippable screens) + per-tool tips | Understand without manual | Must | S | M7 | own |
| Engine in own process | A bad PDF cannot crash the app | Must | L | M7 | own |
| Crash-safe autosave | Never lose work | Must | M | M7 | own |
| Installers (DMG, MSI/NSIS) | Easy install | Must | M | M7 | Tauri bundler |
| Signed opt-in updater | Safe updates | Must | M | M7 | tauri-plugin-updater |

## Later (post-1.0, not scheduled)

Self-signed digital signatures and validation panel · form authoring · comment import/export (XFDF) · compare files ·
read aloud (OS voices) · multi-file search · operator-level redaction (keeps remaining text selectable) · PDF/A export ·
accessibility tagging · Bates numbering · Office conversion (only if a permissive offline engine appears).
