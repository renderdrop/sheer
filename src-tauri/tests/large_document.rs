//! A 500-page document through the whole engine path: generate it, open it, read every page size, render the first page.
//!
//! The budgets of ROADMAP M7 are "a 500-page PDF opens in under one second" and "60 fps scrolling" (ADR-002 context). Timing
//! on a shared CI runner is noise, so this test **logs** what open and the first visible render took, with the budget beside
//! it, and never fails on time. Set `SHEER_PERF_STRICT=1` on a machine you trust to turn the budget into an assertion.
//!
//! The PDF is generated here (no binary fixture of hundreds of kilobytes in the repository): a classic cross-reference table,
//! one content stream per page, pages of three sizes. PDFium is needed for everything but the generator's own checks; without
//! the library (`npm run fetch-pdfium`) the engine tests skip, as the ones in `src/engine` do.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Write as _;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sheer_lib::documents::Registry;
use sheer_lib::engine::{self, Engine, Priority, RenderKey, RenderSpec};

/// What the roadmap asks of opening a 500-page document.
const OPEN_BUDGET: Duration = Duration::from_secs(1);
/// What the first visible page may add on top of the open (the user is looking at a blank canvas until it is there).
const FIRST_RENDER_BUDGET: Duration = Duration::from_millis(300);
const PAGES: u32 = 500;

/// Size in points of page `index` of the synthetic document: mostly US Letter, every 10th landscape, every 25th A4.
fn page_size(index: u32) -> [u32; 2] {
    if index % 25 == 24 {
        [595, 842]
    } else if index % 10 == 9 {
        [792, 612]
    } else {
        [612, 792]
    }
}

/// A PDF of `pages` pages with a correct cross-reference table: object 1 is the catalog, 2 the page tree, 3 the font, then a
/// page object and its content stream per page. Each page has a coloured square (its colour follows the page number) and
/// its number as text, so a render shows that it is the right page.
fn synthetic_pdf(pages: u32) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    let mut object = |out: &mut Vec<u8>, body: &str| {
        offsets.push(out.len());
        let number = offsets.len();
        out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
    };

    object(&mut out, "<< /Type /Catalog /Pages 2 0 R >>");
    let kids: String = (0..pages).fold(String::new(), |mut kids, index| {
        write!(kids, "{} 0 R ", 4 + 2 * index).unwrap();
        kids
    });
    object(
        &mut out,
        &format!("<< /Type /Pages /Kids [{kids}] /Count {pages} >>"),
    );
    object(
        &mut out,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    );
    for index in 0..pages {
        let [width, height] = page_size(index);
        let content_id = 5 + 2 * index;
        object(
            &mut out,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents {content_id} 0 R \
                 /Resources << /Font << /F1 3 0 R >> >> >>"
            ),
        );
        let shade = f64::from(index % 10) / 10.0;
        let stream = format!(
            "{shade:.1} 0.2 0.6 rg 50 {} 100 100 re f\n0 0 0 rg BT /F1 24 Tf 50 {} Td (Page {}) Tj ET",
            height - 150,
            height - 200,
            index + 1
        );
        object(
            &mut out,
            &format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        );
    }

    let xref_at = out.len();
    let count = offsets.len() + 1;
    let mut table = format!("xref\n0 {count}\n0000000000 65535 f \n");
    for offset in &offsets {
        // Every entry is exactly 20 bytes.
        writeln!(table, "{offset:010} 00000 n ").unwrap();
    }
    write!(
        table,
        "trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    )
    .unwrap();
    out.extend_from_slice(table.as_bytes());
    out
}

struct TempFile(PathBuf);

impl TempFile {
    fn with_bytes(name: &str, bytes: &[u8]) -> Self {
        let dir = std::env::temp_dir().join(format!("sheer-large-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(dir) = self.0.parent() {
            let _ = fs::remove_dir(dir);
        }
    }
}

#[test]
fn the_generated_pdf_has_a_consistent_cross_reference_table() {
    let bytes = synthetic_pdf(PAGES);
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(text.starts_with("%PDF-1.4\n") && text.ends_with("%%EOF\n"));

    // `startxref` points at the table, and every entry of the table points at its object.
    let xref_at: usize = text
        .rsplit("startxref\n")
        .next()
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!(text[xref_at..].starts_with("xref\n"));
    let entries: Vec<&str> = text[xref_at..]
        .lines()
        .skip(2)
        .take_while(|line| !line.starts_with("trailer"))
        .collect();
    // The free entry, the catalog, the page tree, the font, and two objects per page.
    assert_eq!(entries.len(), 4 + 2 * PAGES as usize);
    assert!(entries[0].ends_with(" f "));
    for (number, entry) in entries.iter().enumerate().skip(1) {
        assert_eq!(entry.len(), 19, "entries are 20 bytes with the newline");
        let offset: usize = entry[..10].parse().unwrap();
        assert!(
            text[offset..].starts_with(&format!("{number} 0 obj\n")),
            "entry {number} points at {:?}",
            &text[offset..offset + 20]
        );
    }
    assert!(text.contains(&format!("/Count {PAGES} ")));
    assert!(text.contains("(Page 500)"));
    // Three page sizes, in the pattern `page_size` describes.
    assert_eq!(page_size(0), [612, 792]);
    assert_eq!(page_size(9), [792, 612]);
    assert_eq!(page_size(24), [595, 842]);
    assert!(bytes.len() > 100_000, "{} bytes", bytes.len());
}

/// PDFium can be bound once per process, so every test of this file shares one engine and one registry (the ids must not clash).
/// `None` when the library has not been fetched.
fn shared() -> Option<(&'static Engine, &'static Registry)> {
    static SHARED: OnceLock<Option<(Engine, Registry)>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                Some((Engine::start(library), Registry::new()))
            } else {
                eprintln!(
                    "skipping: {} not found (npm run fetch-pdfium)",
                    library.display()
                );
                None
            }
        })
        .as_ref()
        .map(|(engine, registry)| (engine, registry))
}

fn first_visible_page(id: sheer_lib::documents::DocumentId) -> RenderSpec {
    RenderSpec {
        key: RenderKey {
            id,
            page_index: 0,
            // 100 % zoom on a 96 dpi display, bucket b = ceil(4 * log2(4/3)) = 2.
            bucket: 2,
            tile: None,
        },
        priority: Priority::Visible,
        generation: 1,
    }
}

#[test]
fn a_500_page_document_opens_and_shows_its_first_page_within_the_budget_that_is_logged() {
    let Some((engine, registry)) = shared() else {
        return;
    };
    let file = TempFile::with_bytes("synthetic-500.pdf", &synthetic_pdf(PAGES));
    let id = registry.register(file.path().to_path_buf()).unwrap();

    let started = Instant::now();
    let opened = engine
        .open(id, File::open(file.path()).unwrap(), |_| true)
        .unwrap();
    let open_time = started.elapsed();
    assert_eq!(opened, PAGES);

    let sizes_started = Instant::now();
    let sizes = engine.page_sizes(id).unwrap();
    let sizes_time = sizes_started.elapsed();
    assert_eq!(sizes.len(), PAGES as usize);
    for (index, size) in sizes.iter().enumerate() {
        let [width, height] = page_size(index as u32);
        assert_eq!(*size, [width as f32, height as f32], "page {index}");
    }

    let render_started = Instant::now();
    let frame = engine.render(first_visible_page(id)).unwrap();
    let render_time = render_started.elapsed();
    // A 612 x 792 pt page at 1.414 px per point, rounded up: the frame header says so.
    assert_eq!(&frame[..4], b"SHR1");
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(frame[12..16].try_into().unwrap());
    assert_eq!((width, height), (866, 1121));

    let first_page_on_screen = open_time + render_time;
    let within = |time: Duration, budget: Duration| if time <= budget { "within" } else { "OVER" };
    eprintln!(
        "perf: {PAGES} pages, {} KiB: open {open_time:?} ({} the {OPEN_BUDGET:?} budget), page sizes {sizes_time:?}, \
         first visible page {render_time:?} ({} the {FIRST_RENDER_BUDGET:?} budget), open to first page {first_page_on_screen:?}",
        fs::metadata(file.path()).unwrap().len() / 1024,
        within(open_time, OPEN_BUDGET),
        within(render_time, FIRST_RENDER_BUDGET),
    );
    if std::env::var("SHEER_PERF_STRICT").is_ok_and(|value| value == "1") {
        assert!(open_time <= OPEN_BUDGET, "open took {open_time:?}");
        assert!(
            render_time <= FIRST_RENDER_BUDGET,
            "the first visible page took {render_time:?}"
        );
    }
    engine.close(id).unwrap();
}

#[test]
fn pages_far_into_the_document_render_the_right_page_at_their_own_size() {
    let Some((engine, registry)) = shared() else {
        return;
    };
    let file = TempFile::with_bytes("synthetic-500-far.pdf", &synthetic_pdf(PAGES));
    let id = registry.register(file.path().to_path_buf()).unwrap();
    engine
        .open(id, File::open(file.path()).unwrap(), |_| true)
        .unwrap();

    // Page 10 (index 9) is landscape, page 25 (index 24) is A4, index 498 is Letter again.
    for (index, expected) in [(9, (792, 612)), (24, (595, 842)), (498, (612, 792))] {
        let mut spec = first_visible_page(id);
        spec.key.page_index = index;
        // Bucket 0 is 1 px per point.
        spec.key.bucket = 0;
        let frame = engine.render(spec).unwrap();
        let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(frame[12..16].try_into().unwrap());
        assert_eq!((width, height), expected, "page index {index}");
    }
    engine.close(id).unwrap();
}
