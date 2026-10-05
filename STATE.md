# STATE
phase: v1.5.1 (session topic "v1.5.1 Text bearbeiten – Zeile bearbeiten", ADR-122)
version: 1.4.2 (tag v1.4.2)
current_item: pre-fix split buttons (owner) + W0 seam running; then wave 1 backend B1 walker/lines/mapping · B2 fonts/fallback · B3 splice/save · B4 model/commands/refusals; wave 2 F1 tool+edit box · F2 mini bar/popover/notice · F3 refusals/a11y/undo · F4 gate (corpus ≥30, click ≥90 %, footer case); release v1.5.0-beta.1
last_completed: v1.5 spec (ADR-125, ARCHITECTURE §13, DESIGN §3.10) + spike pdfwrite/textedit (not IPC-registered; corpus review/v1.5-spike/, not tracked)
loop_count_this_session: 1
open_blockers: 4 (B-002, B-005 human-only; B-006 recovery pre-task denied by classifier; B-007 corpus producers unknown)
notes: ADR-120: every loop starts with `bash scripts/ci-status.sh` (last completed run on main, never wait); red = fix first. v1.4 W0 2a1e3f3 (stable RustCrypto line), seam 586feeb. Release v1.3.0 published.
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
ci_log: (ADR-120 corrected — package commit → CI run; result filled in at the next push)
  - 6d01605 docs ADR-126 + ADR-125 accepted → not pushed yet (docs only)
  - eae482b lock choice after completed signing → run #90 (37381290387) red: prettier on SignDialog.tsx → fixed f6a0228
  - f6a0228..5e7331c prettier fix + ADR-125 docs + textedit spike → run #91 (37385569465) GREEN
  - 9b60ae8..4a70409 F17 wave 1 (spec, F17.9, F17.1, F17.5 logic, F17.10 gate) → run #85 (37356243921) GREEN
  - e92336c..81b0533 DoD gate + F17 wave 2 → run #86 (37360039469) GREEN
  - 14cfe8a..1551ad3 gate alignment + dialog fixes → run #87 (37365237817) Windows job cancelled by the runner after 15 min (no failing step; web + macOS green), covered by #88
  - 7a87c23 acceptance round 1 fixes → run #88 (37372013180) GREEN
  - ee79220 release v1.4.2 → run #89 (37378345637) GREEN (web 4, macOS 5, Windows 9 min) — tagged v1.4.2, release run 37378345719 success
  - e61e9e9 v1.4 backend B1–B4 → run #71 (37302935989) red: sig_validate command tests bound PDFium twice → fixed aaabac2
  - 02f5650 v1.4 frontend F1–F4 + glue → run #73 (37308405639) red: .p12 decode slot race → fixed 72316ba
  - 0bab7a6 v1.4 acceptance fixes → run #74 (37313577074) red: same PDFium test cause (aaabac2 not yet in)
  - 2965255 v1.4 milestone fixes + both test fixes → run #75 (37318631427) GREEN (Windows + macOS) — main green again
  - 7819d74 ADR-120 correction → run #76 (37320320065) superseded (cancelled while pending; #77 covers it)
  - bb93286 release v1.4.0 → run #77 (37320534094) GREEN — tagged v1.4.0, release run 37327757014 success
  - 935610d/54f1533 ci-status superseded handling → run #78 (37322052934) GREEN
  - f15da4a S4 CI split → run #79 (37335964661) GREEN — web 4 min, macOS 12 min, Windows 14 min (cold rust-cache)
  - b4a067b/c043bc9/a3cf54a S3+S2+S1 → run #80 (37337924918) red: snapshot test raced the save build slot (Windows) → fixed 19ab8e6
  - 19ab8e6..c57ae11 save fix + S8 + S6 + S7 + S5 → run #81 (37342811054) GREEN — Windows 9, macOS 5, web 4 min
  - d80dce9/0da31a0 T2 + T1 → run #82 (37345921685) GREEN
  - b97cd93/85f8bb5 test + acceptance fixes → run #83 (37348558262) GREEN
  - 7e834b8 release v1.4.1 → run #84 (37350514711) GREEN — tagged v1.4.1, release run 37350514517 success (DMG + NSIS)
