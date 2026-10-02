# Blockers

Things only a human can resolve. Each entry: ID · what is blocked · why · exactly what the human must do.
Work continues around them; they are revisited before every milestone tag.

| ID | Blocks | Why | Human action |
|---|---|---|---|
| B-001 | Running macOS code paths (objc2 transparency flag, Unix file modes/FIFO tests, mac PDFium pins) and the CI workflow itself | Development happens on a Windows host without a remote. `cargo check --target aarch64-apple-darwin` needs a C compiler for `objc2-exception-helper`; nothing has run on macOS so far. | Create a GitHub repository, add it as `origin`, push `main` with tags. `.github/workflows/ci.yml` then builds and tests on macOS and Windows. Alternatively run `npm run fetch-pdfium && npm run check` once on a Mac. |
