# STATE
phase: v1.6 (session topic "v1.6 Smarte Verknüpfungen"; order: acceptance infrastructure ADR-131 → Politur v1.5.1 → v1.6 spec → v1.6 → release v1.6.0)
session_plan: I1 automation feature (backend) ‖ I2 acceptance tooling (scripts/ui/accept) ‖ designer spec v1.6 (DESIGN.md) → Politur v1.5.1 (Umbrechen default for multi-line, stop at paragraph edge + correct overflow, focus outline right-aligned, Präambel repro) → v1.6 backend detection wave → frontend overlay wave → acceptance with 3 owner PDFs (footnotes + TOC) in the acceptance build → v1.6.0
version: 1.5.1 (tag v1.5.1; v1.5.0 and pre-release v1.5.0-beta.1 kept)
current_item: v1.5.1 released. Next open: "Politur v1.5.1" (ROADMAP, carried majors/minors) or v1.6 spec
last_completed: v1.5.1 — F1 54bf35a, B1 3f718c6, B2 3ee910b, B3 5b2e905, W (decode + minors) and deflake 0da261f; acceptance fixes b974d69 (stretch give-back), 17b5313 (box width), 20c94c5 (preview region); reviews B1/B2/B3/W PASS; security PASS (lows); designer PASS (2 majors → Politur v1.5.1); tester green + tests; surface gate 993/993, smoke 17/17 (rerun)
loop_count_this_session: 0 (session "v1.6 Smarte Verknüpfungen" running, STOP removed)
open_blockers: 2 (B-002, B-005, human-only). B-006 and B-007 resolved by the owner (ADR-128). Path guard (ADR-127) allows the project memory folder (ADR-128)
notes: ADR-120: every loop starts with `bash scripts/ci-status.sh` (last completed run on main, never wait); red = fix first. v1.4 W0 2a1e3f3 (stable RustCrypto line), seam 586feeb. Release v1.3.0 published.
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
ci_log: (ADR-120 corrected — package commit → CI run; result filled in at the next push)
  - d0268da..f60d18c acceptance infra (I1, I2, FX-I) + Politur v1.5.1 (P-F, P-B) → run #108 (37521354920) red: build.rs named smart_links before lib.rs registered it (split staging) → fixed 79ef1e5
  - 79ef1e5..a794812 smartlinks backend (S1–S3, FX-S) + FX-P → run #109 (37523806276) GREEN
  - a5ad672 smartlinks frontend (F1, F2) → run #110 (37525121951) GREEN
  - 9 commits ..v1.5.1 tests + release → run #107 (37494737957) GREEN; release run #15 (37494738010) success (DMG + NSIS)
  - 20c94c5 preview crop fix FX-F2 → run #106 (37490268401) GREEN
  - b974d69..17b5313 acceptance fixes FX-B + FX-F → run #105 (37485534024) GREEN
  - 0da261f..c6a93fc deflake + W fix + changelog → run #104 (37482891749) GREEN
  - 54bf35a..fc06762 v1.5.1 wave (F1, B1, B2, B3 + ADR-130) → run #103 (37478918822) red: flaky print.test.tsx unmount test (vitest, web job) → fixed 0da261f
  - ccc12ae..a9ae592 blocker fix + FIX + release v1.5.0 → run #102 (37470539405) GREEN; release run #14 (37470539395) success (DMG + NSIS)
  - 6365fca..5eb14e6 wave B + preview fix → run #101 (37464077361) GREEN
  - 3dbbf08..c7aba1a wave A (F1, B2, B3, B1, seam) → run #100 (37459843116) GREEN
  - 66b8cee release v1.5.0-beta.1 → run #99 (37451474704) GREEN; release run #13 (37451474946) success (DMG + NSIS, pre-release)
  - 266bc35 + 8a78a0b P4 + gate fixes → run #98 (37450352909) GREEN
  - 13ca75b wave 2 P1–P3 (textedit frontend) → run #97 (37445931977) GREEN
  - 351fea5..0edc161 seam + ADR-128 + state → run #96 (37443471709) GREEN
  - 55a92e0 / 540ae3c guard-paths → run #94 failure, #95 cancelled; superseded by #96 GREEN
  - 55a92e0 guard-paths hook (ADR-127) → run #94 (37442441626) pending; follow-up fix (sed script ≠ path) pushed after it — read both next session
  - fd25f86..08d15c1 wave 1 B1–B4 + ADR-125 add. 3 → run #93 (37400184937) GREEN
  - 76dd8b7 split-button fix + 9a6a7ff W0 seam (+ docs 6d01605, d001edb) → run #92 (37393656808) GREEN
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
