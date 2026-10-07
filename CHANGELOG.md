# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.0] - 2026-10-07

v1.8 "Context help" (ADR-138, DESIGN §3.13). Unsigned installers (BLOCKERS B-002).

### Added
- Short tips with a 3-second clip at four moments: the first highlight, the first document with form fields, the first signature
  and the first switch into Pages mode. Each tip shows once, never more than once per situation in a session, never over a field
  or the thing you are working on. The clips are part of the app (recorded from Sheer itself), nothing is loaded from outside.
- Settings → Tour & tips: a switch turns tips off entirely; "Show tips again" brings back the ones you have seen.
- With reduced motion the tip shows a still picture instead of the clip; a Replay button plays it again.

### Changed
- The signature and Pages tips have new, shorter texts.
- Tips stay below the banner row and do not cover page cards in Pages mode.

## [1.7.0] - 2026-10-07

v1.7 "Scan & OCR" complete on Windows and macOS (ADR-134, ADR-137, DESIGN §3.12). Unsigned installers (BLOCKERS B-002).

### Added
- macOS: Recognize text uses Apple's Vision text recognition through a small helper inside the app (German and English built in,
  nothing leaves the computer). Same dialog, banner and progress as on Windows. Tested by automated checks on macOS; a hands-on
  check on a Mac is still pending.

### Changed
- The page choice in the Recognize text dialog is a labelled group with round marks, so the selected option is visible without
  relying on colour.
- Progress runs as a full-width bar with "done / total" next to it; screen readers hear the start and the result, not every page.
- If a document becomes signed or read-only while recognition runs, Sheer keeps the finished pages and says why it stopped.
- "Open language settings" (Windows) starts Explorer from the Windows folder only.

### Fixed
- Search results say "1 result on 1 page" instead of "1 results on 1 pages".
- Hardened scan detection against malformed or oversized form objects in hostile PDFs.

## [1.7.0-beta.1] - 2026-10-07

v1.7 part 1 "Scan & OCR" for Windows (ADR-134, ADR-135, DESIGN §3.12). Pre-release; unsigned installers (BLOCKERS B-002).

### Added
- Recognize text (Werkzeuge → Text erkennen…): scanned and photographed pages get an invisible text layer, so they can be searched,
  copied, highlighted and used by smart links. The page looks exactly as before. Uses the text recognition built into Windows;
  nothing leaves the computer.
- A banner offers recognition when the open document has image-only pages; a dialog chooses the pages (scanned pages, all, current
  or selected), shows the language (it follows the app language) and can redo pages recognized before.
- Progress in the banner with Stop; finished pages are kept when you stop. One Undo step removes a whole run.
- If the needed recognition language is not installed, Sheer says so, uses the other installed language and offers to open the
  Windows language settings. Sheer never downloads language packs.
- Saving adds the text layer as an incremental update; redaction removes recognized words under the box as well.
- macOS: not yet (the Apple Vision helper follows in a later release).
- Smart links: a citation range such as "[3–5]" now reaches every number in it; clicking it opens a small chooser with one row
  per entry (ADR-133).

## [1.6.0] - 2026-10-07

v1.6 "Smart links" (ADR-131, ADR-132, DESIGN §3.11). Unsigned installers (BLOCKERS B-002).

### Added
- Smart links: footnote numbers, table-of-contents lines, references such as "siehe S. 12", "Abb. 3", "Tabelle 2", "Kapitel 4",
  "§ 5" and literature references such as "(Müller 2019)" or "[12]" become clickable. They are guessed by the app, shown as a quiet
  dashed underline, marked "Erkannt" in their preview, never written into your PDF, and only drawn when exactly one target fits.
- Back and forward: every jump (smart link, outline, page field) can be undone with the Back button in the top bar, Alt+← / Alt+→
  (macOS ⌘[ / ⌘]) or the mouse side buttons; the exact view (page, position, zoom) comes back.
- Smart links can be switched off for one document (Lesen → Smarte Links, Ansicht menu) or everywhere (Settings).
- Real links in PDFs show a pointer, a hover outline and keyboard focus; each page's links are one Tab stop with arrow keys.

### Changed
- Edit text: Umbrechen is on by default for multi-line paragraphs. Without it the line stops at the paragraph edge and the
  overflow caption shows how far the text runs past it. The focus ring of right-aligned and centred lines grows with the text.
- Edit text: if a paragraph cannot be re-broken, the edit falls back to the single line and says so.

### Fixed
- Edit text: lines that mix two fonts are refused when clicked instead of opening an edit that cannot be applied.
- Edit text: a re-broken line no longer comes out tighter than its natural word spacing.
- Edit text: previews no longer re-read the whole document on every keystroke.

## [1.5.1] - 2026-10-06

Patch v1.5.1 "Politur v1.5 (Rest)" (ADR-130). Unsigned installers (BLOCKERS B-002).

### Changed
- A changed line of a justified paragraph is stretched back to the full paragraph width: the extra space is spread evenly over its
  word gaps. With Umbrechen on, every re-broken line except the paragraph's last is justified too.
- The substitute-font notice quotes the characters it lists ("-", "M" and "t") and sits outside the edited paragraph.
- The edit box grows from the line's anchor: right-aligned lines grow to the left, centred lines both ways; with Umbrechen on it stops
  at the paragraph's right edge. The mini bar no longer covers the line above.
- Rewritten page content is stored compressed; previews are capped per document so one document cannot starve another.

### Fixed
- A justified paragraph is no longer split in two at a strongly stretched line, so it can be edited and re-broken as one paragraph.
- The substitute-font notice disappears after Undo/Redo, when you switch documents and when you leave Edit text.
- Lines with typographic characters such as "…" or "–" in simple fonts (for example in the welcome document) can be edited again.

## [1.5.0] - 2026-10-06

v1.5 "Edit text" (ADR-125, ADR-128, ADR-129). Unsigned installers (BLOCKERS B-002).

### Added
- While you type, the line is drawn in the document's real font (rendered by the app 60 ms after the last key, 100 ms when busy).
- Umbrechen (wrap in paragraph): when an edited line gets longer or shorter, its words re-flow into the following lines of the same
  paragraph; at most one line is added and only when there is room; text never moves to another column or page.

### Changed
- Centred and right-aligned lines keep their alignment when you change them (headings stay centred, address blocks stay right-aligned).
- The edit box grows with the text; the part past the free width sits on a hatch with a clear marker; characters set in the substitute
  font are dotted while editing; the mini bar covers less of the page.
- Recovery banner: "Show all" sits on the summary line.

### Fixed
- The notice naming the substitute font now also appears after Apply.
- A draft the app cannot render no longer leaves an outdated preview on screen.

## [1.5.0-beta.1] - 2026-10-06

Pre-release of v1.5 "Edit text" (ADR-125, ADR-128): line-wise editing of existing text, usable but not final (Politur v1.5 in ROADMAP.md). Unsigned installers (BLOCKERS B-002).

### Added
- Edit text (Edit mode, first tool): click a line of a PDF's own text and change it in place, in the document's font. Enter applies,
  Esc cancels, Tab goes to the next line; each applied line is one Undo step. When the file's font lacks a character or is not
  embedded, the changed words use a bundled substitute (Arimo, Tinos or Cousine). Text that cannot be edited
  (scans, drawn fonts, slanted text, signed or locked files) explains why on hover.

### Changed
- Recovery: unsaved changes older than 30 days are discarded automatically, and from three entries the recovery banner shows a
  summary with "Show all".

### Known issues (beta)
- The notice that names the substitute font does not appear after Apply yet; while typing, the box shows an approximation of the
  font, and a centred line keeps its start instead of staying centred.

### Fixed
- Split tool buttons (Strikeout, Highlight, Rotate, Signature, mini-bar split toggles): the hover and pressed background stays inside the
  rounded outline, the chevron shares the outline and has its own divider, and nothing changes size on hover. The surface gate checks it.

## [1.4.2] - 2026-10-05

Patch "F17 — UI quality after the owner test" (docs/FEEDBACK.md F17, ADR-124, DESIGN §3.9).

### Added
- "Straighten shapes automatically" (on by default): on release a stroke that matches a circle, ellipse, rectangle, line or arrow
  morphs into that shape in 150 ms; Ctrl+Z brings the raw stroke back. Switch in the stroke mini bar.
- The sign sheet remembers the last lock choice and always shows the lock; an approval signature shows the document's lock read-only.

### Changed
- One positioning engine for tooltips, tips, coach marks, popovers and the mini bar: notices never cover inputs or buttons, only one
  notice is visible at a time, a popover that does not fit becomes a dialog.
- Popovers and dialogs size to their content and fit 960 × 640 without inner scrolling (properties, export images, certificate
  signing, menus, crop, redact, about, settings); only lists scroll.
- Stroke width is a fixed segmented control (0,5 · 1 · 2 · 4 · 8 pt); the custom colour popover has the palette on top and a
  full-width hex field with the confirm check inside it.
- Crop popover: four margin fields in one row, page choice as a segmented control.
- The active tool is Solar-filled in every mode, including Lesen; tool labels never end in "…" or get cut — narrow windows show
  icons with tooltips.
- Thumbnails render at 3× and are box-downscaled.

### Fixed
- Deleting a highlight no longer leaves stale card heights or hover state in the comments panel.

### Internal
- New DoD gate `scripts/ui/surface-gate.mjs`: every popover, dialog, the mini bar and each coach step checked at 960 × 640 and
  1280 × 800, en and de, for overflow, cut-off controls, inner scroll and overlap.
- glib Dependabot alert dismissed as not used (Linux-only GTK chain).

## [1.4.1] - 2026-10-05

Patch "Politur v1.2–v1.4 + CI runtime" (ADR-123).

### Added
- Signing a document that has no signature yet offers a choice: "No changes" (default) or "Fill in forms and allow further signatures".
- Page labels from the PDF (i, ii, 1, 2 …) in the thumbnails and the page field; the page field accepts a label.
- The signature dialog says which version of how many ("version n of N") a signature covers.
- The seal placeholder has eight resize handles; Alt(+Shift)+arrow keys resize it.
- More than two notices at once show "n more notices" instead of hiding them.

### Changed
- Save dialogs for signed copies, Save As, editable copies and exports open in the document's folder.
- Signed copies are named "{name} – signiert" / "{name} – signed".
- Certificate menu with a check for the active certificate and its email; fingerprints in blocks of four; Export in the certificate details.
- Comment and citation cards keep one action row; the mini bar shows the five citation colours only; exported citation lists carry the UI language.
- Comment group headers use page labels; the reference popover follows the panel width; the margin column stays inside the window at high zoom.
- Redaction band buttons and the print dialog follow the colour rules (white sheet, Solar selection); tooltips close on scroll.
- Tab titles keep at least eight characters with an ellipsis, and a newly opened tab scrolls fully into view; no horizontal scrollbar when the page fits.
- The signature details name the lock of a form-fill certification ("Allows only filling in forms and further signatures"); fingerprints use a monospace font.

### Fixed
- A second save started right after the first one could be refused ("an earlier save is still being built").
- Recent-file previews are written right after opening, through one background worker.

### Internal
- CI: platform-independent checks in one Linux job, Rust on Windows/macOS with a dependency-only cache and slimmer debug info; each job now finishes in under 15 minutes (Windows 9, macOS 5, web 4 with a warm cache).

## [1.4.0] - 2026-10-05

v1.4 "Certificate signature" (FEEDBACK F15 C, DESIGN §3.8, ADR-121).

### Added
- Sign with a certificate: the new Zertifikat tool (last in Ausfüllen & Signieren) places a visible seal and writes a PAdES B-B signature into a new file ("{name} (signiert)"); the original stays editable. The confirmation says plainly that this is not a qualified electronic signature.
- Certificates: create a self-signed certificate (ECDSA P-256, 3 years) or import a .p12/.pfx; managed in a Certificates tab of the Signatures dialog (details, fingerprint, export, delete). Private keys stay encrypted with a key held in the system keychain and never reach the window.
- Validation of every signed PDF on open: a banner and a Signatures dialog with signer, signing time, whether the file changed after signing, what the signature covers, and a plain note that the identity is not checked against a trust list; "View signed version" opens exactly what was signed; signers can be trusted locally.
- Signed documents are locked as their certification allows: editing tools, page commands, form fields and Save are disabled, Save As keeps the signature, and "Make editable copy…" writes an unsigned copy.

### Changed
- The default citation style is APA 7 in every UI language; the last chosen style is kept (owner decision).
- Documents signed elsewhere are now read-only in Sheer according to their certification level.

### Security
- Hostile signed files are bounded (ByteRange, /Contents size, CMS depth, revision diff, time budgets); changes hidden behind cross-reference or object-stream objects count as changes.

## [1.3.0] - 2026-10-05

v1.3 "Citations" (FEEDBACK F15 C, DESIGN §3.7, ADR-119).

### Added
- Cite: select text and choose Zitieren (selection popover, Kommentieren tool row, Ctrl/Cmd+Shift+C, Edit → Cite Selection). A citation is a highlight with a 1 pt rule in the fill's stroke colour, a margin bubble with the quote, the printed page label (/PageLabels) and the short citation; a selection across pages makes one citation per page in one undo step.
- Reference: Document Properties gets a Reference tab (type, title, ordered authors, year and type-dependent fields), prefilled from XMP, the Info dictionary and page 1 (title, year, DOI) with "from the file" / "from page 1" / "edited" captions; saved in the PDF.
- Styles: APA 7, MLA 9, Chicago (author-date) and DIN ISO 690, in English or German terms. Copy a citation, the reference or the whole citation list (plain text + HTML), or save the list as .txt, .html, .md, .ris or .bib.
- Tags: own coloured tags (five palette colours, up to 64) for comments and citations, assigned from the bubble, the card and the mini bar, managed in one popover (rename, recolour, delete with undo), filterable in the Comments tab together with the new Citation type.
- `scripts/ci-status.sh`: the CI state of main at the start of every loop (ADR-120).

### Changed
- The Comments tab orders cards within a page in reading order and shows the Reference button also when a document has no comments.
- Error toasts show an alert icon and wrap their text.

### Fixed
- Text selection on documents with non-embedded fonts ended about 10 % short of the pointer (runs are fitted with letter-spacing instead of a scale transform).
- After deleting a page and saving, annotation lists came back empty until the document was reopened (the registry kept stale page ids).
- macOS CI: the recents reveal test recorded a relative network spelling that is never stored (runs #61–#66).

## [1.2.0] - 2026-10-05

v1.2 "sheer.": the new design (docs/REDESIGN_BRIEF.md, ADR-100 to ADR-102), the owner feedback on v1.2.0-beta.1 (FEEDBACK F15, ADR-104 to ADR-117), motion v2 (R5) and onboarding (R6). Unsigned installers (BLOCKERS B-002).

### Changed
- New brand: word mark "sheer.", app icon "s.", Solar Yellow on Canvas/Sand/Mist, flat surfaces, Inter, light only (theme and glass settings removed).
- Home: navigation (Home, Recent, Starred, Tools), hero with search over recent files (`/`, arrow keys), recent cards with star and "Show in Explorer/Finder", tool rows, a drop-a-PDF state whose glow follows the dragged file.
- Editor: top bar with file name or tabs, save status ("Saved", edited dot, retry), sidebar toggle, zoom, page, undo/redo, search; one Sand bar with segmented mode tabs Read · Comment · Fill & Sign · Pages · Edit (keys 1–5) and a tool row per mode (FEEDBACK F14); a properties mini bar above the selection; the Windows menu row with all output commands in File; no right inspector panel and no Done button.
- Highlights default to Solar at 45 % multiply with Mint, Sky, Rose, Lavender; strokes Ink plus four tones; search hits and text selection in Solar with readable text.
- Motion v2: one ease-out curve and three durations, no springs; the active tool and mode glide, a keyboard focus ring glides between controls, tooltip groups, page indicator travel, marker trail, undo fades, page delete, comment jump, zoom snap, skeleton shimmer, splash and ambient glow; every spell has a reduced-motion variant.
- Onboarding: tour with new coach marks (progress bar, step count), a tour pill that pauses on tab switches, the welcome document always in a new tab; settings reduced to language, author, drawing, updates, tour and about; tool tips in the new style, at most three per session.
- Mode tabs and tool row form one Sand bar with segmented tabs. Search hits and text selection are Solar yellow and keep the text readable. Enter confirms notes and comments, Shift+Enter breaks the line. Annotations can be dragged in every tool. The Comments panel is wider.
- The author name is asked in a dialog on the first save of an annotated document.

### Added
- Favourites for recent files; reveal a recent file in the file manager.
- Read tools: hand (pan), text selection, magnifier (hold Z).
- Save status next to the file name (Saved / edited dot / saving / failed with retry) instead of the Done button; sidebar toggle in the top bar and a grip on the sidebar edge.
- Comment margin: bubbles beside the page at the height of their anchor (avatar, name, date, text, reply, resolve), compact markers when narrow; View → Comments in Margin. Comments panel filter (type, page, status) and sort; the comment text is the first line of a card.
- Text comment: one click places it and typing starts; the box grows with the text; mini bar with alignment, font size, border and fill. Colour control with a hex field and recently used colours, also in the tool menus.
- Shapes: arrow; freehand shapes snap to circle, ellipse, rectangle, line or arrow after a short pause (can be switched off).
- Outline derived from heading sizes for PDFs without bookmarks, marked "derived".
- Rotate handle on placed signatures and stamps; signatures and marks are placed upright in a rotated view.
- Typed signature fonts Ms Madi (default), Hurricane and Birthstone; drawn signatures smoothed with a One Euro filter and speed-dependent width.

### Fixed
- Large images in PDFs rendered half grey (engine reads crossing a 256 KiB block were short); images to PDF reads each image at its own offsets.
- Reopening a saved file with a placed signature or an unsupported annotation restarted the engine.
- Saving an annotated document did nothing while the author name was empty.
- "Save to library" no longer drops a signature silently; a keychain failure is shown. macOS printing keeps the page images alive until the print sheet has rendered them.
- Clicking a page thumbnail no longer plays the document-open animation.
- No white flash of the page and its thumbnail after a save.

## [1.2.0-beta.1] - 2026-10-04

Pre-release of v1.2 "sheer." for the owner checkpoint (ADR-102): the redesign as of the checkpoint, before motion (R5), onboarding (R6) and the final acceptance (R7). Unsigned.

v1.2 "sheer." redesign, in progress (docs/REDESIGN_BRIEF.md, ADR-100 to ADR-102).

### Changed
- New brand: word mark "sheer.", app icon "s.", Solar Yellow on Canvas/Sand/Mist, flat surfaces, Inter, light only (theme and glass settings removed), ease-out motion tokens.
- Home: navigation (Home, Recent, Starred, Tools), hero with search over recent files, recent cards with star and "Show in Explorer/Finder", tool rows, a drop-a-PDF empty state.
- Editor: top bar (back, file name or tabs, zoom, page, undo/redo, search, Done), mode tabs Read · Comment · Fill & Sign · Pages · Edit (keys 1–5) with a tool row per mode (FEEDBACK F14), a properties mini bar above the selection, the Windows menu row with all output commands in File; the right inspector panel is gone.
- Highlights default to Solar at 45 % multiply with Mint, Sky, Rose, Lavender; strokes Ink plus four tones; new signature sheet.
- Form banner, red redact band, selection popover (Highlight · Comment · Copy); welcome document redesigned.

### Added
- Favourites for recent files; reveal a recent file in the file manager.
- Read tools: hand (pan), text selection, magnifier (also Z held).
- Brand lint gate, contrast gate and a dev-only component page.

## [1.1.0] - 2026-10-04

Structure and comfort (FEEDBACK F12).

### Added

- Start page as a tool hub: Open, Merge, Split, Compress, Images to PDF, Sign, Redact and Fill form as cards; a card asks for the file and opens it straight in the matching mode. Recent files stay below.
- A real menu bar (File, Edit, View, Tools, Help): in the window on Windows, the system menu bar on macOS. Every command and shortcut has a place there.
- Word-style comments: select text, choose "Add comment"; the comments panel shows the quoted text, the comment, author and time, with replies and resolve/accept/reject that other PDF viewers can read. Click a card to jump to the spot. Every annotation type is labelled with its icon.
- Typed signatures in three handwriting fonts: Dancing Script, Great Vibes and Alex Brush (SIL Open Font License).

### Changed

- The toolbar holds only tools: Select, Highlight, Comment, Draw, Shapes, Fill & Sign, Redact. Zoom moved to the status bar.
- Forms: no Form tool any more. Fields are fillable as soon as a document has them, with a notice; "Flatten form" is in the File menu. Check marks, crosses, dots, dates and text for documents without fields are under Fill & Sign.
- Left sidebar tabs: Pages, Outline, Comments, Search. The right panel shows the properties of the selection or the active tool.
- Menus and popovers are opaque enough that the page never shows through.

### Removed

- The Homemade Apple signature font.

## [1.0.1] - 2026-10-04

Patch from the product owner's test of 1.0.0 (FEEDBACK F11).

### Fixed

- Redaction is surgical: only text, drawings and image areas inside the marked rectangles are removed; the rest of the page stays real, selectable and searchable text (in Sheer and in other viewers). Pages are never turned into pictures.
- The live preview while dragging (highlight, text comment, drawing, shapes, signatures) sits exactly under the pointer at every zoom level; highlights follow the text like a selection.
- Text comments, drawings and shapes can be edited after inserting them (move, resize, restyle, edit text by double-click or Enter) without "This request was invalid".
- The comments panel no longer fails once a check mark, cross, dot or signature is placed; they are listed with their own icon.
- Tools stay active after each use until you press Esc or pick Select; selecting something no longer changes the zoom.
- Starting the tour opens the welcome document in a new tab and never closes or discards your open documents.
- Drawn signatures: strokes are never joined across pen lifts and are smoothed while you draw.

## [1.0.0] - 2026-10-04

M7 — Polish and ship.

### Added

- The PDF engine runs in its own process: a crash or hang in a hostile file restarts the engine and reopens your documents instead of closing the app; a file that crashes it twice is shut out.
- Crash-safe autosave: unsaved work is kept on this device (never for password-protected files) and offered back on the next start; restored documents are saved with Save As.
- Opt-in updater, off by default: checks GitHub Releases only when you turn it on or click "Check for updates", verifies the signature before installing, installs when you quit. Builds without the release key say so and never contact the network.
- Welcome tour with all seven steps and one short tip per tool on first use; restart both under Settings → Help.
- Recent files show a small first-page preview (never for password-protected files).
- Windows installer with Sheer artwork, per-user install, listed under "Open with" for PDFs without taking over the default; "Make Sheer the default PDF app…" in Settings. macOS: universal DMG.
- Keyboard: F6 / Shift+F6 cycles toolbar, side panel, page area, inspector and status bar.

### Changed

- Release builds forbid inline styles (CSP style-src 'self') and refuse navigation away from the app.
- Accessibility pass: disabled toolbar icons use a contrast-checked colour, tab strip roles fixed, automated accessibility checks for the main surfaces.
- German typography and a glossary for consistent terms.
- Measured in the app window: a 500-page PDF shows its first page in about 190 ms; scrolling, zoom and panels hold 60 fps.

### Security

- Full release audit passed (0 critical/high); docs/SECURITY.md lists every measure with its evidence and the accepted residual risks.
- Installers are still unsigned (docs/BLOCKERS.md B-002, signing guide included); the updater needs the owner's release key (B-005).

## [0.9.0] - 2026-10-04

M6 — Convert and output.

### Added

- Export as images (Ctrl/Cmd+Shift+E): PNG or JPEG, page range, DPI presets or custom (36–600), JPEG quality, with or without annotations; files named after the document, never after text inside it; existing files: replace, keep both or cancel.
- Create PDF from images: pick or drop PNG/JPEG images, reorder them with thumbnails, page size (fit, A4, Letter; the default follows the system region), orientation and margin; the new PDF opens in a tab. Also on the start screen.
- Print (Ctrl/Cmd+P): choose pages, annotations and quality, then the system print preview takes over; nothing is written to disk.
- Export a copy: keep, flatten or remove annotations, optionally remove metadata; the open file stays unchanged.
- Output always includes unsaved edits (an in-memory snapshot); unapplied redaction marks are never output.

### Changed

- Canvas gutter at 100 %, centred start screen, lighter dark canvas, thumbnail bottom inset.
- CI: runs on main are no longer cancelled by the next push (ADR-052).

### Security

- Output paths only come from system dialogs; replace never follows links; writes are atomic; print and image batches are held in memory with caps and expiry; copy, print and edit permissions of restricted files are enforced.
- New dependency: sys-locale (MIT OR Apache-2.0) for the default paper size.

## [0.8.1] - 2026-10-04

Fixes from the product owner's test of 0.8.0 (FEEDBACK F9, F10).

### Fixed

- Annotation tools work again: Highlight, Note, Text comment, Draw and Rectangle, signature placing and Fill & Sign marks received no pointer input since 0.7.0 (the creation and placement layers inherited `pointer-events: none`). The text-comment and note editors open after creation. A refused edit (read-only or restricted file) now shows a notice instead of doing nothing.
- Signatures are vector with real curves: drawn signatures are smoothed (Catmull-Rom) with velocity-dependent width, typed signatures keep the font's Bézier curves, image signatures keep up to 3 000 px with a soft transparent background; sharp at any zoom and in other viewers.

### Changed

- The two text tools are distinct: "Text comment" (a floating note that stays a comment) and "Insert text" (becomes part of the page); the Markup and Edit toolbar groups are visibly separated.
- Larger signature pad (600×200) with a "New" button; rounded selection handles.

### Added

- `scripts/ui/annot-smoke.mjs`: a window test that creates an annotation with every tool using real input; part of the milestone checks.

### Notes

- This build already contains the backend for M6 (export as images, images to PDF, export a copy, print); it is not reachable from the UI yet.

## [0.8.0] - 2026-10-04

M5 — Edit and protect.

### Added

- Text boxes and images (Edit cluster: Add text E, Add image I): place, move, resize, align, multi-select; text laid out in Rust with the standard Helvetica/Times/Courier fonts (WinAnsi), images re-encoded without metadata; both stay editable until save and are then written into the page content, text stays selectable.
- Crop (K): crop rectangle with handles and numeric margins for the current page, all pages or a range; reset; one undo step; crop hides content, it does not remove it.
- True redaction: mark areas, text or all search results, review the marks, apply: affected pages are rasterised at 200 dpi with the marks burnt in, and their text, annotations, links and form widgets are removed; the save is a full rewrite without backups (older backups of the file are deleted). Optional removal of metadata, XMP, bookmarks, attachments, page labels and scripts.
- Password protection: AES-256 (R6) with an open password and permissions (print, copy, edit) behind a separate permissions password; remove protection with owner rights; saving an encrypted file keeps its encryption after a confirmation.
- Document properties: view and edit title, author, subject and keywords; remove all metadata.
- A note when pages imported from another file had annotations that were skipped.
- CI: Windows and macOS on every push to main (docs-only changes skipped); tag pushes run only the release workflow (ADR-046).

### Changed

- The empty state fits an 800 px window; shared status pill style; German "Formular reduzieren…" for flattening.

### Security

- Passwords are never stored, logged, serialised to the UI or kept in the undo history; they are zeroized and dropped on save and close. SASLprep for R5/R6 passwords.
- Image intake checks size, magic bytes and header dimensions before decoding.
- A test proves redacted text is not extractable after save (page text, streams, strings, metadata, XMP, structure tree, form values, links, bookmarks, attachments).
- Every declared IPC command must also be granted in the capability file (baseline test).
- New direct dependency: stringprep (MIT OR Apache-2.0), already in the build through lopdf.

## [0.7.0] - 2026-10-03

M4 — Forms and signature.

### Added

- Form filling: text, checkbox, radio and choice fields drawn on the page, Tab order across pages, required and read-only states, a field highlight toggle, the Form tool (F) and a "Formular" pill; every edit is undoable; values are saved into the file with regenerated appearances (no scripts are ever run; a hybrid XFA layer is removed with a warning).
- Flatten: burns filled fields into the pages of a new file (with confirm and progress).
- Signatures: draw (pressure), type (bundled Homemade Apple font, Apache-2.0, as outlines) or import an image (PNG/JPEG, re-encoded without metadata); initials; place, move and aspect-locked scale; Fill & Sign marks (check, cross, dot), date and text.
- Signature library: up to 8 entries per kind, encrypted on this device (XChaCha20-Poly1305) with the key in the OS keychain; rename, delete with undo, forget all; session-only when no keychain is available.
- CI: Windows-only on pushes to main with docs changes skipped, macOS on tags and manual runs, caches (ADR-043).

### Security

- Pre-scan judges /Length only for object and xref streams and refuses conflicting length objects (ADR-044); keychain calls time out after 60 s; an unreadable library is quarantined, never overwritten.
- New dependencies: chacha20poly1305, getrandom, keyring-core with the Apple and Windows stores, skrifa (all MIT OR Apache-2.0).
## [0.6.0] - 2026-10-03

M3 — Organize pages.

### Added

- Organize mode: a page grid with a size slider, multi-select, drag-and-drop and keyboard reordering, rotate, delete (never the last page; undo brings pages and their annotations back), insert blank pages or pages from another file — all undoable; the viewer, thumbnails, outline and search follow the new order.
- Save rewrites the page tree incrementally; "clean copy" writes a full new file; changing pages of a signed file asks first.
- Extract pages to a new file; split every N pages or by ranges with a naming pattern into a chosen folder (never overwrites); merge several PDFs (dropping several files offers "Merge into one" or "Open as tabs"); compress with three presets (96/150/220 dpi) and a size estimate. All with progress and cancel; annotations travel along.
- Undo/Redo buttons in the toolbar, an "Edited" badge in the status bar; annotations on inserted pages are editable at once.

### Security

- Every PDF parsed for writing goes through one guarded loader with a decode-budget pre-scan (defence in depth until the separate engine process in M7); imported pages and annotations keep only safe web links (no automatic or JavaScript actions); Windows device names are never used as file names; outputs are claimed with create-new.
- New dependencies: image 0.25 (JPEG only) and flate2 (MIT/Apache).
## [0.5.0] - 2026-10-03

M2 — Comment and markup.

### Added

- Annotation model with a per-document undo/redo command stack (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y on Windows; macOS Edit menu); existing annotations are imported from the file, unknown types stay read-only.
- Tools: highlight, underline, strikethrough (from text), sticky notes with replies, free text (Helvetica), freehand ink (smoothing, pressure), rectangle, ellipse, line and arrow; one-shot or locked tool mode.
- Annotations on the canvas: select, move, resize, nudge with the keyboard, delete; edited originals disappear from the page image at once and come back on undo.
- Properties inspector with the eight Okabe-Ito colours, stroke presets, opacity, font size and line ends.
- Comments panel: threads with replies, filter by type and author, sort by page or date, jump to the annotation.
- Save and Save As (Ctrl/Cmd+S, Ctrl/Cmd+Shift+S): appearance streams for every type, incremental and atomic write, a backup of the original on the first save, the welcome document saves only as a copy; unsaved-changes dot, quit with unsaved documents, file-changed-on-disk confirmation.
- Author name: empty by default; asked once at the first save of a document with annotations (the system name only as a suggestion); empty writes no author; invisible and bidirectional characters are removed.
- Release workflow: unsigned NSIS and DMG installers attached to a GitHub Release on every tag.

### Security

- Bounded annotation import (counts, quads, string bytes per page and document) and an undo history bounded by bytes; the save checks the file again right before replacing it and refuses when it cannot tell; backups are private (0700); one save build per document at a time.
- New dependency: lopdf 0.45.0 (MIT).
## [0.4.0] - 2026-10-03

M1 — Viewer. CI green on Windows and macOS (run 37120538629).

### Security

- Windows file identity from the opened handle (`same-file`); the PDFium worker respawns after a wedge (at most 3 times per process);
  unlocks are serialised per document; recents drop UNC, device and NTFS-stream spellings before any file-system access, and Locate goes
  through the normal intake.

### Added

- Search panel: live search after two characters, hits grouped by page with context, highlights on the canvas, next/previous (Enter, Shift+Enter, Ctrl/Cmd+G, F3).
- Text selection on a lazy per-page text layer; copy with Ctrl/Cmd+C, select all on a page.
- View rotation (Ctrl/Cmd+R / L, view-only, per document) and Go to page (Ctrl/Cmd+Shift+N) from the status bar.
- Password-protected PDFs: an unlock prompt; the password stays in memory for the session only, with a growing wait after wrong attempts.
- Recent files on the empty state: open, remove, missing files marked; ids only cross to the UI, never paths.
- Document tabs (Ctrl+Tab / Ctrl+Shift+Tab, Ctrl/Cmd+W); the macOS menu greys document commands without a document.
- Hostile-input corpus of 61 generated malformed PDFs with a never-crash test; XFA warning banner; intake refuses UNC, device-path and NTFS stream spellings.

- A scrolling, virtualized canvas (ADR-018): every page has a placeholder of its real size, and only the pages within a viewport height of the viewport are mounted (at most 24).
  The render queue has priorities (visible, near, thumbnails), cancels the renders of pages that scrolled away (`set_viewport`) and draws one frame once however many pages ask for it;
  a render cache of up to 256 MiB keeps the images, and a page shows the best one it has while the sharp one is on its way.
- Zoom buckets (a quarter octave, display pixel ratio included) and 1024 px tiles for pages that are too large for one frame, which replace the retry at a smaller scale.
- Zoom around the pointer (Ctrl/Cmd+wheel, trackpad pinch in WebView2 and WKWebView) and around the middle of the viewport (buttons, keys); the point you look at stays where it is.
  Fit width and Fit page stay fitted as the window is resized.
- Scroll modes: Continuous scrolling, Single page and Two pages (More menu, macOS View menu); the status bar shows the page the scroll position is on.
- `get_page_sizes` and `set_viewport` commands; the error code `cancelled` (the UI stays silent about it); a document of more than 50 000 pages is refused.
- A 500-page synthetic PDF test that logs how long opening it and its first visible page take.
- The read APIs of the backend (ADR-019), with typed and validated wrappers in `src/api`: `get_outline` (at most 10 000 nodes, 32 levels, a cycle in the file ends where it comes back),
  `get_text_layer` (the text of a page and a box for every character, in page space), `search` and `cancel_search` (page by page at the lowest priority, so renders go first; hits as
  one rectangle per line, progress, done; Unicode case, hyphenated words and phrases across a line break are found, which PDFium's own search does not do), `get_page_links` and
  `open_link`. A document tells whether it is encrypted, has an XFA or an AcroForm, or is signed (`flags` of `DocumentInfo`).
- Thumbnails panel in the left panel: virtualized for any page count, rendered lazily at thumbnail priority from the shared render cache, the current
  page highlighted and kept in view, one Tab stop with arrow keys, Home and End, click or Enter to jump.
- Outline panel (DESIGN 3.15): the document's bookmarks as a tree in the left panel (WAI-ARIA tree keys, type-ahead, one Tab stop, virtualized
  for 10 000 entries), the section you are reading marked, a click or Enter jumps to the exact spot; entries without a target in this document are
  shown muted.
- Welcome tour (ADR-023, FEEDBACK F4): on the first launch without a file, a bundled "Welcome to Sheer" document (English or German, 4 pages
  in the Iris design, drawn in code) opens once; coach marks point at the control for each task (open, go to page 2, zoom in), a short success
  moment follows each one, progress shows in the status bar, the tour can be skipped and restarted from Settings. More steps (highlight,
  comment, signature, page order) come with their tools in M2–M4.
- Test PDFs generated in code (`src-tauri/tests/support`), with the committed ones under `tests/fixtures/` checked against their generator: outlines (also a cycle), links of every kind,
  text with non-ASCII letters, a hyphenated line end and an emoji, a form, an XFA form, a signed and an encrypted document.

### Changed

- Mood (ADR-020, FEEDBACK F2): a clearly visible Iris background gradient with three soft light fields, so the glass of the toolbar and
  panels shows what is behind it; Iris-tinted glass with a light top edge; soft Iris shadows; a large, gently floating logo on the empty
  state (still under reduced motion, paused while the window is hidden); thin Iris scrollbars; a tinted canvas with an edge in both themes and
  a visible page edge in dark. The inspector column is no longer reserved while nothing is selected: it slides open like the left panel.
- Motion (ADR-022, docs/MOTION.md, FEEDBACK F3): one spring and three durations (120/200/320 ms) for every animation, exits shorter and
  fading; buttons, tabs and menu items answer press and hover; the left panel and the inspector slide in and out while the page in the middle
  stays put; pages fade in instead of popping, a sharp render fades over its stand-in; zoom glides with inertia and snaps to fit width, fit page
  and 100 %, and a document opens at fit width (at most 100 %); a dropped file shows a preview card that falls into the window; opening
  flies from the card or thumbnail to the page; short jumps scroll smoothly; a quiet Iris pulse instead of a dialog marks a success.
  Reduced motion turns all of it into fades. Measured in the Tauri window at 60 fps.

### Security

- Links in a PDF are read as data and nothing they ask for is done: a jump in the document is a page, a URL that is plain `http`, `https` or `mailto` (at most 2048 bytes, only RFC 3986
  characters, no credentials before the host, no attachment in a mail link) is shown in a native dialog from Rust and opened only if the user agrees, and every other action (launch, a jump to
  another file, JavaScript, any other scheme) is blocked. `open_link` takes no URL from the webview. `tauri-plugin-opener` (Apache-2.0 OR MIT) is a dependency for its `open_url` function
  only: it is not registered and no capability names it.
- Outline titles, text and URLs from a file are bounded and filtered before they reach the UI, and the frontend parsers refuse an answer that is not within the bounds.
- A flood of `render_page` calls cannot park the blocking pool: a tile column or row of 64 or more is refused at the command, at most 8 callers join one frame that is being
  drawn (the frame is shared, not copied for each), at most 96 calls per document and 128 in all are in flight, and a viewport hint with more than 64 pages in a list is refused
  while it is read. `get_page_sizes` is answered from the sizes read once when the document was loaded.
- A document whose close the engine could not take is no longer lost: it is hidden from the UI, kept marked as closing, and released by the next open or close; a close that
  timed out still runs.
- A web link needs a real host (DNS labels or a bracketed IPv6 address, a port of at most 65535, no percent-encoding in the host).
- The capability file lists each permission once, and a test keeps it so.

### Fixed

- Page views are memoized for real: the canvas hands them numbers instead of a layout object that is new on every render. Neighbours rendered ahead in a paged mode wait for the
  zoom to settle like a page does. The render cache forgets what it kept about a closed document (page versions, and all but the last 256 closed ids). A rectangle that starts at
  or after a tiled page's edge no longer asks for a tile.

## [0.3.0] - 2026-10-02

### Added

- Design system (`docs/DESIGN.md`, ADR-011/012): Iris tokens for light and dark, glass recipes with a solid mode
  (no `backdrop-filter`, reduced transparency, forced colors, "Glass: Solid"), reduced motion, fixed elevation layers.
- Glass UI primitives: Button, IconButton, Toolbar (clusters, overflow, roving focus, lockable tools), Tooltip, Popover,
  Menu, Tabs, Slider, Splitter, Panel, Field, segmented control.
- App shell: floating toolbar, collapsible left panel with persisted width, opaque canvas with scroll-edge scrim,
  reserved inspector slot, status bar, per-OS window chrome (ADR-014), render isolation (ADR-015).
- Empty state with Open button, drop-zone visual and recents placeholder.
- In-house typed i18n with English and German catalogs shared with Rust; language setting; localized shortcut labels.
- Settings popover (theme, glass, language) and About dialog; global shortcuts are off while a dialog is open.
- One command registry (`src/actions`, ADR-016): the toolbar, the More menu, the keyboard and the macOS menu bar all derive from it. Shortcuts follow the platform
  (Cmd on macOS, Ctrl elsewhere): Open, Close (new), zoom, Actual size, Fit width and Fit page (new), previous and next page (⌘/Ctrl+↓/↑), the panel toggles, Settings, About and
  the tool letters, which work only while the canvas has focus. The key handler never takes a key from a text field.
- The macOS menu bar (App, File, Edit, View, Window, Help), labelled from the UI catalogs in English and German and rebuilt when the language changes. Menu clicks reach the UI
  through a `Channel` passed to the new `subscribe_menu` command, with an allowlist of ids in Rust. Windows has no menu bar (ADR-016).

- Menus have submenus (DESIGN 3.5): an item with `submenu` opens a solid second level with Right, Enter, Space, a click or after the pointer rested on it for 200 ms; Left and Esc close it, and they nest.
- Collapsing or restoring the left panel animates over 250 ms (the columns slide and the panel fades, opacity only under reduced motion) without rendering the shell.
- A leftover `.<name>.<pid>.<n>.tmp` file older than an hour is removed from the app data directory at startup (SECURITY D1).

### Changed

- Popovers and tooltips follow scrolling and resizing once per animation frame, not once per event.
- Ctrl+0 is Fit page and Ctrl+1 is Actual size (it was 100 %). Ctrl on macOS and Cmd on Windows no longer trigger shortcuts.

### Fixed

- The error banner no longer jumps by 8 px when it opens; a render that is cancelled no longer leaves "Rendering…" in the status bar.

### Security

- File names shown in the UI lose every Unicode control (Cc) and format (Cf) character except the two joiners, plus U+2028, U+2029 and U+FFFC (ADR-015). The CSP test covers every `tauri.<platform>.conf.json` and fails when one sets `app.security`.
- The window has no event permission any more (`core:event:allow-listen`/`allow-unlisten` dropped): the macOS "Reduce transparency" flag reaches the UI
  through a `Channel` passed to the new `watch_transparency` command (ADR-013). `dragDropEnabled` is set explicitly.
- Settings file: opened first and judged on the handle (`O_NONBLOCK` on Unix); atomic writes use a per-process unique temp name.
- `unsafe_code = "forbid"`; the lint rule now rejects every HTML sink (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `setHTMLUnsafe`, `createContextualFragment`, `DOMParser`, `document.write`). Phase 3 security audit: PASS.

## [0.2.0] - 2026-10-02

### Added

- Architecture: ADR-001 (stack), ADR-002 (PDFium worker, render cache), ADR-003 (annotation model, undo/redo),
  ADR-004 (file strategy), ADR-005 (CSP for Tauri IPC); `docs/ARCHITECTURE.md` with module map and IPC commands.
- Tauri 2 + React 19 app that opens a PDF through a native dialog and renders pages via bundled PDFium (plain build,
  pinned `chromium/7881`, SHA256-verified by `scripts/fetch-pdfium.sh`), with zoom and Ctrl+wheel.
- Security baseline: strict CSP, three-command capability, async commands, UI-safe errors, central limits,
  panic and timeout guard around PDFium jobs, binary render frames.
- Tooling: `npm run check` (15 steps incl. clippy, cargo-deny, cargo-audit, npm audit, import/network/secret guards),
  `scripts/bump-version.sh`, CI for macOS + Windows, Dependabot.

### Security

- First security review: PASS. Low findings fixed (orphaned document on failed open, raw startup error output,
  unpinned CI tools, debug artifact naming, missing secret scan, unverified cached PDFium library).

## [0.1.0] - 2026-10-02

### Added

- Research on Acrobat features, online PDF tools, desktop UX patterns, PDF libraries and licenses (`docs/research/`).
- Feature catalog with MoSCoW, complexity and milestone mapping (`docs/FEATURES.md`).
- Roadmap with Phase 3 and milestones M1–M7.
- ADR-010 (v1.0 product scope) and ADR-011 (design adjustments).

## [0.0.1] - 2026-10-02

### Added

- Orchestration scaffold: Claude Code subagents, hooks, state and roadmap files.
- Project documents: README, LICENSE (AGPL-3.0-or-later), TRADEMARK, SECURITY policy.
- Docs skeleton: features, architecture, design, security, decisions, licenses, blockers.
- Brand logo (`assets/brand/logo.svg`).
- Pinned toolchains (`.nvmrc`, `rust-toolchain.toml`) and `cargo-deny` policy (`deny.toml`).
