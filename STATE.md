# STATE
phase: v1.4.1 patch "Politur v1.2–v1.4 + CI runtime" released (tag v1.4.1)
version: 1.4.1 (tag v1.4.1)
current_item: SESSION TOPIC F17 "UI quality after owner test" → v1.4.2 (ADR-124). Wave 1: D spec §3.9, F17.9 thumbnails, F17.1 delete cards, F17.5 shape logic, F17.10 DOM gate. Wave 2 after spec: positioning engine + surface rule (F17.7/8), mini bar + colour + crop + shape switch (F17.3/4/5/7), tool row + Lesen + lock memory (F17.0a/2/6). Then gate, notice audit series, installed-build acceptance 960×640 + 1280×800, v1.4.2
last_completed: v1.4.1 Politur + CI runtime (ADR-123)
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: ADR-120: every loop starts with `bash scripts/ci-status.sh` (last completed run on main, never wait); red = fix first. v1.4 W0 2a1e3f3 (stable RustCrypto line), seam 586feeb. Release v1.3.0 published.
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
ci_log: (ADR-120 corrected — package commit → CI run; result filled in at the next push)
  - 9b60ae8..4a70409 F17 wave 1 (spec, F17.9, F17.1, F17.5 logic, F17.10 gate) → run #85 (37356243921) GREEN
  - e92336c..81b0533 DoD gate + F17 wave 2 (engine, minibar/colour/morph, modes/crop, lock memory) → run #86 (37360039469) pending
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
