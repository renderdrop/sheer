# Blockers

Things only a human can resolve. Each entry: ID · what is blocked · why · exactly what the human must do.
Work continues around them; they are revisited before every milestone tag.

| ID | Blocks | Why | Human action |
|---|---|---|---|
| B-001 | Seeing the app run on macOS (window, vibrancy/transparency flag live, menu bar, file association) | **Partly resolved 2026-10-03 (FEEDBACK F6):** `origin` exists; CI on `macos-latest` (arm64) builds, runs `npm run check` (clippy, cargo test incl. Unix file modes/FIFO tests, vitest) and `tauri build --debug` green (run 37120538629, 17f7638). The first macOS runs failed only on test-side issues (APFS refuses non-UTF-8 names; a timing-sensitive respawn test), fixed. Still unverified: the running UI on a Mac — nobody has seen the window. | Run the debug build on a Mac once (`npm run fetch-pdfium && npm run tauri dev`), open a PDF, check the menu bar and the transparency setting. |
