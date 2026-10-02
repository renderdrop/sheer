# Adobe Acrobat functional catalog (input for Sheer)

Researched 2026-10-02 from Adobe help pages (via search excerpts; helpx fetches were blocked) and third-party comparisons. Third-party-only claims are marked "(unverified)". Tier: **R** = Reader (free) and up, **S** = Standard and up, **P** = Pro only. Cx = effort guess for Sheer (S/M/L), not researched.

## Editions and UI model

| Edition | Facts |
|---|---|
| Reader | Free. View, print, search, comment, Fill & Sign, Read Out Loud. Windows, macOS, mobile, web. |
| Standard | About $14.99/mo. Edit text/images, create, export to Office, organize, forms, password protect, compress; collect e-signatures limited to 2 docs/mo. Platforms conflict: Wikipedia says Windows-only; retailers list Mac too (unverified). |
| Pro | About $19.99/mo. Adds OCR, redaction, compare, web forms, advanced e-sign, print production, accessibility remediation, Action Wizard, Bates. Windows and macOS. |
| Studio | About $24.99/mo, launched 2025-08-19. Pro plus AI Assistant, PDF Spaces, Adobe Express. Out of scope. |
| Acrobat 2024 | Pro as 3-year term licence, offline after activation. |

UI model (2024+ "new Acrobat"): global bar (All tools, Edit, Convert, E-sign, Search, Save, Print, Share); All tools menu grouped by category, each tool opens a left pane; floating Quick action toolbar (comment, annotate, fill); right navigation pane with customizable panels.

## 1. Viewing and navigation

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Page layouts | Single, continuous, two-page, two-page scrolling | View menu, page display | R | S |
| Zoom, fit, rotate view | Fit width/page, marquee, percent | Zoom controls, View menu | R | S |
| Read mode, full screen | Distraction-free reading, presentations with auto-advance | View menu, floating toolbar | R | S |
| Reflow | Re-wrap tagged text for small screens | View > Zoom > Reflow | R | M |
| Thumbnails, bookmarks | Jump around, nested outline | Right nav panels | R | M |
| Attachments, layers, portfolios | View embedded files, toggle optional content, open Portfolios | Right nav panels | R | M |
| Measure tool | Distance, perimeter, area on drawings | Measure objects tool | P | M |

## 2. Commenting and markup

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Highlight, underline, strikethrough | Mark text, attach note | Quick action toolbar | R | S |
| Sticky note, text box, callout | Free-floating notes | Add comment tools | R | S |
| Drawing: line, arrow, rect, oval, cloud, polygon, pencil, eraser | Mark up figures | Draw freehand / shapes menu | R | M |
| Insert/replace text markup | Suggest edits in-line | Comment tool on selection | R | M |
| Stamps (standard, dynamic, custom) | Approved/Draft, name+date stamps | Stamp tool, K or J shortcut | R | M |
| Comments list | Sort by page/author/date/type, filter, reply, mark resolved | Comments panel | R | M |
| Import/export comments (FDF, XFDF), summary | Merge reviews offline, print with summary | Comments panel options menu | R | M |

## 3. Editing text and images

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Edit text | Fix typos, font, size, alignment, reflow in text box | Edit > Edit text and images | S | L |
| Add text, add image | Insert new text box or picture | Edit pane | S | M |
| Edit image, object | Replace, crop, flip, rotate, resize | Edit pane, right-click | S | M |
| Links | Rectangle link to page, URL, file, script | Edit > Link | S | M |
| Header/footer, watermark, background | Page numbers, dates, DRAFT marks, backgrounds | Edit pane menus | S (unverified) | M |
| Bates numbering | Legal page IDs, prefix/suffix, 3-15 digits | Edit > Bates | P | M |
| Edit scanned PDF | Edit OCR'd text after recognition | Auto-OCR when editing scan | P | L |

## 4. Organizing pages

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Thumbnails drag-reorder | Rearrange pages | Organize pages | S | M |
| Insert, replace, delete, rotate, extract | Page-level surgery, extract keeps forms/comments | Organize toolbar | S | M |
| Split | By page count, file size, top-level bookmarks | Organize > Split | S | M |
| Combine files | Merge PDFs, Office, images into one | Combine files tool | S | M |
| Crop, page labels, renumber | Trim margins, roman/arabic sections | Organize / Page labels | S | M |
| Portfolios | Package mixed files | Combine / Portfolio | P (unverified) | L |

## 5. Forms (AcroForm vs XFA)

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Fill AcroForm | Type, select, tick; field highlight | Fill & Sign / Reader | R | M |
| XFA fill | Dynamic XFA forms render only in Adobe; XFA deprecated in PDF 2.0, authoring was via separate LiveCycle/AEM Designer | Reader, Acrobat | R | L (suggest: detect and warn) |
| Prepare a form | Create fillable form; auto-detect fields from Word/scan | All tools > Prepare a form | S; from scans P | L |
| Field types | Text, checkbox, radio, dropdown, list, button, signature, date, barcode | Prepare toolbar | S | L |
| Field properties | General, Appearance, Position, Options, Actions, Format, Validate, Calculate tabs; JavaScript | Properties dialog | S | L |
| Collect data | Export/import data CSV, XML, FDF; responses via email or server Portfolio | Distribute / Export a PDF | S | M |

## 6. Fill and sign

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Fill & Sign | Add text, check/cross/dot on flat forms | Fill & Sign tool | R | M |
| Signature/initials | Type, draw, or image; saved for reuse | Sign icon in toolbar | R | M |

## 7. Digital signatures and certificates

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Sign with digital ID | Cryptographic signature; PKCS#12, smart card, Windows store | Use a certificate > Digitally sign | R (unverified) | L |
| Create self-signed ID | Make a .pfx ID | Configure New Digital ID | R (unverified) | M |
| Validate | Check integrity, trust, modifications | Signatures panel | R | L |
| Certify | Author signature with allowed-change level | Use a certificate > Certify | P (unverified) | L |
| Timestamp, LTV | Embed time and revocation data (PAdES) | Signature settings | S (unverified) | L |
| Trusted identities | Import/manage certificates, AATL trust | Preferences > Signatures | R | M |

## 8. Protect

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Open password | Encrypt (AES-256) | Protect a PDF | S | M |
| Permissions password | Block print/edit/copy/comment | Protect a PDF > restrict | S | M |
| Certificate encryption | Per-recipient permissions, AES-128/256 | Protect > encrypt with certificate | S (unverified) | L |

## 9. Redaction

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Mark and apply | Permanently remove text/images/areas | Redact a PDF > Redact text and images | P | L |
| Find and redact | Single word, multiple words, patterns | Find text and redact | P | L |
| Redaction codes | Exemption labels, overlay text | Redact properties | P | M |
| Sanitize | Strip metadata, comments, hidden layers, embedded files | Sanitize document | P | L |

## 10. Create, convert, OCR

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Create from file/clipboard/web page/scanner | PDF from Office, images, web | Create a PDF; Windows PDFMaker add-in | S | L |
| Export to Word, Excel, PowerPoint | Editable Office output keeping layout | Convert > Export a PDF | S | L |
| Export to images, HTML, RTF, text, XML | Page images (JPEG, PNG, TIFF), text | Export a PDF | P (unverified) | M |
| OCR / Enhance scans | Searchable text over image; deskew; many languages | Scan & OCR; Enhance scanned file | P | L |
| Scan to PDF | Scanner capture with settings | Create > Scan | S | M |
| Compress / Optimize | Smaller file; PDF Optimizer audits space, downsamples, unembeds fonts | Compress a PDF; Optimize | S (Optimizer P) | M |
| PDF/A, X, E standards | Archival and print-compliant output, verify conformance | Apply PDF standards; Preflight | P | L |

## 11. Accessibility

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Autotag, tags panel | Build/edit tag tree | Prepare for accessibility | P | L |
| Reading Order tool | Fix order, figures, alt text, form labels | Accessibility tools | P | L |
| Accessibility Check | Validate PDF/UA, WCAG 2.0 | Check for accessibility | P | L |
| MathML in tags | Formula accessibility (2026) | Tags | P (unverified) | L |

## 12. Compare, read aloud, search

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Compare files | Report of text/image/format changes, side by side; scanned mode pixel-wise | Compare files, settings gear | P | L |
| Read Out Loud | Speak page or document via OS voices, speed/pitch | View > Read Out Loud | R | M |
| Find | Whole word, case, bookmarks, comments; Replace With | Ctrl+F toolbar | R | S |
| Advanced Search | Search folder/multiple PDFs, Boolean, proximity, properties | Shift+Ctrl+F | R | M |
| Index/Catalog | Prebuilt full-text index for large collections | Index tool | P | L |

## 13. Print and output

| Feature | User achieves | Acrobat UI | Tier | Cx |
|---|---|---|---|---|
| Print dialog | Fit, actual size, poster tiling, N-up, booklet, comments, page range | File > Print | R | M |
| Print production | Preflight, Output Preview, Convert Colors, ink manager | Use print production | P | L |
| Action Wizard | Batch actions on files/folders | Actions | P | L |

## Top 15 everyday tasks (unverified ranking)

| # | Task | Tier | Cx |
|---|---|---|---|
| 1 | Open, scroll, zoom | R | S |
| 2 | Find text | R | S |
| 3 | Print | R | M |
| 4 | Fill a form | R | M |
| 5 | Sign (draw/type/image) | R | M |
| 6 | Merge files | S | M |
| 7 | Compress | S | M |
| 8 | Highlight/annotate | R | M |
| 9 | Reorder/delete/rotate/extract/split pages | S | M |
| 10 | Export to Word/Excel | S | L |
| 11 | Edit text | S | L |
| 12 | Password protect | S | M |
| 13 | OCR a scan | P | L |
| 14 | Redact | P | L |
| 15 | Convert images/Office to PDF | S | M |

## Deliberately excluded (cloud, AI, collaboration)

Acrobat AI Assistant and PDF Spaces (Studio); generative content (Firefly images, Express covers, podcasts, translate); Acrobat Sign request/bulk e-signature and web forms; Share links, shared review, Send & Track; Adobe Document Cloud and connector storage; cloud auto-tagging; Liquid Mode; Adobe account sign-in and telemetry.

## Open questions

Standard on macOS (sources conflict); exact tier of certify/timestamp/security policies; how offline signing handles OCSP/CRL and timestamp servers; export fidelity expectations for Word/Excel.

## Sources

https://www.adobe.com/acrobat/plans.html
https://en.wikipedia.org/wiki/Adobe_Acrobat
https://mapsoft.com/posts/acrobat-standard-vs-pro.html
https://www.adobe.com/devnet-docs/acrobatetk/tools/ReleaseNotesDC/index.html
https://helpx.adobe.com/acrobat/using/commenting-pdfs.html
https://helpx.adobe.com/acrobat/using/importing-exporting-comments.html
https://helpx.adobe.com/acrobat/using/edit-text-pdfs.html
https://helpx.adobe.com/acrobat/desktop/edit-documents/apply-bates-numbering/add-bates.html
https://helpx.adobe.com/acrobat/web/edit-pdfs/organize-documents/organize-pages.html
https://helpx.adobe.com/acrobat/using/pdf-forms.html
https://helpx.adobe.com/acrobat/current/pdf-form-field-properties.html
https://helpx.adobe.com/acrobat/using/collecting-pdf-form-data.html
https://helpx.adobe.com/acrobat/current/fill-and-sign.html
https://helpx.adobe.com/acrobat/desktop/e-sign-documents/manage-digital-signatures/validate-digital-sign.html
https://helpx.adobe.com/acrobat/using/certificate-based-signatures.html
https://helpx.adobe.com/acrobat/desktop/protect-documents/protect-with-passwords/encrypt-pdfs-with-password.html
https://helpx.adobe.com/acrobat/desktop/protect-documents/redact-pdfs/redact.html
https://helpx.adobe.com/acrobat/desktop/protect-documents/redact-pdfs/sanitize.html
https://helpx.adobe.com/acrobat/using/exporting-pdfs-file-formats.html
https://helpx.adobe.com/acrobat/desktop/create-documents/scan-documents-to-pdfs/recognize-text.html
https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html
https://helpx.adobe.com/acrobat/using/accessibility-features-pdfs.html
https://helpx.adobe.com/acrobat/using/searching-pdfs.html
https://helpx.adobe.com/acrobat/using/print-production-tools-overview-acrobat.html
https://helpx.adobe.com/acrobat/using/pdf-x-pdf-a-pdf.html
https://helpx.adobe.com/acrobat/using/action-wizard-acrobat-pro.html
https://www.pdflib.com/pdf-knowledge-base/pdf-20/deprecated-features/
