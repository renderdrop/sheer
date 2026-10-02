# Online and built-in PDF tools: what people do, what is simple

Researched 2026-10-02 from vendor pages, help docs and third-party summaries. Traffic and search figures are SEO-tool estimates that disagree between sources; untraceable ones are marked (unverified).

## 1. Tool x feature matrix

Legend: Y = included, P = partial / paid tier / workaround, - = none, ? = unverified.

| Feature | iLovePDF | Smallpdf | PDF24 | Sejda | PDFescape | Canva | Preview (mac) | Edge (Win/mac) |
|---|---|---|---|---|---|---|---|---|
| Merge | Y | Y | Y | Y | P | ? | Y | - |
| Split / extract pages | Y | Y | Y | Y | ? | Y | Y | P |
| Compress | Y | P | Y | Y | P | Y | P | - |
| PDF to Word/Excel/PPT | Y | Y | Y | Y | P | Y | - | - |
| Office to PDF | Y | Y | Y | Y | ? | Y | - | - |
| Images to/from PDF | Y | Y | Y | Y | ? | Y | Y | - |
| Rotate | Y | Y | Y | Y | ? | Y | Y | ? |
| Reorder pages | Y | Y | Y | Y | ? | Y | Y | - |
| Delete pages | Y | Y | Y | Y | ? | Y | Y | - |
| Edit existing text | P | P | P | Y | P | P | - | - |
| Annotate / highlight | P | Y | Y | Y | Y | P | Y | Y |
| Fill forms | Y | Y | ? | Y | Y | - | Y | Y |
| Sign (visual) | Y | Y | Y | Y | P | P | Y | P |
| Protect / unlock | Y | Y | Y | Y | P | - | P | - |
| Redact | Y | Y | Y | P | P | - | ? | - |
| OCR | Y | Y | Y | Y | - | - | Y | - |
| Page numbers | Y | Y | Y | Y | P | Y | - | - |
| Watermark | Y | Y | Y | Y | P | ? | - | - |
| Works offline | - | - | Y (Win only) | P | ? | - | Y | Y |

Notes behind the P and ? cells:
- **iLovePDF / Smallpdf / PDF24 "Edit":** add text, images and shapes; editing original text not confirmed (unverified).
- **Sejda:** edits existing text and has find/replace; "whiteout" is offered, true redaction unconfirmed. Desktop is offline but free use is limited to 3 tasks/day.
- **PDFescape (Avanquest):** free tier cannot edit existing text. Merge, compress, watermark, page numbers, PDF-to-Word are Premium.
- **Canva:** import turns each page into editable design elements and may substitute fonts; scanned PDFs import as one flat image. Sources conflict on merging.
- **Preview:** compress is the "Reduce File Size" Quartz filter on export (lower quality). Password-protect on export. OCR is File > Export > "Embed Text" (Sonoma 14+). Redaction is reported by third parties since macOS Big Sur; Apple's guide excerpt does not list it (unverified).
- **Edge:** annotation is ink, highlight, add text, comments; basic form fill (no XFA / JavaScript forms); validates certificate signatures. Extracting pages needs the "Microsoft Print to PDF" page-range workaround.
- **PDF24 Creator** is Windows-only (Mac users get online tools only); it bundles 40+ tools and a PDF printer.

Free-tier caps (relevant to what we should not copy):

| Tool | Cap |
|---|---|
| Smallpdf | 2 tasks/day; Compress "Basic" free, "Moderate" and "Strong" Pro; offline desktop is Pro |
| Sejda | 3 tasks/hour, 50 MB, 50 pages in editor (200 pages / 50 MB in other tools, per third parties) |
| iLovePDF | roughly 100-200 MB per file by tool (unverified); desktop and OCR-to-Word are Premium |
| PDFescape | 10 MB / 100 pages; Premium 40 MB / 1000 pages |
| PDF24 | none stated; ad-funded; files deleted after about one hour |
| Canva import | 300 MB / 500 pages |

## 2. Top tasks by popularity

Smallpdf self-published usage share, 2025 (methodology not disclosed):

| Task | Share |
|---|---|
| Compress | 34% |
| Sign | 19% |
| PDF to Word | 16% |
| Other conversions | 12% |
| Everything else (merge, split, edit, etc.) | 19% |

Search demand, monthly (unverified; SEO-tool estimates that differ by source):

| Query | Volume |
|---|---|
| jpg to pdf | 4.8M-6.1M |
| pdf to word | 4.0M-7.3M |
| pdf to jpg | 3.4M-4.1M |
| word to pdf | about 2.5M |
| compress pdf | about 1.6M |

Scale: iLovePDF about 250-265M visits/month, 71% organic search, about 74% desktop, India 22% (third-party, unverified). Smallpdf desktop share 61% (self-published); its monthly users are quoted as 20M and 40M+ in different places.

Synthesised ranking (my inference from the above, not a measurement):

| Rank | Task family |
|---|---|
| 1 | Convert: image to PDF, PDF to Word, Word to PDF, PDF to image |
| 2 | Compress (usually to fit an email or upload limit) |
| 3 | Merge |
| 4 | Fill and sign a form |
| 5 | Page ops: split, extract, delete, rotate, reorder |
| 6 | Protect / unlock |
| 7 | Long tail: OCR, edit text, redact, number, watermark |

Takeaway: most visits are one-shot "file in, file out" jobs; signing is the one high-share task that is interactive.

## 3. Notably simple flows

| Flow | Where | Step sequence |
|---|---|---|
| Merge | Smallpdf, iLovePDF, PDF24 | Drop files; thumbnails appear and can be dragged, rotated or removed; click one primary button; download. Smallpdf also merges Office files and images. PDF24 adds bookmark and blank-page options. |
| Merge | Preview | Open a PDF; View > Thumbnails; drag another PDF's icon from Finder into the sidebar (or drag its thumbnails). Changes auto-save, so Apple advises duplicating first. |
| Reorder / delete / insert | Preview | View > Thumbnails or Contact Sheet; drag to move; select and press Delete; Edit > Insert for a page from a file or blank page. |
| Compress | iLovePDF | Drop file; choose Extreme / Recommended / Less; click Compress. Three named presets, no sliders. |
| Compress | Preview | File > Export > Quartz Filter "Reduce File Size". One option, coarse result. |
| Sign | Preview | Markup > Sign; capture signature by trackpad, camera or iPhone; saved; click to place and drag handles to resize. |
| Sign | Sejda | Create by typing (10+ handwriting styles), drawing, uploading or camera; pick from the Sign menu; click to place; drag corners. |
| Sign | iLovePDF | Choose "Only me" or "Several people"; draw, type or upload; place signature, initials, name, date; apply to all pages or a range. |
| Fill form | Preview, Edge | Open; click a field; type. Preview AutoFill pulls name and address from Contacts. |
| OCR | Preview | File > Export > Embed Text. The option appears only when no text was recognised. |

## 4. Patterns to adopt and anti-patterns to avoid

Adopt:

| Pattern | Evidence | Why it fits Sheer |
|---|---|---|
| Whole-window drop zone as the entry point | All web tools | The drop alone can suggest the tool (several PDFs: merge; images: make PDF). |
| One shared page-thumbnail grid for merge, organize, split, extract, delete, rotate | Smallpdf merge, Preview contact sheet | One component serves tasks 3 and 5; wins by consistency. |
| Named presets instead of numeric settings | iLovePDF compress | Users want "smaller", not DPI. Show estimated size per preset (my suggestion, not seen elsewhere). |
| Signature library: create once, reuse | Preview, Sejda | Beats re-drawing every time; the 19% sign share suggests heavy repeat use. |
| Result screen with next-step buttons | Smallpdf, PDF24 | Offline we can chain steps on the open document with no re-upload. |
| Save as copy by default | Counter-example: Preview auto-save overwrites | Protects originals. |
| Mixed-format input in merge | Smallpdf | Matches how people assemble document packs. |
| Local speed and privacy stated plainly | PDF24 Creator, Sejda Desktop | Removes the upload bar (iLovePDF shows time and MB/s) and the privacy worry. |

Avoid:

| Anti-pattern | Evidence |
|---|---|
| Task quotas that tax small fixes | Smallpdf 2/day; Sejda 3/hour online and 3/day on desktop; reviewers note a typo fix counts as another task. |
| Paywalling the useful setting | Smallpdf locks Moderate and Strong compression. |
| Upload, wait, delete-in-an-hour trust model | Two online PDF makers leaked user documents in July 2024 (third-party report). |
| Dense tool grids with duplicates | iLovePDF 33 tools in 7 groups, Smallpdf about 50 including 5 AI items; Delete / Extract / Organize / Split overlap. Collapse into task-oriented entries. |
| Silent reflow of PDFs into a design canvas | Canva font substitution and layout shift. |
| Unclear free vs paid lines | PDFescape splits basics between free and Premium. |
| Missing basics in the built-in viewer | Edge cannot reorder, merge or compress. |
| Ads and trial prompts in the work area | PDF24 is ad-funded; Smallpdf pushes a 7-day trial. |

## 5. Complexity guess for Sheer (per top task)

Assumes the PDF engine can manipulate the page tree, content streams and encryption. No engine is recorded in docs/DECISIONS.md yet, so treat these as relative.

| Task | S/M/L | Reason |
|---|---|---|
| Merge, images to PDF, PDF to images | S | Page-level operations; image embedding. |
| Page grid: reorder, delete, rotate, extract, split | M | Operations are S; thumbnails, drag UI and undo are the work. |
| Compress with presets | M | Image resampling and recompression, stream optimisation; quality tuning. |
| Fill and sign (visual signature, AcroForm) | M | Field detection, signature capture and placement; XFA and certificate signing excluded. |
| Annotate / highlight | M | Text selection geometry, annotation appearance streams. |
| Protect / unlock (password) | S-M | Depends on engine encryption support; AES-256 preferred. |
| Page numbers, watermark, crop | S-M | Stamping content onto pages. |
| True redaction | M-L | Must remove underlying text, images and metadata, not just overlay. |
| OCR | L | Bundle an engine and language data; add an invisible text layer. |
| PDF to Word/Excel/PPT | L | Layout reconstruction; no obvious offline permissive library. |
| Word/Excel/PPT to PDF | L | Needs an external Office renderer; licensing must be checked against the allowlist. |
| Edit existing text | L | Font subsetting and reflow; only Sejda does it well among these tools. |

## Sources

https://smallpdf.com/pdf-statistics
https://smallpdf.com/
https://smallpdf.com/merge-pdf
https://smallpdf.com/compress-pdf
https://www.ilovepdf.com/
https://www.ilovepdf.com/compress_pdf
https://www.ilovepdf.com/merge_pdf
https://www.ilovepdf.com/sign-pdf
https://techlist.ai/ilovepdf.com
https://yourstory.com/2026/02/ilovepdf-beats-amazon-india-traffic
https://tools.pdf24.org/en/
https://tools.pdf24.org/en/merge-pdf
https://tools.pdf24.org/en/creator
https://help.pdf24.org/en/questions/question/version-for-apple-mac-os-system/
https://www.sejda.com/
https://www.sejda.com/pdf-editor
https://www.sejda.com/sign-pdf
https://exactpdf.com/blog/sejda-pdf-editor-free-limits-2026
https://www.pdfescape.com/
https://support.pdfescape.com/hc/en-us/articles/360028432531-Are-there-any-Limits-for-PDFescape-Online-File-Size-Page-Count-Images
https://exactpdf.com/blog/smallpdf-free-limits-2026
https://www.canva.com/help/import-and-edit-pdfs-canva/
https://support.apple.com/guide/preview/welcome/mac
https://support.apple.com/guide/preview/combine-pdfs-prvw43696/mac
https://support.apple.com/guide/preview/add-delete-or-move-pdf-pages-prvw11793/mac
https://support.apple.com/guide/preview/reduce-the-size-of-a-pdf-prvw1509/mac
https://support.apple.com/guide/preview/fill-out-and-sign-pdf-forms-prvw35725/mac
https://support.apple.com/en-is/guide/preview/prvw1ddb1cdf/mac
https://learn.microsoft.com/en-us/deployedge/microsoft-edge-pdf
https://mc.merill.net/message/MC1154300
https://www.howtogeek.com/why-i-never-use-free-online-pdf-converters/
