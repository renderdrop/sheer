# STATE
phase: 2
version: 0.1.0
current_item: Architecture: ADR-001..004 + docs/ARCHITECTURE.md
last_completed: Synthesis: docs/FEATURES.md + milestones M1–M7 in ROADMAP.md (tag v0.1.0)
loop_count_this_session: 0
open_blockers: 0
notes: Rust 1.99.0 in ~/.cargo/bin (not on PATH); scripts must prepend it. MSVC + WebView2 present. Node 22.23.1.
  Custom agent types need a session restart; until then run them as general-purpose + ROLE block (ADR-000 §8).
  Scope: PDFium plain + lopdf (ADR-010); design rules ADR-011. ADR-001..009 reserved for Phase 2.
  PDFium pin candidate: bblanchon chromium/7881 (matches pdfium-render 0.9.4 default API); verify digests in spike.
