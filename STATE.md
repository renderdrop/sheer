# STATE
phase: session "v2.0.0-rc.2 — F19 part 1" (ADR-141, tempo level 4)
version: 2.0.0-rc.1 (tag v2.0.0-rc.1, pre-release; latest stable v1.9.0)
current_item: F19 part 1 (docs/FEEDBACK.md F19.1–F19.15)
packages:
  wave 1: A F19.1 foreign comments (backend, cargo) · B F19.7 crop (cargo) · C F19.3/.4/.15 sidebar, last tab, focus ring · D F19.5/.6 home
  wave 2: E F19.12 header/footer (cargo) · F F19.2/.13/.14 tool hover, shapes, palettes · G F19.9/.10/.11 selection bar, bubbles, panel quote · H F19.8 redact
last_completed: F19 part 1 packages A–H committed (d3edaea..1c03543); F19.14 waits for the owner palette spec
loop_count_this_session: 0
open_blockers: 3 (B-002, B-005, B-008, human-only)
notes: Surface gate must run before annot-smoke on a fresh dev window (smoke leaves annotations that break overlap checks).
  ADR-120: every push starts with `bash scripts/ci-status.sh`; red = fix first. Rule 15 / ADR-131: acceptance ONLY via `npm run build:acceptance` + `scripts/ui/accept/*.mjs`; real input only `smoke-real.mjs` (≤ 5 min, announced).
  Split staging across packages can break an intermediate commit (run #108): stage whole files per package when possible.
  Never run the dev window while agents run cargo/vitest; stop it by killing only target\debug\sheer.exe processes.
  Rule 17 / ADR-136: ≤ 2 cargo agents; check:fast for agents, full check once before each commit.
ci_log: (ADR-120 corrected — package commit → CI run; result filled in at the next push)
  - f5c05f0..1c03543 ADR-141/142, F19 part 1 (A–H) → run #144 (37811172571) red: macOS crash, header_footer_detect bound PDFium per test in parallel → fixed d6df5b6
  - d6df5b6 shared engine in header_footer_detect → run #145 (37813850885) GREEN
  - f162738..273b81d ADR-140, v2.0 polish backend/ui, v20 scripts → run #139 (37709850350) red: ocr_layer line test CI-loud, bind() failed while the engine held PDFium → fixed 3186d17
  - 3186d17..7a2a611 PDFium test bind reuse, v20 script fixes → run #140 (37713489154) GREEN
  - 2789536 a11y fixes (81 → 0) → run #141 (37718283927) GREEN
  - 2ca6a96..a238d82 FX-BACK, FX-REASON, acceptance script fixes → run #142 (37724547453) GREEN
  - e57a9b2 release v2.0.0-rc.1 → run #143 (37725511266) GREEN; release run #21 (37725513445) success (universal DMG, NSIS; pre-release)
  - 85aedee release v1.9.0 → run #138 (37704883866) GREEN; release run #20 (37704883995) success (universal DMG, NSIS; stable)
  - b0066da..e3fcd66 save fix, acceptance, menus above modals, designer + gate fixes → runs #135–#137 GREEN
  - 15035be keychain deflake → run #134 (37694753207) GREEN
  - f5e0975..18c9cdc pipefail, tip ids, specs, citations, stamps, header-footer, comment export → run #133 (37692123673) red: Windows keychain timing test flaked twice under load → fixed 15035be
  - 783617c..8c698c8 report v1.8, pipefail checks, new tip ids, v1.9 specs → run #132 (37683297296) GREEN
  - 48aac44 release v1.8.0 → run #131 (37660293846) GREEN; release run #19 (37660293422) success (universal DMG, NSIS; stable)
  - c8c7855..658d558 OCR S7, tips fixes, settings fit, gate harness → run #129 (37652497354) GREEN, run #130 (37658721738) GREEN
  - fdbae51 token heights → run #128 (37647490676) GREEN
  - e7c7016..86d7c20 ADR-138, DESIGN §3.13, tipsEnabled, APNG/clip recorder, OCR-S7 script → run #127 (37643142340) GREEN
  - e3eac8e release v1.7.0 → run #126 (37635908414) GREEN; release run #18 (37635909346) success (universal DMG with sheer-ocr x86_64+arm64, NSIS; stable)
  - b9b0d63..eb02a82 MAC2 tests, sec low, FX-ACC, Vision SIGSEGV fix, FX-D, docs → run #125 (37633889225) GREEN (macOS Vision 5/5)
  - c4006f7..d67f8e9 → run #124 (37631704251) red: Vision tests bound PDFium in parallel (SIGSEGV, macOS) → fixed in #125
  - c0418a5..b372a72 ADR-137, MAC sidecar, PB, PF+FX-RO, AT → run #123 (37628875101) GREEN after rerun (Windows fuzz wedge EngineTimeout flake)
  - dc888af rule 17 → run #122 (37625710523) GREEN
  - 6df51ab..814b76f acceptance + smoke fixes + release v1.7.0-beta.1 → run #121 (37607512522) GREEN; release run #17 (37607515448) success (DMG + NSIS, pre-release)
  - a834dbe..6f8a67c FX-F1, explorer path, ACL fix, FX-GRAY/FX-SEC/tester, permissions → run #120 (37598730231) GREEN
  - 9b1004b..993537b B3, F1, acceptance script, B1, FX-B3 → run #119 (37593740231) GREEN
  - 570293f..6ec72b8 ADR-135 + DESIGN §3.12 + T-SCAN + B2 + W0 → run #118 (37556063073) GREEN
  - 85d161d..53d15a4 design L14 + privacy P0 (ADR-133) → run #115 (37545449136) GREEN
  - 6399a4c..e610716 ADR-134 + range chooser R → run #116 (37547381423) GREEN
  - f704a6e..report FX-R + OCR spike + docs → run #117 (37551440497) GREEN
  - autosave retention test slack → run #114 (37541496411) GREEN
  - tests + release v1.6.0 (41a2c4d) → run #113 (37539156008) red: flaky autosave retention test (whole-second stamps) → fixed next commit; release run #16 (37539156084) success (DMG + NSIS)
  - 3f6cc9f..3763737 FX-G + smoke script → run #112 (37536910147) GREEN
  - 32988ee..125116b FX-PR, docs, FX-D → run #111 (37531795738) GREEN
  - a5ad672 smartlinks frontend (F1, F2) → run #110 (37525121951) GREEN
  - 79ef1e5..a794812 smartlinks backend (S1–S3, FX-S) + FX-P → run #109 (37523806276) GREEN
  - d0268da..f60d18c acceptance infra (I1, I2, FX-I) + Politur v1.5.1 (P-F, P-B) → run #108 (37521354920) red: build.rs named smart_links before lib.rs registered it (split staging) → fixed 79ef1e5
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
